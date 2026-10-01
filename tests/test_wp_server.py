import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.backend.wp_server import get_device_settings, update_device_settings


def test_get_device_settings_includes_status_sections():
    payload = {
        "settings": {"Video Mode": "Auto"},
        "identity": {"Model": "Blackmagic Web Presenter HD"},
        "version": {"Software Release": "3.4"},
        "state": {"status": "Idle", "bitrate": "0", "duration": "", "cache_used": 0},
        "network": {"Interface Count": "2", "Default Interface": "0"},
    }

    with patch("app.backend.wp_server.get_stream_settings", new=AsyncMock(return_value=payload["settings"])), \
         patch("app.backend.wp_server.get_identity", new=AsyncMock(return_value=payload["identity"])), \
         patch("app.backend.wp_server.get_version", new=AsyncMock(return_value=payload["version"])), \
         patch("app.backend.wp_server.get_stream_state", new=AsyncMock(return_value=payload["state"])), \
         patch("app.backend.wp_server.get_network", new=AsyncMock(return_value=payload["network"])):
        result = asyncio.run(get_device_settings("192.168.1.100"))

    assert result["settings"] == payload["settings"]
    assert result["identity"] == payload["identity"]
    assert result["version"] == payload["version"]
    assert result["state"] == payload["state"]
    assert result["network"] == payload["network"]


def test_get_device_settings_tolerates_partial_failures():
    with patch("app.backend.wp_server.get_stream_settings", new=AsyncMock(return_value={"Video Mode": "Auto"})), \
         patch("app.backend.wp_server.get_identity", new=AsyncMock(return_value={"Model": "X"})), \
         patch("app.backend.wp_server.get_version", new=AsyncMock(side_effect=RuntimeError("boom"))), \
         patch("app.backend.wp_server.get_stream_state", new=AsyncMock(side_effect=RuntimeError("boom"))), \
         patch("app.backend.wp_server.get_network", new=AsyncMock(side_effect=RuntimeError("boom"))):
        result = asyncio.run(get_device_settings("192.168.1.100"))

    # The endpoint must still surface settings/identity even if status queries fail.
    assert result["settings"] == {"Video Mode": "Auto"}
    assert result["identity"] == {"Model": "X"}
    assert result["version"] == {}
    assert result["state"] == {}
    assert result["network"] == {}


def test_update_device_settings_blocks_live_without_force():
    with patch("app.backend.wp_server.get_stream_state", new=AsyncMock(return_value={"Streaming": "On"})), \
         patch("app.backend.wp_server.set_stream_settings", new=AsyncMock(return_value=True)) as set_mock:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(update_device_settings("1.2.3.4", {"Video Mode": "1080p30"}))
        assert exc.value.status_code == 409
        set_mock.assert_not_called()


def test_update_device_settings_forces_live_with_flag():
    with patch("app.backend.wp_server.get_stream_state", new=AsyncMock(return_value={"Streaming": "On"})), \
         patch("app.backend.wp_server.set_stream_settings", new=AsyncMock(return_value=True)) as set_mock:
        result = asyncio.run(update_device_settings("1.2.3.4", {"Video Mode": "1080p30", "force": True}))
        assert result["status"] == "ok"
        set_mock.assert_awaited_once()
        # The force flag must not be forwarded to the device.
        forwarded = set_mock.call_args[0][1]
        assert "force" not in forwarded
        assert forwarded["Video Mode"] == "1080p30"


def test_update_device_settings_applies_when_idle():
    with patch("app.backend.wp_server.get_stream_state", new=AsyncMock(return_value={"Streaming": "Off"})), \
         patch("app.backend.wp_server.set_stream_settings", new=AsyncMock(return_value=True)) as set_mock:
        result = asyncio.run(update_device_settings("1.2.3.4", {"Video Mode": "1080p30"}))
        assert result["status"] == "ok"
        set_mock.assert_awaited_once()
