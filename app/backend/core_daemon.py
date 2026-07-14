import asyncio
import datetime
import ftplib
import json
import os
import shutil
from typing import Any

from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command

ACTIVE_EVENT_FILE = "app/backend/active_event.json"
CONFIG_FILE = "app/backend/config.json"

# Shared runtime cache for deck state snapshots exposed via /api/state.
global_deck_state_cache: dict[str, dict[str, Any]] = {}

_monitor_task: asyncio.Task | None = None
_monitor_stop_event: asyncio.Event | None = None
_runtime_state: dict[str, dict[str, Any]] = {}


def _is_success_code(code: Any) -> bool:
    try:
        code_int = int(code)
    except (TypeError, ValueError):
        return False
    return 100 <= code_int < 300


def _transport_status_display(raw_status: str) -> str:
    raw = (raw_status or "").strip().lower()
    mapping = {
        "record": "Recording",
        "play": "Playing",
        "forward": "Playing",
        "reverse": "Reverse",
        "stopped": "Stopped",
        "stop": "Stopped",
        "preview": "Preview",
        "jog": "Jog",
        "shuttle": "Shuttle",
    }
    return mapping.get(raw, raw.title() if raw else "Online")


def _load_runtime_config() -> dict[str, Any]:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                return json.load(f) or {}
        except Exception:
            pass
    return {}


def get_live_event_title() -> str:
    """Reads the active event configuration written by the web server."""
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, "r") as f:
                data = json.load(f)
                return str(data.get("planned_title", "")).strip()
        except Exception:
            pass
    return ""


def get_weekday_sv3(now: datetime.datetime) -> str:
    # Swedish 3-letter weekday abbreviations, ASCII-safe for filenames.
    weekday_names = ["man", "tis", "ons", "tor", "fre", "lor", "son"]
    return weekday_names[now.weekday()]


def _resolve_deck_stage(config: dict[str, Any], deck_name: str) -> str:
    mode = str(config.get("stage_mode", "global"))
    if mode == "per_deck":
        return str((config.get("deck_stages") or {}).get(deck_name, "")).strip()
    return str(config.get("global_stage", "")).strip()


def generate_target_filename(
    deck_name: str,
    template: str,
    stage: str = "",
    ext: str = ".mov",
    original_base: str = "",
    slot_id: str = "1",
    started_at: datetime.datetime | None = None,
) -> str:
    now = started_at or datetime.datetime.now()
    safe_deck_name = deck_name.replace(" ", "_")
    title_context = get_live_event_title()

    # Smart fallback: no event context -> timestamp + deck.
    if not title_context:
        return f"{now.strftime('%Y%m%d_%H%M')}_{safe_deck_name}{ext or '.mov'}"

    tokens = {
        "deck_name": safe_deck_name,
        "stage": stage.replace(" ", "_") if stage else "",
        "slot_id": str(slot_id),
        "planned_title": title_context.replace(" ", "_"),
        "original_base": original_base,
        "ext": ext or ".mov",
        "year": now.strftime("%Y"),
        "month": now.strftime("%m"),
        "day": now.strftime("%d"),
        "hour": now.strftime("%H"),
        "minute": now.strftime("%M"),
        "second": now.strftime("%S"),
        "weekday_sv3": get_weekday_sv3(now),
    }
    try:
        return template.format(**tokens)
    except Exception:
        return f"{now.strftime('%Y%m%d_%H%M')}_{safe_deck_name}{ext or '.mov'}"


def _get_latest_file_from_ftp_sync(host: str, slot_id: str) -> str | None:
    try:
        ftp = ftplib.FTP(host, timeout=12)
        ftp.login()
        ftp.cwd(str(slot_id))
        file_list = ftp.nlst()
        ftp.quit()
        video_files = [f for f in file_list if f.lower().endswith((".mov", ".mp4", ".mxf"))]
        if not video_files:
            return None
        video_files.sort()
        return video_files[-1]
    except Exception:
        return None


def _download_and_distribute_sync(
    host: str,
    slot_id: str,
    remote_filename: str,
    local_filename: str,
    destinations: list[str],
    progress_callback=None,
) -> bool:
    if not destinations:
        return False

    primary_dest = destinations[0]
    primary_path = os.path.join(primary_dest, local_filename)
    os.makedirs(os.path.dirname(primary_path), exist_ok=True)

    try:
        ftp = ftplib.FTP(host, timeout=30)
        ftp.login()
        ftp.cwd(str(slot_id))

        remote_size: int | None = None
        try:
            remote_size = ftp.size(remote_filename)
        except Exception:
            remote_size = None

        if os.path.exists(primary_path):
            try:
                local_size = os.path.getsize(primary_path)
                if remote_size is not None and local_size == remote_size:
                    if progress_callback:
                        progress_callback(100)
                    ftp.quit()
                    return True
            except Exception:
                pass

        downloaded = 0

        def _write_chunk(chunk: bytes) -> None:
            nonlocal downloaded
            f.write(chunk)
            downloaded += len(chunk)
            if progress_callback and remote_size:
                pct = int((downloaded / max(remote_size, 1)) * 100)
                progress_callback(max(0, min(100, pct)))

        with open(primary_path, "wb") as f:
            if progress_callback:
                progress_callback(0)
            ftp.retrbinary(f"RETR {remote_filename}", _write_chunk)
        ftp.quit()

        for dest in destinations[1:]:
            secondary_path = os.path.join(dest, local_filename)
            os.makedirs(os.path.dirname(secondary_path), exist_ok=True)
            shutil.copy2(primary_path, secondary_path)

        return True
    except Exception:
        return False


def _list_recordings_from_ftp_sync(host: str, slot_id: str) -> list[dict[str, Any]]:
    recordings: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _collect_from_current_dir(ftp: ftplib.FTP) -> None:
        names: list[str] = []
        try:
            names = ftp.nlst()
        except Exception:
            names = []

        for raw_name in names:
            name = os.path.basename(str(raw_name or "").strip())
            lower = name.lower()
            if not lower.endswith((".mov", ".mp4", ".mxf")):
                continue
            if name in seen:
                continue
            seen.add(name)

            size = 0
            try:
                size = int(ftp.size(raw_name) or 0)
            except Exception:
                try:
                    size = int(ftp.size(name) or 0)
                except Exception:
                    size = 0

            recordings.append({"name": name, "size": size, "modified": ""})

    try:
        ftp = ftplib.FTP(host, timeout=15)
        ftp.login()

        # Some models expose files in /<slot>, others in root.
        target_slot = str(slot_id or "1").strip() or "1"
        probe_paths = [f"/{target_slot}", target_slot, "/", ""]

        for path in probe_paths:
            try:
                if path:
                    ftp.cwd(path)
                _collect_from_current_dir(ftp)
            except Exception:
                continue

        ftp.quit()
    except Exception:
        return []

    recordings.sort(key=lambda item: str(item.get("name", "")).lower(), reverse=True)
    return recordings


async def list_recordings_from_deck(host: str, slot_id: str = "1") -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_recordings_from_ftp_sync, host, slot_id)


async def transfer_recording_from_deck(
    host: str,
    slot_id: str,
    remote_filename: str,
    local_filename: str,
    destinations: list[str],
    progress_callback=None,
) -> bool:
    return await asyncio.to_thread(
        _download_and_distribute_sync,
        host,
        slot_id,
        remote_filename,
        local_filename,
        destinations,
        progress_callback,
    )


async def _trigger_transfer_for_stop(
    deck_name: str,
    host: str,
    slot_id: str,
    started_at: datetime.datetime,
    config: dict[str, Any],
) -> None:
    runtime = _runtime_state.setdefault(host, {})
    destinations = [str(p).strip() for p in (config.get("destinations") or []) if str(p).strip()]
    if not destinations:
        return

    latest_file = None
    for attempt in range(6):
        await asyncio.sleep(1.2 if attempt == 0 else 1.5)
        latest_file = await asyncio.to_thread(_get_latest_file_from_ftp_sync, host, slot_id)
        if latest_file:
            break
    if not latest_file:
        current = dict(global_deck_state_cache.get(host, {}))
        current["status"] = "Transfer Failed (No Clip Found)"
        current["is_transferring"] = False
        global_deck_state_cache[host] = current
        return

    original_base, ext = os.path.splitext(latest_file)
    stage = _resolve_deck_stage(config, deck_name)
    template = str(config.get("filename_template") or "{year}{month}{day}_{planned_title}{ext}")
    local_filename = generate_target_filename(
        deck_name=deck_name,
        template=template,
        stage=stage,
        ext=ext,
        original_base=original_base,
        slot_id=slot_id,
        started_at=started_at,
    )

    runtime["is_transferring"] = True
    runtime["transfer_progress"] = 0
    runtime["transfer_file"] = local_filename
    current = dict(global_deck_state_cache.get(host, {}))
    global_deck_state_cache[host] = {
        **current,
        "name": deck_name,
        "connected": True,
        "status": "Transferring",
        "transport_status": current.get("transport_status", "Stopped"),
        "progress": 0,
        "file": local_filename,
        "is_transferring": True,
    }

    def _progress_callback(pct: int) -> None:
        runtime["transfer_progress"] = pct
        state = dict(global_deck_state_cache.get(host, {}))
        state["progress"] = pct
        state["file"] = local_filename
        state["status"] = f"Transferring ({pct}%)"
        state["is_transferring"] = True
        global_deck_state_cache[host] = state

    success = await asyncio.to_thread(
        _download_and_distribute_sync,
        host,
        slot_id,
        latest_file,
        local_filename,
        destinations,
        _progress_callback,
    )

    runtime["is_transferring"] = False
    if success:
        current = dict(global_deck_state_cache.get(host, {}))
        current["status"] = "Transfer Complete"
        current["file"] = local_filename
        current["progress"] = 100
        current["is_transferring"] = False
        runtime["transfer_progress"] = 100
        runtime["transfer_file"] = local_filename
        global_deck_state_cache[host] = current
    else:
        current = dict(global_deck_state_cache.get(host, {}))
        current["status"] = "Transfer Failed"
        current["is_transferring"] = False
        global_deck_state_cache[host] = current


async def _poll_single_deck(deck_name: str, host: str, config: dict[str, Any]) -> None:
    runtime = _runtime_state.setdefault(host, {
        "was_recording": False,
        "record_started_at": None,
        "is_transferring": False,
        "transfer_progress": 0,
        "transfer_file": "",
        "poll_failures": 0,
        "last_transport_status": "Configured",
        "last_slot_id": "1",
    })
    connected = False
    status_display = "Configured"
    transport_status_display = "Configured"
    slot_id = "1"

    try:
        response = await send_hyperdeck_command(host, "transport info")
        parsed = parse_hyperdeck_response(response)
        code = parsed.get("_code", 0)
        if _is_success_code(code):
            connected = True
            runtime["poll_failures"] = 0
            raw = str(parsed.get("status", "online")).strip().lower()
            slot_id = str(parsed.get("slot id", "1") or "1")
            transport_status_display = _transport_status_display(raw)
            runtime["last_transport_status"] = transport_status_display
            runtime["last_slot_id"] = slot_id
            status_display = transport_status_display

            is_recording = raw == "record"
            was_recording = bool(runtime.get("was_recording"))
            if is_recording and not was_recording:
                runtime["record_started_at"] = datetime.datetime.now()
                runtime["transfer_progress"] = 0
            if (not is_recording) and was_recording and raw in {"stopped", "preview"}:
                started_at = runtime.get("record_started_at") or datetime.datetime.now()
                asyncio.create_task(_trigger_transfer_for_stop(deck_name, host, slot_id, started_at, config))
            runtime["was_recording"] = is_recording
        else:
            runtime["poll_failures"] = int(runtime.get("poll_failures", 0) or 0) + 1
            transport_status_display = str(runtime.get("last_transport_status") or "Configured")
    except Exception:
        runtime["poll_failures"] = int(runtime.get("poll_failures", 0) or 0) + 1
        transport_status_display = str(runtime.get("last_transport_status") or "Configured")

    existing = dict(global_deck_state_cache.get(host, {}))
    failures = int(runtime.get("poll_failures", 0) or 0)
    if not connected and failures <= 3:
        connected = bool(existing.get("connected", True))
        if not status_display or status_display == "Configured":
            status_display = str(existing.get("status") or "Monitoring")
        if not transport_status_display or transport_status_display == "Configured":
            transport_status_display = str(existing.get("transport_status") or runtime.get("last_transport_status") or "Monitoring")

    is_transferring = bool(runtime.get("is_transferring"))
    transfer_progress = int(runtime.get("transfer_progress", 0) or 0)
    transfer_file = str(runtime.get("transfer_file", "") or "")
    if is_transferring:
        status_display = f"Transferring ({max(0, min(100, transfer_progress))}%)"

    global_deck_state_cache[host] = {
        "name": deck_name,
        "connected": connected,
        "status": status_display if connected else "Configured",
        "transport_status": transport_status_display if connected else "Configured",
        "is_transferring": is_transferring,
        "progress": max(0, min(100, transfer_progress)) if is_transferring else int(existing.get("progress", 0) or 0),
        "file": transfer_file if is_transferring else existing.get("file", ""),
    }


async def _monitor_loop() -> None:
    global _monitor_stop_event
    while _monitor_stop_event is not None and not _monitor_stop_event.is_set():
        config = _load_runtime_config()
        decks = config.get("hyperdecks", {}) if isinstance(config, dict) else {}
        if isinstance(decks, dict) and decks:
            await asyncio.gather(
                *[_poll_single_deck(str(name), str(host), config) for name, host in decks.items()],
                return_exceptions=True,
            )
            active_hosts = {str(host) for host in decks.values()}
            for stale_host in list(global_deck_state_cache.keys()):
                if stale_host not in active_hosts:
                    global_deck_state_cache.pop(stale_host, None)
                    _runtime_state.pop(stale_host, None)
        else:
            global_deck_state_cache.clear()
            _runtime_state.clear()

        try:
            await asyncio.wait_for(_monitor_stop_event.wait(), timeout=1.5)
        except asyncio.TimeoutError:
            pass


def start_background_monitor() -> None:
    global _monitor_task, _monitor_stop_event
    if _monitor_task and not _monitor_task.done():
        return
    _monitor_stop_event = asyncio.Event()
    _monitor_task = asyncio.create_task(_monitor_loop())


async def stop_background_monitor() -> None:
    global _monitor_task, _monitor_stop_event
    if not _monitor_task:
        return
    if _monitor_stop_event:
        _monitor_stop_event.set()
    try:
        await asyncio.wait_for(_monitor_task, timeout=3.0)
    except asyncio.TimeoutError:
        _monitor_task.cancel()
    finally:
        _monitor_task = None
        _monitor_stop_event = None