# Creating Schedule Plugins

Plugins let you populate the schedule from external sources — spreadsheets, CSV files, web scrapers, APIs, databases, or anything else that can produce a list of events.

## Quick Start

Create a Python file in `app/backend/plugins/`:

```python
# app/backend/plugins/my_plugin.py

PLUGIN_LABEL = "My Schedule Plugin"
PLUGIN_DESCRIPTION = "Fetches schedule data from my custom source."

def scrape() -> list[dict[str, str]]:
    return [
        {
            "id": "2026-07-15_1930_evening_service",
            "planned_title": "Evening Service",
            "start_time": "2026-07-15 19:30",
            "stage": "Main Stage",
        },
    ]
```

That's it. The plugin auto-appears in the UI under **Schedule Source**.

## Plugin Manifest

These module-level variables control how the plugin is displayed:

| Variable | Type | Required | Description |
|---|---|---|---|
| `PLUGIN_LABEL` | `str` | No | Human-readable name shown in the UI. Defaults to a title-cased version of the filename. |
| `PLUGIN_DESCRIPTION` | `str` | No | Short description shown under the label. Defaults to `"No plugin description provided."` |
| `PLUGIN_SUPPORTS_FILE_UPLOAD` | `bool` | No | If `True`, the UI shows an upload button for this plugin. Defaults to `False`. |

Example:

```python
PLUGIN_LABEL = "Festival Program Scraper"
PLUGIN_DESCRIPTION = "Scrapes the festival website and converts the program into schedule rows."
PLUGIN_SUPPORTS_FILE_UPLOAD = False
```

## The `scrape()` Function

Every plugin **must** define a `scrape()` function. This is the entry point the system calls when the plugin is executed.

### Signature

```python
def scrape() -> list[dict[str, str]]:
    ...
```

The function can also accept keyword arguments, which are passed from the UI payload:

```python
def scrape(file_path: str = "", **kwargs) -> list[dict[str, str]]:
    ...
```

If the function is `async`, it will be automatically awaited:

```python
async def scrape() -> list[dict[str, str]]:
    ...
```

### Return Value

Must return a **list of dicts**. Each dict represents one schedule event. Supported keys:

| Key | Required | Description |
|---|---|---|
| `id` | Recommended | Unique event identifier. Auto-generated from title + time if missing. |
| `planned_title` | Recommended | Human-readable event name. Used for filename tokens and display. |
| `start_time` | Recommended | Format: `YYYY-MM-DD HH:MM` (e.g. `2026-07-15 19:30`) |
| `stage` | No | Stage/venue name. Leave blank to match regardless of stage. |
| `slate_metadata` | No | Dict of per-event metadata fields (see below). |

### Example Return

```python
return [
    {
        "id": "2026-07-15_1930_main_evening_service",
        "planned_title": "Evening Service",
        "start_time": "2026-07-15 19:30",
        "stage": "Main Stage",
        "slate_metadata": {
            "scene id": "EVE",
            "environment": "interior",
        },
    },
    {
        "id": "2026-07-15_2100_youth_concert",
        "planned_title": "Youth Concert",
        "start_time": "2026-07-15 21:00",
        "stage": "Youth Stage",
    },
]
```

## Plugin Types

### 1. File Upload Plugin

Receives an uploaded file and parses it. Set `PLUGIN_SUPPORTS_FILE_UPLOAD = True`.

```python
from typing import Any

PLUGIN_LABEL = "CSV Schedule Upload"
PLUGIN_DESCRIPTION = "Upload a .csv file and convert rows into schedule entries."
PLUGIN_SUPPORTS_FILE_UPLOAD = True


def scrape(file_path: str = "app/backend/uploads/schedule.csv") -> list[dict[str, str]]:
    import csv
    items = []

    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            planned_title = (row.get("planned_title") or row.get("title") or "").strip()
            start_time = (row.get("start_time") or "").strip()
            stage = (row.get("stage") or "").strip()

            if not planned_title and not start_time:
                continue

            items.append({
                "id": f"{start_time}_{planned_title}".replace(" ", "_").lower(),
                "planned_title": planned_title,
                "start_time": start_time,
                "stage": stage,
            })

    return items
```

The uploaded file is saved to `app/backend/uploads/` before `scrape()` is called. The `file_path` parameter receives the full path to the saved file.

### 2. Web Scraper Plugin

Fetches data from a URL. Use `async def scrape()` with `asyncio.to_thread()` to avoid blocking the event loop.

```python
import asyncio
import re
import requests
from bs4 import BeautifulSoup

PLUGIN_LABEL = "Event Website Scraper"
PLUGIN_DESCRIPTION = "Scrapes event data from a website."


def _fetch_events() -> list[dict[str, str]]:
    response = requests.get("https://example.com/events", timeout=25)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    items = []

    for event in soup.select(".event-row"):
        title = event.select_one(".event-title").get_text(strip=True)
        date = event.select_one(".event-date").get_text(strip=True)
        time = event.select_one(".event-time").get_text(strip=True)
        venue = event.select_one(".event-venue").get_text(strip=True)

        items.append({
            "id": f"{date}_{time}_{venue}".replace(" ", "_"),
            "planned_title": title,
            "start_time": f"{date} {time}",
            "stage": venue,
        })

    return items


async def scrape() -> list[dict[str, str]]:
    return await asyncio.to_thread(_fetch_events)
```

### 3. API/Database Plugin

Query any API or database and map the results:

```python
import asyncio
import httpx

PLUGIN_LABEL = "Google Calendar Sync"
PLUGIN_DESCRIPTION = "Imports events from a Google Calendar API."


async def scrape() -> list[dict[str, str]]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://www.googleapis.com/calendar/v3/events",
            params={"key": "YOUR_API_KEY", "calendarId": "primary"},
            timeout=30,
        )
        resp.raise_for_status()
        events = resp.json().get("items", [])

    items = []
    for event in events:
        start = event.get("start", {}).get("dateTime", "")
        items.append({
            "id": event.get("id", ""),
            "planned_title": event.get("summary", "Untitled"),
            "start_time": start[:16].replace("T", " "),
            "stage": event.get("location", ""),
        })

    return items
```

## Slate Metadata

Per-event metadata fields can be included via the `slate_metadata` key. These are resolved at record time using the scope chain: `global` -> `per_deck` -> `per_event`.

```python
return [
    {
        "id": "opening_2026",
        "planned_title": "Opening Ceremony",
        "start_time": "2026-07-15 18:00",
        "stage": "Main Stage",
        "slate_metadata": {
            "scene id": "OPN",
            "environment": "interior",
            "day night": "day",
            "location detail": "front of house",
        },
    },
]
```

## File Naming Rules

- Plugin filenames must match `[a-zA-Z0-9_]+` (letters, digits, underscores only).
- Each plugin is a single `.py` file in `app/backend/plugins/`.
- The filename (without `.py`) is the plugin's internal name.

## API Endpoints

Plugins are managed through these endpoints:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/plugins` | List all discovered plugins with manifest info |
| `POST` | `/api/plugins/run/{plugin_name}` | Execute a plugin's `scrape()` function |
| `POST` | `/api/plugins/upload/{plugin_name}` | Upload a file then run the plugin |

## Bundled Plugins

| Plugin | Type | Description |
|---|---|---|
| `excel_schedule_uploader` | File upload | Parse `.xlsx` spreadsheets into schedule rows |
| `csv_schedule_uploader` | File upload | Parse `.csv` files into schedule rows |
| `gullbrannafestivalen_scraper` | Web scraper | Fetches the Gullbranna festival program |

## Troubleshooting

**Plugin doesn't appear in the UI**
- Check the filename contains only `[a-zA-Z0-9_]` characters.
- Ensure the file is in `app/backend/plugins/`.
- Verify `scrape()` is defined at module level.

**Plugin returns zero items**
- The schedule is not cleared on empty results — existing data is preserved.
- Check the returned list is not empty.
- Ensure each item has at least `planned_title` or `start_time`.

**Async scraping blocks the server**
- Use `asyncio.to_thread()` to wrap blocking I/O calls.
- Or use an async HTTP client (`httpx`, `aiohttp`) instead of `requests`.
