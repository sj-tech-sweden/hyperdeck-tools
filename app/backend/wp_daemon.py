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

from app.backend.wp_control import (
    WP_PORT,
    get_identity,
    get_stream_settings,
    get_stream_state,
)

logger = logging.getLogger(__name__)

ACTIVE_EVENT_FILE = "app/backend/active_event.json"
CONFIG_FILE = "app/backend/config.json"

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
