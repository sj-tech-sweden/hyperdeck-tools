# app/backend/hyperdeck_control.py
"""
Async utilities for communicating with HyperDeck devices over
the Ethernet Control Protocol (TCP port 9993).
"""
import asyncio
from fastapi import HTTPException

HYPERDECK_PORT = 9993
COMMAND_TIMEOUT = 5.0


async def _read_response_block(reader: asyncio.StreamReader, timeout: float) -> str:
    """Read a HyperDeck response block, tolerating both single-line and multi-line replies."""
    try:
        first_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timed out waiting for HyperDeck response line")

    if not first_line:
        raise HTTPException(status_code=503, detail="HyperDeck closed connection before sending a response")

    chunks: list[bytes] = [first_line]

    # Most replies end with an empty line; some commands only return a status line.
    # Keep reading briefly for trailing fields but do not block long.
    for _ in range(32):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=0.12)
        except asyncio.TimeoutError:
            break
        if not line:
            break
        chunks.append(line)
        if line in (b"\r\n", b"\n"):
            break

    return b"".join(chunks).decode("utf-8", errors="replace").strip()


async def send_hyperdeck_command(
    host: str,
    command: str,
    port: int = HYPERDECK_PORT,
    timeout: float = COMMAND_TIMEOUT,
) -> str:
    """
    Open a TCP connection to a HyperDeck, discard the initial protocol
    banner, send *command*, and return the response text.

    Raises HTTPException (400 / 503 / 504) on validation, connection, or timeout errors.
    """
    if "\r" in command or "\n" in command:
        raise HTTPException(
            status_code=400,
            detail="HyperDeck command must not contain line breaks.",
        )

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(str(host), port), timeout=timeout
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"Connection timed out to HyperDeck at {host}:{port}",
        )
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not connect to HyperDeck at {host}:{port}: {exc}",
        )

    try:
        # The protocol sends a multi-line banner ending with a blank line.
        # The banner carries the HyperDeck model/firmware info but is not
        # required for issuing individual commands, so it is intentionally
        # discarded here.  Callers that need version negotiation can capture
        # and parse the return value of a dedicated `device info` command.
        # Consume banner if present; do not fail hard if deck sends a short/partial greeting.
        try:
            await _read_response_block(reader, timeout=min(timeout, 1.5))
        except HTTPException:
            pass

        writer.write(f"{command}\r\n".encode())
        await writer.drain()

        try:
            return await _read_response_block(reader, timeout=timeout)
        except HTTPException as exc:
            if exc.status_code == 504:
                raise HTTPException(
                    status_code=504,
                    detail=f"Command '{command}' timed out on HyperDeck at {host}:{port}",
                )
            raise
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Communication error with HyperDeck at {host}:{port}: {exc}",
        )
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


def parse_hyperdeck_response(response: str) -> dict:
    """
    Parse a HyperDeck protocol response into a plain dict.

    The first non-blank line carries the numeric response code and a label,
    e.g. ``200 configuration:``.  Subsequent ``key: value`` lines are folded
    into the dict under their trimmed keys.  Two meta-keys are always
    present:

    * ``_code``   – integer response code (200 = success; 0 if unparseable)
    * ``_status`` – raw first non-blank line of the response (empty string if
                    the response is empty/whitespace)
    """
    lines = response.replace("\r\n", "\n").split("\n")
    # Guarantee that _code/_status are always present, even for empty responses.
    result: dict = {"_code": 0, "_status": ""}
    status_parsed = False
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if not status_parsed:
            # Treat the first non-blank line as the status line regardless of
            # its physical position in the response (handles leading blank lines).
            parts = line.split(" ", 1)
            try:
                result["_code"] = int(parts[0])
            except (ValueError, IndexError):
                result["_code"] = 0  # Default to 0 (unrecognised) on parse failure
            result["_status"] = line
            status_parsed = True
            continue
        if ":" in line:
            key, _, value = line.partition(":")
            result[key.strip()] = value.strip()
    return result


def build_configuration_command(settings: dict) -> list[str]:
    """
    Convert a plain settings dict into one or more HyperDeck
    ``configuration:`` command strings ready to be sent to the device.

    Each key-value pair becomes a separate command so the device can
    accept valid settings and reject invalid ones independently.
    """
    # Keys the HyperDeck configuration command accepts.
    ALLOWED_KEYS = {
        "video input",
        "audio input",
        "file format",
        "audio codec",
        "timecode input",
        "timecode output",
    }
    commands = []
    for key, value in settings.items():
        key_clean = key.strip().lower()
        if key_clean not in ALLOWED_KEYS:
            continue
        value_clean = str(value)
        if "\r" in value_clean or "\n" in value_clean:
            raise HTTPException(
                status_code=400,
                detail=f"Configuration value for '{key_clean}' must not contain line breaks.",
            )
        value_clean = value_clean.strip()
        if value_clean:
            commands.append(f"configuration: {key_clean}: {value_clean}")
    return commands
