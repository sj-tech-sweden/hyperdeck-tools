# AGENTS.md — How to work in this repository

Guidance for AI assistants (and humans) contributing to HyperDeck Tools. Follow
these conventions so contributions stay consistent and reviewable.

## Repository at a glance

- **Stack:** FastAPI + Uvicorn backend (Python 3.12+), vanilla JS + Tailwind CSS
  v4 single-page frontend (`app/frontend/`).
- **Two services:** the HyperDeck control panel (`app/backend/server.py`, port
  `8008`) and the Web Presenter tools (`app/backend/wp_server.py`, port `8009`),
  supervised together by `run_both.py`.
- **Packaging:** multi-arch Docker image (`ghcr.io/sj-tech-sweden/hyperdeck-tools`)
  plus standalone macOS/Windows binaries built with PyInstaller.
- **Tooling:** Renovate for dependency updates, `ruff` for Python lint, `pytest`
  for tests. CI runs lint + tests on every push/PR (`.github/workflows/ci.yml`).

## Commit messages

Use **Conventional Commits**. This matches the release workflow, which derives
release notes and the next semantic version from the commit history.

```
<type>(<scope>): <subject>
```

- **type** (one of): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
  `test`, `build`, `ci`, `chore`.
- **scope**: short area, e.g. `webpresenter`, `hyperdeck`, `wp-daemon`,
  `plugins`, `release`, `ci`. Omit only when the change truly spans everything.
- **subject**: lowercase, imperative ("add", "fix", "remove"), no trailing
  period. Keep it short; put detail in the body if needed.
- Append `!` after the scope for breaking changes, e.g. `refactor(wp-daemon)!: ...`.

Good:
```
feat(webpresenter): add editable device config popup
fix(hyperdeck): correct protocol line terminator
chore(release): adopt release-please workflow
```

Bad:
```
Web Presenter: discovery fix   # not conventional; missing type/scope/colon
fixed stuff
Update
```

Do **not** commit unless the user explicitly asks. When asked, write the commit
message in this format and keep the diff focused on the requested change.

## Branch naming

Name branches with the same `type/` prefix as the commit type, kebab-cased:

```
feat/webpresenter-device-popup
fix/hyperdeck-line-terminator
chore/release-workflow
```

## Pull requests

- **All new functionality is delivered as a pull request** — features, fixes,
  refactors, docs, and config changes alike. Never commit or push directly to
  `main`; `main` is the protected integration branch.
- To add functionality: create a `type/...` branch (see Branch naming), implement
  the change there, and open a PR against `main` for review before it is merged.
- Keep each PR focused on one logical change; the commit(s) on the branch must
  follow the Conventional Commits rules above.
- Once a PR is merged, the release is cut from it automatically (see Release
  process). No labels or manual dispatch are needed.

## Release process

Releases are automated with
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action).
release-please watches `main` and opens (and keeps up to date) a **release PR**
that bumps the version in `.release-please-manifest.json` and rewrites the
changelog (`RELEASES.md`) from the Conventional Commits since the last release.
The version bump follows Conventional Commits: `fix` → patch, `feat` → minor,
and a `BREAKING CHANGE`/`!` → major.

- `.github/workflows/release.yml` runs release-please on every push to `main` and
  creates/updates the release PR. Merging that PR publishes the GitHub Release
  and the `v*` tag (per `release-please-config.json`).
- When the release is published, `.github/workflows/build.yml` builds the Docker
  image (multi-arch) and the macOS/Windows binaries and attaches them to the
  release.

See [docs/using-the-release-workflow.md](docs/using-the-release-workflow.md) for
the step-by-step guide. To cut a release: just merge your Conventional-Commit PRs
to `main`; merging the release-please release PR publishes the release and kicks
off the asset build.

## General

- Match existing code style and frameworks; don't introduce new libraries
  without first checking the codebase already uses them.
- Keep the two services consistent: shared patterns (storage keys, audit
  logging, the `app.backend.utils` helpers) live in `app/backend`.
- Don't hardcode secrets or API keys. Runtime configuration comes from
  `config.json` / environment variables, never from source.
- Run the project's lint and tests before considering a change done:
  - `ruff check app/ tests/`
  - `pytest -q`
- Don't commit unless asked.
