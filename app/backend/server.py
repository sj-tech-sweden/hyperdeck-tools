# app/backend/server.py
import os
import json
import importlib.util
import inspect
import ast
import asyncio
from datetime import datetime
from typing import Any, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI()

# Enable CORS so your frontend can chat with the backend smoothly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_headers=["*"],
    allow_methods=["*"],
)

SCHEDULE_FILE = "app/backend/schedule.json"
ACTIVE_EVENT_FILE = "app/backend/active_event.json"
PLUGINS_DIR = "app/backend/plugins"
CONFIG_FILE = "app/backend/config.json" # Your core hyperdeck/destinations config
UPLOADS_DIR = "app/backend/uploads"
DEFAULT_CONFIG = {
    "destinations": [],
    "filename_template": "{year}{month}{day}_{planned_title}",
    "hyperdecks": {},
    "stage_mode": "global",
    "global_stage": "",
    "deck_stages": {},
    "schedule_auto_mode": True,
    "schedule_max_drift_minutes": 45,
}

# Ensure the plugins directory exists out of the gate
os.makedirs(PLUGINS_DIR, exist_ok=True)
os.makedirs(UPLOADS_DIR, exist_ok=True)

# --- Active Metadata Context Logic (Shared via File) ---
def load_active_event():
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return {"id": "default", "planned_title": "", "notes": ""}

def save_active_event(data):
    with open(ACTIVE_EVENT_FILE, 'w') as f:
        json.dump(data, f, indent=4)

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
            with open(SCHEDULE_FILE, 'r') as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_schedule(data):
    with open(SCHEDULE_FILE, 'w') as f:
        json.dump(data, f, indent=4)

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
    return merged

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

def build_deck_schedule_resolution(config: dict[str, Any], deck_name: str, schedule: list[dict[str, Any]]) -> dict[str, Any]:
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
        content = await file.read()
        with open(target_path, "wb") as f:
            f.write(content)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not store uploaded file: {exc}")

    return await run_plugin(plugin_name, {"file_path": target_path})


# --- HyperDeck Control & Config Routes (Brought back in) ---
@app.get("/api/config")
async def get_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            return normalize_config_payload(json.load(f))
    return dict(DEFAULT_CONFIG)

@app.post("/api/config")
async def save_config(config: dict):
    normalized = normalize_config_payload(config)
    with open(CONFIG_FILE, 'w') as f:
        json.dump(normalized, f, indent=4)
    # Pro Tip: Trigger your background daemon to reload its configuration here if needed!
    return {"status": "success"}

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
            enriched[str(host)] = {
                **state,
                "stage": resolution.get("deck_stage", ""),
                "next_event": resolution.get("next_event"),
                "matched_event": resolution.get("matched_event"),
                "auto_selected": resolution.get("auto_selected", False),
                "connected": bool(state.get("connected", False)),
                "status": state.get("status", "Configured"),
            }
        return enriched

    hosts_to_check = [str(host) for host in hyperdecks.values()]
    online_checks = await asyncio.gather(*(is_hyperdeck_online(host) for host in hosts_to_check)) if hosts_to_check else []
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
            "connected": is_online,
            "progress": 0,
            "file": "",
            "stage": resolution.get("deck_stage", ""),
            "next_event": resolution.get("next_event"),
            "matched_event": resolution.get("matched_event"),
            "auto_selected": resolution.get("auto_selected", False),
        }
    return fallback_state


# --- HyperDeck Transport & Configuration Control Routes ---

async def _load_all_deck_hosts() -> dict[str, str]:
    """Return the name→host mapping from the persisted config."""
    config = await get_config()
    hyperdecks = config.get("hyperdecks", {}) if isinstance(config, dict) else {}
    return {str(name): str(host) for name, host in hyperdecks.items()}


async def _send_command_to_deck(deck_id: str, host: str, command: str) -> dict:
    """
    Send *command* to a single HyperDeck and return a result dict (never raises).

    *deck_id* is an arbitrary label used in the result (typically the configured
    deck name, or the host address when no name is available).
    """
    from app.backend.hyperdeck_control import send_hyperdeck_command, parse_hyperdeck_response
    try:
        response = await send_hyperdeck_command(host, command)
        parsed = parse_hyperdeck_response(response)
        success = parsed.get("_code") in (200, 100)
        return {"name": deck_id, "host": host, "success": success, "response": response}
    except HTTPException as exc:
        return {"name": deck_id, "host": host, "success": False, "response": exc.detail}
    except Exception as exc:
        return {
            "name": deck_id,
            "host": host,
            "success": False,
            "response": f"Unexpected communication error: {exc}",
        }


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
    # Use the configured deck name as the result label when available.
    decks = await _load_all_deck_hosts()
    deck_id = next((name for name, h in decks.items() if h == host), host)
    result = await _send_command_to_deck(deck_id, host, "record")
    if not result["success"]:
        raise HTTPException(status_code=502, detail=f"HyperDeck rejected command: {result['response']}")
    return {"status": "ok", "host": host, "response": result["response"]}


@app.post("/api/control/{host}/stop")
async def deck_stop(host: str):
    """Send a *stop* command to a single HyperDeck."""
    decks = await _load_all_deck_hosts()
    deck_id = next((name for name, h in decks.items() if h == host), host)
    result = await _send_command_to_deck(deck_id, host, "stop")
    if not result["success"]:
        raise HTTPException(status_code=502, detail=f"HyperDeck rejected command: {result['response']}")
    return {"status": "ok", "host": host, "response": result["response"]}


@app.get("/api/control/{host}/configuration")
async def get_deck_configuration(host: str):
    """Retrieve the current configuration from a single HyperDeck."""
    from app.backend.hyperdeck_control import send_hyperdeck_command, parse_hyperdeck_response
    response = await send_hyperdeck_command(host, "configuration")
    parsed = parse_hyperdeck_response(response)
    if parsed.get("_code") not in (200, 100):
        raise HTTPException(status_code=502, detail=f"HyperDeck error: {response}")
    # Strip internal meta-keys before returning
    settings = {k: v for k, v in parsed.items() if not k.startswith("_")}
    return {"host": host, "settings": settings}


@app.post("/api/control/{host}/configuration")
async def set_deck_configuration(host: str, settings: dict):
    """
    Apply one or more configuration settings to a single HyperDeck.
    Each key-value pair in *settings* becomes a separate configuration command.
    Returns per-command success/failure information.
    """
    from app.backend.hyperdeck_control import (
        send_hyperdeck_command,
        parse_hyperdeck_response,
        build_configuration_command,
    )
    commands = build_configuration_command(settings)
    if not commands:
        raise HTTPException(status_code=400, detail="No valid configuration keys provided.")

    results = []
    for cmd in commands:
        response = await send_hyperdeck_command(host, cmd)
        parsed = parse_hyperdeck_response(response)
        success = parsed.get("_code") in (200, 100)
        results.append({"command": cmd, "success": success, "response": response})

    overall = all(r["success"] for r in results)
    return {"host": host, "status": "ok" if overall else "partial", "results": results}


@app.get("/api/browse")
async def browse_host_folders(path: str = ""):
    target_path = os.path.abspath(os.path.expanduser(path)) if path else os.path.expanduser("~")

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