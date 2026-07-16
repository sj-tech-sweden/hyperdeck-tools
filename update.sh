#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Virtual environment ---
if [ -d "$REPO_DIR/.venv" ]; then
  info "Activating .venv..."
  # shellcheck disable=SC1091
  source "$REPO_DIR/.venv/bin/activate"
elif [ -d "$REPO_DIR/venv" ]; then
  info "Activating venv..."
  source "$REPO_DIR/venv/bin/activate"
fi

PIP=""
if command -v pip3 >/dev/null 2>&1; then
  PIP="pip3"
elif command -v pip >/dev/null 2>&1; then
  PIP="pip"
fi

# --- Preflight ---
command -v git >/dev/null 2>&1 || error "git is not installed."
[ -n "$PIP" ] || error "pip is not installed."

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || error "Not inside a git repository."

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
if [ -z "$CURRENT_BRANCH" ]; then
  error "Detached HEAD detected. Checkout a branch first (e.g. 'git checkout main')."
fi
info "Current branch: $CURRENT_BRANCH"

# --- Show what will be updated ---
echo ""
info "Latest commits from origin/$CURRENT_BRANCH:"
git log --oneline HEAD..origin/"$CURRENT_BRANCH" 2>/dev/null | head -10 || echo "  (up to date or no remote tracking)"
echo ""

# --- Confirmation ---
echo -en "${CYAN}Proceed with update? [y/N]${NC} "
read -r REPLY
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  info "Aborted."
  exit 0
fi

# --- Stash changes (including untracked files) ---
STASHED=0
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  warn "Stashing local changes (including untracked files)..."
  git stash push --include-untracked -m "auto-stash before update $(date +%Y-%m-%d_%H-%M-%S)"
  STASHED=1
fi

# --- Pull latest ---
info "Pulling latest from origin/$CURRENT_BRANCH..."
if ! git pull --ff-only origin "$CURRENT_BRANCH" 2>/dev/null; then
  warn "Fast-forward failed. Attempting rebase..."
  git pull --rebase origin "$CURRENT_BRANCH" || {
    # Restore stash before exiting so user doesn't lose work
    [ "$STASHED" -eq 1 ] && git stash pop || true
    error "Update failed. Resolve conflicts manually."
  }
fi

# --- Update requirements ---
if [ -f requirements.txt ]; then
  REQ_HASH_BEFORE=$(md5 -q requirements.txt 2>/dev/null || md5sum requirements.txt 2>/dev/null | cut -d' ' -f1)
  # Re-check after pull
  REQ_HASH_AFTER=$(md5 -q requirements.txt 2>/dev/null || md5sum requirements.txt 2>/dev/null | cut -d' ' -f1)
  if [ "$REQ_HASH_BEFORE" != "$REQ_HASH_AFTER" ]; then
    info "requirements.txt changed — installing updated dependencies..."
    $PIP install -r requirements.txt --upgrade
  else
    info "requirements.txt unchanged — skipping pip install."
  fi
fi

# --- Restore stashed changes ---
if [ "$STASHED" -eq 1 ]; then
  warn "Restoring stashed changes..."
  if ! git stash pop; then
    warn "Stash conflict. Your changes are saved — run 'git stash list' to view, 'git stash pop' to retry."
  fi
fi

# --- Summary ---
echo ""
info "Update complete."
echo ""
git log --oneline -5
echo ""
info "Restart HyperDeck Tools to apply changes."
