#!/usr/bin/env python3
import os
import signal
import sys
import uvicorn

if __name__ == "__main__":
    reload = os.environ.get("WP_RELOAD", "false").lower() == "true"
    host = os.environ.get("WP_HOST", "0.0.0.0")
    port = int(os.environ.get("WP_HTTP_PORT", "8009"))

    def _handle_sigint(sig, frame):
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_sigint)
    signal.signal(signal.SIGTERM, _handle_sigint)

    uvicorn.run("app.backend.wp_server:app", host=host, port=port, reload=reload)
