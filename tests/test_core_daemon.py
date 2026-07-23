import datetime
import os

import pytest
from app.backend.core_daemon import (
    _dedupe_filename_for_destinations,
    _is_success_code,
    _transport_status_display,
    generate_target_filename,
    get_weekday_sv3,
)


# ---------------------------------------------------------------------------
# _is_success_code
# ---------------------------------------------------------------------------

class TestIsSuccessCode:
    def test_200(self):
        assert _is_success_code(200) is True

    def test_100(self):
        assert _is_success_code(100) is True

    def test_299(self):
        assert _is_success_code(299) is True

    def test_99(self):
        assert _is_success_code(99) is False

    def test_300(self):
        assert _is_success_code(300) is False

    def test_none(self):
        assert _is_success_code(None) is False

    def test_string(self):
        assert _is_success_code("200") is True


# ---------------------------------------------------------------------------
# _transport_status_display
# ---------------------------------------------------------------------------

class TestTransportStatusDisplay:
    def test_record(self):
        assert _transport_status_display("record") == "Recording"

    def test_play(self):
        assert _transport_status_display("play") == "Playing"

    def test_forward(self):
        assert _transport_status_display("forward") == "Playing"

    def test_stopped(self):
        assert _transport_status_display("stopped") == "Stopped"

    def test_stop(self):
        assert _transport_status_display("stop") == "Stopped"

    def test_preview(self):
        assert _transport_status_display("preview") == "Preview"

    def test_jog(self):
        assert _transport_status_display("jog") == "Jog"

    def test_shuttle(self):
        assert _transport_status_display("shuttle") == "Shuttle"

    def test_reverse(self):
        assert _transport_status_display("reverse") == "Reverse"

    def test_unknown(self):
        assert _transport_status_display("custom_mode") == "Custom_Mode"

    def test_empty(self):
        assert _transport_status_display("") == "Online"

    def test_none(self):
        assert _transport_status_display(None) == "Online"

    def test_case_insensitive(self):
        assert _transport_status_display("RECORD") == "Recording"


# ---------------------------------------------------------------------------
# get_weekday_sv3
# ---------------------------------------------------------------------------

class TestGetWeekdaySv3:
    def test_monday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 20)) == "man"  # Monday

    def test_tuesday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 21)) == "tis"

    def test_wednesday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 22)) == "ons"

    def test_thursday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 23)) == "tor"

    def test_friday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 24)) == "fre"

    def test_saturday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 25)) == "lor"

    def test_sunday(self):
        assert get_weekday_sv3(datetime.datetime(2026, 7, 26)) == "son"


# ---------------------------------------------------------------------------
# generate_target_filename
# ---------------------------------------------------------------------------

class TestGenerateTargetFilename:
    def test_no_event_context(self, monkeypatch):
        monkeypatch.setattr("app.backend.core_daemon.get_live_event_title", lambda: "")
        result = generate_target_filename("Deck1", "{deck_name}{ext}")
        assert "Deck1" in result
        assert result.endswith(".mov")

    def test_with_event_context(self, monkeypatch):
        monkeypatch.setattr("app.backend.core_daemon.get_live_event_title", lambda: "Evening Service")
        result = generate_target_filename(
            "Deck1",
            "{planned_title}_{deck_name}{ext}",
            stage="Main",
            ext=".mp4",
            started_at=datetime.datetime(2026, 7, 15, 19, 30),
        )
        assert "Evening_Service" in result
        assert "Deck1" in result
        assert result.endswith(".mp4")

    def test_double_dot_cleanup(self, monkeypatch):
        monkeypatch.setattr("app.backend.core_daemon.get_live_event_title", lambda: "Test")
        result = generate_target_filename("D", "{planned_title}.{ext}", ext=".mov")
        assert ".." not in result

    def test_no_ext_default(self, monkeypatch):
        monkeypatch.setattr("app.backend.core_daemon.get_live_event_title", lambda: "")
        result = generate_target_filename("D", "{deck_name}")
        assert result.endswith(".mov")

    def test_template_error_fallback(self, monkeypatch):
        monkeypatch.setattr("app.backend.core_daemon.get_live_event_title", lambda: "Test")
        result = generate_target_filename("D", "{invalid_token}")
        assert "D" in result


# ---------------------------------------------------------------------------
# _dedupe_filename_for_destinations
# ---------------------------------------------------------------------------

class TestDedupeFilenameForDestinations:
    def test_no_collision(self, tmp_path):
        result = _dedupe_filename_for_destinations([str(tmp_path)], "unique_file.mov")
        assert result == "unique_file.mov"

    def test_collision_appends_counter(self, tmp_path):
        (tmp_path / "capture.mov").touch()
        result = _dedupe_filename_for_destinations([str(tmp_path)], "capture.mov")
        assert result == "capture_2.mov"

    def test_multiple_collisions(self, tmp_path):
        (tmp_path / "capture.mov").touch()
        (tmp_path / "capture_2.mov").touch()
        result = _dedupe_filename_for_destinations([str(tmp_path)], "capture.mov")
        assert result == "capture_3.mov"

    def test_empty_filename(self, tmp_path):
        result = _dedupe_filename_for_destinations([str(tmp_path)], "")
        assert result == "capture.mov"

    def test_path_stripped(self, tmp_path):
        result = _dedupe_filename_for_destinations([str(tmp_path)], "/some/path/file.mov")
        assert result == "file.mov"
