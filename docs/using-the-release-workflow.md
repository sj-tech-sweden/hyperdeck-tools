# Using the Release Workflow

This document explains how to trigger releases, what gets built, and how to use the resulting artifacts.

## How It Works

The release workflow (`.github/workflows/release.yml`) runs automatically when you push a version tag. It produces three artifacts:

| Artifact | Platform | Format |
|---|---|---|
| Docker image | Linux (amd64 + arm64) | Multi-arch image on GHCR |
| Standalone binary | macOS (Apple Silicon) | Single executable file |
| Standalone binary | Windows (x64) | Single `.exe` file |

All three are attached to a GitHub Release created from the tag.

## Triggering a Release

### 1. Create and push a tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

### 2. What happens automatically

The workflow runs three jobs in parallel:

1. **Docker** — Builds a multi-arch image (`linux/amd64` + `linux/arm64`) and pushes it to GitHub Container Registry
2. **macOS** — Builds a standalone binary with PyInstaller and attaches it to the release
3. **Windows** — Builds a standalone `.exe` with PyInstaller and attaches it to the release

A GitHub Release is created at `https://github.com/sj-tech-sweden/hyperdeck-tools/releases/tag/v1.0.0` with all three artifacts.

### 3. Verify the release

- Go to [Releases](https://github.com/sj-tech-sweden/hyperdeck-tools/releases)
- Confirm the release appears with three assets
- Check the Docker build in [Packages](https://github.com/sj-tech-sweden/hyperdeck-tools/pkgs/container/hyperdeck-tools)

## Docker Image

### Pulling

```bash
# Latest release
docker pull ghcr.io/sj-tech-sweden/hyperdeck-tools:latest

# Specific version
docker pull ghcr.io/sj-tech-sweden/hyperdeck-tools:1.0.0

# Specific minor version
docker pull ghcr.io/sj-tech-sweden/hyperdeck-tools:1.0
```

### Running

```bash
docker run -d \
  --name hyperdeck-tools \
  -p 8008:8008 \
  -v /path/to/your/config.yaml:/app/config.yaml \
  ghcr.io/sj-tech-sweden/hyperdeck-tools:latest
```

### Environment Variables

Pass environment variables with `-e`:

```bash
docker run -d \
  -p 8008:8008 \
  -e HYPERDECK_HOST=0.0.0.0 \
  -e HYPERDECK_PORT=8008 \
  -e HYPERDECK_RELOAD=false \
  -e HYPERDECK_CORS_ORIGINS=https://myhost.example.com \
  -v /path/to/config.yaml:/app/config.yaml \
  ghcr.io/sj-tech-sweden/hyperdeck-tools:latest
```

### Multi-Architecture Support

The Docker image is built for both `linux/amd64` (Intel/AMD) and `linux/arm64` (Apple Silicon, Raspberry Pi, AWS Graviton). Docker automatically pulls the correct architecture for your machine.

Verify the architecture:

```bash
docker inspect ghcr.io/sj-tech-sweden/hyperdeck-tools:latest | grep Architecture
```

## Standalone Binaries

### macOS

1. Download `hyperdeck-tools` from the release page
2. Make it executable:
   ```bash
   chmod +x hyperdeck-tools
   ```
3. Run it:
   ```bash
   ./hyperdeck-tools
   ```

### Windows

1. Download `hyperdeck-tools.exe` from the release page
2. Double-click or run from Command Prompt:
   ```
   hyperdeck-tools.exe
   ```

### Configuring Binaries

Pass environment variables before the command:

```bash
HYPERDECK_PORT=9000 ./hyperdeck-tools
```

Or on Windows:

```
set HYPERDECK_PORT=9000
hyperdeck-tools.exe
```

The binary looks for `config.yaml` in the current working directory. Place it next to the executable or run from the project root.

## Versioning

The workflow uses semantic versioning tags:

| Tag | Result |
|---|---|
| `v1.0.0` | Docker tags: `1.0.0`, `1.0`, `latest` |
| `v1.2.3` | Docker tags: `1.2.3`, `1.2`, `latest` |
| `v2.0.0-rc1` | Docker tag: `2.0.0-rc1` |

The `latest` tag always points to the most recent release.

## Troubleshooting

### Docker build fails

- Ensure the tag follows `v*` format (e.g., `v1.0.0`)
- Check the [Actions tab](https://github.com/sj-tech-sweden/hyperdeck-tools/actions) for build logs
- QEMU cross-compilation for arm64 may be slow on first build — subsequent builds use GitHub Actions cache

### Binary doesn't start on macOS

- macOS may block unsigned binaries. Right-click → Open, or remove quarantine:
  ```bash
  xattr -d com.apple.quarantine ./hyperdeck-tools
  ```

### Binary can't find config.yaml

- Place `config.yaml` in the same directory as the binary
- Or pass the full path via environment variable (not yet supported — use the working directory approach)
