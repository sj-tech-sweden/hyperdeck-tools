import datetime
import json
import logging
import os
import threading
from typing import Any

from app.backend.utils import atomic_json_write

logger = logging.getLogger(__name__)

TRANSFERS_FILE = os.path.join(os.path.dirname(__file__), "transfers.json")

_transfer_lock = threading.Lock()

MAX_TRANSFER_LOG_ENTRIES = 5000
MAX_TRANSFER_LOG_AGE_DAYS = 30


def _load_transfers() -> dict[str, dict[str, Any]]:
    if not os.path.exists(TRANSFERS_FILE):
        return {}
    try:
        with open(TRANSFERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except json.JSONDecodeError as e:
        logger.warning("Transfer log corrupt, backing up and resetting: %s", e)
        try:
            backup = TRANSFERS_FILE + ".corrupt"
            os.replace(TRANSFERS_FILE, backup)
        except OSError:
            pass
        return {}
    except Exception as e:
        logger.warning("Failed to read transfer log: %s", e)
        return {}


def _prune_transfers(data: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Remove old entries to keep the transfer log manageable."""
    if len(data) <= MAX_TRANSFER_LOG_ENTRIES:
        return data

    cutoff = datetime.datetime.now() - datetime.timedelta(days=MAX_TRANSFER_LOG_AGE_DAYS)
    pruned = {}
    for key, entry in data.items():
        ts = entry.get("timestamp", "")
        try:
            entry_time = datetime.datetime.fromisoformat(ts)
            if entry_time > cutoff:
                pruned[key] = entry
        except (ValueError, TypeError):
            pruned[key] = entry

    if len(pruned) > MAX_TRANSFER_LOG_ENTRIES:
        sorted_items = sorted(
            pruned.items(),
            key=lambda x: x[1].get("timestamp", ""),
            reverse=True,
        )
        pruned = dict(sorted_items[:MAX_TRANSFER_LOG_ENTRIES])

    return pruned


def _save_transfers(data: dict[str, dict[str, Any]]) -> None:
    pruned = _prune_transfers(data)
    atomic_json_write(TRANSFERS_FILE, pruned)


def _make_key(host: str, slot_id: str, remote_filename: str) -> str:
    return f"{host}:{slot_id}:{remote_filename}"


def reconcile_in_progress_transfers() -> int:
    """Mark any orphaned in_progress transfers as failed (call on startup)."""
    with _transfer_lock:
        transfers = _load_transfers()
        changed = False
        for entry in transfers.values():
            if entry.get("status") == "in_progress":
                entry["status"] = "failed"
                entry["timestamp"] = datetime.datetime.now().isoformat()
                changed = True
        if changed:
            _save_transfers(transfers)
            logger.info("Reconciled orphaned in_progress transfers on startup")
        return sum(1 for e in transfers.values() if e.get("status") == "in_progress")


def log_transfer_start(
    host: str,
    slot_id: str,
    remote_filename: str,
    local_filename: str,
) -> None:
    with _transfer_lock:
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
    with _transfer_lock:
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
    with _transfer_lock:
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
    with _transfer_lock:
        transfers = _load_transfers()
        key = _make_key(host, slot_id, remote_filename)
        entry = transfers.get(key)
        if not entry:
            return "not_transferred"
        return str(entry.get("status", "not_transferred"))


def get_transfer_status_map(host: str, slot_id: str) -> dict[str, str]:
    """Return {remote_filename: status} for all transfers on a given deck+slot."""
    with _transfer_lock:
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
