"""Shared utilities for the hyperdeck-tools backend."""

import json
import logging
import os
import sys
import tempfile
from logging.handlers import RotatingFileHandler
from typing import Any

DEFAULT_LOG_DIR = "/var/log/hyperdeck-tools"


def setup_logging(service_name: str, default_log_dir: str = DEFAULT_LOG_DIR) -> None:
    """Also mirror root logging to a rotating file under a log directory.

    The directory is resolved in this order:
      1. ``HYPERDECK_LOG_DIR`` environment variable
      2. ``log_dir`` key in ``app/backend/config.json``
      3. ``default_log_dir`` (``/var/log/hyperdeck-tools``)

    If the directory cannot be created or written (e.g. no permissions, or a
    read-only test environment), file logging is skipped and a note is printed
    to stderr so startup is never blocked. The handler is idempotent, so
    calling this from multiple modules only ever adds one file handler.
    """
    root = logging.getLogger()
    for handler in root.handlers:
        if getattr(handler, "_hyperdeck_log_file", False):
            return

    log_dir = os.environ.get("HYPERDECK_LOG_DIR", "").strip()
    if not log_dir:
        try:
            with open("app/backend/config.json", encoding="utf-8") as fh:
                log_dir = json.load(fh).get("log_dir", "")
        except Exception:
            pass
    if not log_dir:
        log_dir = default_log_dir

    try:
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, f"{service_name}.log")
        file_handler = RotatingFileHandler(
            log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler._hyperdeck_log_file = True
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        root.addHandler(file_handler)
        # Raise the root level so app INFO logs are captured (never lower it).
        if root.level == logging.NOTSET or root.level > logging.INFO:
            root.setLevel(logging.INFO)
    except Exception as exc:  # pragma: no cover - best-effort only
        print(
            f"[logging] file logging unavailable at {log_dir}: {exc}",
            file=sys.stderr,
        )


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
