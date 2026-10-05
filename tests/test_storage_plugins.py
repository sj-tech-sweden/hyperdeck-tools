import os

from app.backend.plugins.storage import nfs as nfs_plugin
from app.backend.storage_plugin_manager import (
    StorageTransferQueue,
    discover_storage_plugins,
    read_storage_plugin_manifest,
)


class TestDiscoverStoragePlugins:
    def test_finds_smb_plugin(self):
        plugins = discover_storage_plugins()
        types = [p["storage_type"] for p in plugins]
        assert "smb" in types

    def test_finds_nfs_plugin(self):
        plugins = discover_storage_plugins()
        types = [p["storage_type"] for p in plugins]
        assert "nfs" in types

    def test_finds_s3_plugin(self):
        plugins = discover_storage_plugins()
        types = [p["storage_type"] for p in plugins]
        assert "s3" in types

    def test_finds_sharepoint_plugin(self):
        plugins = discover_storage_plugins()
        types = [p["storage_type"] for p in plugins]
        assert "sharepoint" in types

    def test_finds_nextcloud_plugin(self):
        plugins = discover_storage_plugins()
        types = [p["storage_type"] for p in plugins]
        assert "nextcloud" in types


class TestReadStoragePluginManifest:
    def test_smb_manifest(self):
        manifest = read_storage_plugin_manifest("smb")
        assert manifest is not None
        assert manifest["storage_type"] == "smb"
        assert manifest["label"] == "SMB / CIFS Share"
        assert manifest["enabled"] is True
        assert len(manifest["config_fields"]) == 7

    def test_nfs_manifest(self):
        manifest = read_storage_plugin_manifest("nfs")
        assert manifest is not None
        assert manifest["storage_type"] == "nfs"
        assert manifest["label"] == "NFS Share"
        assert manifest["enabled"] is True
        assert len(manifest["config_fields"]) == 5

    def test_s3_manifest(self):
        manifest = read_storage_plugin_manifest("s3")
        assert manifest is not None
        assert manifest["storage_type"] == "s3"
        assert manifest["label"] == "Amazon S3"
        assert manifest["enabled"] is True
        assert len(manifest["config_fields"]) == 6

    def test_sharepoint_manifest(self):
        manifest = read_storage_plugin_manifest("sharepoint")
        assert manifest is not None
        assert manifest["storage_type"] == "sharepoint"
        assert manifest["label"] == "SharePoint / OneDrive"
        assert manifest["enabled"] is True
        assert len(manifest["config_fields"]) == 7

    def test_nextcloud_manifest(self):
        manifest = read_storage_plugin_manifest("nextcloud")
        assert manifest is not None
        assert manifest["storage_type"] == "nextcloud"
        assert manifest["label"] == "Nextcloud"
        assert manifest["enabled"] is True
        assert len(manifest["config_fields"]) == 4

    def test_nonexistent_plugin(self):
        manifest = read_storage_plugin_manifest("nonexistent_plugin")
        assert manifest is None

    def test_config_field_structure(self):
        manifest = read_storage_plugin_manifest("smb")
        field = manifest["config_fields"][0]
        assert "key" in field
        assert "label" in field
        assert "type" in field
        assert "required" in field


class TestStorageTransferQueue:
    def test_initial_status(self):
        queue = StorageTransferQueue("test-dest", max_concurrent=1)
        status = queue.get_status()
        assert status["pending"] == 0
        assert status["active"] == 0
        assert status["completed"] == 0
        assert status["failed"] == 0

    def test_reset_counts(self):
        queue = StorageTransferQueue("test-dest", max_concurrent=1)
        queue._completed = 5
        queue._failed = 2
        queue.reset_counts()
        status = queue.get_status()
        assert status["completed"] == 0
        assert status["failed"] == 0

    def test_max_concurrent_property(self):
        queue = StorageTransferQueue("test-dest", max_concurrent=3)
        assert queue.max_concurrent == 3
        queue.max_concurrent = 5
        assert queue.max_concurrent == 5
        queue.max_concurrent = 0
        assert queue.max_concurrent == 1


class TestNfsMount:
    def test_ensure_mounted_reports_missing_nfs_helper(self, monkeypatch):
        monkeypatch.setattr(nfs_plugin, "_is_mounted", lambda p: False)
        monkeypatch.setattr(nfs_plugin.os, "makedirs", lambda *a, **k: None)
        monkeypatch.setattr(nfs_plugin.shutil, "which", lambda name: None)

        try:
            nfs_plugin.ensure_mounted(
                {"server": "10.0.0.5", "share": "/export", "mount_point": "/mnt/foo"}
            )
            assert False, "expected RuntimeError"
        except RuntimeError as exc:
            assert "install nfs-common" in str(exc)

    def test_ensure_mounted_invokes_mount(self, monkeypatch):
        captured = {}
        state = {"mounted": False}

        def fake_ismount(p):
            return state["mounted"]

        def fake_run(cmd, timeout=30):
            state["mounted"] = True
            captured["cmd"] = list(cmd)

            class R:
                returncode = 0
                stderr = ""
                stdout = ""

            return R()

        monkeypatch.setattr(nfs_plugin, "_run", fake_run)
        monkeypatch.setattr(nfs_plugin, "_is_mounted", fake_ismount)
        monkeypatch.setattr(nfs_plugin.os, "makedirs", lambda *a, **k: None)
        monkeypatch.setattr(nfs_plugin.shutil, "which", lambda name: "/sbin/mount.nfs")
        assert nfs_plugin.ensure_mounted(
            {"server": "10.0.0.5", "share": "/export", "mount_point": "/mnt/foo"}
        ) is True
        assert "mount" in captured["cmd"]
        assert "-t" in captured["cmd"] and "nfs" in captured["cmd"]

    def test_ensure_mounted_raises_on_failure(self, monkeypatch):
        def fake_run(cmd, timeout=30):
            class R:
                returncode = 32
                stderr = "mount.nfs: access denied by server"
                stdout = ""

            return R()

        monkeypatch.setattr(nfs_plugin, "_run", fake_run)
        monkeypatch.setattr(nfs_plugin, "_is_mounted", lambda p: False)
        monkeypatch.setattr(nfs_plugin.os, "makedirs", lambda *a, **k: None)
        monkeypatch.setattr(nfs_plugin.shutil, "which", lambda name: "/sbin/mount.nfs")
        try:
            nfs_plugin.ensure_mounted(
                {"server": "10.0.0.5", "share": "/export", "mount_point": "/mnt/foo"}
            )
            assert False, "expected RuntimeError"
        except RuntimeError as exc:
            assert "access denied" in str(exc)

    def test_ensure_unmounted_true_when_not_mounted(self, monkeypatch):
        monkeypatch.setattr(nfs_plugin, "_is_mounted", lambda p: False)
        assert nfs_plugin.ensure_unmounted("/mnt/foo") is True
