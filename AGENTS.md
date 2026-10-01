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
chore(release): adopt label-driven release workflow
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

- `main` is the protected integration branch — never push to it directly.
- Develop on a `type/...` branch and open a pull request against `main`.
- Keep each PR focused on one logical change; the commit(s) on the branch must
  follow the Conventional Commits rules above.
- Once a PR is merged, the release is cut from it (see Release process): label the
  merged PR `major` / `minor` / `patch`, or run the Release workflow manually.

## Release process

Releases are driven by **semantic version labels** on a pull request
(`major`, `minor`, `patch`) or manually via the Release workflow's
`workflow_dispatch`.

- Labeling a PR (or dispatching) runs `.github/workflows/release.yml`, which:
  - determines the release type from the highest-priority present label
    (major > minor > patch),
  - computes the next semantic version from the latest `v*` git tag,
  - creates an annotated GitHub Release whose notes are grouped by Conventional
    Commit type (Features / Bug Fixes / Dependencies / Other), matching the
    stockwire-rental release-note style.
- Pushing the resulting tag triggers `.github/workflows/build.yml`, which builds
  the Docker image and the macOS/Windows binaries and attaches them to the
  release.

See [docs/using-the-release-workflow.md](docs/using-the-release-workflow.md) for
the step-by-step guide. To cut a release: label the merged (or merging) PR with
`patch`/`minor`/`major`, or run the Release workflow manually.

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
