from __future__ import annotations

import csv
from typing import Any

PLUGIN_LABEL = "CSV Schedule Upload"
PLUGIN_DESCRIPTION = "Upload a .csv file and convert rows into schedule entries."
PLUGIN_SUPPORTS_FILE_UPLOAD = True


def _norm_header(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


def _build_start_time(row: dict[str, Any]) -> str:
    direct = row.get("start_time") or row.get("start") or row.get("datetime")
    if direct:
        return str(direct).strip()

    date_part = row.get("date")
    time_part = row.get("time")
    if date_part and time_part:
        d = str(date_part).strip()
        t = str(time_part).strip()[:5]
        return f"{d} {t}"
    return ""


def scrape(file_path: str = "app/backend/uploads/schedule.csv") -> list[dict[str, str]]:
    items: list[dict[str, str]] = []

    with open(file_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            return []

        headers = [_norm_header(h) for h in reader.fieldnames]

        for row in reader:
            raw = {_norm_header(k): v for k, v in row.items()}

            start_time = _build_start_time(raw)
            planned_title = str(
                raw.get("planned_title")
                or raw.get("title")
                or raw.get("event")
                or ""
            ).strip()
            stage = str(raw.get("stage") or raw.get("venue") or "").strip()
            row_id = str(raw.get("id") or "").strip()

            if not planned_title and not start_time:
                continue

            if not row_id:
                title_token = planned_title.replace(" ", "_").lower() or "event"
                time_token = start_time.replace(" ", "_").replace(":", "") if start_time else "unscheduled"
                row_id = f"{time_token}_{title_token}"

            item: dict[str, str] = {
                "id": row_id,
                "planned_title": planned_title or row_id,
            }
            if start_time:
                item["start_time"] = start_time
            if stage:
                item["stage"] = stage

            items.append(item)

    return items
