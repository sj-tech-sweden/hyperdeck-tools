import os
import tempfile

import pytest
from app.backend.plugins.csv_schedule_uploader import _build_start_time as csv_build_start_time
from app.backend.plugins.csv_schedule_uploader import _norm_header as csv_norm_header
from app.backend.plugins.csv_schedule_uploader import scrape as csv_scrape
from app.backend.plugins.excel_schedule_uploader import _build_start_time as excel_build_start_time
from app.backend.plugins.excel_schedule_uploader import _format_datetime
from app.backend.plugins.excel_schedule_uploader import _norm_header as excel_norm_header


# ---------------------------------------------------------------------------
# CSV plugin helpers
# ---------------------------------------------------------------------------

class TestCsvNormHeader:
    def test_lowercase(self):
        assert csv_norm_header("Start Time") == "start_time"

    def test_strips_whitespace(self):
        assert csv_norm_header("  Title  ") == "title"

    def test_replaces_spaces(self):
        assert csv_norm_header("Planned Title") == "planned_title"

    def test_empty(self):
        assert csv_norm_header("") == ""

    def test_none(self):
        assert csv_norm_header(None) == ""


class TestCsvBuildStartTime:
    def test_direct_start_time(self):
        assert csv_build_start_time({"start_time": "2026-07-15 19:30"}) == "2026-07-15 19:30"

    def test_direct_start(self):
        assert csv_build_start_time({"start": "2026-07-15 19:30"}) == "2026-07-15 19:30"

    def test_direct_datetime(self):
        assert csv_build_start_time({"datetime": "2026-07-15 19:30"}) == "2026-07-15 19:30"

    def test_split_date_time(self):
        result = csv_build_start_time({"date": "2026-07-15", "time": "19:30"})
        assert result == "2026-07-15 19:30"

    def test_no_time(self):
        assert csv_build_start_time({"date": "2026-07-15"}) == ""

    def test_empty(self):
        assert csv_build_start_time({}) == ""


class TestCsvScrape:
    def test_valid_csv(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("start_time,planned_title,stage\n2026-07-15 19:30,Evening Service,Main Stage\n", encoding="utf-8")
        result = csv_scrape(str(csv_file))
        assert len(result) == 1
        assert result[0]["planned_title"] == "Evening Service"
        assert result[0]["start_time"] == "2026-07-15 19:30"
        assert result[0]["stage"] == "Main Stage"

    def test_empty_csv(self, tmp_path):
        csv_file = tmp_path / "empty.csv"
        csv_file.write_text("", encoding="utf-8")
        result = csv_scrape(str(csv_file))
        assert result == []

    def test_auto_generates_id(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("start_time,planned_title\n2026-07-15 19:30,Service\n", encoding="utf-8")
        result = csv_scrape(str(csv_file))
        assert "id" in result[0]
        assert len(result[0]["id"]) > 0

    def test_skips_empty_rows(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("start_time,planned_title\n,\n2026-07-15 19:30,Service\n", encoding="utf-8")
        result = csv_scrape(str(csv_file))
        assert len(result) == 1

    def test_alternative_headers(self, tmp_path):
        csv_file = tmp_path / "test.csv"
        csv_file.write_text("date,time,title,venue\n2026-07-15,19:30,Service,Main\n", encoding="utf-8")
        result = csv_scrape(str(csv_file))
        assert len(result) == 1
        assert result[0]["planned_title"] == "Service"
        assert result[0]["stage"] == "Main"


# ---------------------------------------------------------------------------
# Excel plugin helpers
# ---------------------------------------------------------------------------

class TestExcelNormHeader:
    def test_lowercase(self):
        assert excel_norm_header("Start Time") == "start_time"

    def test_strips_whitespace(self):
        assert excel_norm_header("  Title  ") == "title"


class TestExcelFormatDatetime:
    def test_datetime_object(self):
        from datetime import datetime
        dt = datetime(2026, 7, 15, 19, 30)
        assert _format_datetime(dt) == "2026-07-15 19:30"

    def test_date_object(self):
        from datetime import date
        d = date(2026, 7, 15)
        assert _format_datetime(d) == "2026-07-15 00:00"

    def test_string_passthrough(self):
        assert _format_datetime("2026-07-15 19:30") == "2026-07-15 19:30"

    def test_none(self):
        assert _format_datetime(None) == ""


class TestExcelBuildStartTime:
    def test_direct_start_time(self):
        from datetime import datetime
        assert excel_build_start_time({"start_time": datetime(2026, 7, 15, 19, 30)}) == "2026-07-15 19:30"

    def test_split_date_time(self):
        from datetime import datetime, date, time
        result = excel_build_start_time({"date": date(2026, 7, 15), "time": time(19, 30)})
        assert result == "2026-07-15 19:30"

    def test_empty(self):
        assert excel_build_start_time({}) == ""
