"""Background daemon for monitoring Blackmagic Web Presenter devices.

Polls configured Web Presenters for stream state and telemetry,
maintaining a shared state cache for the web UI.
"""

import asyncio
import json
import logging
import os
import threading
from typing import Any

from app.backend.utils import atomic_json_write
from app.backend.wp_audit import log_wp_apply
from app.backend.wp_control import (
    WP_PORT,
    get_identity,
    get_stream_settings,
    get_stream_state,
    set_stream_settings,
)

logger = logging.getLogger(__name__)

ACTIVE_EVENT_FILE = "app/backend/active_event.json"
CONFIG_FILE = "app/backend/config.json"
SCHEDULE_FILE = "app/backend/schedule.json"
STREAM_PROFILES_FILE = "app/backend/stream_profiles.json"
PENDING_CHANGES_FILE = "app/backend/wp_pending_changes.json"

# Shared state cache for all Web Presenters, keyed by host IP.
global_presenter_state_cache: dict[str, dict[str, Any]] = {}
_presenter_lock = asyncio.Lock()

_wp_monitor_task: asyncio.Task | None = None
_wp_monitor_stop_event: asyncio.Event | None = None
_presenter_runtime_state: dict[str, dict[str, Any]] = {}

_config_cache: dict[str, Any] | None = None
_config_cache_mtime: float = 0.0
_config_cache_lock = threading.Lock()


def _load_runtime_config() -> dict[str, Any]:
    global _config_cache, _config_cache_mtime
    try:
        mtime = os.path.getmtime(CONFIG_FILE) if os.path.exists(CONFIG_FILE) else 0
    except OSError:
        mtime = 0
    with _config_cache_lock:
        if _config_cache is not None and mtime == _config_cache_mtime:
            return dict(_config_cache)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            with _config_cache_lock:
                _config_cache = data
                _config_cache_mtime = mtime
            return dict(data)
        except Exception:
            pass
    with _config_cache_lock:
        _config_cache = {}
        _config_cache_mtime = 0
    return {}


def get_active_event_title() -> str:
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return str(data.get("planned_title", "")).strip()
        except Exception:
            pass
    return ""


async def _wp_poll_single_presenter(
    name: str,
    host: str,
    config: dict[str, Any],
) -> None:
    """Poll a single Web Presenter for stream state and settings."""
    port = WP_PORT
    wp_cfg = config.get("webpresenters", {})
    entry = wp_cfg.get(name, host)
    if isinstance(entry, dict):
        host = entry.get("ip", host)
        port = entry.get("port", WP_PORT)

    runtime = _presenter_runtime_state.setdefault(host, {
        "poll_failures": 0,
        "last_status": "Configured",
    })

    try:
        state = await get_stream_state(host, port=port)
        settings = {}
        try:
            settings = await get_stream_settings(host, port=port)
        except Exception:
            pass

        identity = {}
        try:
            identity = await get_identity(host, port=port)
        except Exception:
            pass

        runtime["poll_failures"] = 0
        runtime["last_status"] = state.get("status", "Unknown")

        async with _presenter_lock:
            global_presenter_state_cache[host] = {
                "name": name,
                "connected": True,
                "streaming": state.get("status") == "Streaming",
                "status": state.get("status", "Unknown"),
                "duration": state.get("duration", ""),
                "bitrate": state.get("bitrate", "0"),
                "cache_used": state.get("cache_used", 0),
                "video_mode": settings.get("Video Mode", ""),
                "platform": settings.get("Current Platform", ""),
                "server": settings.get("Current Server", ""),
                "quality": settings.get("Current Quality Level", ""),
                "model": identity.get("Model", ""),
                "label": identity.get("Label", ""),
            }
    except Exception:
        runtime["poll_failures"] = int(runtime.get("poll_failures", 0)) + 1
        if runtime["poll_failures"] > 3:
            async with _presenter_lock:
                global_presenter_state_cache[host] = {
                    "name": name,
                    "connected": False,
                    "streaming": False,
                    "status": "Offline",
                    "duration": "",
                    "bitrate": "0",
                    "cache_used": 0,
                    "video_mode": "",
                    "platform": "",
                    "server": "",
                    "quality": "",
                    "stream_key": "",
                    "model": "",
                    "label": "",
                }


# --- Shared apply engine (used by API endpoints and auto-apply) ---

def _enumerate_presenters(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a list of {name, host, port, role, stage} for each configured presenter."""
    presenters = config.get("webpresenters", {}) or {}
    roles = config.get("wp_presenter_roles", {}) or {}
    stages = config.get("wp_stages", {}) or {}
    out: list[dict[str, Any]] = []
    for name, value in presenters.items():
        host, port = _parse_wp_host_port(value)
        if not host:
            continue
        out.append({
            "name": name,
            "host": host,
            "port": port,
            "role": str(roles.get(name, "") or "").strip().lower(),
            "stage": str(stages.get(name, "") or "").strip(),
        })
    return out


def resolve_wp_targets(config: dict[str, Any], target: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve presenters matching a target spec.

    target may contain:
      - role: "primary"/"backup" (optional; empty = any role)
      - stage: stage name (optional; empty = any stage)
      - hosts: explicit list of host IPs (if provided, overrides role/stage filters)
    When both role and stage are given they are AND-combined (device must match both).
    """
    role = str(target.get("role", "") or "").strip().lower()
    stage = str(target.get("stage", "") or "").strip()
    raw_hosts = target.get("hosts")

    presenters = _enumerate_presenters(config)
    # Only honor an explicit, non-empty hosts list. An explicitly empty list
    # means "no targets" (not "all"), and an absent key falls through to the
    # role/stage filters below.
    if raw_hosts is not None:
        hosts_filter = {str(h).strip() for h in raw_hosts}
        if hosts_filter:
            return [p for p in presenters if p["host"] in hosts_filter]
        return []

    result = []
    for p in presenters:
        if role and p["role"] != role:
            continue
        if stage and p["stage"] != stage:
            continue
        result.append(p)
    return result


def _parse_wp_host_port(host_value: Any) -> tuple[str, int]:
    if isinstance(host_value, dict):
        return str(host_value.get("ip", "")), int(host_value.get("port", WP_PORT))
    return str(host_value), WP_PORT


def build_wp_device_settings(device: dict[str, Any], stream_config: dict[str, Any]) -> dict[str, str]:
    """Build the device-facing STREAM SETTINGS payload for one presenter.

    Applies role-aware key selection: primary units get primary keys/URLs and
    the Primary server; backup units get backup keys/URLs and the Secondary server.
    Supports both RTMP and SRT (Custom URL) transports.
    """
    settings: dict[str, str] = {}
    video_mode = str(stream_config.get("video_mode") or "").strip()
    platform = str(stream_config.get("platform") or "").strip()
    quality = str(stream_config.get("quality") or "").strip()
    if video_mode:
        settings["Video Mode"] = video_mode
    if platform:
        settings["Current Platform"] = platform
    if quality:
        settings["Current Quality Level"] = quality

    protocol = str(stream_config.get("protocol") or "rtmp").strip().lower()
    role = str(device.get("role") or "").strip().lower()

    if protocol == "srt":
        settings["Current Server"] = "Custom"
        settings["Current Platform"] = "Custom URL H.264"
        if role == "backup":
            if stream_config.get("srt_backup"):
                settings["Current URL"] = str(stream_config["srt_backup"])
            if stream_config.get("srt_backup_passphrase"):
                settings["Password"] = str(stream_config["srt_backup_passphrase"])
        else:
            if stream_config.get("srt_primary"):
                settings["Current URL"] = str(stream_config["srt_primary"])
            if stream_config.get("srt_passphrase"):
                settings["Password"] = str(stream_config["srt_passphrase"])
    else:
        is_custom = platform in ("Custom", "Custom URL H.264")
        if role == "backup":
            if is_custom:
                settings["Current Server"] = "Custom"
                if stream_config.get("backup_url"):
                    settings["Current URL"] = str(stream_config["backup_url"])
            else:
                settings["Current Server"] = "Secondary"
            if stream_config.get("backup_key"):
                settings["Stream Key"] = str(stream_config["backup_key"])
        else:
            if is_custom:
                settings["Current Server"] = "Custom"
                if stream_config.get("primary_url"):
                    settings["Current URL"] = str(stream_config["primary_url"])
            else:
                settings["Current Server"] = "Primary"
            if stream_config.get("primary_key"):
                settings["Stream Key"] = str(stream_config["primary_key"])
    return settings


def load_profile_settings(name: str) -> dict[str, Any] | None:
    """Load a saved stream profile's settings dict by name, or None if missing."""
    name = str(name or "").strip()
    if not name:
        return None
    if not os.path.exists(STREAM_PROFILES_FILE):
        return None
    try:
        with open(STREAM_PROFILES_FILE, "r", encoding="utf-8") as f:
            profiles = json.load(f) or []
    except Exception:
        return None
    profile = next((p for p in profiles if p.get("name") == name), None)
    if not profile:
        return None
    return profile.get("settings", {})


def _resolve_event_stream_config(event: dict[str, Any]) -> dict[str, Any]:
    """Resolve the stream config for a schedule event.

    Prefers the referenced profile (event.stream_profile); falls back to the
    event's inline stream fields.
    """
    profile_name = str(event.get("stream_profile") or "").strip()
    if profile_name:
        settings = load_profile_settings(profile_name)
        if settings:
            return settings
    keys = [
        "protocol", "platform", "quality", "video_mode",
        "primary_url", "primary_key", "backup_url", "backup_key",
        "srt_primary", "srt_passphrase", "srt_backup", "srt_backup_passphrase",
    ]
    return {k: event.get(k, "") for k in keys}


# --- Pending (queued) changes for devices that are live ---

_wp_pending_changes: dict[str, dict[str, Any]] = {}
_pending_lock = threading.Lock()


def _load_pending_changes() -> dict[str, dict[str, Any]]:
    global _wp_pending_changes
    with _pending_lock:
        if _wp_pending_changes:
            return dict(_wp_pending_changes)
    data: dict[str, dict[str, Any]] = {}
    if os.path.exists(PENDING_CHANGES_FILE):
        try:
            with open(PENDING_CHANGES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
    with _pending_lock:
        _wp_pending_changes = data
    return dict(data)


def enqueue_wp_pending_change(host: str, settings: dict[str, Any]) -> None:
    with _pending_lock:
        _wp_pending_changes[host] = dict(settings)
        data = dict(_wp_pending_changes)
    atomic_json_write(PENDING_CHANGES_FILE, data)


def get_wp_pending_change(host: str) -> dict[str, Any] | None:
    with _pending_lock:
        return dict(_wp_pending_changes[host]) if host in _wp_pending_changes else None


def clear_wp_pending_change(host: str) -> None:
    with _pending_lock:
        _wp_pending_changes.pop(host, None)
        data = dict(_wp_pending_changes)
    atomic_json_write(PENDING_CHANGES_FILE, data)


async def apply_settings_to_targets(
    settings: dict[str, Any],
    target: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply a stream config to all presenters matching ``target``.

    Uses a streaming guard: if a device is currently live it is queued and the
    change is applied later when it goes idle (see the monitor loop).
    """
    if config is None:
        config = _load_runtime_config()
    targets = resolve_wp_targets(config, target)
    results: list[dict[str, Any]] = []
    for device in targets:
        host = device["host"]
        device_settings = build_wp_device_settings(device, settings)
        if not device_settings:
            results.append({"host": host, "name": device["name"], "status": "skipped", "reason": "empty settings"})
            continue
        state = global_presenter_state_cache.get(host, {})
        if state.get("connected") and state.get("streaming"):
            enqueue_wp_pending_change(host, device_settings)
            log_wp_apply(host, "apply_targets", details=device_settings, status="queued",
                         error="device streaming")
            results.append({"host": host, "name": device["name"], "status": "queued", "reason": "device streaming"})
            continue
        try:
            ok = await set_stream_settings(host, device_settings, port=device["port"])
            if ok:
                log_wp_apply(host, "apply_targets", details=device_settings)
                results.append({"host": host, "name": device["name"], "status": "applied"})
            else:
                log_wp_apply(host, "apply_targets", details=device_settings, status="rejected")
                results.append({"host": host, "name": device["name"], "status": "rejected"})
        except Exception as e:  # noqa: BLE001
            log_wp_apply(host, "apply_targets", details=device_settings, status="error", error=str(e))
            results.append({"host": host, "name": device["name"], "status": "error", "error": str(e)})
    return {"targets": len(targets), "results": results}


# --- Auto-apply bookkeeping ---

_last_auto_applied_event_id = ""


def _load_active_event() -> dict[str, Any]:
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception:
            pass
    return {}


def _find_schedule_event(event_id: str, config: dict[str, Any]) -> dict[str, Any] | None:
    event_id = str(event_id or "").strip()
    if not event_id:
        return None
    if not os.path.exists(SCHEDULE_FILE):
        return None
    try:
        with open(SCHEDULE_FILE, "r", encoding="utf-8") as f:
            schedule = json.load(f) or []
    except Exception:
        return None
    return next((e for e in schedule if str(e.get("id", "")).strip() == event_id), None)


async def _wp_monitor_loop() -> None:
    global _wp_monitor_stop_event
    while _wp_monitor_stop_event is not None and not _wp_monitor_stop_event.is_set():
        config = _load_runtime_config()
        presenters = config.get("webpresenters", {})
        if isinstance(presenters, dict) and presenters:
            await asyncio.gather(
                *[
                    _wp_poll_single_presenter(
                        str(name),
                        str(host if isinstance(host, str) else host.get("ip", "")),
                        config,
                    )
                    for name, host in presenters.items()
                ],
                return_exceptions=True,
            )
            active_hosts = set()
            for name, host in presenters.items():
                if isinstance(host, str):
                    active_hosts.add(host)
                elif isinstance(host, dict):
                    active_hosts.add(host.get("ip", ""))

            async with _presenter_lock:
                for stale_host in list(global_presenter_state_cache.keys()):
                    if stale_host not in active_hosts:
                        global_presenter_state_cache.pop(stale_host, None)
                        _presenter_runtime_state.pop(stale_host, None)
        else:
            async with _presenter_lock:
                global_presenter_state_cache.clear()
                _presenter_runtime_state.clear()

        # Apply queued changes for devices that are now idle.
        pending = _load_pending_changes()
        for host, queued_settings in list(pending.items()):
            state = global_presenter_state_cache.get(host, {})
            if state.get("connected") and not state.get("streaming"):
                port = state.get("port", WP_PORT)
                # Resolve port from config if not present in cached state.
                if "port" not in state:
                    for name, value in config.get("webpresenters", {}).items():
                        h, p = _parse_wp_host_port(value)
                        if h == host:
                            port = p
                            break
                try:
                    ok = await set_stream_settings(host, queued_settings, port=port)
                    if ok:
                        logger.info("Applied queued change to %s", host)
                        clear_wp_pending_change(host)
                    else:
                        logger.warning("Device %s rejected queued change", host)
                except Exception as e:  # noqa: BLE001
                    logger.warning("Failed to apply queued change to %s: %s", host, e)

        # Guarded auto-apply of the active event's profile to its stage.
        if config.get("wp_auto_apply_event"):
            active = _load_active_event()
            active_id = str(active.get("id", "")).strip()
            global _last_auto_applied_event_id
            if active_id and active_id != _last_auto_applied_event_id:
                _last_auto_applied_event_id = active_id
                event = _find_schedule_event(active_id, config)
                if event:
                    event_settings = _resolve_event_stream_config(event)
                    stage = str(event.get("stage") or "").strip()
                    if event_settings and stage:
                        try:
                            res = await apply_settings_to_targets(
                                event_settings, {"stage": stage}, config
                            )
                            logger.info(
                                "Auto-applied event %s to stage %s: %s",
                                active_id, stage, res,
                            )
                        except Exception as e:  # noqa: BLE001
                            logger.warning("Auto-apply of event %s failed: %s", active_id, e)

        try:
            await asyncio.wait_for(_wp_monitor_stop_event.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


def start_wp_background_monitor() -> None:
    global _wp_monitor_task, _wp_monitor_stop_event
    if _wp_monitor_task and not _wp_monitor_task.done():
        return
    _wp_monitor_stop_event = asyncio.Event()
    _wp_monitor_task = asyncio.create_task(_wp_monitor_loop())


async def stop_wp_background_monitor() -> None:
    global _wp_monitor_task, _wp_monitor_stop_event
    if not _wp_monitor_task:
        return
    if _wp_monitor_stop_event:
        _wp_monitor_stop_event.set()
    try:
        await asyncio.wait_for(_wp_monitor_task, timeout=3.0)
    except asyncio.TimeoutError:
        _wp_monitor_task.cancel()
    finally:
        _wp_monitor_task = None
        _wp_monitor_stop_event = None
