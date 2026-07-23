import pytest
from fastapi import HTTPException

from app.backend.hyperdeck_control import (
    HYPERDECK_PORT,
    build_configuration_command,
    parse_deck_host_port,
    parse_hyperdeck_response,
)

# ---------------------------------------------------------------------------
# parse_hyperdeck_response
# ---------------------------------------------------------------------------

class TestParseHyperdeckResponse:
    def test_empty_response(self):
        result = parse_hyperdeck_response("")
        assert result["_code"] == 0
        assert result["_status"] == ""

    def test_whitespace_only(self):
        result = parse_hyperdeck_response("  \n  \n  ")
        assert result["_code"] == 0
        assert result["_status"] == ""

    def test_single_line_success(self):
        result = parse_hyperdeck_response("200 OK")
        assert result["_code"] == 200
        assert result["_status"] == "200 OK"

    def test_multiline_response(self):
        raw = "200 configuration:\nvideo input: SDI\naudio input: embedded\nfile format: ProRes"
        result = parse_hyperdeck_response(raw)
        assert result["_code"] == 200
        assert result["video input"] == "SDI"
        assert result["audio input"] == "embedded"
        assert result["file format"] == "ProRes"

    def test_crlf_line_endings(self):
        raw = "200 OK\r\nslot id: 1\r\nclip count: 5"
        result = parse_hyperdeck_response(raw)
        assert result["_code"] == 200
        assert result["slot id"] == "1"
        assert result["clip count"] == "5"

    def test_unparseable_code(self):
        result = parse_hyperdeck_response("abc something")
        assert result["_code"] == 0
        assert result["_status"] == "abc something"

    def test_leading_blank_lines(self):
        raw = "\n\n200 OK\nvideo input: HDMI"
        result = parse_hyperdeck_response(raw)
        assert result["_code"] == 200
        assert result["video input"] == "HDMI"

    def test_code_210(self):
        result = parse_hyperdeck_response("210 clip info:")
        assert result["_code"] == 210

    def test_value_with_colons(self):
        raw = "200 OK\ntimecode preset: 2026-07-15 19:30:00"
        result = parse_hyperdeck_response(raw)
        assert result["timecode preset"] == "2026-07-15 19:30:00"


# ---------------------------------------------------------------------------
# build_configuration_command
# ---------------------------------------------------------------------------

class TestBuildConfigurationCommand:
    def test_video_input(self):
        cmds = build_configuration_command({"video input": "SDI"})
        assert cmds == ["configuration: video input: SDI"]

    def test_audio_input(self):
        cmds = build_configuration_command({"audio input": "embedded"})
        assert cmds == ["configuration: audio input: embedded"]

    def test_file_format(self):
        cmds = build_configuration_command({"file format": "ProRes HQ"})
        assert cmds == ["configuration: file format: ProRes HQ"]

    def test_slate_clips_key(self):
        cmds = build_configuration_command({"scene id": "OPN"})
        assert cmds == ["slate clips: scene id: OPN"]

    def test_slate_project_key(self):
        cmds = build_configuration_command({"project name": "Summer Fest"})
        assert cmds == ["slate project: project name: Summer Fest"]

    def test_multiple_keys(self):
        cmds = build_configuration_command({
            "video input": "HDMI",
            "file format": "ProRes",
            "scene id": "SC01",
        })
        assert len(cmds) == 3
        assert "configuration: video input: HDMI" in cmds
        assert "configuration: file format: ProRes" in cmds
        assert "slate clips: scene id: SC01" in cmds

    def test_unknown_key_ignored(self):
        cmds = build_configuration_command({"unknown_key": "value"})
        assert cmds == []

    def test_empty_value_ignored(self):
        cmds = build_configuration_command({"video input": ""})
        assert cmds == []

    def test_line_break_raises(self):
        with pytest.raises(HTTPException) as exc_info:
            build_configuration_command({"video input": "SDI\ninjected"})
        assert exc_info.value.status_code == 400

    def test_case_insensitive_key(self):
        cmds = build_configuration_command({"VIDEO INPUT": "SDI"})
        assert cmds == ["configuration: video input: SDI"]

    def test_whitespace_stripped(self):
        cmds = build_configuration_command({"  video input  ": "  SDI  "})
        assert cmds == ["configuration: video input: SDI"]


# ---------------------------------------------------------------------------
# parse_deck_host_port
# ---------------------------------------------------------------------------

class TestParseDeckHostPort:
    def test_string_format(self):
        host, port = parse_deck_host_port("192.168.1.50")
        assert host == "192.168.1.50"
        assert port == HYPERDECK_PORT

    def test_dict_format_default_port(self):
        host, port = parse_deck_host_port({"ip": "10.0.0.1"})
        assert host == "10.0.0.1"
        assert port == HYPERDECK_PORT

    def test_dict_format_custom_port(self):
        host, port = parse_deck_host_port({"ip": "10.0.0.1", "port": 9999})
        assert host == "10.0.0.1"
        assert port == 9999

    def test_empty_string(self):
        host, port = parse_deck_host_port("")
        assert host == ""
        assert port == HYPERDECK_PORT

    def test_empty_dict(self):
        host, port = parse_deck_host_port({})
        assert host == ""
        assert port == HYPERDECK_PORT

    def test_whitespace_stripped(self):
        host, port = parse_deck_host_port("  192.168.1.1  ")
        assert host == "192.168.1.1"
