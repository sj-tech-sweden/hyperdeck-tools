"""Nextcloud storage plugin.

Uploads files to a Nextcloud server via the WebDAV API.
No special libraries required — uses HTTP PUT for uploads.

Setup:
1. In Nextcloud, go to Settings > Security > App passwords
2. Create an app password for this application
3. Enter the server URL, username, and app password in the plugin config
"""

import logging
import os

logger = logging.getLogger(__name__)

PLUGIN_LABEL = "Nextcloud"
PLUGIN_DESCRIPTION = "Upload files to a Nextcloud server via WebDAV"
PLUGIN_STORAGE_TYPE = "nextcloud"
PLUGIN_CONFIG_FIELDS = [
    {"key": "server_url", "label": "Server URL", "type": "text", "required": True, "default": ""},
    {"key": "username", "label": "Username", "type": "text", "required": True, "default": ""},
    {"key": "password", "label": "App Password", "type": "password", "required": True, "default": ""},
    {"key": "folder", "label": "Folder (optional)", "type": "text", "required": False, "default": "/HyperDeck"},
]


def _validate_config(config: dict) -> str | None:
    """Validate config and return an error message, or None if OK."""
    server_url = config.get("server_url", "").strip()
    username = config.get("username", "")
    password = config.get("password", "")

    if not server_url:
        return "Server URL is required."
    if not username:
        return "Username is required."
    if not password:
        return "App Password is required."

    if not server_url.startswith(("http://", "https://")):
        return f"Server URL must start with http:// or https://. Got: {server_url}"

    return None


def _get_webdav_url(config: dict, remote_name: str = "") -> str:
    """Build the WebDAV URL for a file."""
    server_url = config.get("server_url", "").strip().rstrip("/")
    username = config.get("username", "")
    folder = config.get("folder", "/HyperDeck").strip().rstrip("/")

    base = f"{server_url}/remote.php/dav/files/{username}"
    if folder:
        base = f"{base}{folder}"
    if remote_name:
        base = f"{base}/{remote_name}"
    return base


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured Nextcloud server via WebDAV."""
    if not os.path.exists(local_path):
        logger.error("Nextcloud upload: source file does not exist: %s", local_path)
        return False

    validation_error = _validate_config(config)
    if validation_error:
        logger.error("Nextcloud upload: config error: %s", validation_error)
        return False

    try:
        import requests
        from requests.exceptions import ConnectionError, SSLError, Timeout
    except ImportError:
        logger.error("Nextcloud upload: 'requests' library not installed")
        return False

    username = config.get("username", "")
    password = config.get("password", "")
    folder = config.get("folder", "/HyperDeck").strip().rstrip("/")

    try:
        if folder:
            folder_url = _get_webdav_url(config)
            resp = requests.request(
                "MKCOL",
                folder_url,
                auth=(username, password),
                timeout=15,
            )
            if resp.status_code not in (201, 405):
                logger.warning("Nextcloud MKCOL returned %d for %s", resp.status_code, folder_url)

        url = _get_webdav_url(config, remote_name)
        logger.info("Nextcloud upload: %s -> %s", os.path.basename(local_path), url)

        with open(local_path, "rb") as f:
            file_data = f.read()

        resp = requests.put(
            url,
            auth=(username, password),
            headers={"Content-Type": "application/octet-stream"},
            data=file_data,
            timeout=300,
        )

        if resp.status_code in (201, 204):
            logger.info("Nextcloud upload OK: %s (%d bytes)", remote_name, len(file_data))
            return True

        if resp.status_code == 401:
            logger.error(
                "Nextcloud upload: authentication failed (401). "
                "Make sure you are using an app password (Settings > Security > App passwords), "
                "not your regular login password."
            )
            return False
        if resp.status_code == 403:
            logger.error(
                "Nextcloud upload: access denied (403). "
                "WebDAV may be disabled on this server, or your account lacks upload permissions. "
                "Check with your Nextcloud administrator."
            )
            return False
        if resp.status_code == 404:
            logger.error(
                "Nextcloud upload: not found (404). "
                "Check that the server URL is correct (e.g. https://cloud.example.com) "
                "and that WebDAV is enabled on the server."
            )
            return False
        if resp.status_code == 413:
            logger.error(
                "Nextcloud upload: file too large (413). "
                "The file exceeds the server upload limit. "
                "Check Nextcloud's upload_max_filesize setting."
            )
            return False
        if resp.status_code == 507:
            logger.error(
                "Nextcloud upload: insufficient storage (507). "
                "The Nextcloud account has run out of storage space."
            )
            return False

        logger.error("Nextcloud upload: unexpected status %d: %s", resp.status_code, resp.text[:200])
        return False

    except SSLError as e:
        logger.error(
            "Nextcloud upload: SSL certificate error. "
            "If using a self-signed certificate, try using http:// instead of https://, "
            "or install the certificate on the server. Error: %s", e
        )
        return False
    except ConnectionError as e:
        server_url = config.get("server_url", "").strip()
        logger.error(
            "Nextcloud upload: could not connect to %s. "
            "Check that the server is running and reachable. "
            "If behind a firewall, ensure ports 443 (HTTPS) or 80 (HTTP) are open. Error: %s",
            server_url, e,
        )
        return False
    except Timeout:
        server_url = config.get("server_url", "").strip()
        logger.error(
            "Nextcloud upload: connection to %s timed out. "
            "The server may be slow or unreachable. Check network connectivity.",
            server_url,
        )
        return False
    except Exception as e:
        logger.exception("Nextcloud upload: unexpected error: %s", e)
        return False


def test_connection(config: dict) -> dict:
    """Test connectivity by listing the root WebDAV directory."""
    validation_error = _validate_config(config)
    if validation_error:
        return {"ok": False, "message": validation_error}

    try:
        import requests
        from requests.exceptions import ConnectionError, SSLError, Timeout
    except ImportError:
        return {"ok": False, "message": "The 'requests' library is not installed. Contact your server administrator."}

    server_url = config.get("server_url", "").strip().rstrip("/")
    username = config.get("username", "")
    password = config.get("password", "")

    webdav_root = f"{server_url}/remote.php/dav/files/{username}"

    try:
        resp = requests.request(
            "PROPFIND",
            webdav_root,
            auth=(username, password),
            headers={"Depth": "0"},
            timeout=15,
        )

        if resp.status_code == 207:
            return {"ok": True, "message": f"Connected to Nextcloud as: {username}"}

        if resp.status_code == 401:
            return {
                "ok": False,
                "message": (
                    "Authentication failed (401). "
                    "Make sure you are using an **app password**, not your regular login password. "
                    "Create one at: Settings > Security > App passwords"
                ),
            }

        if resp.status_code == 403:
            return {
                "ok": False,
                "message": (
                    "Access denied (403). "
                    "WebDAV may be disabled on this server, or your account lacks permissions. "
                    "Check with your Nextcloud administrator."
                ),
            }

        if resp.status_code == 404:
            return {
                "ok": False,
                "message": (
                    f"WebDAV endpoint not found (404) at: {webdav_root}\n"
                    "Possible causes:\n"
                    "- Server URL is wrong (should be like https://cloud.example.com)\n"
                    "- WebDAV / DAV plugin is disabled on the server\n"
                    "- Username is incorrect"
                ),
            }

        return {"ok": False, "message": f"Unexpected response from server: HTTP {resp.status_code}"}

    except SSLError as e:
        return {
            "ok": False,
            "message": (
                f"SSL certificate error connecting to {server_url}. "
                "If using a self-signed certificate, try http:// instead of https://, "
                "or install the certificate on the server."
            ),
        }
    except ConnectionError as e:
        return {
            "ok": False,
            "message": (
                f"Could not connect to {server_url}. "
                "Check that the server is running and the URL is correct. "
                "If behind a firewall, ensure ports 443 (HTTPS) or 80 (HTTP) are open."
            ),
        }
    except Timeout:
        return {
            "ok": False,
            "message": f"Connection to {server_url} timed out. The server may be slow or unreachable.",
        }
    except Exception as e:
        return {"ok": False, "message": f"Connection error: {e}"}
