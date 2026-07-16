#!/usr/bin/env python3
import os
import uvicorn

if __name__ == "__main__":
    reload = os.environ.get("HYPERDECK_RELOAD", "true").lower() == "true"
    host = os.environ.get("HYPERDECK_HOST", "0.0.0.0")
    port = int(os.environ.get("HYPERDECK_PORT", "8008"))

    uvicorn.run("app.backend.server:app", host=host, port=port, reload=reload)
