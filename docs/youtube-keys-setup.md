# YouTube Live keys plugin — setup guide

This guide explains how to configure the **YouTube Live** keys plugin so the
Web Presenter tool can automatically fetch the RTMP ingestion address and
stream key for your active YouTube broadcast.

> The plugin is **auto-discovered** — it lives in
> `app/backend/plugins/keys/youtube.py` and shows up as **"YouTube Live"** in
> the keys-plugin selector of the Web Presenter UI. No code changes are needed
> to enable it; you only have to supply OAuth credentials.

## How it works

When the Web Presenter needs a stream key, the plugin:

1. Loads OAuth credentials (from `app/backend/youtube_config.json` or from
   environment variables).
2. Exchanges the **refresh token** for a short-lived **access token** via
   `https://oauth2.googleapis.com/token`.
3. Lists your **active** YouTube live broadcasts (`broadcastStatus=active`).
4. Reads the **bound stream** of that broadcast and returns its RTMP
   `ingestionAddress` (primary + backup) and `streamName`.

Those values are then handed to the encoder exactly like the `custom` plugin's
`active_stream.json` values would be.

### Requirements

- A Google Cloud project with the **YouTube Data API v3** enabled.
- OAuth 2.0 **client ID + secret** (type *Web application* or *Desktop app*).
- A **refresh token** with the `https://www.googleapis.com/auth/youtube`
  scope. The plugin stores the secret and only keeps the refresh token — the
  access token is fetched on demand for every call.
- **An active (live) broadcast** must exist at the moment keys are requested.
  If no broadcast is currently live, the plugin returns an error and the
  Web Presenter falls back to its other behavior.
- The `httpx` package must be installed (it already is in the app image).

## Step 1 — Create the Google Cloud project and OAuth client

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. Enable **YouTube Data API v3** (APIs & Services → Library).
3. APIs & Services → **Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application** (or Desktop app).
   - Note the **Client ID** and **Client secret** — you will need both.
4. Under **OAuth consent screen**, make sure the app is in
   *Testing* mode (or add your Google account as a test user) so you can
   authorize it without going through full verification.
5. On the **Credentials** page, open the OAuth client and add an
   **Authorized redirect URI** pointing back at this app:

   ```
   http://<host>:<port>/api/wp/plugins/keys/youtube/callback
   ```

   The `<host>:<port>` must be **exactly** the URL you open the Web Presenter
   UI in — the backend derives the redirect URI from the incoming request, so
   `http://localhost:8009/...`, `http://192.168.8.13:8009/...` and
   `https://stream.example.com/...` are all different and must each be
   registered if you use more than one.

   > **Google only allows `http://` redirect URIs for `localhost`.** If you open
   > the UI via a LAN IP (`http://192.168.x.x:8009`), Google will reject the
   > callback with `redirect_uri_mismatch`. Two easy ways around this:
   > - **SSH tunnel (simplest):** on your laptop run
   >   `ssh -L 8009:localhost:8009 user@192.168.8.13`, then open
   >   `http://localhost:8009` in the browser. Register the
   >   `http://localhost:8009/.../callback` URI.
   > - **HTTPS:** put the backend behind a reverse proxy with a valid
   >   certificate and register the `https://.../callback` URI.

## Step 2 — Obtain a refresh token

The simplest way is Google's **OAuth 2.0 Playground**:

1. Open <https://developers.google.com/oauthplayground/>.
2. Click the **gear** (⚙) in the top-right and tick
   *Use your own OAuth credentials*. Paste your **Client ID** and
   **Client secret**.
3. In the left panel, find *YouTube Data API v3* and select the scope
   `https://www.googleapis.com/auth/youtube`. Click **Authorize APIs**.
4. Sign in with the Google account that will own the broadcasts and allow
   access.
5. Click **Exchange authorization code for tokens**. The response contains a
   **`refresh_token`** — copy it.

> Keep the refresh token safe. Unlike the access token it does not expire on
> its own, so anyone holding it can start streams on your channel until you
> revoke it.

## Step 3 — Provide the credentials

Pick **one** of the two methods below.

### Option A — config file (recommended)

Create `app/backend/youtube_config.json` (relative to the repo root, i.e.
`/app/app/backend/youtube_config.json` inside the container):

```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "refresh_token": "YOUR_REFRESH_TOKEN"
}
```

Restart the backend (or the whole stack) so the file is picked up.

### Option B — environment variables

Set these where the backend runs:

```bash
export YOUTUBE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
export YOUTUBE_CLIENT_SECRET="YOUR_CLIENT_SECRET"
export YOUTUBE_REFRESH_TOKEN="YOUR_REFRESH_TOKEN"
```

Environment variables take precedence over the config file if both are set.

## Step 4 — Select the plugin in the UI

1. Open the Web Presenter UI (default port `8009`, or `8008` for the combined
   backend depending on your deployment).
2. Choose **YouTube Live** as the keys plugin for the presenter/role you want
   to drive.
3. Make sure you have a **live broadcast** created in YouTube Studio
   (the broadcast must be in the `active`/`live` state when keys are fetched).

When the Web Presenter starts a stream it will now pull the RTMP address and
key straight from YouTube instead of from a manually maintained
`active_stream.json`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `YouTube OAuth2 credentials not configured` | The config file is missing/empty or the env vars are unset. Check `app/backend/youtube_config.json` (or the env vars) contains all three values. |
| `Failed to get access token: …` | Wrong client secret, or the refresh token was revoked. Re-run Step 2 to get a fresh refresh token. |
| `No active YouTube Live broadcast found.` | No broadcast is currently live. Create and start a livestream, then retry. |
| `httpx library not installed` | The backend image is missing `httpx`. Rebuild/upgrade the image; `httpx` is a normal dependency of the app. |
| Got a refresh token once but it stopped working | Refresh tokens can be invalidated if you change the OAuth client, hit the token-count limit, or revoke access. Generate a new one. |
| `422 (Unprocessable Content)` on `/api/wp/plugins/keys/youtube/authorize` | The handler's `request` argument must be typed as `Request`. If you see this, you are on a build before the fix — update to a version that includes it. It means the OAuth request never reached Google. |
| `redirect_uri_mismatch` from Google | The callback URL the app sent does not match an **Authorized redirect URI** in the Google Cloud console. Register the exact URL you browse to (see Step 1.5), and remember Google only allows `http://` for `localhost`. |

## Where are the logs?

The backend mirrors its logs to a rotating file so you can inspect OAuth
problems without a terminal on the host:

- Default location: `/var/log/hyperdeck-tools/webpresenter.log`
  (the Web Presenter service) and `/var/log/hyperdeck-tools/hyperdeck.log`
  (the HyperDeck control panel).
- Override the directory with the `HYPERDECK_LOG_DIR` environment variable, or
  set `log_dir` in `app/backend/config.json`.
- If the directory is not writable the backend prints a note to stderr and
  keeps running — file logging is best-effort and never blocks startup.

## Notes

- The plugin only reads `client_id`, `client_secret`, and `refresh_token`.
  There is **no in-UI settings form** for it — configuration is file/env only.
- Because the access token is refreshed on every call, you do **not** need to
  restart the backend when the access token expires.
- For a self-hosted / non-YouTube workflow, use the `custom` keys plugin
  (`app/backend/plugins/keys/custom.py`) which reads
  `app/backend/active_stream.json` instead.
