# Creating Storage Plugins

Storage plugins let you send transferred files to external storage backends — NFS mounts, S3 buckets, cloud storage, or any custom destination. Files are automatically uploaded after local ingest completes.

> **Note:** This document covers *storage* plugins. For schedule (metadata) plugins, see [creating-plugins.md](creating-plugins.md).

## Quick Start

Create a Python file in `app/backend/plugins/storage/`:

```python
# app/backend/plugins/storage/my_storage.py

PLUGIN_LABEL = "My Storage Backend"
PLUGIN_DESCRIPTION = "Sends files to my custom storage."
PLUGIN_STORAGE_TYPE = "my_storage"
PLUGIN_CONFIG_FIELDS = [
    {"key": "url", "label": "Server URL", "type": "text", "required": True},
]

def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload local_path to remote_name using config."""
    # Your upload logic here
    return True

def test_connection(config: dict) -> dict:
    """Test the connection. Return {"ok": bool, "message": str}."""
    return {"ok": True, "message": "Connected"}
```

The plugin auto-appears in the **Storage Plugin Destinations** section of the configuration panel.

## Plugin Directory Structure

```
app/backend/plugins/
├── metadata/
│   ├── csv_schedule_uploader.py
│   ├── excel_schedule_uploader.py
│   └── gullbrannafestivalen_scraper.py
└── storage/
    ├── __init__.py
    ├── smb.py
    ├── nfs.py
    ├── s3.py
    ├── nextcloud.py
    └── sharepoint.py
```

Storage plugins go in `plugins/storage/`. Schedule plugins go in `plugins/metadata/` (see [creating-plugins.md](creating-plugins.md)).

## Plugin Manifest

These module-level variables control how the plugin is displayed and configured:

| Variable | Type | Required | Description |
| --- | --- | --- | --- |
| `PLUGIN_LABEL` | `str` | No | Human-readable name shown in the UI. Defaults to a title-cased version of the filename. |
| `PLUGIN_DESCRIPTION` | `str` | No | Short description shown under the label. |
| `PLUGIN_STORAGE_TYPE` | `str` | No | Unique identifier for this plugin type. Defaults to the filename. |
| `PLUGIN_CONFIG_FIELDS` | `list[dict]` | No | List of configuration field definitions (see below). |

### Config Field Definition

Each field in `PLUGIN_CONFIG_FIELDS` is a dict with these keys:

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `str` | Yes | Internal field name, used as the key in the config dict. |
| `label` | `str` | No | Display label in the UI. Defaults to `key`. |
| `type` | `str` | No | Input type: `"text"` or `"password"`. Defaults to `"text"`. |
| `required` | `bool` | No | Whether the field is required. Defaults to `False`. |
| `default` | `str` | No | Default value. Defaults to `""`. |

Example:

```python
PLUGIN_CONFIG_FIELDS = [
    {"key": "bucket", "label": "Bucket Name", "type": "text", "required": True},
    {"key": "region", "label": "Region", "type": "text", "default": "us-east-1"},
    {"key": "secret_key", "label": "Secret Key", "type": "password", "required": True},
]
```

## Required Functions

### `send_file(local_path, remote_name, config) -> bool`

Upload a local file to the storage backend.

- **`local_path`** (`str`): Absolute path to the local file to upload.
- **`remote_name`** (`str`): The filename to use on the remote side (e.g., `"20260715_1930_MainStage.mov"`).
- **`config`** (`dict`): The configuration dict from `PLUGIN_CONFIG_FIELDS` values entered by the user.
- **Returns** (`bool`): `True` on success, `False` on failure.

```python
def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    import boto3
    client = boto3.client("s3",
        aws_access_key_id=config["access_key"],
        aws_secret_access_key=config["secret_key"],
    )
    client.upload_file(local_path, config["bucket"], remote_name)
    return True
```

### `test_connection(config) -> dict`

Test that the storage backend is reachable and credentials are valid.

- **`config`** (`dict`): The configuration dict from `PLUGIN_CONFIG_FIELDS` values.
- **Returns** (`dict`): Must contain `"ok"` (bool) and `"message"` (str).

```python
def test_connection(config: dict) -> dict:
    try:
        client = boto3.client("s3",
            aws_access_key_id=config["access_key"],
            aws_secret_access_key=config["secret_key"],
        )
        client.head_bucket(Bucket=config["bucket"])
        return {"ok": True, "message": f"Connected to {config['bucket']}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
```

## How It Works

1. A HyperDeck recording is detected and downloaded locally via FTP.
2. After the local download completes, the system looks for enabled storage destinations.
3. For each enabled destination, the file is queued for upload via `send_file()`.
4. Each destination has its own independent queue with configurable concurrency.
5. Transfers run asynchronously — a slow S3 upload won't block a fast local copy.

## Config Structure

Storage destinations are stored in `config.json`:

```json
{
    "storage_destinations": [
        {
            "id": "s3-prod",
            "plugin_type": "s3",
            "label": "S3 Production",
            "enabled": true,
            "max_concurrent": 3,
            "config": {
                "bucket": "my-prod-bucket",
                "region": "eu-west-1",
                "access_key": "...",
                "secret_key": "..."
            }
        }
    ]
}
```

## API Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/storage-plugins` | List available storage plugin manifests |
| `POST` | `/api/storage-plugins/{type}/test` | Test connection for a plugin config |
| `GET` | `/api/storage-destinations` | List configured storage destinations |
| `POST` | `/api/storage-destinations` | Add or update a storage destination |
| `DELETE` | `/api/storage-destinations/{id}` | Remove a storage destination |
| `GET` | `/api/storage-destinations/{id}/queue` | Get queue status for a destination |

## Bundled Storage Plugins

| Plugin | Type | Description |
| --- | --- | --- |
| `smb` | SMB/CIFS | Upload files to Windows file shares or Samba servers (pure Python, no mounting) |
| `nfs` | NFS | Upload files to NFS shares (auto-mount/unmount, requires root) |
| `s3` | Amazon S3 | Upload files to an S3-compatible bucket |
| `sharepoint` | SharePoint / OneDrive | Upload files to SharePoint or OneDrive via Microsoft Graph API |
| `nextcloud` | Nextcloud | Upload files to a Nextcloud server via WebDAV |

## Creating a Custom Storage Plugin

### Step 1: Create the plugin file

```python
# app/backend/plugins/storage/dropbox.py

PLUGIN_LABEL = "Dropbox"
PLUGIN_DESCRIPTION = "Upload files to Dropbox"
PLUGIN_STORAGE_TYPE = "dropbox"
PLUGIN_CONFIG_FIELDS = [
    {"key": "access_token", "label": "Access Token", "type": "password", "required": True},
    {"key": "path", "label": "Dropbox Path", "type": "text", "default": "/"},
]

def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    import dropbox
    dbx = dropbox.Dropbox(config["access_token"])
    with open(local_path, "rb") as f:
        dbx.files_upload(f.read(), f"{config['path']}/{remote_name}")
    return True

def test_connection(config: dict) -> dict:
    try:
        import dropbox
        dbx = dropbox.Dropbox(config["access_token"])
        dbx.users_get_current_account()
        return {"ok": True, "message": "Connected to Dropbox"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
```

### Step 2: Restart the server

The plugin is discovered automatically on startup.

### Step 3: Configure in the UI

1. Go to **Service Operations** > **Storage Plugin Destinations**
2. Click **+ Add**
3. Select your plugin from the dropdown
4. Fill in the configuration fields
5. Click **Test Connection** to verify
6. Click **Save**

## File Naming Rules

- Plugin filenames must match `[a-zA-Z0-9_]+` (letters, digits, underscores only).
- Each plugin is a single `.py` file in `app/backend/plugins/storage/`.
- The filename (without `.py`) is the plugin's internal name.

## Troubleshooting

**Plugin doesn't appear in the UI**
- Check the filename contains only `[a-zA-Z0-9_]` characters.
- Ensure the file is in `app/backend/plugins/storage/`.
- Verify both `send_file()` and `test_connection()` are defined at module level.
- Restart the server after adding new plugins.

**Upload fails silently**
- Check the server logs for error messages.
- Use the **Test Connection** button to verify credentials.
- Ensure the storage backend is reachable from the server.

**Slow uploads blocking other transfers**
- Reduce `max_concurrent` for the slow destination.
- Each destination has its own queue — slow destinations won't block fast ones.
