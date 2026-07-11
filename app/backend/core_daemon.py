# Inside core_daemon.py
import os
import json
import datetime

ACTIVE_EVENT_FILE = "app/backend/active_event.json"

# Shared runtime cache for deck state snapshots exposed via /api/state.
global_deck_state_cache: dict[str, dict] = {}

def get_live_event_title() -> str:
    """Reads the active event configuration written by the web server."""
    if os.path.exists(ACTIVE_EVENT_FILE):
        try:
            with open(ACTIVE_EVENT_FILE, 'r') as f:
                data = json.load(f)
                return data.get("planned_title", "").strip()
        except Exception:
            pass
    return ""

def get_weekday_sv3(now: datetime.datetime) -> str:
    # Swedish 3-letter weekday abbreviations, ASCII-safe for filenames.
    weekday_names = ["man", "tis", "ons", "tor", "fre", "lor", "son"]
    return weekday_names[now.weekday()]

def generate_target_filename(deck_name: str, template: str, stage: str = "") -> str:
    now = datetime.datetime.now()
    safe_deck_name = deck_name.replace(" ", "_")
    title_context = get_live_event_title()
    
    # Smart Fallback: If no event title was selected or it's empty, use the date/time string format
    if not title_context:
        return f"{now.strftime('%Y%m%d_%H%M')}_{safe_deck_name}.mov"
        
    # Standard Token Template resolution
    tokens = {
        "deck_name": safe_deck_name,
        "stage": stage.replace(" ", "_") if stage else "",
        "planned_title": title_context.replace(" ", "_"),
        "year": now.strftime("%Y"),
        "month": now.strftime("%m"),
        "day": now.strftime("%d"),
        "weekday_sv3": get_weekday_sv3(now),
    }
    return template.format(**tokens)