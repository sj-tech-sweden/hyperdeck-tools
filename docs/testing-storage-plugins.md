# Testing the plugins

This document is the test plan for the **storage** and **keys** plugin
families. The **metadata** plugins (CSV uploader, Excel uploader, Gullbranna
scraper) are already well covered and are not repeated here.

## Plugin inventory

### Storage plugins (`app/backend/plugins/storage/`)

| Plugin | Type | Offline-testable? | Mock backend used in compose |
|--------|------|-------------------|------------------------------|
| Amazon S3 | `s3` | Yes | Garage (`garage`) |
| SMB / CIFS | `smb` | Yes | Samba (`samba`) |
| NFS | `nfs` | Yes (see caveat) | `nfs-server-alpine` (`nfs`) |
| Nextcloud | `nextcloud` | Yes | Nextcloud (`nextcloud`) |
| SharePoint / OneDrive | `sharepoint` | **No** | — (needs a real Microsoft 365 tenant) |

### Keys plugins (`app/backend/plugins/keys/`)

| Plugin | Type | Offline-testable? | Notes |
|--------|------|-------------------|-------|
| Manual Entry | `custom` | Yes | Reads `app/backend/active_stream.json` |
| YouTube Live | `youtube` | **No** | Needs real Google OAuth + an active broadcast |

The YouTube **Live** keys plugin and the SharePoint **storage** plugin are the
two that must be pointed at the real services (you already noted this).

---

## 1. Offline storage plugins — docker-compose harness

The compose file spins up the app plus a mock backend for every offline storage
plugin so you can exercise `test_connection()` and a real `send_file()` upload
without any external account.

```bash
# By default Garage (the S3 backend) is skipped — start the other backends:
docker compose -f docker-compose.storage-test.yml up -d --build

# To also test the S3 plugin, bring Garage up in its profile:
docker compose -f docker-compose.storage-test.yml --profile s3 up -d --build
```

- App (HyperDeck control panel + Storage Destinations UI): <http://localhost:8008>
- Nextcloud: <http://localhost:8080>
- Garage (only with `--profile s3`): S3 API on <http://localhost:3900>,
  web admin on <http://localhost:3902>. The `hyperdeck` bucket and an API key
  are created by the `garage-init` container — see the S3 section for how to
  read the key.

> **Two ways to run the app — pick one, and match the hostnames accordingly:**
>
> 1. **In Docker (recommended):** let the `app` service run the app. All plugin
>    dependencies (`boto3`, `smbprotocol`, `requests`) are baked into the image, so
>    nothing to install, and destination configs use the **internal** hostnames
>    `garage`, `samba`, `nfs`, `nextcloud`.
> 2. **Natively on the host:** run `python run_both.py` yourself and start only
>    the backend containers, e.g.
>    `docker compose -f docker-compose.storage-test.yml up -d samba garage nextcloud nfs`.
>    Then the app runs on the host, so destination configs must use **`localhost`**
>    plus the published ports (SMB `445`, Garage `3900`, Nextcloud `8080`). Also
>    make sure your venv has the plugin deps: `pip install -r requirements.txt`
>    (this is what fixes `smbprotocol is not installed`).
>
> If you get `smbprotocol is not installed` / `boto3 is required` / `requests is
> not installed`, that is the plugin telling you a dependency is missing from the
> environment running the app — install `requirements.txt` (native mode) or use
> the `app` container (docker mode).

### Default credentials / endpoints in the harness

| Backend | What to enter in the destination config |
|---------|------------------------------------------|
| Garage (S3) | bucket `hyperdeck`, endpoint `http://garage:3900`, region `garage`, access key / secret key = the values printed by `garage-init` (see below) |
| Samba (SMB) | server `samba`, share `public`, username `hyperdeck`, password `hyperdeck`, port `445` |
| NFS | server `nfs`, share `/exports`, mount point `/mnt/hyperdeck_nfs` |
| Nextcloud | server URL `http://nextcloud:80`, username `admin`, password = the **app password** you generate in Nextcloud |

### Per-plugin test steps

For each destination, in the UI (<http://localhost:8008> → Storage
Destinations): Add destination → fill the config above → **Test Connection**
→ should report OK → **Save** (enabled).

Then run the smoke test that uploads a sample file to every enabled destination:

```bash
docker compose -f docker-compose.storage-test.yml exec app \
    python scripts/test_storage_upload.py
```

#### S3 / Garage
- Only runs when you start the stack with `--profile s3`.
- `garage-init` bootstraps a single-node cluster, creates the `hyperdeck`
  bucket, and creates an API key. Read the key (Access Key ID + Secret Key)
  from its logs:
  ```bash
  docker compose -f docker-compose.storage-test.yml --profile s3 logs garage-init
  ```
- In the S3 destination config use: endpoint `http://garage:3900`, region
  `garage`, bucket `hyperdeck`, and the access/secret key from the logs above.
- `test_connection` → `Connected to bucket: hyperdeck`
- After smoke test, verify the upload landed in the bucket from the app
  container (which already has boto3). Substitute the real key values:
  ```bash
  docker compose -f docker-compose.storage-test.yml exec app python -c \
    "import boto3; c=boto3.client('s3',endpoint_url='http://garage:3900',aws_access_key_id='<ACCESS>',aws_secret_access_key='<SECRET>',region_name='garage'); print([o['Key'] for o in c.list_objects_v2(Bucket='hyperdeck').get('Contents',[])])"
  ```
  Prefix, if set, is honoured.

> **Idempotent re-runs.** `garage-init` persists its key credentials on the
> `garage_creds` volume and re-allows the bucket by **key id** (never by name),
> so you can run it as many times as you like — it will not create duplicate
> keys or leave the bucket unauthorised. Re-running simply re-applies the same
> permissions. This also means the printed credentials are stable across
> restarts.

#### SMB / CIFS
- `test_connection` → `Connected to \\samba\public`
- After smoke test:
  ```bash
  docker compose -f docker-compose.storage-test.yml exec samba ls -la /share
  ```
  The uploaded `storage_test_*.txt` should be listed. Subfolder, if set, is
  created automatically.
- **Note:** the `dperson/samba` `-s` flag format is
  `"<name>;<path>[;browsable;readonly;guest;users]"`. The compose uses
  `-s "public;/share;yes;no;no;hyperdeck"` (user `hyperdeck`, no guest access)
  plus `-p` so the share gets correct permissions. The container will exit at
  startup if the `-s` syntax is wrong for the pulled image version.

#### NFS
- `test_connection` → `Connected to nfs:/exports`
- After smoke test, the file is written through the mount to the server's
  `/exports`. Verify via the shared volume:
  ```bash
  docker run --rm -v hyperdeck-tools_nfs-data:/data busybox ls -la /data
  ```
- **Caveat — the NFS *server* is the problem, not the plugin.** The `nfs`
  container needs privileged access to `/proc/fs/nfsd`. It works on a real
  Linux host, but on **Docker Desktop (macOS/Windows)** the LinuxKit VM usually
  lacks the NFS kernel module, so the container logs
  `rpc.nfsd: Unable to access /proc/fs/nfsd` and loops forever. In that case,
  test the NFS plugin from the **host** instead of from a container:
  - **macOS:** enable the built-in NFS server and export a folder, e.g.
    ```bash
    echo "/System/Volumes/Data/export -alldirs -mapall=$(whoami)" | sudo tee /etc/exports
    sudo nfsd enable && sudo nfsd restart
    ```
    Then configure the NFS destination with server `localhost`, share
    `/System/Volumes/Data/export` (or whatever you exported), mount point
    `/mnt/hyperdeck_nfs`, and run the app natively so it can mount it.
  - **Linux:** `sudo apt install nfs-kernel-server`, export a dir in
    `/etc/exports`, `sudo exportfs -ra`, and point the destination at
    `localhost`.
  - The plugin code path (`send_file` / `test_connection`) is identical — only
    the server location differs.

#### Nextcloud
- First-run setup: open <http://localhost:8080>, create the admin user
  (`admin` / pick a password), let it finish installing (SQLite is fine for
  testing).
- Then: Personal settings → **Security** → create an **app password**
  (e.g. name `hyperdeck`). Use that app password (not your login password) as
  the destination `password`.
- `test_connection` → `Connected to Nextcloud as: admin`
- After smoke test: browse Nextcloud Files → `/HyperDeck` (or the folder you
  configured) and confirm the `storage_test_*.txt` upload.

---

## 2. Keys plugins

### Manual Entry (`custom`) — offline

This plugin simply reads `app/backend/active_stream.json`.

1. Write a known payload, e.g.:
   ```json
   {
     "event_id": "test-123",
     "primary_url": "rtmp://ingest.example/live",
     "primary_key": "abc-key",
     "backup_url": "rtmp://backup.example/live",
     "backup_key": "xyz-key"
   }
   ```
2. Confirm the plugin returns it:
   ```bash
   docker compose -f docker-compose.storage-test.yml exec app python -c \
     "import sys; sys.path.insert(0,'.'); from app.backend.plugins.keys.custom import fetch_keys; print(fetch_keys())"
   ```
   Expect the same `primary_url` / `primary_key` / `backup_url` / `backup_key`
   values back.
3. In the Web Presenter UI, the stream-key fields should populate from this
   file when streaming starts.

### YouTube Live (`youtube`) — online only

Requires a real Google Cloud OAuth client and a refresh token. Full
step-by-step setup (creating the OAuth client, obtaining a refresh token, and
config file format) is in **[`docs/youtube-keys-setup.md`](youtube-keys-setup.md)**.

In short:

1. Create a Google Cloud project, enable **YouTube Data API v3**, and make an
   OAuth 2.0 client ID + secret.
2. Obtain a `refresh_token` with the `https://www.googleapis.com/auth/youtube`
   scope (e.g. via the OAuth 2.0 Playground).
3. Set the credentials — either env vars on the app
   (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`) or a
   config file at `app/backend/youtube_config.json`
   (`{ "client_id": …, "client_secret": …, "refresh_token": … }`).
4. Start an **active** YouTube live broadcast in Studio.
5. Call `fetch_keys()` (async) and confirm it returns a non-empty
   `primary_url` (ingestion address) and `primary_key` (stream name).
6. Expect a clear error (not a crash) when credentials are missing or there is
   no active broadcast — that error handling is part of what to verify.

---

## 3. Online-only plugins (real services)

- **SharePoint / OneDrive** (`sharepoint`): configure a real tenant, site, and
  app registration; run `test_connection` then a real upload and verify the
  file lands in the target document library.
- **YouTube Live** (keys): as above.

These are deliberately excluded from the compose harness because they need real
accounts.

## 4. Cleanup

```bash
docker compose -f docker-compose.storage-test.yml down
# remove the mock data volumes too, if desired:
docker compose -f docker-compose.storage-test.yml down -v
```
