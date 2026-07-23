import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def tmp_data_dir(tmp_path):
    """Provide a temp directory and patch module-level file paths."""
    return tmp_path


@pytest.fixture()
def test_config():
    return {
        "destinations": ["/tmp/test_dest"],
        "filename_template": "{year}-{month}-{day}/{planned_title}_{deck_name}_Slot{slot_id}{ext}",
        "hyperdecks": {"TestDeck": "192.168.1.100"},
        "stage_mode": "global",
        "global_stage": "Main Stage",
        "deck_stages": {},
        "schedule_auto_mode": True,
        "schedule_max_drift_minutes": 45,
        "slate_metadata": {
            "global": {},
            "per_deck": {},
            "per_event": {},
        },
    }


@pytest.fixture()
def client(tmp_data_dir, test_config):
    """Create a TestClient with config/schedule paths pointed at temp dir."""
    config_path = str(tmp_data_dir / "config.json")
    schedule_path = str(tmp_data_dir / "schedule.json")

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(test_config, f)
    with open(schedule_path, "w", encoding="utf-8") as f:
        json.dump([], f)

    import app.backend.server as srv
    orig_config = srv.CONFIG_FILE
    orig_schedule = srv.SCHEDULE_FILE
    srv.CONFIG_FILE = config_path
    srv.SCHEDULE_FILE = schedule_path

    with TestClient(srv.app) as c:
        yield c

    srv.CONFIG_FILE = orig_config
    srv.SCHEDULE_FILE = orig_schedule
