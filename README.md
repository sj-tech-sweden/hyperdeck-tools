# HyperDeck Tools

A FastAPI + frontend control panel for multi-HyperDeck workflows with:
- deck monitoring and discovery
- config management (destinations, naming template, stages)
- schedule sync via plugins
- automatic active-event selection with drift control

## Features

- Active Equipment dashboard with per-deck next event and auto-match info
- Stage-aware scheduling:
  - one global stage for all decks
  - or per-deck stage assignment
- Dynamic Event Index Mappings with:
  - in-scope filtering
  - manual row editing
  - date/time/stage support
- Plugin system for schedule ingestion
  - `gullbrannafestivalen_scraper`
  - `excel_schedule_uploader` (default Excel upload plugin)

## UI Screenshot

![HyperDeck Tools UI](docs/images/Screenshot_13-7-2026_14438_localhost.jpeg)

## Requirements

Install dependencies:

```bash
pip install -r requirements.txt
```

## Run

```bash
python run.py
```

Open:
- `http://localhost:8008`

## Excel Upload Plugin

Plugin name: `excel_schedule_uploader`

Use the upload panel in **Active Metadata Schedule** when this plugin is selected.

Bundled sample workbook:
- [templates/schedule_template.xlsx](/Users/samueljorblad/Documents/scripts/hyperdeck-tools/templates/schedule_template.xlsx)

### Supported Excel format (.xlsx)

First row should contain headers. Recommended headers:
- `start_time` (example: `2026-07-15 19:30`)
- `planned_title`
- `stage`
- `id` (optional)

Also supported as alternatives:
- `title` or `event` instead of `planned_title`
- `date` + `time` instead of `start_time`
- `venue` instead of `stage`

### Example rows

| start_time        | planned_title    | stage       | id |
|------------------|------------------|-------------|----|
| 2026-07-15 19:30 | Evening_Service  | Main Stage  |    |
| 2026-07-15 21:00 | Concert          | Youth Stage |    |

If `id` is missing, one is generated automatically.

If you want a starting point, duplicate and edit the bundled template workbook:
- [templates/schedule_template.xlsx](/Users/samueljorblad/Documents/scripts/hyperdeck-tools/templates/schedule_template.xlsx)

## Auto Event Selection

In Service Operations:
- `Automatic Event Selection`:
  - `Enabled`: active event is auto-selected from nearest in-scope event
  - `Disabled`: use manual Set Active
- `Max Time Difference (minutes)` controls drift tolerance

## Tokens

Naming template supports tokens including:
- `{deck_name}`
- `{stage}`
- `{slot_id}`
- `{planned_title}`
- `{original_base}`
- `{ext}`
- `{year}` `{month}` `{day}`

## Notes

- Schedules are saved in `app/backend/schedule.json`.
- Uploaded files are stored in `app/backend/uploads/`.
- Plugin scripts are in `app/backend/plugins/`.
