import json
from datetime import datetime

from app.backend.server import (
    _append_unique_case_insensitive,
    _atomic_json_write,
    _parse_clips_get_response,
    _split_option_values,
    build_deck_schedule_resolution,
    is_hyperdeck_success_code,
    normalize_config_payload,
    normalize_schedule_item,
    normalize_schedule_payload,
    parse_start_time,
    resolve_deck_stage,
    resolve_scoped_slate_metadata,
    sanitize_slate_settings,
)

# ---------------------------------------------------------------------------
# is_hyperdeck_success_code
# ---------------------------------------------------------------------------

class TestIsHyperdeckSuccessCode:
    def test_100_is_success(self):
        assert is_hyperdeck_success_code(100) is True

    def test_200_is_success(self):
        assert is_hyperdeck_success_code(200) is True

    def test_299_is_success(self):
        assert is_hyperdeck_success_code(299) is True

    def test_99_is_failure(self):
        assert is_hyperdeck_success_code(99) is False

    def test_300_is_failure(self):
        assert is_hyperdeck_success_code(300) is False

    def test_string_input(self):
        assert is_hyperdeck_success_code("200") is True

    def test_none_input(self):
        assert is_hyperdeck_success_code(None) is False

    def test_garbage_input(self):
        assert is_hyperdeck_success_code("abc") is False

    def test_float_input(self):
        assert is_hyperdeck_success_code(200.0) is True


# ---------------------------------------------------------------------------
# _split_option_values
# ---------------------------------------------------------------------------

class TestSplitOptionValues:
    def test_empty(self):
        assert _split_option_values("") == []

    def test_none(self):
        assert _split_option_values(None) == []

    def test_comma_separated(self):
        assert _split_option_values("ProRes, DNxHD, H.264") == ["ProRes", "DNxHD", "H.264"]

    def test_pipe_separated(self):
        assert _split_option_values("SDI|HDMI|Component") == ["SDI", "HDMI", "Component"]

    def test_slash_separated(self):
        assert _split_option_values("1080i/720p") == ["1080i", "720p"]

    def test_single_value(self):
        assert _split_option_values("ProRes") == ["ProRes"]

    def test_wrapped_in_brackets(self):
        assert _split_option_values("[ProRes, DNxHD]") == ["ProRes", "DNxHD"]

    def test_space_separated_tokens(self):
        assert _split_option_values("1080i 720p 480i") == ["1080i", "720p", "480i"]

    def test_single_value_with_spaces(self):
        result = _split_option_values("ProRes HQ")
        assert result == ["ProRes", "HQ"]

    def test_whitespace_stripped(self):
        assert _split_option_values("  ProRes , DNxHD  ") == ["ProRes", "DNxHD"]


# ---------------------------------------------------------------------------
# _append_unique_case_insensitive
# ---------------------------------------------------------------------------

class TestAppendUniqueCaseInsensitive:
    def test_appends_new(self):
        items = ["ProRes"]
        _append_unique_case_insensitive(items, "DNxHD")
        assert items == ["ProRes", "DNxHD"]

    def test_skips_duplicate(self):
        items = ["ProRes"]
        _append_unique_case_insensitive(items, "prores")
        assert items == ["ProRes"]

    def test_skips_empty(self):
        items = ["ProRes"]
        _append_unique_case_insensitive(items, "")
        assert items == ["ProRes"]

    def test_skips_none(self):
        items = ["ProRes"]
        _append_unique_case_insensitive(items, None)
        assert items == ["ProRes"]


# ---------------------------------------------------------------------------
# _parse_clips_get_response
# ---------------------------------------------------------------------------

class TestParseClipsGetResponse:
    def test_variant_a(self):
        raw = "1: clip001.mov 12345\n2: clip002.mp4 67890"
        clips = _parse_clips_get_response(raw)
        assert len(clips) == 2
        assert clips[0]["id"] == "1"
        assert clips[0]["name"] == "clip001.mov"
        assert clips[1]["id"] == "2"

    def test_variant_b(self):
        raw = "clip id: 1\nname: opening.mov\nclip id: 2\nname: closing.mp4"
        clips = _parse_clips_get_response(raw)
        assert len(clips) == 2
        assert clips[0]["id"] == "1"
        assert clips[0]["name"] == "opening.mov"

    def test_empty_response(self):
        assert _parse_clips_get_response("") == []

    def test_variant_b_no_name(self):
        raw = "clip id: 5"
        clips = _parse_clips_get_response(raw)
        assert len(clips) == 1
        assert clips[0]["id"] == "5"
        assert clips[0]["name"] == "clip_5"

    def test_crlf_endings(self):
        raw = "1: test.mov 100\r\n2: test2.mp4 200"
        clips = _parse_clips_get_response(raw)
        assert len(clips) == 2


# ---------------------------------------------------------------------------
# normalize_schedule_item / normalize_schedule_payload
# ---------------------------------------------------------------------------

class TestNormalizeScheduleItem:
    def test_full_item(self):
        raw = {"id": "evt1", "planned_title": "Service", "start_time": "2026-07-15 19:30", "stage": "Main"}
        result = normalize_schedule_item(raw, 0)
        assert result["id"] == "evt1"
        assert result["planned_title"] == "Service"
        assert result["start_time"] == "2026-07-15 19:30"
        assert result["stage"] == "Main"

    def test_missing_id_auto_generated(self):
        raw = {"planned_title": "Service"}
        result = normalize_schedule_item(raw, 2)
        assert result["id"] == "event_003"

    def test_title_fallback_to_id(self):
        raw = {"id": "evt_001"}
        result = normalize_schedule_item(raw, 0)
        assert result["planned_title"] == "evt_001"

    def test_empty_stage_omitted(self):
        raw = {"id": "evt1", "planned_title": "Test"}
        result = normalize_schedule_item(raw, 0)
        assert "stage" not in result

    def test_empty_start_time_omitted(self):
        raw = {"id": "evt1", "planned_title": "Test"}
        result = normalize_schedule_item(raw, 0)
        assert "start_time" not in result

    def test_slate_metadata_included(self):
        raw = {"id": "evt1", "planned_title": "Test", "slate_metadata": {"scene id": "OPN"}}
        result = normalize_schedule_item(raw, 0)
        assert result["slate_metadata"]["scene id"] == "OPN"


class TestNormalizeSchedulePayload:
    def test_empty_list(self):
        assert normalize_schedule_payload([]) == []

    def test_filters_non_dicts(self):
        raw = [{"id": "1", "planned_title": "A"}, "invalid", 42]
        result = normalize_schedule_payload(raw)
        assert len(result) == 1

    def test_multiple_items(self):
        raw = [{"id": "1", "planned_title": "A"}, {"id": "2", "planned_title": "B"}]
        result = normalize_schedule_payload(raw)
        assert len(result) == 2


# ---------------------------------------------------------------------------
# normalize_config_payload
# ---------------------------------------------------------------------------

class TestNormalizeConfigPayload:
    def test_merges_defaults(self):
        result = normalize_config_payload({})
        assert "destinations" in result
        assert "hyperdecks" in result
        assert result["schedule_max_drift_minutes"] == 45

    def test_preserves_values(self):
        config = {"schedule_max_drift_minutes": 30, "global_stage": "Youth"}
        result = normalize_config_payload(config)
        assert result["schedule_max_drift_minutes"] == 30
        assert result["global_stage"] == "Youth"

    def test_invalid_drift_clamps(self):
        result = normalize_config_payload({"schedule_max_drift_minutes": -5})
        assert result["schedule_max_drift_minutes"] == 0

    def test_non_numeric_drift(self):
        result = normalize_config_payload({"schedule_max_drift_minutes": "abc"})
        assert result["schedule_max_drift_minutes"] == 45

    def test_per_deck_stage_mode(self):
        result = normalize_config_payload({"stage_mode": "per_deck"})
        assert result["stage_mode"] == "per_deck"

    def test_invalid_stage_mode_defaults_global(self):
        result = normalize_config_payload({"stage_mode": "invalid"})
        assert result["stage_mode"] == "global"

    def test_slate_metadata_structure(self):
        result = normalize_config_payload({})
        assert isinstance(result["slate_metadata"], dict)
        assert "global" in result["slate_metadata"]
        assert "per_deck" in result["slate_metadata"]
        assert "per_event" in result["slate_metadata"]


# ---------------------------------------------------------------------------
# parse_start_time
# ---------------------------------------------------------------------------

class TestParseStartTime:
    def test_full_datetime(self):
        result = parse_start_time("2026-07-15 19:30")
        assert result == datetime(2026, 7, 15, 19, 30)

    def test_full_datetime_with_seconds(self):
        result = parse_start_time("2026-07-15 19:30:00")
        assert result == datetime(2026, 7, 15, 19, 30, 0)

    def test_time_only(self):
        result = parse_start_time("19:30")
        assert result is not None
        assert result.hour == 19
        assert result.minute == 30

    def test_empty_string(self):
        assert parse_start_time("") is None

    def test_none(self):
        assert parse_start_time(None) is None

    def test_garbage(self):
        assert parse_start_time("not a date") is None


# ---------------------------------------------------------------------------
# sanitize_slate_settings
# ---------------------------------------------------------------------------

class TestSanitizeSlateSettings:
    def test_filters_invalid_keys(self):
        result = sanitize_slate_settings({"scene id": "OPN", "invalid_key": "val"})
        assert "scene id" in result
        assert "invalid_key" not in result

    def test_strips_whitespace(self):
        result = sanitize_slate_settings({"  scene id  ": "  OPN  "})
        assert result["scene id"] == "OPN"

    def test_skips_empty_values(self):
        result = sanitize_slate_settings({"scene id": ""})
        assert "scene id" not in result

    def test_non_dict_input(self):
        assert sanitize_slate_settings(None) == {}
        assert sanitize_slate_settings("invalid") == {}


# ---------------------------------------------------------------------------
# resolve_scoped_slate_metadata
# ---------------------------------------------------------------------------

class TestResolveScopedSlateMetadata:
    def test_global_only(self):
        config = {"slate_metadata": {"global": {"project name": "Fest"}, "per_deck": {}, "per_event": {}}}
        result = resolve_scoped_slate_metadata(config, "Deck1", "10.0.0.1", "")
        assert result["project name"] == "Fest"

    def test_per_deck_overrides_global(self):
        config = {"slate_metadata": {
            "global": {"project name": "Fest"},
            "per_deck": {"Deck1": {"project name": "Override"}},
            "per_event": {},
        }}
        result = resolve_scoped_slate_metadata(config, "Deck1", "10.0.0.1", "")
        assert result["project name"] == "Override"

    def test_per_event_overrides_all(self):
        config = {"slate_metadata": {
            "global": {"project name": "Fest"},
            "per_deck": {"Deck1": {"project name": "Override"}},
            "per_event": {"evt1": {"project name": "EventOverride"}},
        }}
        result = resolve_scoped_slate_metadata(config, "Deck1", "10.0.0.1", "evt1")
        assert result["project name"] == "EventOverride"

    def test_host_keyed_fallback(self):
        config = {"slate_metadata": {
            "global": {},
            "per_deck": {"10.0.0.1": {"camera": "A"}},
            "per_event": {},
        }}
        result = resolve_scoped_slate_metadata(config, "UnknownDeck", "10.0.0.1", "")
        assert result["camera"] == "A"


# ---------------------------------------------------------------------------
# resolve_deck_stage
# ---------------------------------------------------------------------------

class TestResolveDeckStage:
    def test_global_mode(self):
        config = {"stage_mode": "global", "global_stage": "Main Stage"}
        assert resolve_deck_stage(config, "Deck1") == "Main Stage"

    def test_per_deck_mode(self):
        config = {"stage_mode": "per_deck", "deck_stages": {"Deck1": "Youth"}}
        assert resolve_deck_stage(config, "Deck1") == "Youth"

    def test_per_deck_missing_deck(self):
        config = {"stage_mode": "per_deck", "deck_stages": {}}
        assert resolve_deck_stage(config, "Deck1") == ""


# ---------------------------------------------------------------------------
# build_deck_schedule_resolution
# ---------------------------------------------------------------------------

class TestBuildDeckScheduleResolution:
    def test_empty_schedule(self):
        config = {"stage_mode": "global", "global_stage": "Main"}
        result = build_deck_schedule_resolution(config, "Deck1", [])
        assert result["matched_event"] is None
        assert result["next_event"] is None

    def test_matching_event(self):
        now = datetime.now()
        future = now.strftime("%Y-%m-%d %H:%M")
        config = {"stage_mode": "global", "global_stage": "Main", "schedule_max_drift_minutes": 60}
        schedule = [{"id": "evt1", "planned_title": "Service", "start_time": future, "stage": "Main"}]
        result = build_deck_schedule_resolution(config, "Deck1", schedule)
        assert result["matched_event"] is not None
        assert result["matched_event"]["id"] == "evt1"

    def test_stage_filtering(self):
        now = datetime.now()
        future = now.strftime("%Y-%m-%d %H:%M")
        config = {"stage_mode": "global", "global_stage": "Main", "schedule_max_drift_minutes": 60}
        schedule = [{"id": "evt1", "planned_title": "Service", "start_time": future, "stage": "Youth"}]
        result = build_deck_schedule_resolution(config, "Deck1", schedule)
        assert result["matched_event"] is None


# ---------------------------------------------------------------------------
# _atomic_json_write
# ---------------------------------------------------------------------------

class TestAtomicJsonWrite:
    def test_writes_file(self, tmp_path):
        target = str(tmp_path / "test.json")
        _atomic_json_write(target, {"key": "value"})
        with open(target, "r", encoding="utf-8") as f:
            assert json.load(f) == {"key": "value"}

    def test_creates_parent_dirs(self, tmp_path):
        target = str(tmp_path / "sub" / "dir" / "test.json")
        _atomic_json_write(target, [1, 2, 3])
        with open(target, "r", encoding="utf-8") as f:
            assert json.load(f) == [1, 2, 3]
