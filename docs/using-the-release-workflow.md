# Using the Release Workflow

This document explains how releases are triggered, what gets built, and how to
use the resulting artifacts.

## How It Works

Releases are automated with
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action).
There are two workflows:

- **`release.yml`** runs on every push to `main`. It opens (and keeps up to date)
  a **release PR** that bumps the version in `.release-please-manifest.json` and
  rewrites the changelog (`RELEASES.md`) from the
  [Conventional Commits](https://www.conventionalcommits.org/) since the last
  release. Merging that PR publishes the GitHub Release and the `v*` tag.
- **`build.yml`** runs when the release is published. It builds and attaches the
  three artifacts:

| Artifact | Platform | Format |
| --- | --- | --- |
| Docker image | Linux (amd64 + arm64) | Multi-arch image on GHCR |
| Standalone binary | macOS (Apple Silicon) | `.zip` archive (`hyperdeck-tools-macos-<arch>.zip`) |
| Standalone binary | Windows (x64) | Single `.exe` file |

The version bump follows Conventional Commits: `fix` → patch, `feat` → minor,
and a `BREAKING CHANGE` / `!` → major.

## Triggering a Release

### 1. Merge Conventional-Commit PRs to `main`

No labels or manual dispatch are needed. As soon as commits land on `main`,
release-please opens (or updates) the release PR. The proposed version reflects
the commit types merged since the last release.

### 2. Review and merge the release PR

The release PR is titled like `chore(main): release vX.Y.Z` and contains the
changelog diff. Merge it to publish the GitHub Release and tag, which in turn
triggers `build.yml`.

### 3. What happens automatically

1. **Release PR** — `release.yml` opens/updates the release PR with the changelog
   (`RELEASES.md`) and version bump derived from Conventional Commits.
2. **Publish** — merging the release PR creates the GitHub Release + `v*` tag at
   `https://github.com/sj-tech-sweden/hyperdeck-tools/releases/tag/vX.Y.Z`.
3. **Build** — `build.yml` runs on the published release and attaches the
   artifacts:
   - **Docker** — Builds a multi-arch image (`linux/amd64` + `linux/arm64`) and pushes it to GitHub Container Registry
   - **macOS** — Builds a standalone binary with PyInstaller and attaches it to the release
   - **Windows** — Builds a standalone `.exe` with PyInstaller and attaches it to the release

### 4. Verify the release

- Go to [Releases](https://github.com/sj-tech-sweden/hyperdeck-tools/releases)
- Confirm the release appears with three assets and auto-generated notes
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

The macOS asset is a `.zip` named `hyperdeck-tools-macos-<arch>.zip` (e.g.
`hyperdeck-tools-macos-arm64.zip` on Apple Silicon).

1. Download `hyperdeck-tools-macos-<arch>.zip` from the release page
2. Unzip it:
   ```bash
   unzip hyperdeck-tools-macos-<arch>.zip
   ```
3. Make it executable:
   ```bash
   chmod +x hyperdeck-tools-macos-<arch>
   ```
4. Run it:
   ```bash
   ./hyperdeck-tools-macos-<arch>
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
| --- | --- |
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
  xattr -d com.apple.quarantine ./hyperdeck-tools-macos-<arch>
  ```
  ```

### Binary can't find config.yaml

- Place `config.yaml` in the same directory as the binary
- Or pass the full path via environment variable (not yet supported — use the working directory approach)
