# Release Notes

## v0.2.0 — UX & Real-Time Improvements

Quality-of-life release focused on real-time updates, schedule usability, and deck configuration flexibility.

### What's New

**Server-Sent Events (SSE)**
- Dashboard now receives live state updates via `/api/events` instead of 2-second polling
- Automatic fallback to polling if SSE connection fails
- Polling pauses when browser tab is backgrounded to save resources

**Drag-and-Drop Schedule Reordering**
- Grab handle (⠿) on each schedule row for intuitive reordering
- Visual drop indicator with indigo highlight on drag-over
- Changes auto-save immediately after drop

**Per-Deck TCP Port Configuration**
- Each deck can now specify a custom TCP port (default 9993)
- Config supports both legacy format (`deck_name: "ip"`) and new format (`deck_name: {ip: "...", port: 9993}`)
- Backwards-compatible — existing configs work without changes

**Keyboard Shortcuts**
- `Ctrl+R` — Record All decks
- `Ctrl+.` — Stop All decks
- `Ctrl+S` — Save Schedule
- `Ctrl+Shift+S` — Save Config
- Shortcuts are disabled when editing text inputs

**Connection Pooling (TCP)**
- New `send_hyperdeck_commands_session()` sends multiple commands over a single TCP session
- Reduces connection overhead for batch operations

**CSV Schedule Import**
- New `csv_schedule_uploader` plugin for importing schedules from `.csv` files
- File input accepts `.csv` alongside `.xlsx`

**Destination Path Validation**
- Config save now validates all destination paths (exists, is directory, writable)
- Warnings returned to UI before persisting

**FTP Transfer Retry Logic**
- Automatic retry (3 attempts with exponential backoff) on FTP download failures
- Applied to all file distribution transfers

**Command Audit Log**
- Ring buffer of last 200 command entries
- New `/api/audit-log` endpoint for viewing recent activity
- Each entry includes timestamp, command, host, deck name, success status

**Health Check Endpoint**
- New `/api/health` returns daemon status, deck counts, and last audit entry

**Disk Space Monitoring**
- New `/api/disk-space` endpoint returns per-destination usage (total, used, free, percent)

### Improvements

- Record button disabled with "Recording" text when deck is actively recording
- Record All button disabled with faded styling when all decks recording
- Status badge colors: red for recording, green for playback, neutral default
- Toast notification system replaces all `alert()` calls with slide-in notifications
- Config caching in memory reduces disk reads on repeated requests
- CORS, reload, host, and port configurable via environment variables

### Bug Fixes

- Fixed `\n` → `\r\n` in HyperDeck prepare/confirm protocol messages
- Fixed recording detection to handle case-insensitive `record` status prefix
- Fixed `queue.empty()` race condition with `queue.get_nowait()` + `QueueEmpty` catch
- Fixed XSS vulnerabilities in inline `value` and `onclick` attributes
- Fixed FTP connection leaks with `try/finally` cleanup
- Fixed thread-unsafe dict mutations with threading lock
- Fixed non-atomic JSON writes with write-to-temp + `os.replace()`
- Fixed response truncation (500 lines, 0.5s per-line timeout)

---

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
- `update.sh` — one-command update script that pulls latest code and refreshes dependencies

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
