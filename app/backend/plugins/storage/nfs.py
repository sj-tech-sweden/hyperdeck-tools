"""NFS storage plugin.

Uploads files to NFS shares by auto-mounting the share, copying the file,
and unmounting. Requires root/sudo access for mount operations.
"""

import os
import shutil
import subprocess
import threading

PLUGIN_LABEL = "NFS Share"
PLUGIN_DESCRIPTION = "Upload files to an NFS share (auto-mount/unmount)"
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


def _is_mounted(mount_point: str) -> bool:
    """Check if a path is currently a mount point."""
    try:
        result = subprocess.run(
            ["mountpoint", "-q", mount_point],
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def _mount_nfs(config: dict) -> bool:
    """Mount the NFS share. Returns True on success."""
    server = config.get("server", "")
    share = config.get("share", "/")
    mount_point = config.get("mount_point", "")
    options = config.get("options", "rw,soft,timeo=10")

    if not server or not mount_point:
        return False

    if _is_mounted(mount_point):
        return True

    os.makedirs(mount_point, exist_ok=True)

    try:
        cmd = ["mount", "-t", "nfs"]
        if options:
            cmd.extend(["-o", options])
        cmd.extend([f"{server}:{share}", mount_point])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False


def _umount_nfs(mount_point: str) -> bool:
    """Unmount the NFS share. Returns True on success."""
    if not _is_mounted(mount_point):
        return True

    try:
        result = subprocess.run(
            ["umount", "-f", mount_point],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            result = subprocess.run(
                ["umount", mount_point],
                capture_output=True,
                text=True,
                timeout=15,
            )
        return result.returncode == 0
    except Exception:
        return False


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured NFS share."""
    if not os.path.exists(local_path):
        return False

    server = config.get("server", "")
    mount_point = config.get("mount_point", "")
    if not server or not mount_point:
        return False

    mount_lock = _get_mount_lock(mount_point)
    with mount_lock:
        mounted_by_us = False
        try:
            if not _is_mounted(mount_point):
                if not _mount_nfs(config):
                    return False
                mounted_by_us = True

            subfolder = config.get("subfolder", "").strip()
            target_dir = os.path.join(mount_point, subfolder) if subfolder else mount_point
            os.makedirs(target_dir, exist_ok=True)

            target_path = os.path.join(target_dir, remote_name)
            shutil.copy2(local_path, target_path)
            return os.path.exists(target_path)
        except Exception:
            return False
        finally:
            if mounted_by_us:
                _umount_nfs(mount_point)


def test_connection(config: dict) -> dict:
    """Test NFS connectivity by mounting, verifying, and unmounting."""
    server = config.get("server", "")
    share = config.get("share", "/")
    mount_point = config.get("mount_point", "")

    if not server:
        return {"ok": False, "message": "No NFS server address configured."}
    if not mount_point:
        return {"ok": False, "message": "No local mount point configured."}

    mounted_by_us = False
    try:
        if not _is_mounted(mount_point):
            if not _mount_nfs(config):
                return {"ok": False, "message": f"Failed to mount {server}:{share}"}
            mounted_by_us = True

        if not os.path.isdir(mount_point):
            return {"ok": False, "message": f"Mount point does not exist: {mount_point}"}

        test_file = os.path.join(mount_point, ".hyperdeck_nfs_test")
        try:
            with open(test_file, "w") as f:
                f.write("test")
            os.unlink(test_file)
        except PermissionError:
            return {"ok": False, "message": f"Permission denied on {mount_point}"}
        except OSError as e:
            return {"ok": False, "message": f"Write test failed: {e}"}

        return {"ok": True, "message": f"Connected to {server}:{share}"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
    finally:
        if mounted_by_us:
            _umount_nfs(mount_point)
