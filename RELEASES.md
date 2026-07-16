# Release Notes

## v0.1.0 — Initial Release

First stable release of HyperDeck Tools — a web-based control panel for multi-HyperDeck workflows.

### What's Included

**Dashboard & Monitoring**
- Real-time deck status with transport indicators (Record, Play, Stop, Preview, Jog, Shuttle)
- Online/offline detection with color-coded pulse badges
- Per-deck next-event and auto-match info displayed inline
- Live transfer progress with ETA estimation

**Transport Controls**
- Record, Stop, and Play per deck or globally ("Record All" / "Stop All")
- Cue playback by clip ID
- Schedule playback at a future datetime with optional cue clip
- Upload playback files to deck FTP slots

**Network Discovery**
- Automatic subnet scanner that detects HyperDecks on port 9993
- One-click "Add to System" for discovered devices

**Schedule Management**
- Dynamic event matrix with inline editing (ID, title, date, time, stage)
- Scope filtering — view all events or only in-scope events
- Manual row append and delete with autosave
- Active event context with manual or automatic selection
- Auto event selection with configurable drift tolerance

**Automatic File Ingest**
- Detects record-stop transitions on all decks automatically
- Queries deck FTP for the latest recording
- Resolves filename from token-based template
- Distributes files to configured destination folders with deduplication

**Deck Configuration**
- Read and apply settings over TCP: file format, video/audio input, codec, timecode, and more
- Device-driven option discovery with model capability profile fallback
- Slate metadata at three scopes: global → per-deck → per-event
- Settings groups — save, load, apply, and delete named presets

**Card Formatting**
- Format card (exFAT / HFS+) from the UI
- Confirmation checkbox + text input guard before execution

**Manual Recording Transfer**
- Browse recordings on deck via FTP
- Transfer individual files to configured destinations
- Upload files to deck for playback

**Plugin System**
- Auto-discovered Python plugins in `app/backend/plugins/`
- Bundled plugins:
  - `excel_schedule_uploader` — upload `.xlsx` files to populate the schedule
  - `gullbrannafestivalen_scraper` — scrape festival program from the web
- Write your own by adding a `.py` file with a `scrape()` function

**Standalone CLI Daemon**
- `hyperdeck_sync.py` — headless monitoring and ingest without the web UI
- Supports YAML config and CLI argument overrides

**Deployment**
- systemd service support on Linux (documented in README)

### Tech Stack

- **Backend:** FastAPI + Uvicorn (async Python)
- **Frontend:** Vanilla JS + Tailwind CSS v4 (single-page app)
- **Protocol:** HyperDeck Ethernet Control (TCP 9993)
- **File Transfer:** FTP (anonymous)
- **Dependencies:** pyyaml, uvicorn, fastapi, psutil, requests, beautifulsoup4, openpyxl, python-multipart

### Getting Started

```bash
pip install -r requirements.txt
python run.py
```

Open `http://localhost:8008` in your browser.

### Notes

- Schedules are stored in `app/backend/schedule.json`
- Uploaded files are stored in `app/backend/uploads/`
- Plugin scripts live in `app/backend/plugins/`
- Default port: `8008`
