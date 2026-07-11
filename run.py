#!/usr/bin/env python3
import uvicorn

if __name__ == "__main__":
    # Boots the ASGI web server directly targeting our application module wrapper
    uvicorn.run("app.backend.server:app", host="0.0.0.0", port=8008, reload=True)