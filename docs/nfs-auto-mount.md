# NFS auto-mount

The NFS storage plugin mounts the configured share **automatically** — there is
no need to run `mount` by hand. When you configure an NFS destination in the
WebUI (server, export path, local mount point) and click **Test Connection**, the
backend mounts the share, verifies writability, and leaves it mounted so the
folder browser can navigate it.

## Why mounts need root

`mount`/`umount` require root privileges. The backend therefore mounts via
`sudo` whenever it is not already running as root.

### Option A — keep the service as a limited user (recommended)

Grant the service account passwordless sudo for just the mount binaries:

```bash
sudo install -m 0440 deploy/hyperdeck-tools.sudoers /etc/sudoers.d/hyperdeck-tools
sudo visudo -c
```

The shipped file assumes the service runs as `sj-tech`; edit the username to
match your `hyperdeck-tools.service` `User=`.

### Option B — run the service as root

Set `User=root` in `hyperdeck-tools.service`. No sudoers rule is required, at
the cost of running the whole process as root.

## Browsing NFS shares

The destination folder browser in the WebUI can navigate the mounted share
directly. The mount point (e.g. `/mnt/hyperdeck_nfs`) appears under the
`/mnt` quick-access entry, and the browser will auto-mount the share on demand
if it is not already up.

If **Test Connection** reports a permission error after a successful mount, the
problem is on the NFS *server* side — typically `root_squash` mapping the
client's root to `nobody`. Fix the export (e.g. `no_root_squash` on a trusted
LAN, or `all_squash,anonuid=<uid>,anongid=<gid>` matching the client user) and
re-test.
