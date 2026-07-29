"""Shared utilities for the hyperdeck-tools backend."""

import json
import os
import tempfile
from typing import Any


def atomic_json_write(file_path: str, data: Any) -> None:
    """Write JSON data atomically using a temp file + rename."""
    dir_name = os.path.dirname(file_path) or "."
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        os.replace(tmp_path, file_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
