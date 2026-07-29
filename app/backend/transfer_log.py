import datetime
import json
import os
import tempfile
from typing import Any

TRANSFERS_FILE = "app/backend/transfers.json"


def _atomic_json_write(file_path: str, data: Any) -> None:
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


def _load_transfers() -> dict[str, dict[str, Any]]:
    if not os.path.exists(TRANSFERS_FILE):
        return {}
    try:
        with open(TRANSFERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _save_transfers(data: dict[str, dict[str, Any]]) -> None:
    _atomic_json_write(TRANSFERS_FILE, data)


def _make_key(host: str, slot_id: str, remote_filename: str) -> str:
    return f"{host}:{slot_id}:{remote_filename}"


def log_transfer_start(
    host: str,
    slot_id: str,
    remote_filename: str,
    local_filename: str,
) -> None:
    transfers = _load_transfers()
    key = _make_key(host, slot_id, remote_filename)
    transfers[key] = {
        "deck_host": host,
        "slot_id": slot_id,
        "remote_filename": remote_filename,
        "local_filename": local_filename,
        "status": "in_progress",
        "timestamp": datetime.datetime.now().isoformat(),
        "destinations": [],
    }
    _save_transfers(transfers)


def log_transfer_complete(
    host: str,
    slot_id: str,
    remote_filename: str,
    local_filename: str,
    destinations: list[str] | None = None,
) -> None:
    transfers = _load_transfers()
    key = _make_key(host, slot_id, remote_filename)
    transfers[key] = {
        "deck_host": host,
        "slot_id": slot_id,
        "remote_filename": remote_filename,
        "local_filename": local_filename,
        "status": "completed",
        "timestamp": datetime.datetime.now().isoformat(),
        "destinations": destinations or [],
    }
    _save_transfers(transfers)


def log_transfer_failed(
    host: str,
    slot_id: str,
    remote_filename: str,
) -> None:
    transfers = _load_transfers()
    key = _make_key(host, slot_id, remote_filename)
    existing = transfers.get(key, {})
    transfers[key] = {
        "deck_host": host,
        "slot_id": slot_id,
        "remote_filename": remote_filename,
        "local_filename": existing.get("local_filename", ""),
        "status": "failed",
        "timestamp": datetime.datetime.now().isoformat(),
        "destinations": existing.get("destinations", []),
    }
    _save_transfers(transfers)


def get_transfer_status(host: str, slot_id: str, remote_filename: str) -> str:
    """Return status: 'completed', 'in_progress', 'failed', or 'not_transferred'."""
    transfers = _load_transfers()
    key = _make_key(host, slot_id, remote_filename)
    entry = transfers.get(key)
    if not entry:
        return "not_transferred"
    return str(entry.get("status", "not_transferred"))


def get_transfer_status_map(host: str, slot_id: str) -> dict[str, str]:
    """Return {remote_filename: status} for all transfers on a given deck+slot."""
    transfers = _load_transfers()
    result: dict[str, str] = {}
    prefix = f"{host}:{slot_id}:"
    for key, entry in transfers.items():
        if key.startswith(prefix):
            remote_filename = str(entry.get("remote_filename", ""))
            status = str(entry.get("status", "not_transferred"))
            if remote_filename:
                result[remote_filename] = status
    return result
