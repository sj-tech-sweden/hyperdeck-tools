import asyncio
import ast
import importlib.util
import json
import logging
import os
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

STORAGE_PLUGINS_DIR = "app/backend/plugins/storage"
CONFIG_FILE = "app/backend/config.json"

_storage_plugin_cache: dict[str, Any] = {}


def discover_storage_plugins() -> list[dict[str, Any]]:
    """Scan the storage plugins directory for available plugins and return manifests."""
    if not os.path.exists(STORAGE_PLUGINS_DIR):
        return []

    plugins = []
    for filename in sorted(os.listdir(STORAGE_PLUGINS_DIR), key=str.lower):
        if not filename.endswith(".py") or filename.startswith("__"):
            continue
        plugin_name = filename[:-3]
        manifest = read_storage_plugin_manifest(plugin_name)
        if manifest:
            plugins.append(manifest)
    return plugins


def read_storage_plugin_manifest(plugin_name: str) -> dict[str, Any] | None:
    """Parse a storage plugin's manifest from module-level variables using AST."""
    plugin_path = os.path.join(STORAGE_PLUGINS_DIR, f"{plugin_name}.py")
    if not os.path.exists(plugin_path):
        return None

    try:
        with open(plugin_path, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=plugin_path)
    except Exception:
        return None

    manifest: dict[str, Any] = {"name": plugin_name, "storage_type": plugin_name}

    for node in ast.iter_child_nodes(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            if target.id == "PLUGIN_LABEL" and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                manifest["label"] = node.value.value
            elif target.id == "PLUGIN_DESCRIPTION" and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                manifest["description"] = node.value.value
            elif target.id == "PLUGIN_STORAGE_TYPE" and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                manifest["storage_type"] = node.value.value
            elif target.id == "PLUGIN_CONFIG_FIELDS" and isinstance(node.value, (ast.List, ast.Tuple)):
                manifest["config_fields"] = _parse_config_fields_ast(node.value)

    manifest.setdefault("label", plugin_name.replace("_", " ").title())
    manifest.setdefault("description", "No description provided.")
    manifest.setdefault("config_fields", [])

    has_send = False
    has_test = False
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == "send_file":
                has_send = True
            elif node.name == "test_connection":
                has_test = True
    manifest["enabled"] = has_send and has_test

    return manifest


def _parse_config_fields_ast(node: ast.List | ast.Tuple) -> list[dict[str, Any]]:
    """Parse a list of config field dicts from AST nodes."""
    fields = []
    for elem in node.elts:
        if not isinstance(elem, ast.Dict):
            continue
        field: dict[str, Any] = {}
        for i, key in enumerate(elem.keys):
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                val_node = elem.values[i]
                if isinstance(val_node, ast.Constant):
                    field[key.value] = val_node.value
                elif isinstance(val_node, ast.Name) and val_node.id == "True":
                    field[key.value] = True
                elif isinstance(val_node, ast.Name) and val_node.id == "False":
                    field[key.value] = False
        if field.get("key"):
            field.setdefault("label", field["key"])
            field.setdefault("type", "text")
            field.setdefault("required", False)
            field.setdefault("default", "")
            fields.append(field)
    return fields


def load_storage_plugin_module(storage_type: str):
    """Dynamically load a storage plugin module by type name."""
    if storage_type in _storage_plugin_cache:
        return _storage_plugin_cache[storage_type]

    if not re.fullmatch(r"[a-zA-Z0-9_]+", storage_type):
        raise ValueError(f"Invalid storage plugin type: {storage_type}")

    plugin_path = os.path.join(STORAGE_PLUGINS_DIR, f"{storage_type}.py")
    if not os.path.exists(plugin_path):
        raise FileNotFoundError(f"Storage plugin not found: {storage_type}")

    spec = importlib.util.spec_from_file_location(storage_type, plugin_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load storage plugin: {storage_type}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _storage_plugin_cache[storage_type] = module
    return module


def test_storage_connection(storage_type: str, config: dict[str, Any]) -> dict[str, Any]:
    """Test a storage plugin connection. Returns {"ok": bool, "message": str}."""
    module = load_storage_plugin_module(storage_type)
    if not hasattr(module, "test_connection"):
        return {"ok": False, "message": "Plugin does not implement test_connection()."}
    try:
        result = module.test_connection(config)
        if isinstance(result, dict):
            return {"ok": bool(result.get("ok", False)), "message": str(result.get("message", ""))}
        return {"ok": bool(result), "message": ""}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def send_file_to_storage(
    storage_type: str,
    local_path: str,
    remote_name: str,
    config: dict[str, Any],
) -> bool:
    """Send a file to a storage backend. Returns True on success."""
    module = load_storage_plugin_module(storage_type)
    if not hasattr(module, "send_file"):
        raise AttributeError(f"Plugin {storage_type} does not implement send_file().")
    try:
        result = module.send_file(local_path, remote_name, config)
        if result:
            logger.info("Storage upload OK: %s -> %s[%s]", remote_name, storage_type, config.get("bucket") or config.get("path", ""))
        else:
            logger.warning("Storage upload returned False: %s -> %s", remote_name, storage_type)
        return bool(result)
    except Exception as e:
        logger.exception("Storage upload error: %s -> %s: %s", remote_name, storage_type, e)
        return False


# --- Transfer Queue ---

class StorageTransferQueue:
    """Per-destination async queue for managing storage uploads."""

    def __init__(self, dest_id: str, max_concurrent: int = 1):
        self.dest_id = dest_id
        self._max_concurrent = max(1, max_concurrent)
        self._semaphore = asyncio.Semaphore(self._max_concurrent)
        self._pending: list[dict[str, Any]] = []
        self._active: dict[str, asyncio.Task] = {}
        self._completed: int = 0
        self._failed: int = 0
        self._lock = asyncio.Lock()

    @property
    def max_concurrent(self) -> int:
        return self._max_concurrent

    @max_concurrent.setter
    def max_concurrent(self, value: int) -> None:
        value = max(1, value)
        if value != self._max_concurrent:
            self._max_concurrent = value
            self._semaphore = asyncio.Semaphore(value)

    def get_status(self) -> dict[str, int]:
        return {
            "pending": len(self._pending),
            "active": len(self._active),
            "completed": self._completed,
            "failed": self._failed,
        }

    def reset_counts(self) -> None:
        self._completed = 0
        self._failed = 0

    async def queue_transfer(
        self,
        storage_type: str,
        local_path: str,
        remote_name: str,
        config: dict[str, Any],
        deck_state_cache: dict | None = None,
        host: str = "",
    ) -> None:
        """Add a transfer to the queue and process it asynchronously."""
        task_info = {
            "storage_type": storage_type,
            "local_path": local_path,
            "remote_name": remote_name,
            "config": config,
        }
        async with self._lock:
            self._pending.append(task_info)

        asyncio.create_task(
            self._process_next(task_info, deck_state_cache, host)
        )

    async def _process_next(
        self,
        task_info: dict[str, Any],
        deck_state_cache: dict | None,
        host: str,
    ) -> None:
        async with self._semaphore:
            async with self._lock:
                if task_info in self._pending:
                    self._pending.remove(task_info)
                self._active[task_info["remote_name"]] = asyncio.current_task()

            try:
                success = await asyncio.to_thread(
                    send_file_to_storage,
                    task_info["storage_type"],
                    task_info["local_path"],
                    task_info["remote_name"],
                    task_info["config"],
                )
                async with self._lock:
                    if success:
                        self._completed += 1
                    else:
                        self._failed += 1
            except Exception:
                async with self._lock:
                    self._failed += 1
            finally:
                async with self._lock:
                    self._active.pop(task_info["remote_name"], None)


# Global queue registry: dest_id -> StorageTransferQueue
_queue_registry: dict[str, StorageTransferQueue] = {}


def get_or_create_queue(dest_id: str, max_concurrent: int = 1) -> StorageTransferQueue:
    """Get or create a transfer queue for a storage destination."""
    if dest_id not in _queue_registry:
        _queue_registry[dest_id] = StorageTransferQueue(dest_id, max_concurrent)
    queue = _queue_registry[dest_id]
    queue.max_concurrent = max_concurrent
    return queue


def get_all_queue_status() -> dict[str, dict[str, int]]:
    """Return status of all queues."""
    return {dest_id: queue.get_status() for dest_id, queue in _queue_registry.items()}


def load_storage_destinations() -> list[dict[str, Any]]:
    """Load configured storage destinations from config.json."""
    if not os.path.exists(CONFIG_FILE):
        return []
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f) or {}
        return config.get("storage_destinations", [])
    except Exception:
        return []


def get_enabled_storage_destinations() -> list[dict[str, Any]]:
    """Return only enabled storage destinations."""
    return [d for d in load_storage_destinations() if d.get("enabled", True)]
