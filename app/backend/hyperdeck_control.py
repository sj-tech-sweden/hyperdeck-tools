# app/backend/hyperdeck_control.py
"""
Async utilities for communicating with HyperDeck devices over
the Ethernet Control Protocol (TCP port 9993).
"""
import asyncio
from fastapi import HTTPException

HYPERDECK_PORT = 9993
COMMAND_TIMEOUT = 5.0


async def send_hyperdeck_command(
    host: str,
    command: str,
    port: int = HYPERDECK_PORT,
    timeout: float = COMMAND_TIMEOUT,
) -> str:
    """
    Open a TCP connection to a HyperDeck, discard the initial protocol
    banner, send *command*, and return the response text.

    Raises HTTPException (503 / 504) on connection or timeout errors.
    """
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
        await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=timeout)

        writer.write(f"{command}\r\n".encode())
        await writer.drain()

        # All responses end with a blank line (\r\n\r\n).
        response_bytes = await asyncio.wait_for(
            reader.readuntil(b"\r\n\r\n"), timeout=timeout
        )
        return response_bytes.decode("utf-8", errors="replace").strip()
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"Command '{command}' timed out on HyperDeck at {host}:{port}",
        )
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

    The first line carries the numeric response code and a label, e.g.
    ``200 configuration:``.  Subsequent ``key: value`` lines are folded
    into the dict under their trimmed keys.  Two meta-keys are always
    present:

    * ``_code``   – integer response code (200 = success)
    * ``_status`` – raw first line of the response
    """
    lines = response.replace("\r\n", "\n").split("\n")
    result: dict = {}
    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        if i == 0:
            parts = line.split(" ", 1)
            try:
                result["_code"] = int(parts[0])
            except (ValueError, IndexError):
                result["_code"] = None
            result["_status"] = line
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
        value_clean = str(value).strip()
        if value_clean:
            commands.append(f"configuration: {key_clean}: {value_clean}")
    return commands
