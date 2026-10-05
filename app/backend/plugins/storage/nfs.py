"""NFS storage plugin.

Uploads files to NFS shares by auto-mounting the share on demand and keeping
it mounted so the WebUI folder browser can navigate it. Mounting requires root
privileges; when the backend runs as a non-root user it invokes
``mount``/``umount`` via ``sudo`` (see deploy/hyperdeck-tools.sudoers).
"""

import logging
import os
import shutil
import subprocess
import threading

logger = logging.getLogger(__name__)

PLUGIN_LABEL = "NFS Share"
PLUGIN_DESCRIPTION = "Upload files to an NFS share (auto-mount on demand)"
PLUGIN_STORAGE_TYPE = "nfs"
PLUGIN_CONFIG_FIELDS = [
    {"key": "server", "label": "NFS Server Address", "type": "text", "required": True, "default": ""},
    {"key": "share", "label": "Export Path", "type": "text", "required": True, "default": "/export"},
    {
        "key": "mount_point", "label": "Local Mount Point", "type": "text",
        "required": True, "default": "/mnt/hyperdeck_nfs",
    },
    {
        "key": "options", "label": "Mount Options (optional)", "type": "text",
        "required": False, "default": "rw,soft,timeo=10",
    },
    {"key": "subfolder", "label": "Subfolder (optional)", "type": "text", "required": False, "default": ""},
]

_mount_locks: dict[str, threading.Lock] = {}
_mount_locks_guard = threading.Lock()


def _get_mount_lock(mount_point: str) -> threading.Lock:
    with _mount_locks_guard:
        if mount_point not in _mount_locks:
            _mount_locks[mount_point] = threading.Lock()
        return _mount_locks[mount_point]


def _run(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    """Run a command, prefixing with sudo when not running as root."""
    if os.geteuid() != 0:
        cmd = ["sudo", *cmd]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _is_mounted(mount_point: str) -> bool:
    """Check if a path is currently a mount point."""
    try:
        return os.path.ismount(mount_point)
    except Exception:
        return False


def ensure_mounted(config: dict) -> bool:
    """Mount the NFS share if it is not already mounted.

    Returns True on success. Raises RuntimeError with the underlying mount
    error when mounting fails, so callers can surface a useful message.
    """
    server = config.get("server", "")
    share = config.get("share", "/")
    mount_point = config.get("mount_point", "")
    options = config.get("options", "rw,soft,timeo=10")

    if not server or not mount_point:
        raise RuntimeError("server address and mount point are required")

    mount_point = os.path.abspath(os.path.expanduser(mount_point))
    if _is_mounted(mount_point):
        return True

    os.makedirs(mount_point, exist_ok=True)

    cmd = ["mount", "-t", "nfs"]
    if options:
        cmd.extend(["-o", options])
    cmd.extend([f"{server}:{share}", mount_point])

    try:
        result = _run(cmd)
    except subprocess.TimeoutExpired:
        raise RuntimeError("mount timed out (is the NFS server reachable?)")
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(stderr or "mount failed with no output")

    if not _is_mounted(mount_point):
        raise RuntimeError("mount reported success but the path is not mounted")
    return True


def ensure_unmounted(mount_point: str) -> bool:
    """Unmount the NFS share if it is mounted. Returns True when not mounted."""
    mount_point = os.path.abspath(os.path.expanduser(mount_point))
    if not _is_mounted(mount_point):
        return True
    try:
        result = _run(["umount", "-f", mount_point])
        if result.returncode != 0:
            result = _run(["umount", mount_point])
        return result.returncode == 0
    except Exception:
        return False


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured NFS share (mounting on demand)."""
    if not os.path.exists(local_path):
        return False

    mount_point = config.get("mount_point", "")
    if not mount_point:
        return False

    mount_lock = _get_mount_lock(mount_point)
    with mount_lock:
        try:
            ensure_mounted(config)

            subfolder = config.get("subfolder", "").strip()
            target_dir = os.path.join(mount_point, subfolder) if subfolder else mount_point
            os.makedirs(target_dir, exist_ok=True)

            target_path = os.path.join(target_dir, remote_name)
            shutil.copy2(local_path, target_path)
            return os.path.exists(target_path)
        except Exception as e:
            logger.warning("NFS upload failed: %s", e)
            return False
        # Intentionally left mounted so the WebUI folder browser (and subsequent
        # uploads) can reach the share without re-mounting every time.


def test_connection(config: dict) -> dict:
    """Test NFS connectivity by mounting, verifying writability, and reporting.

    The share is left mounted on success so it is immediately browsable.
    """
    server = config.get("server", "")
    share = config.get("share", "/")
    mount_point = config.get("mount_point", "")

    if not server:
        return {"ok": False, "message": "No NFS server address configured."}
    if not mount_point:
        return {"ok": False, "message": "No local mount point configured."}

    mount_lock = _get_mount_lock(mount_point)
    with mount_lock:
        try:
            ensure_mounted(config)
        except RuntimeError as e:
            return {"ok": False, "message": f"Failed to mount {server}:{share}: {e}"}
        except Exception as e:
            return {"ok": False, "message": f"Failed to mount {server}:{share}: {e}"}

        try:
            test_file = os.path.join(mount_point, ".hyperdeck_nfs_test")
            try:
                with open(test_file, "w") as f:
                    f.write("test")
                os.unlink(test_file)
            except PermissionError:
                return {
                    "ok": False,
                    "message": (
                        f"Mounted {server}:{share} at {mount_point}, but write "
                        f"permission denied. Check the NFS export's squash/permissions "
                        f"(e.g. root_squash maps root to nobody)."
                    ),
                }
            except OSError as e:
                return {"ok": False, "message": f"Write test failed: {e}"}

            return {
                "ok": True,
                "message": f"Connected to {server}:{share} (mounted at {mount_point})",
            }
        except Exception as e:
            return {"ok": False, "message": str(e)}
        # Intentionally left mounted so the folder browser can use it.
