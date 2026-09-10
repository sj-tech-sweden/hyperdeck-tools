#!/usr/bin/env python3
"""Run both HyperDeck and Web Presenter services simultaneously.

Usage:
    python run_both.py                    # Run both on default ports
    python run_both.py --reload           # Enable hot reload for development
    python run_both.py --hd-port 8008 --wp-port 8009  # Custom ports

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


def _is_port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.settimeout(1)
            s.bind((host, port))
            return False
        except OSError:
            return True


def main():
    parser = argparse.ArgumentParser(description="Run HyperDeck and Web Presenter services")
    parser.add_argument("--reload", action="store_true", help="Enable hot reload for both services")
    parser.add_argument("--hd-port", type=int, default=int(os.environ.get("HD_PORT", "8008")))
    parser.add_argument("--wp-port", type=int, default=int(os.environ.get("WP_PORT", "8009")))
    parser.add_argument("--hd-host", default=os.environ.get("HD_HOST", "0.0.0.0"))
    parser.add_argument("--wp-host", default=os.environ.get("WP_HOST", "0.0.0.0"))
    args = parser.parse_args()

    hd_reload = args.reload or os.environ.get("HD_RELOAD", "").lower() in ("1", "true")
    wp_reload = args.reload or os.environ.get("WP_RELOAD", "").lower() in ("1", "true")

    # Pre-flight port check
    ports_ok = True
    if _is_port_in_use(args.hd_host, args.hd_port):
        print(f"ERROR: Port {args.hd_port} is already in use (HyperDeck).")
        print("       Kill the existing process or use --hd-port to use a different port.")
        ports_ok = False
    if _is_port_in_use(args.wp_host, args.wp_port):
        print(f"ERROR: Port {args.wp_port} is already in use (Web Presenter).")
        print("       Kill the existing process or use --wp-port to use a different port.")
        ports_ok = False
    if not ports_ok:
        sys.exit(1)

    env = os.environ.copy()
    python = sys.executable

    print(f"Starting HyperDeck on {args.hd_host}:{args.hd_port} (reload={hd_reload})")
    print(f"Starting Web Presenter on {args.wp_host}:{args.wp_port} (reload={wp_reload})")
    print(f"HyperDeck UI: http://localhost:{args.hd_port}")
    print(f"Web Presenter UI: http://localhost:{args.wp_port}")
    print("Press Ctrl+C to stop both services.\n")

    hd_proc = subprocess.Popen(
        [python, "-m", "uvicorn", "app.backend.server:app",
         "--host", args.hd_host, "--port", str(args.hd_port),
         *([] if not hd_reload else ["--reload"])],
        env=env,
    )

    time.sleep(0.5)

    wp_proc = subprocess.Popen(
        [python, "-m", "uvicorn", "app.backend.wp_server:app",
         "--host", args.wp_host, "--port", str(args.wp_port),
         *([] if not wp_reload else ["--reload"])],
        env=env,
    )

    def _shutdown(sig=None, frame=None):
        for proc in [hd_proc, wp_proc]:
            if proc.poll() is None:
                proc.terminate()
        for proc in [hd_proc, wp_proc]:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        while hd_proc.poll() is None or wp_proc.poll() is None:
            if hd_proc.poll() is not None and hd_proc.returncode != 0:
                print(f"HyperDeck exited with code {hd_proc.returncode}")
                break
            if wp_proc.poll() is not None and wp_proc.returncode != 0:
                print(f"Web Presenter exited with code {wp_proc.returncode}")
                break
            time.sleep(1)
        _shutdown()
    except KeyboardInterrupt:
        _shutdown()


if __name__ == "__main__":
    main()
