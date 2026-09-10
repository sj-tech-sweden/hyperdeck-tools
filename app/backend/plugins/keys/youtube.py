"""YouTube Live stream key plugin.

Fetches stream keys from YouTube Live API using OAuth2 credentials.
Credentials can be configured via the web UI or environment variables.
"""

import json
import os

PLUGIN_LABEL = "YouTube Live"
PLUGIN_DESCRIPTION = "Fetch stream keys from YouTube Live API"

YOUTUBE_CONFIG_FILE = "app/backend/youtube_config.json"


def _load_credentials() -> dict:
    """Load credentials from config file or environment variables."""
    # Try config file first
    if os.path.exists(YOUTUBE_CONFIG_FILE):
        try:
            with open(YOUTUBE_CONFIG_FILE, "r", encoding="utf-8") as f:
                config = json.load(f)
            if config.get("client_id") and config.get("client_secret"):
                return config
        except Exception:
            pass

    # Fall back to environment variables
    return {
        "client_id": os.environ.get("YOUTUBE_CLIENT_ID", ""),
        "client_secret": os.environ.get("YOUTUBE_CLIENT_SECRET", ""),
        "refresh_token": os.environ.get("YOUTUBE_REFRESH_TOKEN", ""),
    }


async def fetch_keys(event_id: str = "", **kwargs) -> dict:
    """Fetch YouTube Live stream key for the active broadcast."""
    creds = _load_credentials()
    client_id = creds.get("client_id", "")
    client_secret = creds.get("client_secret", "")
    refresh_token = creds.get("refresh_token", "")

    if not all([client_id, client_secret, refresh_token]):
        return {
            "event_id": event_id,
            "error": (
                "YouTube OAuth2 credentials not configured. "
                "Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, "
                "and YOUTUBE_REFRESH_TOKEN environment variables."
            ),
            "primary_url": "",
            "primary_key": "",
            "backup_url": "",
            "backup_key": "",
        }

    try:
        import httpx

        # Get access token
        token_resp = await httpx.AsyncClient().post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=10,
        )
        token_data = token_resp.json()
        access_token = token_data.get("access_token", "")
        if not access_token:
            return {
                "event_id": event_id,
                "error": f"Failed to get access token: {token_data.get('error_description', 'Unknown error')}",
                "primary_url": "",
                "primary_key": "",
                "backup_url": "",
                "backup_key": "",
            }

        # List live broadcasts
        headers = {"Authorization": f"Bearer {access_token}"}
        broadcasts_resp = await httpx.AsyncClient().get(
            "https://www.googleapis.com/youtube/v3/liveBroadcasts",
            params={"part": "status,contentDetails", "broadcastStatus": "active", "maxResults": 1},
            headers=headers,
            timeout=10,
        )
        broadcasts = broadcasts_resp.json().get("items", [])
        if not broadcasts:
            return {
                "event_id": event_id,
                "error": "No active YouTube Live broadcast found.",
                "primary_url": "",
                "primary_key": "",
                "backup_url": "",
                "backup_key": "",
            }

        broadcast = broadcasts[0]
        stream_id = broadcast.get("contentDetails", {}).get("boundStreamId", "")

        # Get stream details
        streams_resp = await httpx.AsyncClient().get(
            "https://www.googleapis.com/youtube/v3/liveStreams",
            params={"part": "cdn,snippet", "id": stream_id},
            headers=headers,
            timeout=10,
        )
        streams = streams_resp.json().get("items", [])
        if not streams:
            return {
                "event_id": event_id,
                "error": "Stream details not found.",
                "primary_url": "",
                "primary_key": "",
                "backup_url": "",
                "backup_key": "",
            }

        stream = streams[0]
        ingestion_info = stream.get("cdn", {}).get("ingestionInfo", {})
        return {
            "event_id": event_id,
            "primary_url": ingestion_info.get("ingestionAddress", ""),
            "primary_key": ingestion_info.get("streamName", ""),
            "backup_url": ingestion_info.get("backupIngestionAddress", ""),
            "backup_key": ingestion_info.get("streamName", ""),
        }
    except ImportError:
        return {
            "event_id": event_id,
            "error": "httpx library not installed. Install with: pip install httpx",
            "primary_url": "",
            "primary_key": "",
            "backup_url": "",
            "backup_key": "",
        }
    except Exception as e:
        return {
            "event_id": event_id,
            "error": str(e),
            "primary_url": "",
            "primary_key": "",
            "backup_url": "",
            "backup_key": "",
        }
