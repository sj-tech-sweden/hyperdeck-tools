import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.backend.wp_control import (
    _sanitize_wp_value,
    get_identity,
    get_stream_settings,
    get_stream_state,
    is_wp_success,
    parse_wp_response,
    start_stream,
    stop_stream,
)


class TestParseWpResponse:
    def test_simple_response(self):
        response = "Status: Streaming\nDuration: 01:23:45\nBitrate: 5000000\n"
        result = parse_wp_response(response)
        assert result["Status"] == "Streaming"
        assert result["Duration"] == "01:23:45"
        assert result["Bitrate"] == "5000000"

    def test_filters_ack(self):
        response = "\x06\nStatus: Idle\n"
        result = parse_wp_response(response)
        assert "ACK" not in result
        assert result["Status"] == "Idle"

    def test_filters_nak(self):
        response = "\x15\nError: Failed\n"
        result = parse_wp_response(response)
        assert result.get("Error") == "Failed"

    def test_empty_response(self):
        result = parse_wp_response("")
        assert result == {}

    def test_blank_lines(self):
        response = "\nStatus: Streaming\n\nDuration: 00:05:00\n\n"
        result = parse_wp_response(response)
        assert result["Status"] == "Streaming"
        assert result["Duration"] == "00:05:00"

    def test_colon_in_value(self):
        response = "URL: rtmp://live.twitch.tv/app/\nKey: live_123\n"
        result = parse_wp_response(response)
        assert result["URL"] == "rtmp://live.twitch.tv/app/"
        assert result["Key"] == "live_123"

    def test_whitespace_handling(self):
        response = "  Status :  Streaming  \n  Bitrate :  5000  \n"
        result = parse_wp_response(response)
        assert result["Status"] == "Streaming"
        assert result["Bitrate"] == "5000"

    def test_stream_settings_response(self):
        response = (
            "ACK\n\n"
            "STREAM SETTINGS:\n"
            "Available Video Modes: Auto,1080p59.94,1080p50,1080p29.97,1080p25,1080p23.98\n"
            "Video Mode: Auto\n"
            "Current Platform: YouTube\n"
            "Current Server: Primary\n"
            "Current Quality Level: Streaming Medium\n"
            "Stream Key: xxxx-yyyy-zzzz\n"
        )
        result = parse_wp_response(response)
        assert result["Video Mode"] == "Auto"
        assert result["Current Platform"] == "YouTube"
        assert result["Stream Key"] == "xxxx-yyyy-zzzz"

    def test_section_header_filtered(self):
        response = "STREAM STATE:\nStatus: Streaming\n"
        result = parse_wp_response(response)
        assert "STREAM STATE" not in result
        assert result["Status"] == "Streaming"


class TestIsWpSuccess:
    def test_ack_byte(self):
        assert is_wp_success("\x06\nStatus: Idle") is True

    def test_ack_string(self):
        assert is_wp_success("ACK\nStatus: Idle") is True

    def test_nak(self):
        assert is_wp_success("\x15\nError") is False

    def test_no_ack(self):
        assert is_wp_success("Status: Idle") is False

    def test_empty(self):
        assert is_wp_success("") is False


class TestSanitizeWpValue:
    def test_strips_crlf(self):
        assert _sanitize_wp_value("hello\r\nworld") == "helloworld"

    def test_strips_cr(self):
        assert _sanitize_wp_value("hello\rworld") == "helloworld"

    def test_strips_lf(self):
        assert _sanitize_wp_value("hello\nworld") == "helloworld"

    def test_preserves_normal_string(self):
        assert _sanitize_wp_value("rtmp://live.twitch.tv/app/") == "rtmp://live.twitch.tv/app/"

    def test_injection_attempt(self):
        malicious = "YouTube\r\nSHUTDOWN:\r\nAction: Reboot"
        result = _sanitize_wp_value(malicious)
        assert "\r" not in result
        assert "\n" not in result
        assert result == "YouTubeSHUTDOWN:Action: Reboot"


def _make_mock_reader_writer(response_data: bytes):
    """Create mock reader/writer that simulates a Web Presenter TCP response."""
    preamble = b"PROTOCOL PREAMBLE:\r\nVersion: 1.0\r\nEND PRELUDE:\r\n"
    reader = AsyncMock()
    reader.readuntil = AsyncMock(return_value=preamble)
    reader.read = AsyncMock(return_value=response_data)
    writer = MagicMock()
    writer.write = MagicMock()
    writer.drain = AsyncMock()
    writer.close = MagicMock()
    writer.wait_closed = AsyncMock()
    return reader, writer


class TestSendWpCommand:
    def test_sends_command_and_returns_response(self):
        response = b"\x06\nStatus: Idle\n"
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                from app.backend.wp_control import send_wp_command
                return await send_wp_command("192.168.1.100", "STREAM STATE:")

        result = asyncio.run(_run())
        assert "Status" in result
        assert "Idle" in result
        writer.close.assert_called_once()

    def test_connection_closed_on_timeout(self):
        reader, writer = _make_mock_reader_writer(b"")
        reader.readuntil = AsyncMock(side_effect=asyncio.TimeoutError)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                from app.backend.wp_control import send_wp_command
                try:
                    await send_wp_command("192.168.1.100", "STREAM STATE:", timeout=0.1)
                except asyncio.TimeoutError:
                    pass
            return writer

        writer = asyncio.run(_run())
        writer.close.assert_called_once()


class TestAsyncWpFunctions:
    def test_get_stream_state(self):
        response = (
            b"\x06\nSTREAM STATE:\nStatus: Streaming\n"
            b"Duration: 01:23:45\nBitrate: 5000000\nCache Used: 12\n"
        )
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                return await get_stream_state("192.168.1.100")

        result = asyncio.run(_run())
        assert result["status"] == "Streaming"
        assert result["duration"] == "01:23:45"
        assert result["bitrate"] == "5000000"
        assert result["cache_used"] == 12

    def test_get_stream_settings(self):
        response = (
            b"\x06\nSTREAM SETTINGS:\nVideo Mode: Auto\n"
            b"Current Platform: YouTube\nCurrent Quality Level: Streaming Medium\n"
        )
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                return await get_stream_settings("192.168.1.100")

        result = asyncio.run(_run())
        assert result["Video Mode"] == "Auto"
        assert result["Current Platform"] == "YouTube"

    def test_get_identity(self):
        response = (
            b"\x06\nIDENTITY:\nModel: Blackmagic Web Presenter HD\n"
            b"Label: WP Main\nUnique ID: abc123def456\n"
        )
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                return await get_identity("192.168.1.100")

        result = asyncio.run(_run())
        assert result["Model"] == "Blackmagic Web Presenter HD"
        assert result["Label"] == "WP Main"

    def test_start_stream(self):
        response = b"\x06\n"
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                return await start_stream("192.168.1.100")

        result = asyncio.run(_run())
        assert result is True

    def test_stop_stream(self):
        response = b"\x06\n"
        reader, writer = _make_mock_reader_writer(response)

        async def _run():
            with patch("asyncio.open_connection", return_value=(reader, writer)):
                return await stop_stream("192.168.1.100")

        result = asyncio.run(_run())
        assert result is True

    def test_connection_failure_returns_false(self):
        async def _run():
            with patch("asyncio.open_connection", side_effect=ConnectionRefusedError):
                from app.backend.wp_control import check_connectivity
                return await check_connectivity("192.168.1.100", timeout=0.1)

        result = asyncio.run(_run())
        assert result is False
