# Web Presenter Setup Guide

## Quick Start

### Run Both Services (Recommended)

```bash
python run_both.py
```

This starts both HyperDeck (port 8008) and Web Presenter (port 8009) simultaneously.

### Run Individual Services

```bash
# HyperDeck only
python run.py                    # port 8008

# Web Presenter only
python run_webpresenter.py       # port 8009
```

### Development Mode (Hot Reload)

```bash
# Both with hot reload
python run_both.py --reload

# Individual with hot reload
HD_RELOAD=true python run.py
WP_RELOAD=true python run_webpresenter.py
```

With hot reload enabled, the server automatically restarts when you change Python files.

## Architecture

```
HyperDeck App (port 8008)          Web Presenter App (port 8009)
├── run.py                         ├── run_webpresenter.py
├── app/backend/server.py          ├── app/backend/wp_server.py
├── app/backend/core_daemon.py     ├── app/backend/wp_daemon.py
├── app/backend/hyperdeck_control  ├── app/backend/wp_control.py
└── TCP port 9993                  └── TCP port 9977

run_both.py — Starts both services in parallel

Shared:
├── schedule.json                  (same schedule data)
├── active_event.json              (same active event)
├── config.json                    (same config file)
└── app/frontend/                  (same UI, tab-based)
```

## Tab-Based UI

When both services are running, the web UI shows two tabs:

| Tab | Port | Controls |
|-----|------|----------|
| **HyperDeck** | 8008 | Record/Stop, file transfers, deck settings |
| **Web Presenter** | 8009 | Stream Start/Stop, stream config, key plugins |

Each tab only appears if the corresponding service is running. If you open port 8009 directly, you'll see the Web Presenter tab and can still access HyperDeck features if port 8008 is also running.

## Web Presenter Features

### Device Management
- Add devices manually or scan the network
- Assign roles: **Primary** or **Backup**
- Assign **Stages** (e.g., "Main Stage", "Stage B")

### Stream Configuration
- **Protocol**: RTMP or SRT
- **Platform**: YouTube, Twitch, Facebook, Restream.IO, Custom
- **Quality**: Streaming High/Medium/Low, HyperDeck High/Medium/Low
- **Video Mode**: Auto, 1080p59.94, 1080p50, 720p60, etc.
- **Primary/Backup URLs and Keys**

### Stream Profiles
- Save current stream config as a named profile
- Apply profiles to quickly switch configurations
- Reuse profiles across events

### Stream Key Plugins
- **Custom**: Manual entry of RTMP URLs and keys
- **YouTube Live**: Auto-fetch keys from YouTube API (requires OAuth2 setup)

### Schedule Management
- Add, edit, delete schedule events
- Import CSV/XLSX files
- Filter events (All, Today, Upcoming, Past)
- **Stage events** — load event's stream config into the form
- Each event can store its own stream keys and endpoints

### Push to Devices
- Push stream settings from the form to all Web Presenters via TCP
- Settings include: platform, quality, video mode, stream key/URL

## Configuration

### Config File (`config.json`)

```json
{
    "webpresenters": {
        "WP_Main": "192.168.1.150",
        "WP_Backup": {"ip": "192.168.1.151", "port": 9977}
    },
    "wp_presenter_roles": {
        "WP_Main": "primary",
        "WP_Backup": "backup"
    },
    "wp_stages": {
        "WP_Main": "Main Stage",
        "WP_Backup": "Main Stage"
    },
    "wp_default_quality": "Streaming Medium",
    "wp_auto_sync_interval": 2
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HD_PORT` | `8008` | HyperDeck HTTP port |
| `WP_PORT` | `8009` | Web Presenter HTTP port |
| `HD_HOST` | `0.0.0.0` | HyperDeck bind address |
| `WP_HOST` | `0.0.0.0` | Web Presenter bind address |
| `HD_RELOAD` | `false` | Enable HyperDeck hot reload |
| `WP_RELOAD` | `false` | Enable Web Presenter hot reload |

## API Endpoints

### Web Presenter API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/wp/presenters` | List all configured presenters |
| `POST` | `/api/wp/presenters` | Add/update a presenter (with role, stage) |
| `DELETE` | `/api/wp/presenters/{name}` | Remove a presenter |
| `GET` | `/api/wp/discover` | Scan network for devices |
| `POST` | `/api/wp/stream/start` | Start stream on selected units |
| `POST` | `/api/wp/stream/stop` | Stop stream on selected units |
| `POST` | `/api/wp/stream/start-all` | Start all streams |
| `POST` | `/api/wp/stream/stop-all` | Stop all streams |
| `GET` | `/api/wp/active` | Get active stream config |
| `POST` | `/api/wp/active` | Set active stream config |
| `GET` | `/api/wp/state` | Get all device states |
| `GET` | `/api/wp/events` | SSE real-time updates |
| `GET` | `/api/wp/{host}/settings` | Get device settings |
| `POST` | `/api/wp/{host}/settings` | Update device settings |
| `GET` | `/api/wp/schedule` | Get schedule |
| `POST` | `/api/wp/schedule` | Save schedule |
| `GET` | `/api/wp/profiles` | List stream profiles |
| `POST` | `/api/wp/profiles` | Save/update a profile |
| `DELETE` | `/api/wp/profiles/{name}` | Delete a profile |
| `GET` | `/api/wp/plugins/keys` | List key plugins |
| `POST` | `/api/wp/plugins/keys/fetch/{name}` | Fetch keys from plugin |
| `GET` | `/api/wp/plugins/keys/youtube/config` | Get YouTube config |
| `POST` | `/api/wp/plugins/keys/youtube/config` | Save YouTube config |

### Shared API (available on both ports)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/schedule` | Get schedule (shared) |
| `GET` | `/api/schedule/active` | Get active event (shared) |

## Troubleshooting

### "Connection refused" when accessing the other service
- Ensure both services are running
- Check that the ports are not blocked by firewall
- Verify no other process is using the ports

### Hot reload not working
- Ensure `HD_RELOAD=true` or `WP_RELOAD=true` is set
- Hot reload only watches Python files, not static frontend files
- For frontend changes, refresh the browser manually

### Web Presenter not found during scan
- Ensure the device is on the same subnet
- Check that port 9977 is not blocked
- Try adding the device manually by IP

### Stream won't start
- Verify stream keys are configured (use Stream Key Plugins)
- Check that the RTMP/SRT server is reachable
- Ensure the device cache isn't full (Cache > 90%)
