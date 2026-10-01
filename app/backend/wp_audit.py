"""Lightweight audit log for Web Presenter device changes.

Writes one JSON object per line to ``wp_apply_log.jsonl`` next to this module.
Used to keep a timestamped trail of what settings were pushed to which device,
which is invaluable when debugging on a live broadcast.
"""
import json
import os
import threading
from datetime import datetime, timezone

AUDIT_LOG = os.path.join(os.path.dirname(__file__), "wp_apply_log.jsonl")
_lock = threading.Lock()


def log_wp_apply(
    host: str,
    action: str,
    details: dict | None = None,
    status: str = "ok",
    error: str | None = None,
) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "host": host,
        "action": action,
        "status": status,
        "details": details or {},
    }
    if error is not None:
        entry["error"] = str(error)
    try:
        with _lock:
            with open(AUDIT_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
