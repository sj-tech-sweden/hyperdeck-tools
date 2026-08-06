"""Microsoft SharePoint / OneDrive storage plugin.

Uploads files to SharePoint document libraries or OneDrive folders
via the Microsoft Graph API. Requires Azure AD app registration.

Setup:
1. Register an app in Azure Portal > App registrations
2. Add API permissions: Files.ReadWrite.All (Delegated) for OneDrive,
   or Sites.ReadWrite.All (Application) for SharePoint app-only
3. For OneDrive: generate a refresh token via OAuth2 flow
4. For SharePoint app-only: create a client secret
"""

import logging
import os

logger = logging.getLogger(__name__)

PLUGIN_LABEL = "SharePoint / OneDrive"
PLUGIN_DESCRIPTION = "Upload files to SharePoint or OneDrive via Microsoft Graph API"
PLUGIN_STORAGE_TYPE = "sharepoint"
PLUGIN_CONFIG_FIELDS = [
    {"key": "tenant_id", "label": "Tenant ID", "type": "text", "required": True, "default": ""},
    {"key": "client_id", "label": "Client ID (Application)", "type": "text", "required": True, "default": ""},
    {"key": "client_secret", "label": "Client Secret", "type": "password", "required": True, "default": ""},
    {
        "key": "auth_mode", "label": "Auth Mode (onedrive / sharepoint_app)",
        "type": "text", "required": True, "default": "onedrive",
    },
    {
        "key": "refresh_token", "label": "Refresh Token (for OneDrive)",
        "type": "password", "required": False, "default": "",
    },
    {
        "key": "site_url", "label": "SharePoint Site URL (for SharePoint)",
        "type": "text", "required": False, "default": "",
    },
    {
        "key": "drive_path", "label": "Drive Path (folder path in the drive)",
        "type": "text", "required": False, "default": "/HyperDeck",
    },
]


def _get_access_token(config: dict) -> str:
    """Acquire an access token using MSAL."""
    try:
        import msal
    except ImportError:
        raise ImportError("msal is required for SharePoint/OneDrive. Install with: pip install msal")

    tenant_id = config.get("tenant_id", "")
    client_id = config.get("client_id", "")
    client_secret = config.get("client_secret", "")
    auth_mode = config.get("auth_mode", "onedrive").lower()

    if not tenant_id or not client_id or not client_secret:
        raise ValueError("tenant_id, client_id, and client_secret are required")

    authority = f"https://login.microsoftonline.com/{tenant_id}"

    if auth_mode == "sharepoint_app":
        app = msal.ConfidentialClientApplication(
            client_id,
            authority=authority,
            client_credential=client_secret,
        )
        result = app.acquire_token_for_client(
            scopes=["https://graph.microsoft.com/.default"],
        )
    else:
        refresh_token = config.get("refresh_token", "")
        if not refresh_token:
            raise ValueError("refresh_token is required for OneDrive auth mode")

        app = msal.PublicClientApplication(
            client_id,
            authority=authority,
        )
        result = app.acquire_token_by_refresh_token(
            refresh_token,
            scopes=["https://graph.microsoft.com/.default"],
        )

    if "access_token" in result:
        return result["access_token"]

    error = result.get("error_description", result.get("error", "Unknown error"))
    raise RuntimeError(f"Failed to acquire token: {error}")


def _get_drive_base_url(config: dict) -> str:
    """Get the Graph API base URL for the configured drive."""
    auth_mode = config.get("auth_mode", "onedrive").lower()
    if auth_mode == "sharepoint_app":
        site_url = config.get("site_url", "").strip().rstrip("/")
        if not site_url:
            raise ValueError("site_url is required for SharePoint auth mode")
        import urllib.parse
        encoded_site = urllib.parse.quote(site_url, safe="")
        return f"https://graph.microsoft.com/v1.0/sites/{encoded_site}/drive/root"
    else:
        return "https://graph.microsoft.com/v1.0/me/drive/root"


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured SharePoint/OneDrive drive."""
    if not os.path.exists(local_path):
        return False

    try:
        token = _get_access_token(config)
        base_url = _get_drive_base_url(config)
        drive_path = config.get("drive_path", "/HyperDeck").strip().rstrip("/")
        upload_path = f"{drive_path}/{remote_name}" if drive_path else remote_name
        import urllib.parse
        encoded_path = urllib.parse.quote(upload_path, safe="/")
        upload_url = f"{base_url}:{encoded_path}:/content"

        import requests

        with open(local_path, "rb") as f:
            resp = requests.put(
                upload_url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream",
                },
                data=f,
                timeout=300,
        )

        if resp.status_code in (200, 201):
            return True

        logger.error("SharePoint upload failed: HTTP %d for %s", resp.status_code, upload_url)
        return False
    except ImportError:
        raise
    except Exception as e:
        logger.error("SharePoint upload error: %s -> %s: %s", local_path, remote_name, e)
        return False


def test_connection(config: dict) -> dict:
    """Test connectivity by fetching the current user or site info."""
    try:
        token = _get_access_token(config)
    except ImportError as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:
        return {"ok": False, "message": str(e)}

    auth_mode = config.get("auth_mode", "onedrive").lower()

    try:
        import requests

        headers = {"Authorization": f"Bearer {token}"}

        if auth_mode == "sharepoint_app":
            site_url = config.get("site_url", "").strip()
            if not site_url:
                return {"ok": False, "message": "site_url is required for SharePoint."}
            import urllib.parse
            encoded_site = urllib.parse.quote(site_url, safe="")
            resp = requests.get(
                f"https://graph.microsoft.com/v1.0/sites/{encoded_site}",
                headers=headers,
                timeout=15,
            )
            if resp.status_code == 200:
                site_data = resp.json()
                name = site_data.get("displayName", site_url)
                return {"ok": True, "message": f"Connected to SharePoint site: {name}"}
            else:
                error = resp.json().get("error", {}).get("message", resp.text[:200])
                return {"ok": False, "message": f"SharePoint error: {error}"}
        else:
            resp = requests.get(
                "https://graph.microsoft.com/v1.0/me",
                headers=headers,
                timeout=15,
            )
            if resp.status_code == 200:
                user = resp.json()
                name = user.get("displayName", user.get("userPrincipalName", "Unknown"))
                return {"ok": True, "message": f"Connected to OneDrive as: {name}"}
            else:
                error = resp.json().get("error", {}).get("message", resp.text[:200])
                return {"ok": False, "message": f"OneDrive error: {error}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
