#!/usr/bin/env python3
"""Run and supervise both HyperDeck and Web Presenter services.

This is a small, dependency-free supervisor: it keeps both uvicorn processes
alive, restarts either one if it crashes (with a short backoff), and frees a
port held by a stale process on startup so you never get stuck on
"port already in use". Send SIGHUP (or `kill -HUP <pid>`) to reload both
services without a full restart.

Usage:
    python run_both.py                    # Run + supervise both on default ports
    python run_both.py --reload           # Enable hot reload for development
    python run_both.py --hd-port 8008 --wp-port 8009  # Custom ports
    python run_both.py --no-kill-port      # Fail instead of freeing a busy port

Environment variables:
    HD_RELOAD=1   Enable HyperDeck hot reload
    WP_RELOAD=1   Enable Web Presenter hot reload
    HD_HOST       HyperDeck bind address (default: 0.0.0.0)
    WP_HOST       Web Presenter bind address (default: 0.0.0.0)
    HD_PORT       HyperDeck port (default: 8008)
    WP_PORT       Web Presenter port (default: 8009)
"""
import argparse
import os
import signal
import socket
import subprocess
import sys
import time

RESTART_BACKOFF = 2.0  # seconds to wait before restarting a crashed child


def _is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.settimeout(1)
            s.bind((host, port))
            return False
        except OSError:
            return True


def _pids_on_port(port: int) -> list[int]:
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}"],
            capture_output=True, text=True,
        ).stdout.strip()
        return [int(p) for p in out.split() if p.strip()] if out else []
    except Exception:
        return []


def _free_port(port: int, kill: bool) -> bool:
    """Free a port by terminating the process holding it. Returns True if free."""
    pids = _pids_on_port(port)
    if not pids:
        return True
    if not kill:
        return False
    print(f"  Port {port} held by PID(s) {pids}; terminating them...")
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    for _ in range(20):
        time.sleep(0.5)
        if not _is_port_in_use("0.0.0.0", port):
            return True
    # Hard kill fallback
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    time.sleep(1)
    return not _is_port_in_use("0.0.0.0", port)


class _Child:
    def __init__(self, name: str, cmd: list[str], env: dict):
        self.name = name
        self.cmd = cmd
        self.env = env
        self.proc: subprocess.Popen | None = None
        self.last_start = 0.0

    def start(self) -> None:
        self.last_start = time.time()
        self.proc = subprocess.Popen(self.cmd, env=self.env)
        print(f"  Started {self.name} (pid {self.proc.pid})")

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def wait(self, timeout: float = 5.0) -> None:
        if self.proc:
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()


def main():
    parser = argparse.ArgumentParser(description="Supervise HyperDeck and Web Presenter services")
    parser.add_argument("--reload", action="store_true", help="Enable hot reload for both services")
    parser.add_argument("--hd-port", type=int, default=int(os.environ.get("HD_PORT", "8008")))
    parser.add_argument("--wp-port", type=int, default=int(os.environ.get("WP_PORT", "8009")))
    parser.add_argument("--hd-host", default=os.environ.get("HD_HOST", "0.0.0.0"))
    parser.add_argument("--wp-host", default=os.environ.get("WP_HOST", "0.0.0.0"))
    parser.add_argument("--kill-port", dest="kill_port", action="store_true", default=True,
                        help="Free a port held by a stale process on startup (default)")
    parser.add_argument("--no-kill-port", dest="kill_port", action="store_false",
                        help="Fail instead of freeing a busy port")
    args = parser.parse_args()

    hd_reload = args.reload or os.environ.get("HD_RELOAD", "").lower() in ("1", "true")
    wp_reload = args.reload or os.environ.get("WP_RELOAD", "").lower() in ("1", "true")
    env = os.environ.copy()
    python = sys.executable

    # Pre-flight: free any busy ports so we don't error out.
    for svc, host, port in (("HyperDeck", args.hd_host, args.hd_port),
                             ("Web Presenter", args.wp_host, args.wp_port)):
        if _is_port_in_use(host, port):
            if not _free_port(port, kill=args.kill_port):
                print(f"ERROR: Port {port} is already in use by another process ({svc}).")
                print("       Kill it manually, or let this script free it (default behavior).")
                sys.exit(1)
            if args.kill_port:
                print(f"  Freed port {port} for {svc}.")

    hd_cmd = [python, "-m", "uvicorn", "app.backend.server:app",
              "--host", args.hd_host, "--port", str(args.hd_port),
              *([] if not hd_reload else ["--reload"])]
    wp_cmd = [python, "-m", "uvicorn", "app.backend.wp_server:app",
              "--host", args.wp_host, "--port", str(args.wp_port),
              *([] if not wp_reload else ["--reload"])]

    children = [
        _Child("HyperDeck", hd_cmd, env),
        _Child("Web Presenter", wp_cmd, env),
    ]

    shutdown = {"requested": False}
    reload_requested = {"requested": False}

    def _on_term(signum, frame):
        shutdown["requested"] = True

    def _on_hup(signum, frame):
        reload_requested["requested"] = True

    signal.signal(signal.SIGINT, _on_term)
    signal.signal(signal.SIGTERM, _on_term)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _on_hup)

    print(f"Supervising HyperDeck on {args.hd_host}:{args.hd_port} (reload={hd_reload})")
    print(f"Supervising Web Presenter on {args.wp_host}:{args.wp_port} (reload={wp_reload})")
    print(f"HyperDeck UI: http://localhost:{args.hd_port}")
    print(f"Web Presenter UI: http://localhost:{args.wp_port}")
    print("Ctrl+C to stop. Send SIGHUP to reload both services.\n")

    for c in children:
        c.start()

    try:
        while not shutdown["requested"]:
            if reload_requested["requested"]:
                reload_requested["requested"] = False
                print("Reloading both services...")
                for c in children:
                    c.stop()
                    c.wait()
                    c.start()
                continue

            for c in children:
                if not c.alive():
                    # Avoid tight restart loops on instant crashes.
                    elapsed = time.time() - c.last_start
                    if elapsed < RESTART_BACKOFF:
                        time.sleep(RESTART_BACKOFF - elapsed)
                    print(f"WARNING: {c.name} exited; restarting...")
                    c.start()
            time.sleep(1)
    finally:
        print("\nShutting down...")
        for c in children:
            c.stop()
        for c in children:
            c.wait()


if __name__ == "__main__":
    main()
