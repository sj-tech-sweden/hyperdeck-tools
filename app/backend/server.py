# app/backend/server.py
import ast
import asyncio
import importlib.util
import inspect
import json
import logging
import os
import platform
import re
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

# Command audit log - ring buffer of last 200 entries
_command_audit_log: list[dict[str, Any]] = []
_COMMAND_AUDIT_MAX = 200


def log_command(command: str, host: str, deck_name: str = "", success: bool = True, detail: str = "") -> None:
    entry = {
        "timestamp": datetime.now().isoformat(),
        "command": command,
        "host": host,
        "deck_name": deck_name or host,
        "success": success,
        "detail": detail,
    }
    _command_audit_log.append(entry)
    if len(_command_audit_log) > _COMMAND_AUDIT_MAX:
        _command_audit_log.pop(0)

CORS_ORIGINS = [o.strip() for o in os.environ.get("HYPERDECK_CORS_ORIGINS", "*").split(",") if o.strip()]
CORS_ALLOW_CREDENTIALS = os.environ.get("HYPERDECK_CORS_CREDENTIALS", "true").lower() == "true"


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.backend.core_daemon import start_background_monitor, stop_background_monitor
    start_background_monitor()
    yield
    await stop_background_monitor()


app = FastAPI(lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_headers=["*"],
    allow_methods=["*"],
)

SCHEDULE_FILE = "app/backend/schedule.json"
ACTIVE_EVENT_FILE = "app/backend/active_event.json"
PLUGINS_DIR = "app/backend/plugins"
CONFIG_FILE = "app/backend/config.json" # Your core hyperdeck/destinations config
UPLOADS_DIR = "app/backend/uploads"
MODEL_CAPABILITY_PROFILES_FILE = "app/backend/model_capability_profiles.json"
DEFAULT_CONFIG = {
    "destinations": [],
    "filename_template": "{year}{month}{day}_{planned_title}",
    "hyperdecks": {},
    "stage_mode": "global",
    "global_stage": "",
    "deck_stages": {},
    "schedule_auto_mode": True,
    "schedule_max_drift_minutes": 45,
    "slate_metadata": {
        "global": {},
        "per_deck": {},
        "per_event": {},
    },
    "settings_groups": {},
}


def _atomic_json_write(file_path: str, data: Any) -> None:
    """Write JSON data atomically using a temp file + rename."""
    dir_name = os.path.dirname(file_path) or "."
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        os.replace(tmp_path, file_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


SLATE_SETTING_KEYS: tuple[str, ...] = (
    "reel",
    "scene id",
    "shot type",
    "take",
    "take scenario",
    "take auto inc",
    "good take",
    "environment",
    "day night",
    "project name",
    "camera",
    "director",
    "camera operator",
)

DECK_SETTING_KEYS: tuple[str, ...] = (
    "file format",
    "video input",
    "audio input",
    "audio codec",
    "default standard",
    "audio input channels",
    "timecode input",
    "timecode output",
    "timecode preset",
    "audio meters",
)


def load_model_capability_profiles() -> dict[str, dict[str, list[str]]]:
    if not os.path.exists(MODEL_CAPABILITY_PROFILES_FILE):
        return {}

    try:
        with open(MODEL_CAPABILITY_PROFILES_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f) or {}
    except Exception:
        logger.exception("Failed to read model capability profile file")
        return {}

    if not isinstance(raw, dict):
        return {}

    profiles: dict[str, dict[str, list[str]]] = {}
    for model_key, values in raw.items():
        if not isinstance(values, dict):
            continue
        normalized_model = str(model_key).strip().lower()
        if not normalized_model:
            continue

        normalized_settings: dict[str, list[str]] = {}
        for setting_key in DECK_SETTING_KEYS:
            candidates = values.get(setting_key, [])
            if not isinstance(candidates, list):
                continue
            normalized_values: list[str] = []
            for value in candidates:
                clean = str(value).strip()
                if clean:
                    normalized_values.append(clean)
            if normalized_values:
                normalized_settings[setting_key] = normalized_values

        if normalized_settings:
            profiles[normalized_model] = normalized_settings

    return profiles


_playback_schedule_tasks: dict[str, asyncio.Task] = {}
_playback_schedule_status: dict[str, dict[str, Any]] = {}

# Ensure the plugins directory exists out of the gate
os.makedirs(PLUGINS_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

# --- Active Metadata Context Logic (Shared via File) ---
def load_active_event():
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, 'r', encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"id": "default", "planned_title": "", "notes": ""}

def save_active_event(data):
    _atomic_json_write(ACTIVE_EVENT_FILE, data)


def is_hyperdeck_success_code(code: Any) -> bool:
    try:
        code_int = int(code)
    except (TypeError, ValueError):
        return False
    return 100 <= code_int < 300


def _split_option_values(raw: str) -> list[str]:
    value = (raw or "").strip()
    if not value:
        return []

    # Remove wrapper punctuation often used in help output.
    value = value.strip("[]()")

    for sep in (",", "|", "/", ";"):
        if sep in value:
            return [part.strip() for part in value.split(sep) if part.strip()]

    # If the string is a space-separated list of token-like values, split by spaces.
    tokens = value.split()
    if 1 < len(tokens) <= 16 and all(re.fullmatch(r"[\w.\-:+]+", t) for t in tokens):
        return tokens

    return [value]


def _append_unique_case_insensitive(values: list[str], candidate: str) -> None:
    clean = str(candidate or "").strip()
    if not clean:
        return
    lower_set = {v.lower() for v in values}
    if clean.lower() not in lower_set:
        values.append(clean)


def _parse_clips_get_response(raw_response: str) -> list[dict[str, str]]:
    clips: list[dict[str, str]] = []
    lines = [line.strip() for line in str(raw_response or "").replace("\r\n", "\n").split("\n") if line.strip()]

    # Variant A: lines like "1: clip001.mp4 ..."
    for line in lines:
        match = re.match(r"^(\d+)\s*:\s*(.+)$", line)
        if not match:
            continue
        clip_id = match.group(1).strip()
        tail = match.group(2).strip()
        name_match = re.search(r"([^\r\n]+\.(?:mov|mp4|mxf))", tail, flags=re.IGNORECASE)
        if name_match:
            name = name_match.group(1).strip()
        else:
            name = tail.split()[0] if tail else f"clip_{clip_id}"
        clips.append({"id": clip_id, "name": name, "label": tail or name})

    if clips:
        return clips

    # Variant B: key/value blocks with clip id and optional name.
    pending_id = ""
    pending_name = ""
    for line in lines:
        id_match = re.match(r"^clip\s+id\s*:\s*(\d+)\s*$", line, flags=re.IGNORECASE)
        if id_match:
            if pending_id:
                clips.append({
                    "id": pending_id,
                    "name": pending_name or f"clip_{pending_id}",
                    "label": pending_name or f"clip {pending_id}",
                })
            pending_id = id_match.group(1).strip()
            pending_name = ""
            continue

        name_match = re.match(r"^name\s*:\s*(.+)$", line, flags=re.IGNORECASE)
        if name_match and pending_id:
            pending_name = name_match.group(1).strip()

    if pending_id:
        clips.append({
            "id": pending_id,
            "name": pending_name or f"clip_{pending_id}",
            "label": pending_name or f"clip {pending_id}",
        })

    return clips


def _collect_options_from_text(raw_text: str, options: dict[str, list[str]], key_hints: set[str] | None = None) -> None:
    """Extract potential option values from free-form HyperDeck responses."""
    if not raw_text:
        return

    lines = [line.strip() for line in raw_text.replace("\r\n", "\n").split("\n") if line.strip()]
    aliases = {
        "file format": ["file format", "record format", "codec"],
        "video input": ["video input"],
        "audio input": ["audio input"],
        "audio codec": ["audio codec"],
        "default standard": ["default standard", "video format", "standard"],
    }

    for key in options.keys():
        if key_hints and key not in key_hints:
            continue
        candidates: list[str] = []
        words = aliases.get(key, [key])
        for line in lines:
            lower = line.lower()
            if not any(word in lower for word in words):
                continue

            # Take text after the first colon if present.
            value_part = line.split(":", 1)[1].strip() if ":" in line else line

            # Gather braced and regular split values.
            for match in re.findall(r"\{([^}]+)\}", value_part):
                for part in _split_option_values(match):
                    _append_unique_case_insensitive(candidates, part)
            for part in _split_option_values(value_part):
                _append_unique_case_insensitive(candidates, part)

        for candidate in candidates:
            _append_unique_case_insensitive(options[key], candidate)


async def discover_deck_setting_options(host: str, settings: dict[str, str]) -> tuple[dict[str, list[str]], str]:
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command

    # Strict device-driven mode: no default fallback lists.
    options: dict[str, list[str]] = {k: [] for k in DECK_SETTING_KEYS}
    discovered: dict[str, list[str]] = {}
    source = "current_only"
    model_name = ""

    try:
        info_response = await send_hyperdeck_command(host, "device info")
        parsed_info = parse_hyperdeck_response(info_response)
        if is_hyperdeck_success_code(parsed_info.get("_code")):
            model_name = str(parsed_info.get("model", "")).strip().lower()
    except Exception:
        model_name = ""

    # Query current configuration (supported on all HyperDeck models) and extract values.
    try:
        cfg_response = await send_hyperdeck_command(host, "configuration")
        _collect_options_from_text(cfg_response, discovered)
        parsed_cfg = parse_hyperdeck_response(cfg_response)
        if is_hyperdeck_success_code(parsed_cfg.get("_code")):
            for key in options.keys():
                current_val = str(parsed_cfg.get(key, "")).strip()
                if current_val:
                    discovered.setdefault(key, [])
                    _append_unique_case_insensitive(discovered[key], current_val)
    except Exception:
        pass

    # Probe specific commands to discover field-specific options from actual device replies.
    for setting_key in options.keys():
        probe_commands = [
            f"configuration: {setting_key}: ?",
            f"configuration: {setting_key}",
            f"configuration: {setting_key}:",
        ]
        for probe_command in probe_commands:
            try:
                response = await send_hyperdeck_command(host, probe_command)
                temp = {setting_key: []}
                _collect_options_from_text(response, temp, {setting_key})
                for value in temp[setting_key]:
                    discovered.setdefault(setting_key, [])
                    _append_unique_case_insensitive(discovered[setting_key], value)
            except Exception:
                continue

    # Slot probes for current/available video format context.
    for slot_cmd in ("slot info", "slot select", "slot select: video format: ?", "slot select: video format:"):
        try:
            response = await send_hyperdeck_command(host, slot_cmd)
            temp = {"default standard": [], "file format": []}
            _collect_options_from_text(response, temp, {"default standard", "file format"})
            for value in temp["default standard"]:
                discovered.setdefault("default standard", [])
                _append_unique_case_insensitive(discovered["default standard"], value)
            for value in temp["file format"]:
                discovered.setdefault("file format", [])
                _append_unique_case_insensitive(discovered["file format"], value)
        except Exception:
            continue

    # Per setting, keep only device-reported options.
    for key in list(options.keys()):
        if key in discovered and discovered[key]:
            options[key] = discovered[key]

    # Prefer model profile lists for known models so UI remains stable and complete.
    used_model_profile = False
    model_profiles = load_model_capability_profiles()
    model_profile = model_profiles.get(model_name, {}) if model_name else {}
    if model_profile:
        for key in options.keys():
            profile_values = model_profile.get(key, [])
            if profile_values:
                options[key] = []
                for candidate in profile_values:
                    _append_unique_case_insensitive(options[key], candidate)
                used_model_profile = True
                continue

            # If the profile has no list for this key, keep device-discovered values.
            if key in discovered and discovered[key]:
                options[key] = discovered[key]

    if discovered:
        if used_model_profile:
            source = "model_profile_preferred"
        elif len(discovered) == len(options):
            source = "device"
        else:
            source = "device_partial"
    elif used_model_profile:
        source = "model_profile"

    # Ensure current values are selectable even when option enumeration is incomplete.
    for key in options.keys():
        current = str(settings.get(key, "")).strip()
        _append_unique_case_insensitive(options[key], current)

    return options, source


def _deck_option_probe_commands() -> list[str]:
    commands: list[str] = [
        "device info",
        "configuration",
        "transport info",
        "slot info",
        "slot select",
        "slot select: video format: ?",
        "slot select: video format:",
        "external drive list",
        "external drive selected",
    ]
    for setting_key in DECK_SETTING_KEYS:
        commands.extend([
            f"configuration: {setting_key}: ?",
            f"configuration: {setting_key}",
            f"configuration: {setting_key}:",
        ])
    commands.extend(["slot select", "slot info"])
    # Keep order but remove duplicates.
    seen: set[str] = set()
    unique_commands: list[str] = []
    for cmd in commands:
        if cmd in seen:
            continue
        seen.add(cmd)
        unique_commands.append(cmd)
    return unique_commands


async def discover_deck_slots(host: str) -> list[str]:
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command

    discovered: list[str] = []
    seen: set[str] = set()

    # Probe explicit slot ids because many models return only the selected slot for plain `slot info`.
    for slot_num in range(1, 7):
        try:
            response = await send_hyperdeck_command(host, f"slot info: slot id: {slot_num}")
            parsed = parse_hyperdeck_response(response)
            if not is_hyperdeck_success_code(parsed.get("_code")):
                continue
            slot_id = str(parsed.get("slot id", "") or "").strip()
            if not slot_id:
                continue
            if slot_id not in seen:
                seen.add(slot_id)
                discovered.append(slot_id)
        except Exception:
            continue

    if discovered:
        return discovered

    try:
        response = await send_hyperdeck_command(host, "slot info")
        parsed = parse_hyperdeck_response(response)
        if not is_hyperdeck_success_code(parsed.get("_code")):
            return ["1"]

        # Common keys seen across firmware variants.
        slot_id = str(parsed.get("slot id", "") or "").strip()
        slot_count_raw = str(parsed.get("slot count", "") or parsed.get("slots", "") or "").strip()

        slot_count = 0
        if slot_count_raw.isdigit():
            slot_count = int(slot_count_raw)

        if slot_count > 0:
            return [str(i) for i in range(1, slot_count + 1)]
        if slot_id:
            return [slot_id]
    except Exception:
        pass

    return ["1"]


async def run_deck_option_probes(host: str) -> list[dict[str, Any]]:
    from app.backend.hyperdeck_control import (
        parse_hyperdeck_response,
        send_hyperdeck_command,
    )

    results: list[dict[str, Any]] = []
    for command in _deck_option_probe_commands():
        try:
            response = await send_hyperdeck_command(host, command)
            parsed = parse_hyperdeck_response(response)
            results.append({
                "command": command,
                "success": is_hyperdeck_success_code(parsed.get("_code")),
                "code": parsed.get("_code", 0),
                "status": parsed.get("_status", ""),
                "response": response,
            })
        except HTTPException as exc:
            results.append({
                "command": command,
                "success": False,
                "code": exc.status_code,
                "status": "HTTPException",
                "response": str(exc.detail),
            })
        except Exception as exc:
            results.append({
                "command": command,
                "success": False,
                "code": 0,
                "status": "Exception",
                "response": str(exc),
            })
    return results

async def is_hyperdeck_online(host: str, port: int = 9993, timeout: float = 0.35) -> bool:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(str(host), port), timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except (asyncio.TimeoutError, OSError):
        return False

@app.get("/api/schedule/active")
async def get_active_metadata_context():
    return load_active_event()

@app.post("/api/schedule/active")
async def set_active_metadata_context(event: dict):
    # If the title is missing or explicitly reset, save the default fallback state
    title = event.get("planned_title", "").strip()
    event_id = event.get("id", "default").strip() or "default"

    context = {
        "id": event_id if title else "default",
        "planned_title": title,
        "notes": event.get("notes", "").strip()
    }
    save_active_event(context)
    return {"status": "success", "active_context": context}


# --- Schedule Database Operations ---
def load_schedule():
    if os.path.exists(SCHEDULE_FILE):
        try:
            with open(SCHEDULE_FILE, 'r', encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_schedule(data):
    _atomic_json_write(SCHEDULE_FILE, data)

def normalize_schedule_item(raw: dict[str, Any], index: int) -> dict[str, Any]:
    start_time = str(raw.get("start_time") or "").strip()
    stage = str(raw.get("stage") or "").strip()
    item_id = str(raw.get("id") or raw.get("start_time") or f"event_{index + 1:03d}").strip()
    title = str(raw.get("planned_title") or raw.get("title") or raw.get("original_name") or item_id).strip()
    if not title:
        title = item_id
    normalized_item: dict[str, Any] = {
        "id": item_id or f"event_{index + 1:03d}",
        "planned_title": title,
    }
    if start_time:
        normalized_item["start_time"] = start_time
    if stage:
        normalized_item["stage"] = stage
    slate_metadata = sanitize_slate_settings(raw.get("slate_metadata", {}))
    if slate_metadata:
        normalized_item["slate_metadata"] = slate_metadata
    return normalized_item

def normalize_schedule_payload(data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for idx, item in enumerate(data):
        if isinstance(item, dict):
            normalized.append(normalize_schedule_item(item, idx))
    return normalized

def read_plugin_manifest(plugin_name: str) -> dict[str, Any]:
    plugin_path = os.path.join(PLUGINS_DIR, f"{plugin_name}.py")
    manifest = {
        "name": plugin_name,
        "label": plugin_name.replace("_", " ").title(),
        "description": "No plugin description provided.",
        "enabled": False,
        "supports_upload": False,
    }

    try:
        with open(plugin_path, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source)
    except Exception as exc:
        manifest["description"] = f"Plugin parse error: {exc}"
        return manifest

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "scrape":
            manifest["enabled"] = True
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in {"PLUGIN_LABEL", "PLUGIN_DESCRIPTION"}:
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        if target.id == "PLUGIN_LABEL":
                            manifest["label"] = node.value.value
                        elif target.id == "PLUGIN_DESCRIPTION":
                            manifest["description"] = node.value.value
                if isinstance(target, ast.Name) and target.id == "PLUGIN_SUPPORTS_FILE_UPLOAD":
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, bool):
                        manifest["supports_upload"] = node.value.value
    return manifest

def load_plugin_module(plugin_name: str):
    if not re.fullmatch(r"[a-zA-Z0-9_]+", plugin_name):
        raise HTTPException(status_code=400, detail="Invalid plugin name.")
    plugin_path = os.path.join(PLUGINS_DIR, f"{plugin_name}.py")
    if not os.path.exists(plugin_path):
        raise HTTPException(status_code=404, detail="Requested sync profile plugin not found.")

    spec = importlib.util.spec_from_file_location(plugin_name, plugin_path)
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=422, detail="Plugin could not be loaded from file path.")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def normalize_config_payload(config: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {**DEFAULT_CONFIG, **(config or {})}

    if not isinstance(merged.get("destinations"), list):
        merged["destinations"] = []
    if not isinstance(merged.get("hyperdecks"), dict):
        merged["hyperdecks"] = {}
    if not isinstance(merged.get("deck_stages"), dict):
        merged["deck_stages"] = {}

    merged["stage_mode"] = "per_deck" if merged.get("stage_mode") == "per_deck" else "global"
    merged["global_stage"] = str(merged.get("global_stage") or "").strip()
    merged["schedule_auto_mode"] = bool(merged.get("schedule_auto_mode", True))
    try:
        merged["schedule_max_drift_minutes"] = max(0, int(merged.get("schedule_max_drift_minutes", 45)))
    except (TypeError, ValueError):
        merged["schedule_max_drift_minutes"] = 45
    merged["filename_template"] = str(merged.get("filename_template") or DEFAULT_CONFIG["filename_template"])

    slate_cfg = merged.get("slate_metadata")
    if not isinstance(slate_cfg, dict):
        slate_cfg = {}

    slate_global = slate_cfg.get("global")
    slate_per_deck = slate_cfg.get("per_deck")
    slate_per_event = slate_cfg.get("per_event")

    merged["slate_metadata"] = {
        "global": slate_global if isinstance(slate_global, dict) else {},
        "per_deck": slate_per_deck if isinstance(slate_per_deck, dict) else {},
        "per_event": slate_per_event if isinstance(slate_per_event, dict) else {},
    }

    raw_groups = merged.get("settings_groups")
    normalized_groups: dict[str, dict[str, Any]] = {}
    if isinstance(raw_groups, dict):
        for raw_name, raw_payload in raw_groups.items():
            name = str(raw_name or "").strip()
            if not name or not isinstance(raw_payload, dict):
                continue
            targets_raw = raw_payload.get("targets")
            if isinstance(targets_raw, list):
                targets = [str(t).strip() for t in targets_raw if str(t).strip()]
            else:
                targets = []
            settings_raw = raw_payload.get("settings")
            settings = settings_raw if isinstance(settings_raw, dict) else {}
            field_keys_raw = raw_payload.get("field_keys")
            field_keys: list[str] = []
            if isinstance(field_keys_raw, list):
                seen: set[str] = set()
                for item in field_keys_raw:
                    key = str(item or "").strip().lower()
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    field_keys.append(key)
            normalized_groups[name] = {
                "targets": targets,
                "settings": settings,
                "field_keys": field_keys,
            }
    merged["settings_groups"] = normalized_groups
    return merged


def sanitize_slate_settings(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, str] = {}
    for key, value in raw.items():
        key_clean = str(key or "").strip().lower()
        if key_clean not in SLATE_SETTING_KEYS:
            continue
        value_clean = str(value or "").strip()
        if value_clean:
            clean[key_clean] = value_clean
    return clean


def resolve_scoped_slate_metadata(config: dict[str, Any], deck_name: str, host: str, event_id: str) -> dict[str, str]:
    slate_cfg = config.get("slate_metadata", {}) if isinstance(config, dict) else {}
    global_scope = sanitize_slate_settings(slate_cfg.get("global", {}))

    per_deck_raw = slate_cfg.get("per_deck", {}) if isinstance(slate_cfg.get("per_deck", {}), dict) else {}
    deck_scope = sanitize_slate_settings(per_deck_raw.get(deck_name, {}))
    if not deck_scope:
        # Optional host-keyed fallback for per-deck scope.
        deck_scope = sanitize_slate_settings(per_deck_raw.get(host, {}))

    per_event_raw = slate_cfg.get("per_event", {}) if isinstance(slate_cfg.get("per_event", {}), dict) else {}
    event_scope = sanitize_slate_settings(per_event_raw.get(event_id, {})) if event_id else {}

    # Precedence: global < per_deck < per_event
    return {**global_scope, **deck_scope, **event_scope}


def resolve_record_event_id_for_deck(config: dict[str, Any], deck_name: str) -> str:
    schedule = load_schedule()
    resolution = build_deck_schedule_resolution(config, deck_name, schedule)
    matched_event = resolution.get("matched_event") if isinstance(resolution, dict) else None
    matched_id = str((matched_event or {}).get("id", "")).strip() if isinstance(matched_event, dict) else ""
    if matched_id:
        return matched_id

    active = load_active_event()
    active_id = str((active or {}).get("id", "")).strip()
    return active_id if active_id and active_id.lower() != "default" else ""


async def apply_scoped_slate_metadata_for_record(deck_name: str, host: str) -> list[dict[str, Any]]:
    from app.backend.hyperdeck_control import (
        build_configuration_command,
        parse_hyperdeck_response,
        send_hyperdeck_command,
    )

    config = await get_config()
    schedule = load_schedule()

    event_id = ""
    event_scope: dict[str, str] = {}

    resolution = build_deck_schedule_resolution(config, deck_name, schedule)
    matched_event = resolution.get("matched_event") if isinstance(resolution, dict) else None
    matched_id = str((matched_event or {}).get("id", "")).strip() if isinstance(matched_event, dict) else ""

    if matched_id:
        event_id = matched_id
    else:
        active = load_active_event()
        active_id = str((active or {}).get("id", "")).strip()
        if active_id and active_id.lower() != "default":
            event_id = active_id

    if event_id:
        source_item = next((item for item in schedule if str(item.get("id", "")).strip() == event_id), None)
        if isinstance(source_item, dict):
            event_scope = sanitize_slate_settings(source_item.get("slate_metadata", {}))

    # Event row metadata in schedule has highest precedence.
    metadata = {
        **resolve_scoped_slate_metadata(config, deck_name, host, event_id),
        **event_scope,
    }
    if not metadata:
        return []

    commands = build_configuration_command(metadata)
    if not commands:
        return []

    results: list[dict[str, Any]] = []
    for cmd in commands:
        try:
            response = await send_hyperdeck_command(host, cmd)
            parsed = parse_hyperdeck_response(response)
            results.append({
                "command": cmd,
                "success": is_hyperdeck_success_code(parsed.get("_code")),
                "response": response,
            })
        except HTTPException as exc:
            results.append({
                "command": cmd,
                "success": False,
                "response": str(exc.detail),
            })
    return results

def parse_start_time(value: str) -> Optional[datetime]:
    raw = (value or "").strip()
    if not raw:
        return None

    # Full date + time formats.
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue

    # Time-only values are interpreted as today in local time.
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            parsed_time = datetime.strptime(raw, fmt).time()
            return datetime.combine(datetime.now().date(), parsed_time)
        except ValueError:
            continue

    return None

def resolve_deck_stage(config: dict[str, Any], deck_name: str) -> str:
    mode = config.get("stage_mode", "global")
    if mode == "per_deck":
        return str(config.get("deck_stages", {}).get(deck_name, "")).strip()
    return str(config.get("global_stage", "")).strip()

def build_deck_schedule_resolution(
    config: dict[str, Any], deck_name: str, schedule: list[dict[str, Any]]
) -> dict[str, Any]:
    now = datetime.now()
    drift_minutes = int(config.get("schedule_max_drift_minutes", 45))
    deck_stage = resolve_deck_stage(config, deck_name)

    stage_filtered: list[tuple[dict[str, Any], datetime]] = []
    for item in schedule:
        when = parse_start_time(str(item.get("start_time", "")))
        if when is None:
            continue

        item_stage = str(item.get("stage", "")).strip()
        if deck_stage:
            if item_stage and item_stage.lower() != deck_stage.lower():
                continue

        stage_filtered.append((item, when))

    if not stage_filtered:
        return {
            "deck_stage": deck_stage,
            "next_event": None,
            "matched_event": None,
            "auto_selected": False,
        }

    next_tuple = min(stage_filtered, key=lambda pair: pair[1])
    future_candidates = [pair for pair in stage_filtered if pair[1] >= now]
    if future_candidates:
        next_tuple = min(future_candidates, key=lambda pair: pair[1])

    nearest_tuple = min(stage_filtered, key=lambda pair: abs((pair[1] - now).total_seconds()))
    nearest_event, nearest_time = nearest_tuple
    nearest_diff = abs((nearest_time - now).total_seconds()) / 60.0
    matched_event = nearest_event if nearest_diff <= drift_minutes else None

    next_event, next_time = next_tuple
    next_diff = int((next_time - now).total_seconds() / 60)
    next_payload = {
        "id": next_event.get("id", ""),
        "planned_title": next_event.get("planned_title", ""),
        "start_time": next_event.get("start_time", ""),
        "stage": next_event.get("stage", ""),
        "minutes_until": next_diff,
    }

    matched_payload = None
    if matched_event is not None:
        matched_payload = {
            "id": matched_event.get("id", ""),
            "planned_title": matched_event.get("planned_title", ""),
            "start_time": matched_event.get("start_time", ""),
            "stage": matched_event.get("stage", ""),
            "minutes_diff": int(round(nearest_diff)),
        }

    return {
        "deck_stage": deck_stage,
        "next_event": next_payload,
        "matched_event": matched_payload,
        "auto_selected": matched_payload is not None,
    }

def maybe_update_active_context_from_auto_mode(config: dict[str, Any], per_deck_resolutions: dict[str, Any]) -> None:
    if not config.get("schedule_auto_mode", True):
        return

    candidates: list[dict[str, Any]] = []
    for resolution in per_deck_resolutions.values():
        matched = resolution.get("matched_event")
        if matched:
            candidates.append(matched)

    if not candidates:
        return

    chosen = min(candidates, key=lambda item: item.get("minutes_diff", 10**9))
    current = load_active_event()
    chosen_id = str(chosen.get("id", "")).strip()
    chosen_title = str(chosen.get("planned_title", "")).strip()
    if not chosen_id or not chosen_title:
        return

    if current.get("id") == chosen_id and current.get("planned_title") == chosen_title:
        return

    save_active_event({
        "id": chosen_id,
        "planned_title": chosen_title,
        "notes": "auto-selected",
    })

@app.get("/api/schedule")
async def get_schedule():
    return load_schedule()

@app.post("/api/schedule")
async def update_schedule(data: list[dict]):
    save_schedule(normalize_schedule_payload(data))
    return {"status": "success"}


# --- Plugin Extensibility System ---
@app.get("/api/plugins")
async def list_plugins():
    """Dynamically scan directory for python execution scripts."""
    if not os.path.exists(PLUGINS_DIR):
        return []

    files = sorted(
        [f[:-3] for f in os.listdir(PLUGINS_DIR) if f.endswith('.py') and not f.startswith('__')],
        key=str.lower,
    )

    plugins: list[dict[str, Any]] = []
    for plugin_name in files:
        plugins.append(read_plugin_manifest(plugin_name))

    return plugins

@app.post("/api/plugins/run/{plugin_name}")
async def run_plugin(plugin_name: str, payload: Optional[dict[str, Any]] = None):
    try:
        module = load_plugin_module(plugin_name)

        if not hasattr(module, 'scrape'):
            raise HTTPException(status_code=422, detail="Plugin is missing standard execution hook rule.")

        scrape_fn = module.scrape
        payload = payload or {}
        scrape_signature = inspect.signature(scrape_fn)
        accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in scrape_signature.parameters.values())
        accepted_payload = payload if accepts_kwargs else {
            key: value for key, value in payload.items() if key in scrape_signature.parameters
        }

        scrape_result = scrape_fn(**accepted_payload) if accepted_payload else scrape_fn()
        scraped_data = await scrape_result if inspect.isawaitable(scrape_result) else scrape_result

        if scraped_data:
            if not isinstance(scraped_data, list):
                raise HTTPException(status_code=422, detail="Plugin scrape() must return a list of event objects.")

            normalized = normalize_schedule_payload(scraped_data)
            save_schedule(normalized)
            return {
                "status": "success",
                "items_synced": len(normalized),
                "plugin": plugin_name,
                "data": normalized,
            }
        else:
            return {"status": "warning", "message": "Plugin executed but returned zero assets."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Runtime error running plugin routine: {str(e)}")

@app.post("/api/plugins/upload/{plugin_name}")
async def upload_plugin_source_file(plugin_name: str, file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file name provided")

    filename = os.path.basename(file.filename)
    target_path = os.path.join(UPLOADS_DIR, filename)
    try:
        with open(target_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not store uploaded file: {exc}")

    return await run_plugin(plugin_name, {"file_path": target_path})


# --- HyperDeck Control & Config Routes (Brought back in) ---
_config_cache: dict[str, Any] | None = None

@app.get("/api/config")
async def get_config():
    global _config_cache
    if _config_cache is not None:
        return dict(_config_cache)
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r', encoding="utf-8") as f:
            _config_cache = normalize_config_payload(json.load(f))
            return dict(_config_cache)
    _config_cache = dict(DEFAULT_CONFIG)
    return dict(_config_cache)

@app.post("/api/config")
async def save_config(config: dict):
    global _config_cache
    existing = await get_config()
    merged = {**existing, **(config or {})}
    normalized = normalize_config_payload(merged)

    warnings = []
    for dest in normalized.get("destinations", []):
        dest_str = str(dest).strip()
        if not dest_str:
            continue
        if not os.path.exists(dest_str):
            warnings.append(f"Path does not exist: {dest_str}")
        elif not os.path.isdir(dest_str):
            warnings.append(f"Path is not a directory: {dest_str}")
        elif not os.access(dest_str, os.W_OK):
            warnings.append(f"Path is not writable: {dest_str}")

    _atomic_json_write(CONFIG_FILE, normalized)
    _config_cache = dict(normalized)

    result = {"status": "success"}
    if warnings:
        result["warnings"] = warnings
    return result

@app.get("/api/audit-log")
async def get_audit_log(limit: int = 50):
    entries = list(_command_audit_log)
    if limit > 0:
        entries = entries[-limit:]
    return {"entries": entries}

@app.get("/api/health")
async def health_check():
    from app.backend.core_daemon import _monitor_task, global_deck_state_cache
    config = await get_config()
    decks = config.get("hyperdecks", {})
    connected = sum(1 for v in global_deck_state_cache.values() if v.get("connected"))
    return {
        "status": "ok",
        "daemon_running": _monitor_task is not None and not _monitor_task.done(),
        "decks_configured": len(decks),
        "decks_connected": connected,
        "last_audit_entry": _command_audit_log[-1] if _command_audit_log else None,
    }

@app.get("/api/disk-space")
async def get_disk_space():
    import shutil
    config = await get_config()
    destinations = config.get("destinations", [])
    results = []
    for dest in destinations:
        dest_str = str(dest).strip()
        if not dest_str or not os.path.isdir(dest_str):
            results.append({"path": dest_str, "exists": False})
            continue
        try:
            usage = shutil.disk_usage(dest_str)
            results.append({
                "path": dest_str,
                "exists": True,
                "total_gb": round(usage.total / (1024**3), 1),
                "used_gb": round(usage.used / (1024**3), 1),
                "free_gb": round(usage.free / (1024**3), 1),
                "percent_used": round((usage.used / usage.total) * 100, 1),
            })
        except Exception:
            results.append({"path": dest_str, "exists": True, "error": "Could not read disk space"})
    return {"destinations": results}

@app.get("/api/events")
async def sse_events():
    import json as _json

    from app.backend.core_daemon import global_deck_state_cache

    async def event_generator():
        last_state = {}
        while True:
            current_state = dict(global_deck_state_cache)
            if current_state != last_state:
                last_state = current_state
                yield f"data: {_json.dumps(current_state)}\n\n"
            await asyncio.sleep(1)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)

@app.get("/api/discover")
async def discover_devices():
    # Import your dynamic network scanner function directly here
    from app.backend.discovery import discover_hyperdecks
    return await discover_hyperdecks()

@app.get("/api/state")
async def get_deck_states():
    # Return live daemon state when available, otherwise expose configured decks as offline placeholders.
    from app.backend.core_daemon import global_deck_state_cache
    config = await get_config()
    schedule = load_schedule()
    hyperdecks = config.get("hyperdecks", {}) if isinstance(config, dict) else {}
    per_deck_resolutions: dict[str, Any] = {}
    for deck_name in hyperdecks.keys():
        per_deck_resolutions[deck_name] = build_deck_schedule_resolution(config, str(deck_name), schedule)

    maybe_update_active_context_from_auto_mode(config, per_deck_resolutions)

    if global_deck_state_cache:
        enriched = {}
        for host, state in global_deck_state_cache.items():
            state_name = str(state.get("name", "")).strip()
            resolution = per_deck_resolutions.get(state_name, {
                "deck_stage": resolve_deck_stage(config, state_name),
                "next_event": None,
                "matched_event": None,
                "auto_selected": False,
            })
            playback_schedule = _playback_schedule_status.get(str(host), {
                "state": "idle",
                "play_at": "",
                "cue_clip_id": "",
                "error": "",
            })
            enriched[str(host)] = {
                **state,
                "stage": resolution.get("deck_stage", ""),
                "next_event": resolution.get("next_event"),
                "matched_event": resolution.get("matched_event"),
                "auto_selected": resolution.get("auto_selected", False),
                "connected": bool(state.get("connected", False)),
                "status": state.get("status", "Configured"),
                "transport_status": state.get("transport_status", state.get("status", "Configured")),
                "transfer_eta_seconds": state.get("transfer_eta_seconds"),
                "playback_schedule": playback_schedule,
            }
        return enriched

    hosts_to_check = [str(host) for host in hyperdecks.values()]
    online_checks = []
    if hosts_to_check:
        online_checks = await asyncio.gather(
            *(is_hyperdeck_online(host) for host in hosts_to_check)
        )
    online_by_host = {host: online for host, online in zip(hosts_to_check, online_checks)}

    fallback_state = {}
    for deck_name, host in hyperdecks.items():
        resolution = per_deck_resolutions.get(str(deck_name), {
            "deck_stage": resolve_deck_stage(config, str(deck_name)),
            "next_event": None,
            "matched_event": None,
            "auto_selected": False,
        })
        host_str = str(host)
        is_online = bool(online_by_host.get(host_str, False))
        fallback_state[str(host)] = {
            "name": str(deck_name),
            "status": "Online" if is_online else "Configured",
            "transport_status": "Online" if is_online else "Configured",
            "connected": is_online,
            "progress": 0,
            "file": "",
            "stage": resolution.get("deck_stage", ""),
            "next_event": resolution.get("next_event"),
            "matched_event": resolution.get("matched_event"),
            "auto_selected": resolution.get("auto_selected", False),
            "transfer_eta_seconds": None,
            "playback_schedule": _playback_schedule_status.get(host_str, {
                "state": "idle",
                "play_at": "",
                "cue_clip_id": "",
                "error": "",
            }),
        }
    return fallback_state


# --- HyperDeck Transport & Configuration Control Routes ---

async def _load_all_deck_hosts() -> dict[str, str]:
    """Return the name→host mapping from the persisted config."""
    config = await get_config()
    hyperdecks = config.get("hyperdecks", {}) if isinstance(config, dict) else {}
    return {str(name).strip(): str(host).strip() for name, host in hyperdecks.items()}


async def _get_deck_port(host: str) -> int:
    """Return the TCP port for a specific host from config, defaulting to 9993."""
    from app.backend.hyperdeck_control import HYPERDECK_PORT, parse_deck_host_port
    config = await get_config()
    hyperdecks = config.get("hyperdecks", {}) if isinstance(config, dict) else {}
    for deck_value in hyperdecks.values():
        parsed_host, parsed_port = parse_deck_host_port(deck_value)
        if parsed_host == host:
            return parsed_port
    return HYPERDECK_PORT


async def _validate_deck_host(host: str) -> None:
    """Raise 404 if *host* is not in the persisted HyperDeck config."""
    decks = await _load_all_deck_hosts()
    if host.strip() not in decks.values():
        raise HTTPException(
            status_code=404,
            detail=f"HyperDeck '{host}' is not in the configured device list.",
        )


async def _send_command_to_deck(deck_id: str, host: str, command: str) -> dict:
    """
    Send *command* to a single HyperDeck and return a result dict (never raises).

    *deck_id* is an arbitrary label used in the result (typically the configured
    deck name, or the host address when no name is available).
    """
    from app.backend.core_daemon import global_deck_state_cache
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command
    try:
        metadata_results: list[dict[str, Any]] = []
        if command == "record":
            metadata_results = await apply_scoped_slate_metadata_for_record(deck_id, host)

        port = await _get_deck_port(host)
        response = await send_hyperdeck_command(host, command, port=port)
        parsed = parse_hyperdeck_response(response)
        success = is_hyperdeck_success_code(parsed.get("_code"))
        if success:
            existing = dict(global_deck_state_cache.get(host, {}))
            next_status = existing.get("status", "Online")
            next_transport = existing.get("transport_status", existing.get("status", "Online"))
            if command == "record":
                next_status = "Recording"
                next_transport = "Recording"
            elif command == "stop":
                next_status = "Stopped"
                next_transport = "Stopped"
            global_deck_state_cache[host] = {
                "name": existing.get("name", deck_id),
                "connected": True,
                "status": next_status,
                "transport_status": next_transport,
                "progress": int(existing.get("progress", 0) or 0),
                "file": existing.get("file", ""),
                "is_transferring": bool(existing.get("is_transferring", False)),
            }
        return {
            "name": deck_id,
            "host": host,
            "success": success,
            "response": response,
            "metadata_results": metadata_results,
        }
    except HTTPException as exc:
        return {
            "name": deck_id,
            "host": host,
            "success": False,
            "response": exc.detail,
            "status_code": exc.status_code,
        }
    except Exception:
        logger.exception("Unexpected error sending HyperDeck command to %s", host)
        return {
            "name": deck_id,
            "host": host,
            "success": False,
            "response": "Unexpected communication error.",
            "status_code": 503,
        }


async def _apply_settings_to_host(host: str, settings: dict[str, Any]) -> dict[str, Any]:
    from app.backend.hyperdeck_control import (
        build_configuration_command,
        parse_hyperdeck_response,
        send_hyperdeck_command,
    )

    commands = build_configuration_command(settings)
    if not commands:
        return {"host": host, "status": "noop", "results": [], "success": False}

    results: list[dict[str, Any]] = []
    for cmd in commands:
        response = await send_hyperdeck_command(host, cmd)
        parsed = parse_hyperdeck_response(response)
        success = is_hyperdeck_success_code(parsed.get("_code"))
        results.append({"command": cmd, "success": success, "response": response})

    overall = all(r.get("success") for r in results)
    return {"host": host, "status": "ok" if overall else "partial", "results": results, "success": overall}


async def _run_scheduled_playback(host: str, play_at_iso: str, cue_clip_id: str = "") -> None:
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command

    status = _playback_schedule_status.setdefault(host, {})
    status.update({
        "host": host,
        "play_at": play_at_iso,
        "cue_clip_id": cue_clip_id,
        "state": "scheduled",
        "last_response": "",
        "error": "",
    })

    try:
        run_at = datetime.fromisoformat(play_at_iso)
    except ValueError:
        status.update({"state": "failed", "error": "Invalid ISO datetime for play_at."})
        return

    delay = (run_at - datetime.now()).total_seconds()
    if delay > 0:
        await asyncio.sleep(delay)

    if cue_clip_id:
        cue_resp = await send_hyperdeck_command(host, f"goto: clip id: {cue_clip_id}")
        cue_parsed = parse_hyperdeck_response(cue_resp)
        if not is_hyperdeck_success_code(cue_parsed.get("_code")):
            status.update({"state": "failed", "last_response": cue_resp, "error": "Cue command rejected by deck."})
            return

    play_resp = await send_hyperdeck_command(host, "play")
    play_parsed = parse_hyperdeck_response(play_resp)
    if not is_hyperdeck_success_code(play_parsed.get("_code")):
        status.update({"state": "failed", "last_response": play_resp, "error": "Play command rejected by deck."})
        return

    status.update({"state": "completed", "last_response": play_resp, "error": ""})


# NOTE: Routes with literal path segments ("all") must be registered BEFORE
# parameterised routes ({host}) so FastAPI does not absorb "all" as a host value.

@app.post("/api/control/all/record")
async def all_decks_record():
    """Send a *record* command to every configured HyperDeck concurrently."""
    decks = await _load_all_deck_hosts()
    if not decks:
        raise HTTPException(status_code=400, detail="No HyperDecks configured.")
    results = await asyncio.gather(*(_send_command_to_deck(n, h, "record") for n, h in decks.items()))
    return {"status": "ok", "results": list(results)}


@app.post("/api/control/all/stop")
async def all_decks_stop():
    """Send a *stop* command to every configured HyperDeck concurrently."""
    decks = await _load_all_deck_hosts()
    if not decks:
        raise HTTPException(status_code=400, detail="No HyperDecks configured.")
    results = await asyncio.gather(*(_send_command_to_deck(n, h, "stop") for n, h in decks.items()))
    return {"status": "ok", "results": list(results)}


@app.post("/api/control/{host}/record")
async def deck_record(host: str):
    """Send a *record* command to a single HyperDeck."""
    await _validate_deck_host(host)
    decks = await _load_all_deck_hosts()
    deck_name = next((name for name, value in decks.items() if value == host), host)
    result = await _send_command_to_deck(deck_name, host, "record")
    log_command("record", host, deck_name, result["success"], result.get("response", ""))
    if not result["success"]:
        status_code = result.get("status_code", 502)
        detail = result["response"] if status_code != 502 else f"HyperDeck rejected command: {result['response']}"
        raise HTTPException(status_code=status_code, detail=detail)
    return {"status": "ok", "host": host, "response": result["response"]}


@app.post("/api/control/{host}/stop")
async def deck_stop(host: str):
    """Send a *stop* command to a single HyperDeck."""
    await _validate_deck_host(host)
    decks = await _load_all_deck_hosts()
    deck_name = next((name for name, value in decks.items() if value == host), host)
    result = await _send_command_to_deck(deck_name, host, "stop")
    log_command("stop", host, deck_name, result["success"], result.get("response", ""))
    if not result["success"]:
        status_code = result.get("status_code", 502)
        detail = result["response"] if status_code != 502 else f"HyperDeck rejected command: {result['response']}"
        raise HTTPException(status_code=status_code, detail=detail)
    return {"status": "ok", "host": host, "response": result["response"]}


@app.get("/api/control/{host}/recordings")
async def list_deck_recordings(host: str, slot_id: str = "1"):
    """List available recording files on a deck slot via FTP for manual browsing/transfer."""
    await _validate_deck_host(host)
    from app.backend.core_daemon import list_recordings_from_deck

    recordings = await list_recordings_from_deck(host, str(slot_id or "1"))
    return {
        "host": host,
        "slot_id": str(slot_id or "1"),
        "recordings": recordings,
    }


@app.get("/api/control/{host}/clips")
async def list_deck_clips(host: str, slot_id: str = "1"):
    """List deck clip IDs for cue/play/schedule workflows."""
    await _validate_deck_host(host)
    from app.backend.core_daemon import list_recordings_from_deck
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command

    target_slot = str(slot_id or "1").strip() or "1"
    clips: list[dict[str, str]] = []
    source = "hyperdeck"

    # Best effort: select slot first on models that support explicit slot select.
    try:
        await send_hyperdeck_command(host, f"slot select: slot id: {target_slot}")
    except Exception:
        pass

    try:
        response = await send_hyperdeck_command(host, "clips get")
        parsed = parse_hyperdeck_response(response)
        if is_hyperdeck_success_code(parsed.get("_code")):
            clips = _parse_clips_get_response(response)
    except Exception:
        clips = []

    if not clips:
        source = "ftp_fallback"
        recordings = await list_recordings_from_deck(host, target_slot)
        clips = [
            {
                "id": str(idx + 1),
                "name": str(item.get("name") or f"clip_{idx + 1}"),
                "label": str(item.get("name") or f"clip_{idx + 1}"),
            }
            for idx, item in enumerate(recordings)
        ]

    return {"host": host, "slot_id": target_slot, "source": source, "clips": clips}


@app.get("/api/control/{host}/slots")
async def list_deck_slots(host: str):
    """Return available slot IDs for a deck, if the device reports them."""
    await _validate_deck_host(host)
    slots = await discover_deck_slots(host)
    return {
        "host": host,
        "slots": slots,
    }


@app.post("/api/control/{host}/transfer-recording")
async def transfer_deck_recording(host: str, payload: dict[str, Any]):
    """Manually transfer a selected recording from HyperDeck FTP storage to configured destinations."""
    await _validate_deck_host(host)

    slot_id = str(payload.get("slot_id") or "1").strip() or "1"
    remote_filename = str(payload.get("remote_filename") or "").strip()
    local_filename_raw = str(payload.get("local_filename") or "").strip()
    local_filename = local_filename_raw or remote_filename

    if not remote_filename:
        raise HTTPException(status_code=400, detail="remote_filename is required.")

    # Prevent path traversal and nested path injection.
    if any(part in remote_filename for part in ("/", "\\", "..")):
        raise HTTPException(status_code=400, detail="remote_filename must be a plain filename.")
    if any(part in local_filename for part in ("/", "\\", "..")):
        raise HTTPException(status_code=400, detail="local_filename must be a plain filename.")

    config = await get_config()
    destinations = [str(p).strip() for p in (config.get("destinations") or []) if str(p).strip()]
    if not destinations:
        raise HTTPException(status_code=400, detail="No destination folders configured.")

    decks = await _load_all_deck_hosts()
    deck_name = next((name for name, value in decks.items() if value == host), host)

    from app.backend.core_daemon import (
        _dedupe_filename_for_destinations,
        global_deck_state_cache,
        transfer_recording_from_deck,
    )

    if not local_filename_raw:
        local_filename = _dedupe_filename_for_destinations(destinations, local_filename)

    def _progress_callback(pct: int) -> None:
        state = dict(global_deck_state_cache.get(host, {}))
        state["name"] = state.get("name", deck_name)
        state["connected"] = True
        state["status"] = f"Transferring ({pct}%)"
        state["transport_status"] = state.get("transport_status", "Stopped")
        state["progress"] = max(0, min(100, int(pct or 0)))
        state["file"] = local_filename
        state["is_transferring"] = True
        global_deck_state_cache[host] = state

    success = await transfer_recording_from_deck(
        host=host,
        slot_id=slot_id,
        remote_filename=remote_filename,
        local_filename=local_filename,
        destinations=destinations,
        progress_callback=_progress_callback,
    )

    if success:
        state = dict(global_deck_state_cache.get(host, {}))
        state["name"] = state.get("name", deck_name)
        state["connected"] = True
        state["status"] = "Transfer Complete"
        state["progress"] = 100
        state["file"] = local_filename
        state["is_transferring"] = False
        global_deck_state_cache[host] = state
        return {
            "status": "ok",
            "host": host,
            "slot_id": slot_id,
            "remote_filename": remote_filename,
            "local_filename": local_filename,
        }

    state = dict(global_deck_state_cache.get(host, {}))
    state["name"] = state.get("name", deck_name)
    state["connected"] = bool(state.get("connected", True))
    state["status"] = "Transfer Failed"
    state["is_transferring"] = False
    global_deck_state_cache[host] = state
    raise HTTPException(status_code=502, detail="Failed to transfer recording from deck FTP storage.")


@app.post("/api/control/{host}/transfer-preview")
async def preview_deck_recording_transfer(host: str, payload: dict[str, Any]):
    """Preview the final local filename with dedupe logic before transfer starts."""
    await _validate_deck_host(host)

    remote_filename = str(payload.get("remote_filename") or "").strip()
    local_filename_raw = str(payload.get("local_filename") or "").strip()
    if not remote_filename:
        raise HTTPException(status_code=400, detail="remote_filename is required.")
    if any(part in remote_filename for part in ("/", "\\", "..")):
        raise HTTPException(status_code=400, detail="remote_filename must be a plain filename.")

    config = await get_config()
    destinations = [str(p).strip() for p in (config.get("destinations") or []) if str(p).strip()]
    if not destinations:
        raise HTTPException(status_code=400, detail="No destination folders configured.")

    from app.backend.core_daemon import _dedupe_filename_for_destinations

    requested = local_filename_raw or remote_filename
    resolved = _dedupe_filename_for_destinations(destinations, requested)

    return {
        "host": host,
        "requested_local_filename": requested,
        "resolved_local_filename": resolved,
        "will_dedupe": requested != resolved,
    }


@app.post("/api/control/{host}/upload-playback")
async def upload_deck_playback_file(host: str, slot_id: str = "1", file: UploadFile = File(...)):
    """Upload a media file to the deck's FTP slot for playback use."""
    await _validate_deck_host(host)

    filename = os.path.basename(str(file.filename or "").strip())
    if not filename:
        raise HTTPException(status_code=400, detail="Uploaded file must have a filename.")
    if any(part in filename for part in ("/", "\\", "..")):
        raise HTTPException(status_code=400, detail="Invalid filename.")

    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=os.path.splitext(filename)[1])
        os.close(fd)
        total_size = 0
        with open(tmp_path, "wb") as tmp_file:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp_file.write(chunk)
                total_size += len(chunk)
        if total_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        from app.backend.core_daemon import upload_playback_file_to_deck

        uploaded = await upload_playback_file_to_deck(host, slot_id, filename, tmp_path)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"FTP upload failed: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    return {
        "status": "ok",
        "host": host,
        "slot_id": str(slot_id),
        "filename": uploaded.get("filename", filename),
        "size": int(uploaded.get("size", total_size) or total_size),
    }


@app.post("/api/control/{host}/cue")
async def cue_deck_playback(host: str, payload: dict[str, Any]):
    """Cue a recording clip by clip-id (position in clip list) for playback."""
    await _validate_deck_host(host)
    clip_id = str(payload.get("clip_id") or "").strip()
    if not clip_id or not clip_id.isdigit():
        raise HTTPException(status_code=400, detail="clip_id must be a numeric string.")

    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command
    response = await send_hyperdeck_command(host, f"goto: clip id: {clip_id}")
    parsed = parse_hyperdeck_response(response)
    if not is_hyperdeck_success_code(parsed.get("_code")):
        raise HTTPException(status_code=502, detail=f"Deck rejected cue command: {response}")

    return {"status": "ok", "host": host, "clip_id": clip_id, "response": response}


@app.post("/api/control/{host}/play")
async def play_deck_now(host: str, payload: dict[str, Any] | None = None):
    """Start playback on a deck."""
    await _validate_deck_host(host)
    decks = await _load_all_deck_hosts()
    deck_name = next((name for name, value in decks.items() if value == host), host)
    clip_id = str((payload or {}).get("clip_id") or "").strip()

    if clip_id:
        if not clip_id.isdigit():
            raise HTTPException(status_code=400, detail="clip_id must be numeric when provided.")
        from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command
        cue_response = await send_hyperdeck_command(host, f"goto: clip id: {clip_id}")
        cue_parsed = parse_hyperdeck_response(cue_response)
        if not is_hyperdeck_success_code(cue_parsed.get("_code")):
            raise HTTPException(status_code=502, detail=f"Deck rejected cue command: {cue_response}")

    result = await _send_command_to_deck(deck_name, host, "play")
    log_command("play", host, deck_name, result.get("success", False), result.get("response", ""))
    if not result.get("success"):
        status_code = result.get("status_code", 502)
        resp_detail = result.get("response")
        if status_code == 502:
            resp_detail = f"Deck rejected play command: {resp_detail}"
        raise HTTPException(status_code=status_code, detail=resp_detail)
    return {"status": "ok", "host": host, "clip_id": clip_id, "response": result.get("response", "")}


@app.post("/api/control/{host}/play-schedule")
async def schedule_deck_playback(host: str, payload: dict[str, Any]):
    """Schedule playback at a future ISO datetime, optionally with a cue clip-id."""
    await _validate_deck_host(host)

    play_at = str(payload.get("play_at") or "").strip()
    cue_clip_id = str(payload.get("clip_id") or "").strip()
    if not play_at:
        raise HTTPException(status_code=400, detail="play_at ISO datetime is required.")
    if cue_clip_id and (not cue_clip_id.isdigit()):
        raise HTTPException(status_code=400, detail="clip_id must be numeric when provided.")

    old_task = _playback_schedule_tasks.get(host)
    if old_task and not old_task.done():
        old_task.cancel()

    task = asyncio.create_task(_run_scheduled_playback(host, play_at, cue_clip_id))
    _playback_schedule_tasks[host] = task

    _playback_schedule_status[host] = {
        "host": host,
        "play_at": play_at,
        "cue_clip_id": cue_clip_id,
        "state": "scheduled",
        "last_response": "",
        "error": "",
    }

    return {
        "status": "ok",
        "host": host,
        "play_at": play_at,
        "cue_clip_id": cue_clip_id,
        "state": "scheduled",
    }


@app.delete("/api/control/{host}/play-schedule")
async def cancel_deck_playback_schedule(host: str):
    await _validate_deck_host(host)
    task = _playback_schedule_tasks.get(host)
    if task and not task.done():
        task.cancel()
    _playback_schedule_status[host] = {
        "host": host,
        "play_at": "",
        "cue_clip_id": "",
        "state": "cancelled",
        "last_response": "",
        "error": "",
    }
    return {"status": "ok", "host": host, "state": "cancelled"}


@app.get("/api/control/{host}/play-schedule")
async def get_deck_playback_schedule(host: str):
    await _validate_deck_host(host)
    status = _playback_schedule_status.get(host, {
        "host": host,
        "play_at": "",
        "cue_clip_id": "",
        "state": "idle",
        "last_response": "",
        "error": "",
    })
    return status


@app.post("/api/control/{host}/format-card")
async def format_deck_card(host: str, payload: dict[str, Any]):
    """Format a card in the selected slot (destructive). Requires explicit confirmation text."""
    await _validate_deck_host(host)

    confirm_text = str(payload.get("confirm_text") or "").strip()
    if confirm_text != "FORMAT":
        raise HTTPException(status_code=400, detail="Formatting requires confirm_text='FORMAT'.")

    slot_id = str(payload.get("slot_id") or "1").strip() or "1"
    filesystem_raw = str(payload.get("filesystem") or "exFAT").strip().lower()
    filesystem = "exFAT" if filesystem_raw in {"exfat", "ex-fat", "ex_fat"} else "HFS+"
    volume_name = str(payload.get("volume_name") or "").strip()

    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_prepare_confirm

    def _is_2xx(parsed: dict[str, Any]) -> bool:
        try:
            code = int(parsed.get("_code", 0))
        except (TypeError, ValueError):
            return False
        return 200 <= code < 300

    # Step 1: prepare command (slot form as primary, device form as fallback).
    prepare_cmd_slot = f"format: slot id: {slot_id} prepare: {filesystem}"
    if volume_name:
        prepare_cmd_slot = f"{prepare_cmd_slot} name: {volume_name}"

    prepare_cmd_device = f"format: device: {slot_id} prepare: {filesystem}"
    if volume_name:
        prepare_cmd_device = f"{prepare_cmd_device} name: {volume_name}"

    prepare_attempts: list[dict[str, str]] = []
    confirm_attempts: list[dict[str, str]] = []
    prepare_used = ""
    confirm_used = ""
    confirm_response = ""
    token = ""

    confirm_templates = [
        "format: confirm: {token}",
        f"format: slot id: {slot_id} confirm: {{token}}",
        f"format: device: {slot_id} confirm: {{token}}",
    ]

    for prepare_cmd in (prepare_cmd_slot, prepare_cmd_device):
        for confirm_template in confirm_templates:
            try:
                result = await send_hyperdeck_prepare_confirm(host, prepare_cmd, confirm_template)
                prepare_attempts.append({
                    "command": result.get("prepare_command", prepare_cmd),
                    "response": str(result.get("prepare_response", "")),
                })

                if result.get("error") == "no_token":
                    continue

                confirm_cmd = str(result.get("confirm_command", ""))
                response = str(result.get("confirm_response", ""))
                parsed = parse_hyperdeck_response(response)
                confirm_attempts.append({"command": confirm_cmd, "response": response})
                if _is_2xx(parsed):
                    prepare_used = prepare_cmd
                    confirm_used = confirm_cmd
                    confirm_response = response
                    token = str(result.get("token", ""))
                    break
            except HTTPException as exc:
                confirm_attempts.append({
                    "command": f"{prepare_cmd} -> {confirm_template}",
                    "response": str(exc.detail),
                })
        if confirm_used:
            break

    if not confirm_used:
        detail_payload: dict[str, Any] = {
            "message": "Deck rejected format confirm command.",
            "prepare_attempts": prepare_attempts,
            "confirm_attempts": confirm_attempts,
        }
        if token:
            detail_payload["token"] = token
        raise HTTPException(status_code=502, detail=detail_payload)

    return {
        "status": "ok",
        "host": host,
        "slot_id": slot_id,
        "filesystem": filesystem,
        "volume_name": volume_name,
        "prepare_command": prepare_used,
        "confirm_command": confirm_used,
        "response": confirm_response,
    }


@app.get("/api/control/{host}/configuration")
async def get_deck_configuration(host: str, debug: bool = False):
    """Retrieve the current configuration from a single HyperDeck."""
    await _validate_deck_host(host)
    from app.backend.hyperdeck_control import parse_hyperdeck_response, send_hyperdeck_command
    response = await send_hyperdeck_command(host, "configuration")
    parsed = parse_hyperdeck_response(response)
    if not is_hyperdeck_success_code(parsed.get("_code")):
        raise HTTPException(status_code=502, detail=f"HyperDeck error: {response}")

    # Strip internal meta-keys before returning.
    settings = {k: v for k, v in parsed.items() if not k.startswith("_")}

    # Best-effort enrich with slate metadata sections when supported by the device.
    for extra_command in ("slate clips", "slate project"):
        try:
            extra_response = await send_hyperdeck_command(host, extra_command)
            extra_parsed = parse_hyperdeck_response(extra_response)
            if is_hyperdeck_success_code(extra_parsed.get("_code")):
                for key, value in extra_parsed.items():
                    if key.startswith("_"):
                        continue
                    settings[key] = value
        except Exception:
            # Older models/firmware may not implement slate commands.
            continue

    options, options_source = await discover_deck_setting_options(host, settings)
    payload: dict[str, Any] = {
        "host": host,
        "settings": settings,
        "options": options,
        "options_source": options_source,
    }
    if debug:
        payload["probes"] = await run_deck_option_probes(host)
    return payload


@app.post("/api/control/{host}/configuration")
async def set_deck_configuration(host: str, settings: dict):
    """
    Apply one or more configuration settings to a single HyperDeck.
    Each key-value pair in *settings* becomes a separate configuration command.
    Returns per-command success/failure information.
    """
    await _validate_deck_host(host)
    from app.backend.hyperdeck_control import (
        build_configuration_command,
        parse_hyperdeck_response,
        send_hyperdeck_command,
    )
    commands = build_configuration_command(settings)
    if not commands:
        raise HTTPException(status_code=400, detail="No valid configuration keys provided.")

    results = []
    for cmd in commands:
        response = await send_hyperdeck_command(host, cmd)
        parsed = parse_hyperdeck_response(response)
        success = is_hyperdeck_success_code(parsed.get("_code"))
        results.append({"command": cmd, "success": success, "response": response})

    overall = all(r["success"] for r in results)
    return {"host": host, "status": "ok" if overall else "partial", "results": results}


@app.post("/api/control/apply-settings")
async def apply_settings_to_multiple_decks(payload: dict[str, Any]):
    """Apply a settings payload to multiple configured deck hosts."""
    targets_raw = payload.get("targets")
    settings = payload.get("settings")

    if not isinstance(targets_raw, list) or not targets_raw:
        raise HTTPException(status_code=400, detail="targets must be a non-empty array of configured hosts.")
    if not isinstance(settings, dict) or not settings:
        raise HTTPException(status_code=400, detail="settings must be a non-empty object.")

    configured = await _load_all_deck_hosts()
    configured_hosts = {str(h).strip() for h in configured.values()}
    targets = [str(t).strip() for t in targets_raw if str(t).strip()]
    invalid = [t for t in targets if t not in configured_hosts]
    if invalid:
        raise HTTPException(status_code=404, detail=f"Unknown or unconfigured hosts: {', '.join(invalid)}")

    tasks = [_apply_settings_to_host(host, settings) for host in targets]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    normalized_results: list[dict[str, Any]] = []
    for host, result in zip(targets, results):
        if isinstance(result, Exception):
            normalized_results.append({
                "host": host, "status": "error", "success": False,
                "results": [], "error": str(result),
            })
        elif isinstance(result, dict):
            normalized_results.append(result)
        else:
            normalized_results.append({
                "host": host, "status": "error", "success": False,
                "results": [], "error": "Unexpected apply-settings result type.",
            })

    return {
        "status": "ok",
        "targets": targets,
        "success_count": sum(1 for r in normalized_results if r.get("success")),
        "results": normalized_results,
    }


@app.get("/api/control/settings-groups")
async def get_settings_groups():
    config = await get_config()
    groups = (config.get("settings_groups") or {}) if isinstance(config, dict) else {}
    return {"groups": groups}


@app.post("/api/control/settings-groups")
async def save_settings_group(payload: dict[str, Any]):
    name = str(payload.get("name") or "").strip()
    targets_raw = payload.get("targets")
    settings = payload.get("settings")
    field_keys_raw = payload.get("field_keys")

    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    if not isinstance(targets_raw, list) or not targets_raw:
        raise HTTPException(status_code=400, detail="targets must be a non-empty array.")
    if not isinstance(settings, dict) or not settings:
        raise HTTPException(status_code=400, detail="settings must be a non-empty object.")

    targets = [str(t).strip() for t in targets_raw if str(t).strip()]
    if not targets:
        raise HTTPException(status_code=400, detail="targets must contain at least one host.")

    field_keys: list[str] = []
    if isinstance(field_keys_raw, list):
        seen: set[str] = set()
        for item in field_keys_raw:
            key = str(item or "").strip().lower()
            if not key or key in seen:
                continue
            if key not in settings:
                continue
            seen.add(key)
            field_keys.append(key)
    else:
        field_keys = sorted(str(k).strip().lower() for k in settings.keys() if str(k).strip())

    if not field_keys:
        raise HTTPException(status_code=400, detail="field_keys must contain at least one selected setting key.")

    config = await get_config()
    groups = dict((config.get("settings_groups") or {}))
    groups[name] = {"targets": targets, "settings": settings, "field_keys": field_keys}

    config["settings_groups"] = groups
    _atomic_json_write(CONFIG_FILE, normalize_config_payload(config))

    return {"status": "ok", "name": name, "group": groups[name]}


@app.delete("/api/control/settings-groups/{group_name}")
async def delete_settings_group(group_name: str):
    name = str(group_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="group_name is required.")

    config = await get_config()
    groups = dict((config.get("settings_groups") or {}))
    if name not in groups:
        raise HTTPException(status_code=404, detail="Settings group not found.")

    groups.pop(name, None)
    config["settings_groups"] = groups
    _atomic_json_write(CONFIG_FILE, normalize_config_payload(config))

    return {"status": "ok", "deleted": name}


@app.post("/api/control/settings-groups/{group_name}/apply")
async def apply_settings_group(group_name: str):
    name = str(group_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="group_name is required.")

    config = await get_config()
    groups = (config.get("settings_groups") or {}) if isinstance(config, dict) else {}
    group = groups.get(name)
    if not isinstance(group, dict):
        raise HTTPException(status_code=404, detail="Settings group not found.")

    settings = group.get("settings") or {}
    field_keys = group.get("field_keys") or []
    if isinstance(field_keys, list) and field_keys:
        allowed = {str(x).strip().lower() for x in field_keys}
        scoped_settings = {
            str(k): v for k, v in settings.items()
            if str(k).strip().lower() in allowed
        }
    else:
        scoped_settings = settings

    payload = {
        "targets": group.get("targets") or [],
        "settings": scoped_settings,
    }
    result = await apply_settings_to_multiple_decks(payload)
    result["group_name"] = name
    return result


def _get_allowed_roots() -> list[str]:
    """Return a list of allowed root directories (home + mounted external disks)."""
    roots = [os.path.expanduser("~")]
    if platform.system() == "Darwin":
        volumes_path = "/Volumes"
        if os.path.isdir(volumes_path):
            for entry in os.listdir(volumes_path):
                full = os.path.join(volumes_path, entry)
                if os.path.isdir(full):
                    roots.append(full)
    else:
        # Ubuntu/Debian: /media/<user>/* , Fedora/RHEL/Arch: /run/media/<user>/*
        for base in ("/media", "/mnt", "/run/media"):
            if not os.path.isdir(base):
                continue
            for entry in os.listdir(base):
                full = os.path.join(base, entry)
                if not os.path.isdir(full):
                    continue
                roots.append(full)
                # One level deeper: /media/<user>/<disk>, /run/media/<user>/<disk>
                try:
                    for sub in os.listdir(full):
                        sub_full = os.path.join(full, sub)
                        if os.path.isdir(sub_full):
                            roots.append(sub_full)
                except OSError:
                    pass
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.loads(f.read())
        for dest in config.get("destinations", []):
            dest = os.path.abspath(dest)
            if os.path.isdir(dest) and dest not in roots:
                roots.append(dest)
    except Exception:
        pass
    return roots


@app.get("/api/browse/roots")
async def get_browse_roots():
    return {"roots": _get_allowed_roots()}

@app.get("/api/browse")
async def browse_host_folders(path: str = ""):
    target_path = os.path.abspath(os.path.expanduser(path)) if path else os.path.expanduser("~")

    allowed_roots = _get_allowed_roots()
    if not any(target_path == root or target_path.startswith(root + os.sep) for root in allowed_roots):
        raise HTTPException(status_code=403, detail="Access denied: path is outside allowed directories.")

    if not os.path.isdir(target_path):
        raise HTTPException(status_code=400, detail="Path is not a readable directory")

    try:
        directories = [
            entry
            for entry in os.listdir(target_path)
            if os.path.isdir(os.path.join(target_path, entry))
        ]
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to browse directory: {exc}")

    directories.sort(key=str.lower)
    parent_path = os.path.dirname(target_path) or target_path
    return {
        "current_path": target_path,
        "parent_path": parent_path,
        "directories": directories,
    }

# --- Frontend Static Asset Delivery ---
# (Make sure this is placed AFTER all your @app.get("/api/...") routes)

FRONTEND_DIR = "app/frontend"

if os.path.exists(FRONTEND_DIR):
    # 1. Serve the landing page directly at http://localhost:8008/
    @app.get("/")
    async def serve_frontend_root():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    # 2. Mount the rest of the folder so index.html can load app.js and styles
    app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
else:
    print(f"⚠️ Warning: Frontend directory not found at '{FRONTEND_DIR}'. API endpoints will still function.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
