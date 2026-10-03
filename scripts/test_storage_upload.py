#!/usr/bin/env python3
"""Offline storage-plugin smoke test.

Reads the enabled destinations from app/backend/config.json and, for each one,
runs the plugin's `test_connection()` and then uploads a small sample file via
`send_file()`. This exercises the full plugin code path (including the
StorageTransferQueue file copy) without needing a HyperDeck deck.

Run it inside the app container so it can reach the mock backends on the
compose network:

    docker compose -f docker-compose.storage-test.yml exec app \
        python scripts/test_storage_upload.py

After a run, verify the file actually landed in the backend:
    S3/Garage: docker compose -f docker-compose.storage-test.yml logs garage-init
               (the printed access/secret keys are what you paste into the S3
               destination; the bucket is "hyperdeck")
    Samba:     docker compose -f docker-compose.storage-test.yml exec samba ls -la /share
    NFS:       docker run --rm -v hyperdeck-tools_nfs-data:/data busybox ls -la /data
    Nextcloud: browse http://localhost:8080  -> Files -> /HyperDeck
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.backend.storage_plugin_manager import (
    load_storage_destinations,
    test_storage_connection,
    send_file_to_storage,
)


def main() -> int:
    destinations = [d for d in load_storage_destinations() if d.get("enabled", True)]
    if not destinations:
        print("No enabled storage destinations found.")
        print("Add them first via the UI at http://localhost:8008 (Storage Destinations).")
        return 1

    failures = 0
    for dest in destinations:
        plugin_type = dest.get("plugin_type", "")
        label = dest.get("label", plugin_type)
        config = dest.get("config", {})

        print(f"\n=== {label} ({plugin_type}) ===")

        conn = test_storage_connection(plugin_type, config)
        print(f"test_connection: ok={conn.get('ok')} message={conn.get('message')!r}")
        if not conn.get("ok"):
            failures += 1
            print("  -> skipping upload (connection test failed)")
            continue

        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tf:
            tf.write(f"hyperdeck-tools storage smoke test @ {time.time()}\n".encode())
            local_path = tf.name
        remote_name = f"storage_test_{int(time.time())}.txt"

        ok = send_file_to_storage(plugin_type, local_path, remote_name, config)
        print(f"send_file: {'OK' if ok else 'FAILED'} -> {remote_name}")
        if not ok:
            failures += 1

        os.unlink(local_path)

    print(f"\nDone. {failures} destination(s) failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
