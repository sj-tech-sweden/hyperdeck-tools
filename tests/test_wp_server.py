import asyncio
from unittest.mock import AsyncMock, patch

from app.backend.wp_server import get_device_settings


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
