import asyncio
import json

import pytest

from app.backend import wp_daemon as daemon


@pytest.fixture()
def wp_paths(tmp_path):
    daemon.CONFIG_FILE = str(tmp_path / "config.json")
    daemon.SCHEDULE_FILE = str(tmp_path / "schedule.json")
    daemon.STREAM_PROFILES_FILE = str(tmp_path / "stream_profiles.json")
    daemon.PENDING_CHANGES_FILE = str(tmp_path / "pending.json")
    daemon.global_presenter_state_cache.clear()
    yield tmp_path
    daemon.global_presenter_state_cache.clear()


def _write(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def test_resolve_wp_targets_combo(wp_paths):
    config = {
        "webpresenters": {
            "A": {"ip": "10.0.0.1"},
            "B": {"ip": "10.0.0.2"},
            "C": {"ip": "10.0.0.3"},
        },
        "wp_presenter_roles": {"A": "primary", "B": "backup", "C": "primary"},
        "wp_stages": {"A": "Stage1", "B": "Stage1", "C": "Stage2"},
    }
    def names(t):
        return sorted(p["name"] for p in daemon.resolve_wp_targets(config, t))
    assert names({}) == ["A", "B", "C"]
    assert names({"role": "primary"}) == ["A", "C"]
    assert names({"stage": "Stage1"}) == ["A", "B"]
    # role + stage are AND-combined
    assert names({"role": "primary", "stage": "Stage1"}) == ["A"]
    assert names({"role": "primary", "stage": "Stage2"}) == ["C"]
    # explicit hosts override role/stage filters
    assert names({"hosts": ["10.0.0.3"]}) == ["C"]
    assert names({"hosts": ["9.9.9.9"]}) == []
    assert names({"role": "primary", "hosts": ["10.0.0.3"]}) == ["C"]
    # an explicitly empty hosts list matches nothing (not "all")
    assert names({"hosts": []}) == []


def test_build_wp_device_settings_rtmp_role_aware():
    cfg = {
        "protocol": "rtmp", "platform": "YouTube RTMP", "quality": "Streaming High",
        "video_mode": "1080p30", "primary_url": "rtmps://x", "primary_key": "PK",
        "backup_url": "rtmps://y", "backup_key": "BK",
    }
    primary = daemon.build_wp_device_settings({"role": "primary"}, cfg)
    assert primary["Current Server"] == "Primary"
    assert primary["Stream Key"] == "PK"
    assert primary["Video Mode"] == "1080p30"
    assert primary["Current Quality Level"] == "Streaming High"

    backup = daemon.build_wp_device_settings({"role": "backup"}, cfg)
    assert backup["Current Server"] == "Secondary"
    assert backup["Stream Key"] == "BK"


def test_build_wp_device_settings_custom_and_srt():
    custom_cfg = {"protocol": "rtmp", "platform": "Custom URL H.264",
                  "primary_url": "rtmps://x", "primary_key": "PK"}
    custom = daemon.build_wp_device_settings({"role": "primary"}, custom_cfg)
    assert custom["Current Server"] == "Custom"
    assert custom["Current URL"] == "rtmps://x"

    srt = {"protocol": "srt", "srt_primary": "srt://h:port", "srt_passphrase": "pw",
           "srt_backup": "srt://h2:port", "srt_backup_passphrase": "pw2"}
    prim = daemon.build_wp_device_settings({"role": "primary"}, srt)
    assert prim["Current Server"] == "Custom"
    assert prim["Current Platform"] == "Custom URL H.264"
    assert prim["Current URL"] == "srt://h:port"
    assert prim["Password"] == "pw"
    back = daemon.build_wp_device_settings({"role": "backup"}, srt)
    assert back["Current URL"] == "srt://h2:port"
    assert back["Password"] == "pw2"


def test_resolve_event_stream_config(wp_paths):
    _write(daemon.STREAM_PROFILES_FILE,
           [{"name": "YT", "settings": {"protocol": "rtmp", "platform": "YouTube RTMP", "primary_key": "XYZ"}}])
    assert daemon._resolve_event_stream_config({"stream_profile": "YT"})["primary_key"] == "XYZ"
    inline = {"protocol": "rtmp", "primary_key": "ABC"}
    assert daemon._resolve_event_stream_config(inline)["primary_key"] == "ABC"
    # missing profile falls back to inline fields
    assert daemon._resolve_event_stream_config({"stream_profile": "nope", "primary_key": "FB"})["primary_key"] == "FB"


def test_apply_queues_when_streaming(wp_paths, monkeypatch):
    config = {
        "webpresenters": {"A": {"ip": "10.0.0.1"}},
        "wp_presenter_roles": {"A": "primary"},
        "wp_stages": {"A": "Stage1"},
    }
    daemon.global_presenter_state_cache["10.0.0.1"] = {"connected": True, "streaming": True}
    calls = []
    async def fake_set(host, settings, port=9977):
        calls.append(host)
        return True
    monkeypatch.setattr(daemon, "set_stream_settings", fake_set)

    result = asyncio.run(daemon.apply_settings_to_targets(
        {"protocol": "rtmp", "primary_key": "K"}, {"role": "primary"}, config))
    assert result["targets"] == 1
    assert result["results"][0]["status"] == "queued"
    assert calls == []  # not pushed while live
    assert daemon.get_wp_pending_change("10.0.0.1") is not None


def test_apply_applies_when_idle(wp_paths, monkeypatch):
    config = {
        "webpresenters": {"A": {"ip": "10.0.0.1"}},
        "wp_presenter_roles": {"A": "primary"},
        "wp_stages": {"A": "Stage1"},
    }
    daemon.global_presenter_state_cache["10.0.0.1"] = {"connected": True, "streaming": False}
    calls = []
    async def fake_set(host, settings, port=9977):
        calls.append(host)
        return True
    monkeypatch.setattr(daemon, "set_stream_settings", fake_set)

    result = asyncio.run(daemon.apply_settings_to_targets(
        {"protocol": "rtmp", "primary_key": "K"}, {"role": "primary"}, config))
    assert result["results"][0]["status"] == "applied"
    assert calls == ["10.0.0.1"]


def test_profiles_apply_endpoint(wp_paths, monkeypatch):
    import app.backend.wp_server as wp_srv
    wp_srv.CONFIG_FILE = daemon.CONFIG_FILE
    wp_srv.SCHEDULE_FILE = daemon.SCHEDULE_FILE
    wp_srv.STREAM_PROFILES_FILE = daemon.STREAM_PROFILES_FILE
    _write(daemon.CONFIG_FILE, {
        "webpresenters": {"A": {"ip": "10.0.0.1"}},
        "wp_presenter_roles": {"A": "primary"},
        "wp_stages": {"A": "Stage1"},
    })
    _write(daemon.STREAM_PROFILES_FILE,
           [{"name": "YT", "settings": {"protocol": "rtmp", "platform": "YouTube RTMP", "primary_key": "XYZ"}}])
    daemon.global_presenter_state_cache.clear()
    async def _always_true(host, settings, port=9977):
        return True
    monkeypatch.setattr(daemon, "set_stream_settings", _always_true)

    from fastapi.testclient import TestClient
    with TestClient(wp_srv.app) as client:
        res = client.post("/api/wp/profiles/apply", json={"profile": "YT", "target": {"role": "primary"}})
        assert res.status_code == 200
        data = res.json()
        assert data["targets"] == 1
        assert data["results"][0]["status"] == "applied"

        missing = client.post("/api/wp/profiles/apply", json={"profile": "ghost", "target": {}})
        assert missing.status_code == 404
