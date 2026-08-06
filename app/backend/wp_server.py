"""FastAPI application for Blackmagic Web Presenter control.

Provides REST API routes for managing Web Presenter devices,
stream control, stream key management, and real-time state updates.
"""

import asyncio
import importlib.util
import json
import logging
import os
import re
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.backend.utils import atomic_json_write
from app.backend.wp_control import (
    WP_PORT,
    check_connectivity,
    get_identity,
    get_stream_settings,
    reboot_device,
    set_stream_settings,
    start_stream,
    stop_stream,
)
from app.backend.wp_daemon import (
    global_presenter_state_cache,
)

logger = logging.getLogger(__name__)

ACTIVE_EVENT_FILE = "app/backend/active_event.json"
SCHEDULE_FILE = "app/backend/schedule.json"
CONFIG_FILE = "app/backend/config.json"
ACTIVE_STREAM_FILE = "app/backend/active_stream.json"

DEFAULT_CONFIG: dict[str, Any] = {
    "webpresenters": {},
    "wp_stages": {},
    "wp_presenter_roles": {},
    "wp_default_quality": "Streaming Medium",
    "wp_auto_sync_interval": 2,
    "destinations": [],
    "filename_template": "{year}{month}{day}_{planned_title}",
    "hyperdecks": {},
    "stage_mode": "global",
    "global_stage": "",
    "deck_stages": {},
    "schedule_auto_mode": True,
    "schedule_max_drift_minutes": 45,
    "slate_metadata": {"global": {}, "per_deck": {}, "per_event": {}},
    "settings_groups": {},
    "storage_destinations": [],
}

_wp_config_cache: dict[str, Any] | None = None
_wp_config_cache_mtime: float = 0.0
_wp_config_lock = threading.Lock()


def _normalize_config(config: dict[str, Any]) -> dict[str, Any]:
    merged = {**DEFAULT_CONFIG, **(config or {})}
    if not isinstance(merged.get("webpresenters"), dict):
        merged["webpresenters"] = {}
    if not isinstance(merged.get("wp_stages"), dict):
        merged["wp_stages"] = {}
    if not isinstance(merged.get("wp_presenter_roles"), dict):
        merged["wp_presenter_roles"] = {}
    merged["wp_default_quality"] = str(merged.get("wp_default_quality") or "Streaming Medium")
    try:
        merged["wp_auto_sync_interval"] = max(1, int(merged.get("wp_auto_sync_interval", 2)))
    except (TypeError, ValueError):
        merged["wp_auto_sync_interval"] = 2
    return merged


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.backend.wp_daemon import start_wp_background_monitor, stop_wp_background_monitor
    start_wp_background_monitor()
    yield
    await stop_wp_background_monitor()


app = FastAPI(title="Web Presenter Tools", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("WP_CORS_ORIGINS", "*").split(","),
    allow_credentials=os.environ.get("WP_CORS_CREDENTIALS", "true").lower() == "true",
    allow_headers=["*"],
    allow_methods=["*"],
)


async def _get_config() -> dict[str, Any]:
    global _wp_config_cache, _wp_config_cache_mtime
    try:
        mtime = os.path.getmtime(CONFIG_FILE) if os.path.exists(CONFIG_FILE) else 0
    except OSError:
        mtime = 0
    with _wp_config_lock:
        if _wp_config_cache is not None and mtime == _wp_config_cache_mtime:
            return dict(_wp_config_cache)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            with _wp_config_lock:
                _wp_config_cache = data
                _wp_config_cache_mtime = mtime
            return dict(data)
        except Exception:
            pass
    with _wp_config_lock:
        _wp_config_cache = {}
        _wp_config_cache_mtime = 0
    return {}


def _parse_wp_host_port(host_value: Any) -> tuple[str, int]:
    if isinstance(host_value, dict):
        return str(host_value.get("ip", "")), int(host_value.get("port", WP_PORT))
    return str(host_value), WP_PORT


# --- Config Routes ---

@app.get("/api/wp/config")
async def get_wp_config():
    config = await _get_config()
    return {
        "webpresenters": config.get("webpresenters", {}),
        "wp_default_quality": config.get("wp_default_quality", "Streaming Medium"),
        "wp_auto_sync_interval": config.get("wp_auto_sync_interval", 2),
    }


@app.post("/api/wp/config")
async def save_wp_config(payload: dict[str, Any]):
    config = await _get_config()
    if "webpresenters" in payload:
        config["webpresenters"] = payload["webpresenters"]
    if "wp_default_quality" in payload:
        config["wp_default_quality"] = payload["wp_default_quality"]
    if "wp_auto_sync_interval" in payload:
        config["wp_auto_sync_interval"] = payload["wp_auto_sync_interval"]
    atomic_json_write(CONFIG_FILE, _normalize_config(config))
    global _wp_config_cache, _wp_config_cache_mtime
    with _wp_config_lock:
        _wp_config_cache = None
    return {"status": "ok"}


# --- Device Management Routes ---

@app.get("/api/wp/presenters")
async def list_presenters():
    config = await _get_config()
    presenters = config.get("webpresenters", {})
    roles = config.get("wp_presenter_roles", {})
    stages = config.get("wp_stages", {})
    result = []
    for name, value in presenters.items():
        host, port = _parse_wp_host_port(value)
        state = global_presenter_state_cache.get(host, {})
        result.append({
            "name": name,
            "host": host,
            "port": port,
            "role": roles.get(name, ""),
            "stage": stages.get(name, ""),
            "state": state,
        })
    return {"presenters": result}


@app.post("/api/wp/presenters")
async def save_presenter(payload: dict[str, Any]):
    name = str(payload.get("name", "")).strip()
    host = str(payload.get("host", "")).strip()
    port = int(payload.get("port", WP_PORT))
    role = str(payload.get("role", "")).strip()
    stage = str(payload.get("stage", "")).strip()

    if not name:
        raise HTTPException(status_code=400, detail="name is required.")
    if not host:
        raise HTTPException(status_code=400, detail="host (IP) is required.")

    config = await _get_config()
    presenters = config.get("webpresenters", {})
    if port and port != WP_PORT:
        presenters[name] = {"ip": host, "port": port}
    else:
        presenters[name] = host
    config["webpresenters"] = presenters

    if role:
        roles = config.get("wp_presenter_roles", {})
        roles[name] = role
        config["wp_presenter_roles"] = roles
    if stage:
        stages = config.get("wp_stages", {})
        stages[name] = stage
        config["wp_stages"] = stages

    atomic_json_write(CONFIG_FILE, _normalize_config(config))
    return {"status": "ok", "name": name}


@app.delete("/api/wp/presenters/{name}")
async def delete_presenter(name: str):
    config = await _get_config()
    presenters = config.get("webpresenters", {})
    presenters.pop(name, None)
    config["webpresenters"] = presenters
    roles = config.get("wp_presenter_roles", {})
    roles.pop(name, None)
    config["wp_presenter_roles"] = roles
    stages = config.get("wp_stages", {})
    stages.pop(name, None)
    config["wp_stages"] = stages
    atomic_json_write(CONFIG_FILE, _normalize_config(config))
    return {"status": "ok"}


@app.get("/api/wp/discover")
async def discover_presenters():
    """Scan the local subnet for Blackmagic Web Presenters on port 9977."""
    import ipaddress
    import socket

    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
    except Exception:
        local_ip = "127.0.0.1"

    network = ipaddress.ip_network(f"{local_ip}/24", strict=False)
    found = []

    async def _check(ip_str: str) -> None:
        if await check_connectivity(ip_str, port=WP_PORT, timeout=0.5):
            try:
                identity = await get_identity(ip_str, port=WP_PORT)
                found.append({
                    "ip": ip_str,
                    "model": identity.get("Model", "Unknown"),
                    "label": identity.get("Label", ""),
                })
            except Exception:
                found.append({"ip": ip_str, "model": "Unknown", "label": ""})

    hosts = [str(ip) for ip in network.hosts()]
    await asyncio.gather(*[_check(ip) for ip in hosts[:50]], return_exceptions=True)
    return {"found": found, "subnet": str(network), "scanned": len(hosts[:50])}


# --- State & SSE Routes ---

@app.get("/api/wp/state")
async def get_wp_state():
    return dict(global_presenter_state_cache)


@app.get("/api/wp/events")
async def wp_sse_events():
    async def event_generator():
        last_state: dict = {}
        while True:
            current = dict(global_presenter_state_cache)
            if current != last_state:
                last_state = current
                yield f"data: {json.dumps(current)}\n\n"
            await asyncio.sleep(1)
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)


# --- Stream Control Routes ---

@app.post("/api/wp/stream/start")
async def wp_stream_start(payload: dict[str, Any] | None = None):
    hosts = []
    if payload and "hosts" in payload:
        hosts = payload["hosts"]
    elif payload and "name" in payload:
        config = await _get_config()
        presenters = config.get("webpresenters", {})
        name = payload["name"]
        if name in presenters:
            host, port = _parse_wp_host_port(presenters[name])
            hosts = [host]
    else:
        hosts = list(global_presenter_state_cache.keys())

    results = []
    for host in hosts:
        try:
            config = await _get_config()
            presenters = config.get("webpresenters", {})
            port = WP_PORT
            for name, value in presenters.items():
                h, p = _parse_wp_host_port(value)
                if h == host:
                    port = p
                    break
            ok = await start_stream(host, port=port)
            results.append({"host": host, "success": ok})
        except Exception as e:
            results.append({"host": host, "success": False, "error": str(e)})
    return {"results": results}


@app.post("/api/wp/stream/stop")
async def wp_stream_stop(payload: dict[str, Any] | None = None):
    hosts = []
    if payload and "hosts" in payload:
        hosts = payload["hosts"]
    elif payload and "name" in payload:
        config = await _get_config()
        presenters = config.get("webpresenters", {})
        name = payload["name"]
        if name in presenters:
            host, port = _parse_wp_host_port(presenters[name])
            hosts = [host]
    else:
        hosts = list(global_presenter_state_cache.keys())

    results = []
    for host in hosts:
        try:
            config = await _get_config()
            presenters = config.get("webpresenters", {})
            port = WP_PORT
            for name, value in presenters.items():
                h, p = _parse_wp_host_port(value)
                if h == host:
                    port = p
                    break
            ok = await stop_stream(host, port=port)
            results.append({"host": host, "success": ok})
        except Exception as e:
            results.append({"host": host, "success": False, "error": str(e)})
    return {"results": results}


def _lookup_wp_port(host: str, config: dict[str, Any]) -> int:
    """Look up the TCP port for a given host from the config."""
    presenters = config.get("webpresenters", {})
    for name, value in presenters.items():
        h, p = _parse_wp_host_port(value)
        if h == host:
            return p
    return WP_PORT


@app.post("/api/wp/stream/start-all")
async def wp_stream_start_all():
    config = await _get_config()
    hosts = list(global_presenter_state_cache.keys())
    results = []
    for host in hosts:
        try:
            port = _lookup_wp_port(host, config)
            ok = await start_stream(host, port=port)
            results.append({"host": host, "success": ok})
        except Exception as e:
            results.append({"host": host, "success": False, "error": str(e)})
    return {"results": results}


@app.post("/api/wp/stream/stop-all")
async def wp_stream_stop_all():
    config = await _get_config()
    hosts = list(global_presenter_state_cache.keys())
    results = []
    for host in hosts:
        try:
            port = _lookup_wp_port(host, config)
            ok = await stop_stream(host, port=port)
            results.append({"host": host, "success": ok})
        except Exception as e:
            results.append({"host": host, "success": False, "error": str(e)})
    return {"results": results}


# --- Device Settings Routes ---

@app.get("/api/wp/{host}/settings")
async def get_device_settings(host: str):
    try:
        settings = await get_stream_settings(host)
        identity = await get_identity(host)
        return {"host": host, "settings": settings, "identity": identity}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query device: {e}")


@app.post("/api/wp/{host}/settings")
async def update_device_settings(host: str, payload: dict[str, Any]):
    try:
        ok = await set_stream_settings(host, payload)
        if ok:
            return {"status": "ok", "host": host}
        raise HTTPException(status_code=502, detail="Device rejected settings update.")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to update settings: {e}")


@app.get("/api/wp/{host}/identity")
async def get_device_identity(host: str):
    try:
        identity = await get_identity(host)
        version = {}
        try:
            from app.backend.wp_control import get_version
            version = await get_version(host)
        except Exception:
            pass
        return {"host": host, "identity": identity, "version": version}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to query device: {e}")


@app.post("/api/wp/{host}/reboot")
async def reboot_presenter(host: str):
    try:
        ok = await reboot_device(host)
        return {"status": "ok" if ok else "failed", "host": host}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to reboot: {e}")


# --- Active Stream Routes ---

@app.get("/api/wp/active")
async def get_active_stream():
    if os.path.exists(ACTIVE_STREAM_FILE):
        try:
            with open(ACTIVE_STREAM_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "event_id": "",
        "title": "",
        "platform": "",
        "primary_url": "",
        "primary_key": "",
        "backup_url": "",
        "backup_key": "",
        "quality": "",
        "video_mode": "",
    }


@app.post("/api/wp/active")
async def save_active_stream(payload: dict[str, Any]):
    atomic_json_write(ACTIVE_STREAM_FILE, payload)
    return {"status": "ok"}


# --- Shared Schedule Routes ---

@app.get("/api/wp/schedule")
async def get_schedule():
    if os.path.exists(SCHEDULE_FILE):
        try:
            with open(SCHEDULE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


@app.post("/api/wp/schedule")
async def save_schedule(payload: list[dict[str, Any]] | dict[str, Any]):
    """Save schedule data. Accepts a list of events."""
    data = payload if isinstance(payload, list) else payload.get("events", [])
    atomic_json_write(SCHEDULE_FILE, data)
    return {"status": "ok", "count": len(data)}


@app.get("/api/wp/schedule/active")
async def get_active_event():
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


@app.post("/api/wp/schedule/active")
async def save_active_event(payload: dict[str, Any]):
    atomic_json_write(ACTIVE_EVENT_FILE, payload)
    return {"status": "ok"}


# --- Stream Profiles ---

STREAM_PROFILES_FILE = "app/backend/stream_profiles.json"


@app.get("/api/wp/profiles")
async def list_profiles():
    if os.path.exists(STREAM_PROFILES_FILE):
        try:
            with open(STREAM_PROFILES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []


@app.post("/api/wp/profiles")
async def save_profile(payload: dict[str, Any]):
    profiles = []
    if os.path.exists(STREAM_PROFILES_FILE):
        try:
            with open(STREAM_PROFILES_FILE, "r", encoding="utf-8") as f:
                profiles = json.load(f)
        except Exception:
            pass

    name = str(payload.get("name", "")).strip()
    if not name:
        import uuid
        name = f"profile_{str(uuid.uuid4())[:8]}"

    settings = payload.get("settings", {})
    existing_idx = next((i for i, p in enumerate(profiles) if p.get("name") == name), None)
    profile = {"name": name, "settings": settings}
    if existing_idx is not None:
        profiles[existing_idx] = profile
    else:
        profiles.append(profile)

    atomic_json_write(STREAM_PROFILES_FILE, profiles)
    return {"status": "ok", "name": name}


@app.delete("/api/wp/profiles/{name}")
async def delete_profile(name: str):
    profiles = []
    if os.path.exists(STREAM_PROFILES_FILE):
        try:
            with open(STREAM_PROFILES_FILE, "r", encoding="utf-8") as f:
                profiles = json.load(f)
        except Exception:
            pass
    profiles = [p for p in profiles if p.get("name") != name]
    atomic_json_write(STREAM_PROFILES_FILE, profiles)
    return {"status": "ok"}


# --- YouTube Plugin Configuration ---

YOUTUBE_CONFIG_FILE = "app/backend/youtube_config.json"

YOUTUBE_SCOPES = "offline_access https://www.googleapis.com/auth/youtube"


def _load_youtube_config() -> dict[str, Any]:
    if os.path.exists(YOUTUBE_CONFIG_FILE):
        try:
            with open(YOUTUBE_CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


@app.get("/api/wp/plugins/keys/youtube/config")
async def get_youtube_config():
    data = _load_youtube_config()
    return {
        "client_id": data.get("client_id", ""),
        "client_secret": "***" if data.get("client_secret") else "",
        "refresh_token": "***" if data.get("refresh_token") else "",
        "configured": bool(data.get("client_id") and data.get("client_secret")),
    }


@app.post("/api/wp/plugins/keys/youtube/config")
async def save_youtube_config(payload: dict[str, Any]):
    existing = _load_youtube_config()
    config = {
        "client_id": str(payload.get("client_id") or existing.get("client_id", "")),
        "client_secret": str(payload.get("client_secret") or existing.get("client_secret", "")),
        "refresh_token": str(payload.get("refresh_token") or existing.get("refresh_token", "")),
    }
    atomic_json_write(YOUTUBE_CONFIG_FILE, config)
    return {"status": "ok", "configured": bool(config["client_id"] and config["client_secret"])}


@app.get("/api/wp/plugins/keys/youtube/authorize")
async def youtube_authorize(request):
    """Generate Google OAuth2 authorization URL and return it."""
    data = _load_youtube_config()
    client_id = data.get("client_id", "")
    if not client_id:
        raise HTTPException(status_code=400, detail="Client ID not configured. Save credentials first.")

    # Build redirect URI from the request's origin
    base_url = str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url}/api/wp/plugins/keys/youtube/callback"

    import urllib.parse
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": YOUTUBE_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    })
    auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{params}"
    return {"auth_url": auth_url, "redirect_uri": redirect_uri}


@app.get("/api/wp/plugins/keys/youtube/callback")
async def youtube_callback(request: Request, code: str = "", error: str = ""):
    """Handle OAuth2 callback from Google, exchange code for tokens."""
    from starlette.responses import HTMLResponse

    if error:
        return HTMLResponse(_youtube_callback_html(False, f"Authorization denied: {error}"))

    if not code:
        return HTMLResponse(_youtube_callback_html(False, "No authorization code received."))

    data = _load_youtube_config()
    client_id = data.get("client_id", "")
    client_secret = data.get("client_secret", "")

    if not client_id or not client_secret:
        return HTMLResponse(_youtube_callback_html(False, "Client credentials not configured."))

    # Exchange authorization code for tokens
    try:
        import httpx

        base_url = str(request.base_url).rstrip("/")
        redirect_uri = f"{base_url}/api/wp/plugins/keys/youtube/callback"

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
                timeout=15,
            )
            tokens = resp.json()

        if "refresh_token" not in tokens:
            error_desc = tokens.get("error_description", tokens.get("error", "Unknown error"))
            return HTMLResponse(_youtube_callback_html(False, f"Token exchange failed: {error_desc}"))

        # Save the refresh token
        config = {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": tokens["refresh_token"],
        }
        atomic_json_write(YOUTUBE_CONFIG_FILE, config)

        return HTMLResponse(_youtube_callback_html(True, "YouTube account connected successfully!"))
    except ImportError:
        return HTMLResponse(_youtube_callback_html(False, "httpx library not installed."))
    except Exception as e:
        return HTMLResponse(_youtube_callback_html(False, f"Error: {e}"))


def _youtube_callback_html(success: bool, message: str) -> str:
    """Generate an HTML page for the OAuth2 callback that communicates back to the opener."""
    status_color = "#10b981" if success else "#ef4444"
    icon = "✓" if success else "✕"
    return f"""<!DOCTYPE html>
<html>
<head><title>YouTube Authorization</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;
height:100vh;font-family:system-ui;background:#0f172a;color:#e2e8f0;">
<div style="text-align:center;padding:2rem;">
<div style="font-size:3rem;margin-bottom:1rem;color:{status_color};">{icon}</div>
<h2 style="font-size:1.25rem;margin-bottom:0.5rem;">{message}</h2>
<p style="color:#94a3b8;font-size:0.875rem;">This window will close automatically.</p>
</div>
<script>
window.opener && window.opener.postMessage(
    {{"type":"youtube_auth","success":{str(success).lower()}}}, "*"
);
setTimeout(function() {{ window.close(); }}, 2000);
</script>
</body>
</html>"""


# --- Stream Key Plugins ---

KEY_PLUGINS_DIR = "app/backend/plugins/keys"


def _read_key_plugin_manifest(plugin_name: str) -> dict[str, Any] | None:
    import ast
    plugin_path = os.path.join(KEY_PLUGINS_DIR, f"{plugin_name}.py")
    if not os.path.exists(plugin_path):
        return None
    try:
        with open(plugin_path, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=plugin_path)
    except Exception:
        return None

    manifest: dict[str, Any] = {"name": plugin_name}
    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id == "PLUGIN_LABEL" and isinstance(node.value, ast.Constant):
                manifest["label"] = str(node.value.value)
            elif target.id == "PLUGIN_DESCRIPTION" and isinstance(node.value, ast.Constant):
                manifest["description"] = str(node.value.value)

    manifest.setdefault("label", plugin_name.replace("_", " ").title())
    manifest.setdefault("description", "")

    has_fetch = any(
        isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "fetch_keys"
        for n in ast.iter_child_nodes(tree)
    )
    manifest["enabled"] = has_fetch
    return manifest


@app.get("/api/wp/plugins/keys")
async def list_key_plugins():
    if not os.path.exists(KEY_PLUGINS_DIR):
        return []
    files = sorted(
        [f[:-3] for f in os.listdir(KEY_PLUGINS_DIR) if f.endswith(".py") and not f.startswith("__")],
        key=str.lower,
    )
    return [_read_key_plugin_manifest(name) for name in files if _read_key_plugin_manifest(name)]


@app.post("/api/wp/plugins/keys/fetch/{plugin_name}")
async def fetch_stream_keys(plugin_name: str):
    if not re.fullmatch(r"[a-zA-Z0-9_]+", plugin_name):
        raise HTTPException(status_code=400, detail="Invalid plugin name.")
    plugin_path = os.path.join(KEY_PLUGINS_DIR, f"{plugin_name}.py")
    if not os.path.exists(plugin_path):
        raise HTTPException(status_code=404, detail="Key plugin not found.")

    spec = importlib.util.spec_from_file_location(plugin_name, plugin_path)
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=500, detail="Failed to load plugin.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, "fetch_keys"):
        raise HTTPException(status_code=422, detail="Plugin missing fetch_keys() function.")

    active_event = {}
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, "r", encoding="utf-8") as f:
                active_event = json.load(f)
        except Exception:
            pass

    event_id = active_event.get("id", "")
    try:
        import inspect
        result = module.fetch_keys(event_id)
        if inspect.isawaitable(result):
            result = await result
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plugin error: {e}")


# --- Static Frontend ---

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(FRONTEND_DIR):
    from starlette.responses import FileResponse

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
