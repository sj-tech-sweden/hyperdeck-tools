"""SMB/CIFS storage plugin.

Uploads files to SMB/CIFS shares (Windows file shares, Samba, etc.)
using the smbprotocol library. No manual mounting required.
"""

import os

PLUGIN_LABEL = "SMB / CIFS Share"
PLUGIN_DESCRIPTION = "Upload files to a Windows file share or Samba server"
PLUGIN_STORAGE_TYPE = "smb"
PLUGIN_CONFIG_FIELDS = [
    {"key": "server", "label": "Server Address", "type": "text", "required": True, "default": ""},
    {"key": "share", "label": "Share Name", "type": "text", "required": True, "default": ""},
    {"key": "username", "label": "Username", "type": "text", "required": True, "default": ""},
    {"key": "password", "label": "Password", "type": "password", "required": True, "default": ""},
    {"key": "domain", "label": "Domain (optional)", "type": "text", "required": False, "default": ""},
    {"key": "port", "label": "Port", "type": "text", "required": False, "default": "445"},
    {"key": "subfolder", "label": "Subfolder (optional)", "type": "text", "required": False, "default": ""},
]


def _get_smb_connection(config: dict):
    """Create and return an SMB connection."""
    try:
        from smbprotocol.connection import Connection
        from smbprotocol.session import Session
        from smbprotocol.tree import TreeConnect
    except ImportError:
        raise ImportError("smbprotocol is required for SMB storage. Install with: pip install smbprotocol")

    server = config.get("server", "")
    port = int(config.get("port", 445) or 445)
    username = config.get("username", "")
    password = config.get("password", "")
    domain = config.get("domain", "")
    share = config.get("share", "")

    if not server or not share:
        raise ValueError("server and share are required")

    conn = Connection(uuid_generate=True, server_name=server, port=port)
    conn.connect()

    session = Session(conn, username=username, password=password, domain=domain)
    session.connect()

    tree = TreeConnect(session, f"\\\\{server}\\{share}")
    tree.connect()

    return conn, session, tree


def _ensure_directory(tree, path_parts: list[str]) -> None:
    """Ensure a directory path exists on the SMB share."""
    from smbprotocol.open import Open, CreateDisposition, ImpersonationLevel, AccessMask, ShareAccess

    current = ""
    for part in path_parts:
        current = f"{current}/{part}" if current else part
        try:
            f = Open(tree, current)
            f.create(
                ImpersonationLevel.Impersonation,
                AccessMask.GENERIC_READ,
                None,
                0,
                CreateDisposition.FILE_OPEN,
                0,
                None,
            )
            f.close()
        except Exception:
            try:
                f = Open(tree, current)
                f.create(
                    ImpersonationLevel.Impersonation,
                    AccessMask.GENERIC_ALL,
                    None,
                    0,
                    CreateDisposition.FILE_CREATE,
                    0,
                    None,
                )
                f.close()
            except Exception:
                pass


def send_file(local_path: str, remote_name: str, config: dict) -> bool:
    """Upload a file to the configured SMB share."""
    if not os.path.exists(local_path):
        return False

    from smbprotocol.open import Open, CreateDisposition, ImpersonationLevel, AccessMask, ShareAccess

    conn, session, tree = None, None, None
    try:
        conn, session, tree = _get_smb_connection(config)

        subfolder = config.get("subfolder", "").strip()
        if subfolder:
            _ensure_directory(tree, subfolder.split("/"))
            remote_path = f"{subfolder}/{remote_name}"
        else:
            remote_path = remote_name

        with open(local_path, "rb") as local_file:
            f = Open(tree, remote_path)
            f.create(
                ImpersonationLevel.Impersonation,
                AccessMask.GENERIC_WRITE,
                None,
                0,
                CreateDisposition.FILE_OVERWRITE_IF,
                0,
                None,
            )
            offset = 0
            chunk_size = 1024 * 1024  # 1MB chunks
            while True:
                chunk = local_file.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk, offset)
                offset += len(chunk)
            f.close()

        return True
    except ImportError as e:
        raise e
    except Exception:
        return False
    finally:
        if tree:
            try:
                tree.disconnect()
            except Exception:
                pass
        if session:
            try:
                session.disconnect()
            except Exception:
                pass
        if conn:
            try:
                conn.disconnect()
            except Exception:
                pass


def test_connection(config: dict) -> dict:
    """Test SMB connectivity by connecting and listing the share."""
    try:
        from smbprotocol.open import Open, CreateDisposition, ImpersonationLevel, AccessMask
    except ImportError:
        return {"ok": False, "message": "smbprotocol is not installed. Install with: pip install smbprotocol"}

    conn, session, tree = None, None, None
    try:
        conn, session, tree = _get_smb_connection(config)

        f = Open(tree, "")
        f.create(
            ImpersonationLevel.Impersonation,
            AccessMask.GENERIC_READ,
            None,
            0,
            CreateDisposition.FILE_OPEN,
            0,
            None,
        )
        f.close()

        server = config.get("server", "")
        share = config.get("share", "")
        return {"ok": True, "message": f"Connected to \\\\{server}\\{share}"}
    except ImportError as e:
        return {"ok": False, "message": str(e)}
    except Exception as e:
        error_msg = str(e)
        if "STATUS_LOGON_FAILURE" in error_msg or "logon" in error_msg.lower():
            return {"ok": False, "message": "Authentication failed. Check username/password."}
        if "STATUS_BAD_NETWORK_NAME" in error_msg or "bad network" in error_msg.lower():
            return {"ok": False, "message": f"Share not found: {config.get('share', '')}"}
        return {"ok": False, "message": error_msg}
    finally:
        if tree:
            try:
                tree.disconnect()
            except Exception:
                pass
        if session:
            try:
                session.disconnect()
            except Exception:
                pass
        if conn:
            try:
                conn.disconnect()
            except Exception:
                pass
