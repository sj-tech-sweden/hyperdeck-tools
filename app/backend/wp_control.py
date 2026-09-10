"""TCP protocol client for Blackmagic Web Presenter devices (port 9977).

The Web Presenter Ethernet Control Protocol uses a text-based, section-oriented
command format over TCP. Commands are section headers followed by key-value pairs,
terminated by an empty line. Responses include an ACK/NAK byte followed by data lines.
"""

import asyncio
from typing import Any

WP_PORT = 9977
COMMAND_TIMEOUT = 5.0


def _sanitize_wp_value(value: str) -> str:
    """Strip CRLF sequences from values to prevent TCP command injection."""
    return str(value).replace("\r", "").replace("\n", "")


async def send_wp_command(
    host: str,
    command: str,
    port: int = WP_PORT,
    timeout: float = COMMAND_TIMEOUT,
) -> str:
    """Send a command to a Web Presenter and return the raw response text.

    Opens a fresh TCP connection, reads and discards the protocol preamble,
    sends the command, reads the response, and closes the connection.
    """
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port),
        timeout=timeout,
    )
    try:
        # Read and discard the protocol preamble
        try:
            await asyncio.wait_for(
                reader.readuntil(b"END PRELUDE:"),
                timeout=timeout,
            )
            # Consume trailing \r\n after END PRELUDE:
            await asyncio.wait_for(reader.read(2), timeout=1.0)
        except asyncio.TimeoutError:
            pass

        # Send command with CRLF terminator
        payload = command if command.endswith("\r\n") else f"{command}\r\n"
        writer.write(payload.encode())
        await writer.drain()

        # Read response
        raw = await asyncio.wait_for(reader.read(8192), timeout=timeout)
        return raw.decode("utf-8", errors="replace")
    finally:
        writer.close()
        await writer.wait_closed()


def parse_wp_response(response: str) -> dict[str, str]:
    """Parse a Web Presenter response into a key-value dict.

    Filters out ACK/NAK bytes, blank lines, and section headers
    (lines ending with ':' that have no value).
    """
    result: dict[str, str] = {}
    for line in response.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Filter ACK (0x06) and NAK (0x15) bytes
        if line in ("\x06", "\x15", "ACK", "NAK"):
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip()
            # Skip section headers (e.g. "STREAM STATE:" with no value)
            if not value:
                continue
            result[key] = value
    return result


def is_wp_success(response: str) -> bool:
    """Check if a response indicates success (ACK present)."""
    return "ACK" in response or "\x06" in response


async def get_stream_state(host: str, port: int = WP_PORT) -> dict[str, Any]:
    """Query the current stream state from a Web Presenter."""
    raw = await send_wp_command(host, "STREAM STATE:", port=port)
    parsed = parse_wp_response(raw)
    return {
        "status": parsed.get("Status", "Unknown"),
        "action": parsed.get("Action", ""),
        "duration": parsed.get("Duration", ""),
        "bitrate": parsed.get("Bitrate", "0"),
        "cache_used": int(parsed.get("Cache Used", "0") or "0"),
    }


async def get_stream_settings(host: str, port: int = WP_PORT) -> dict[str, Any]:
    """Query the current stream settings from a Web Presenter."""
    raw = await send_wp_command(host, "STREAM SETTINGS:", port=port)
    return parse_wp_response(raw)


async def get_identity(host: str, port: int = WP_PORT) -> dict[str, Any]:
    """Query device identity (model, label, unique ID)."""
    raw = await send_wp_command(host, "IDENTITY:", port=port)
    return parse_wp_response(raw)


async def get_version(host: str, port: int = WP_PORT) -> dict[str, Any]:
    """Query device firmware version."""
    raw = await send_wp_command(host, "VERSION:", port=port)
    return parse_wp_response(raw)


async def start_stream(host: str, port: int = WP_PORT) -> bool:
    """Send start stream command."""
    raw = await send_wp_command(host, "STREAM STATE:\r\nAction: Start", port=port)
    return is_wp_success(raw)


async def stop_stream(host: str, port: int = WP_PORT) -> bool:
    """Send stop stream command."""
    raw = await send_wp_command(host, "STREAM STATE:\r\nAction: Stop", port=port)
    return is_wp_success(raw)


async def set_stream_settings(
    host: str,
    settings: dict[str, str],
    port: int = WP_PORT,
) -> bool:
    """Update stream settings on a Web Presenter.

    Args:
        host: Device IP address.
        settings: Dict of key-value pairs to set (e.g. {"Stream Key": "...", "Current Platform": "YouTube"}).
        port: TCP port (default 9977).
    """
    lines = ["STREAM SETTINGS:"]
    for key, value in settings.items():
        safe_key = _sanitize_wp_value(str(key)).replace(":", "")
        safe_value = _sanitize_wp_value(str(value))
        lines.append(f"{safe_key}: {safe_value}")
    command = "\r\n".join(lines)
    raw = await send_wp_command(host, command, port=port)
    return is_wp_success(raw)


async def reboot_device(host: str, port: int = WP_PORT) -> bool:
    """Reboot a Web Presenter device."""
    raw = await send_wp_command(host, "SHUTDOWN:\r\nAction: Reboot", port=port)
    return is_wp_success(raw)


async def check_connectivity(host: str, port: int = WP_PORT, timeout: float = 2.0) -> bool:
    """Quick connectivity check — opens TCP and reads preamble."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout,
        )
        try:
            await asyncio.wait_for(reader.read(256), timeout=timeout)
        finally:
            writer.close()
            await writer.wait_closed()
        return True
    except Exception:
        return False
