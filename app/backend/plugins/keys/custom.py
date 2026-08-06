"""Manual stream key entry plugin.

Allows users to manually enter RTMP URLs and stream keys.
This is the default/fallback plugin when no API integration is available.
"""

import json
import os

PLUGIN_LABEL = "Manual Entry"
PLUGIN_DESCRIPTION = "Manually enter RTMP server URL and stream key"

ACTIVE_STREAM_FILE = "app/backend/active_stream.json"


def fetch_keys(event_id: str = "", **kwargs) -> dict:
    """Return the currently configured stream keys from active_stream.json."""
    if os.path.exists(ACTIVE_STREAM_FILE):
        try:
            with open(ACTIVE_STREAM_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {
                "event_id": data.get("event_id", event_id),
                "primary_url": data.get("primary_url", ""),
                "primary_key": data.get("primary_key", ""),
                "backup_url": data.get("backup_url", ""),
                "backup_key": data.get("backup_key", ""),
            }
        except Exception:
            pass
    return {
        "event_id": event_id,
        "primary_url": "",
        "primary_key": "",
        "backup_url": "",
        "backup_key": "",
    }
