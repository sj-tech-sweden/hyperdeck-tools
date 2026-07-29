import datetime
import re
from collections import defaultdict

import requests
from bs4 import BeautifulSoup

PLUGIN_LABEL = "Gullbranna Festival Program"
PLUGIN_DESCRIPTION = "Fetches and converts the Gullbranna festival program into schedule rows."

URL = "https://gullbrannafestivalen.com/program/"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    )
}

SWEDISH_MONTHS = {
    "jan": "01",
    "feb": "02",
    "mar": "03",
    "apr": "04",
    "maj": "05",
    "jun": "06",
    "jul": "07",
    "aug": "08",
    "sep": "09",
    "okt": "10",
    "nov": "11",
    "dec": "12",
}


def detect_festival_year(soup: BeautifulSoup) -> int:
    page_text = soup.get_text(" ", strip=True)
    year_match = re.search(r"\b(20\d{2})\b", page_text)
    if year_match:
        return int(year_match.group(1))
    return datetime.datetime.now().year


def parse_date_to_iso(date_str: str, festival_year: int) -> str:
    day_match = re.search(r"\d+", date_str)
    day = int(day_match.group()) if day_match else 1

    normalized = date_str.lower().strip()
    month_num = "07"
    for prefix, number in SWEDISH_MONTHS.items():
        if prefix in normalized:
            month_num = number
            break

    return f"{festival_year}-{month_num}-{day:02d}"


def clean_title(value: str) -> str:
    cleaned = value.strip()
    replacements = {
        "\u00e5": "a",
        "\u00e4": "a",
        "\u00f6": "o",
        "\u00c5": "A",
        "\u00c4": "A",
        "\u00d6": "O",
    }
    for old, new in replacements.items():
        cleaned = cleaned.replace(old, new)

    cleaned = cleaned.replace(" ", "_")
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = re.sub(r"[^\w\-_]", "", cleaned)
    return cleaned


def _extract_title_from_node(node) -> str:
    parent = node
    for _ in range(4):
        parent = parent.parent
        if not parent:
            break
        heading_tag = parent.find(["h1", "h2", "h3", "h4", "h5", "h6", "strong"])
        if heading_tag and heading_tag.get_text(strip=True):
            candidate = heading_tag.get_text(strip=True)
            if "Datum" not in candidate:
                return candidate

    parent_text = node.parent.get_text(separator=" ", strip=True) if node.parent else ""
    before_datum = parent_text.split("Datum")[0].strip()
    if before_datum:
        return before_datum
    return "Unknown Event"


def fetch_schedule() -> list[dict[str, str]]:
    response = requests.get(URL, headers=HEADERS, timeout=25)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    festival_year = detect_festival_year(soup)
    program: defaultdict[str, dict[str, dict[str, str]]] = defaultdict(dict)

    meta_nodes = soup.find_all(
        lambda tag: tag.name and all(w in tag.get_text() for w in ["Datum", "Tid", "Plats"])
    )

    for node in meta_nodes:
        has_matching_child = any(
            all(w in child.get_text() for w in ["Datum", "Tid", "Plats"])
            for child in node.find_all()
        )
        if has_matching_child:
            continue

        node_text = node.get_text(separator=" ", strip=True)
        date_match = re.search(r"Datum\s+(.*?)\s+Tid", node_text)
        time_match = re.search(r"Tid\s+(.*?)\s+Plats", node_text)
        place_match = re.search(r"Plats\s+(.*?)\s*(Mer info|$)", node_text)

        if not (date_match and time_match and place_match):
            continue

        raw_date = date_match.group(1).strip()
        raw_time = time_match.group(1).strip()
        stage_name = place_match.group(1).split(",")[0].strip() or "unknown_stage"

        iso_date = parse_date_to_iso(raw_date, festival_year)
        start_time = f"{iso_date} {raw_time}"

        raw_title = _extract_title_from_node(node)
        formatted_title = clean_title(raw_title)
        unique_id = f"{start_time}_{clean_title(stage_name)}_{formatted_title}".lower()

        existing = program[stage_name].get(start_time)
        if existing:
            existing["planned_title"] = f"{existing['planned_title']}_and_{formatted_title}"
            continue

        program[stage_name][start_time] = {
            "id": unique_id,
            "planned_title": formatted_title,
            "start_time": start_time,
            "stage": stage_name,
        }

    merged: list[dict[str, str]] = []
    for _, stage_events in sorted(program.items(), key=lambda x: x[0].lower()):
        for _, item in sorted(stage_events.items(), key=lambda x: x[0]):
            merged.append(item)

    return merged


async def scrape() -> list[dict[str, str]]:
    import asyncio
    return await asyncio.to_thread(fetch_schedule)
