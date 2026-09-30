import datetime
import html
import re

import requests

PLUGIN_LABEL = "Gullbranna Festival Program"
PLUGIN_DESCRIPTION = "Fetches and converts the Gullbranna festival program into schedule rows."

PLUGIN_INPUTS = [
    {
        "name": "year",
        "label": "Festival Year",
        "type": "number",
        "placeholder": "yyyy",
        "default": "current_year",
        "min": 2000,
        "max": 2100,
        "help": "pre-filled with current year; use arrows for other years",
    },
]

API_BASE = "https://gullbrannafestivalen.com/wp-json/tribe/events/v1/events"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    )
}


def clean_title(value: str) -> str:
    cleaned = html.unescape(value or "").strip()
    # Strip any residual HTML tags.
    cleaned = re.sub(r"<[^>]+>", "", cleaned)
    replacements = {
        "\u00e5": "a",
        "\u00e4": "a",
        "\u00f6": "o",
        "\u00c5": "A",
        "\u00c4": "A",
        "\u00d6": "O",
        "\u2013": "-",
        "\u2014": "-",
    }
    for old, new in replacements.items():
        cleaned = cleaned.replace(old, new)

    cleaned = cleaned.replace(" ", "_")
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = re.sub(r"[^\w\-_]", "", cleaned)
    return cleaned


def _event_to_row(event: dict[str, str]) -> dict[str, str] | None:
    title_raw = event.get("title") or ""
    title = clean_title(title_raw)
    if not title:
        return None

    start = (event.get("start_date") or "")[:16]  # "YYYY-MM-DD HH:MM"
    if not start:
        return None

    venue = event.get("venue") or {}
    venue_name = venue.get("venue") if isinstance(venue.get("venue"), str) else ""
    if not venue_name and isinstance(venue.get("venue"), dict):
        venue_name = venue["venue"].get("venue") or ""
    stage = (venue_name or "unknown_stage").strip()

    start_time = start
    unique_id = f"{start_time}_{clean_title(stage)}_{title}".lower()

    return {
        "id": unique_id,
        "planned_title": title,
        "start_time": start_time,
        "stage": stage,
    }


def fetch_schedule(year: int | None = None) -> list[dict[str, str]]:
    if not year:
        year = datetime.datetime.now().year
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"

    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    page = 1
    while True:
        params = f"?per_page=50&page={page}&start_date={start_date}&end_date={end_date}"
        response = requests.get(API_BASE + params, headers=HEADERS, timeout=30)
        response.raise_for_status()
        data = response.json()
        events = data.get("events", [])
        for event in events:
            row = _event_to_row(event)
            if not row:
                continue
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            rows.append(row)
        total_pages = int(data.get("total_pages", 1) or 1)
        if page >= total_pages or not events:
            break
        page += 1

    return rows


async def scrape(year: int | None = None) -> list[dict[str, str]]:
    import asyncio

    return await asyncio.to_thread(fetch_schedule, year)
