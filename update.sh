#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Preflight ---
command -v git >/dev/null 2>&1 || error "git is not installed."
command -v pip >/dev/null 2>&1 || error "pip is not installed."

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || error "Not inside a git repository."

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")"
info "Current branch: $CURRENT_BRANCH"

# --- Stash local changes ---
if ! git diff --quiet HEAD 2>/dev/null; then
  warn "Stashing local changes..."
  git stash push -m "auto-stash before update $(date +%Y%m%d-%H%M%S)"
  STASHED=1
else
  STASHED=0
fi

# --- Pull latest ---
info "Pulling latest from origin/$CURRENT_BRANCH..."
git pull --ff-only origin "$CURRENT_BRANCH" || {
  warn "Fast-forward failed. Attempting rebase..."
  git pull --rebase origin "$CURRENT_BRANCH" || error "Update failed. Resolve conflicts manually."
}

# --- Update requirements ---
if [ -f requirements.txt ]; then
  info "Installing/updating requirements..."
  pip install -r requirements.txt --upgrade
fi

# --- Restore stashed changes ---
if [ "$STASHED" -eq 1 ]; then
  warn "Restoring stashed changes..."
  git stash pop || warn "Could not restore stash. Run 'git stash list' to view it."
fi

# --- Summary ---
echo ""
info "Update complete."
echo ""
git log --oneline -5
echo ""
info "Restart HyperDeck Tools to apply changes."
