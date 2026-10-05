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

SERVICE_NAME="hyperdeck-tools.service"
SERVICE_USER=""

resolve_service_user() {
  if [ -n "${HYPERDECK_SERVICE_USER:-}" ]; then
    SERVICE_USER="$HYPERDECK_SERVICE_USER"
  elif command -v systemctl >/dev/null 2>&1 \
    && systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
    SERVICE_USER="$(systemctl show "$SERVICE_NAME" --property=User --value)"
    SERVICE_USER="${SERVICE_USER:-root}"
  else
    SERVICE_USER="${SUDO_USER:-$(id -un)}"
  fi
}

configure_mount_permissions() {
  [ "$(uname -s)" = "Linux" ] || return 0
  resolve_service_user

  if [ "$SERVICE_USER" = "root" ]; then
    info "HyperDeck Tools runs as root; skipping /mnt permission setup."
    return 0
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    warn "Cannot find service user '$SERVICE_USER'; skipping /mnt permission setup."
    return 1
  fi
  if [ ! -d /mnt ]; then
    warn "/mnt does not exist; skipping mount permission setup."
    return 1
  fi

  local mount_group="hyperdeck-mount"
  local configured=1
  getent group "$mount_group" >/dev/null 2>&1 || configured=0
  id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -Fxq "$mount_group" || configured=0
  [ "$(stat -c '%G:%a' /mnt 2>/dev/null)" = "$mount_group:3775" ] || configured=0
  if [ "$configured" -eq 1 ]; then
    info "Mount permissions under /mnt are already configured."
    return 0
  fi

  command -v sudo >/dev/null 2>&1 || {
    warn "sudo is unavailable; cannot configure /mnt for NFS mount points."
    return 1
  }
  info "Configuring /mnt so '$SERVICE_USER' can create mount-point directories..."
  sudo -v || {
    warn "Could not obtain administrator privileges; /mnt permissions were not changed."
    return 1
  }
  if ! getent group "$mount_group" >/dev/null 2>&1; then
    sudo groupadd --system "$mount_group" || {
      warn "Could not create the '$mount_group' group."
      return 1
    }
  fi
  sudo usermod -aG "$mount_group" "$SERVICE_USER" || {
    warn "Could not add '$SERVICE_USER' to the '$mount_group' group."
    return 1
  }
  sudo chown root:"$mount_group" /mnt && sudo chmod 3775 /mnt || {
    warn "Could not configure group access on /mnt."
    return 1
  }
  info "Configured /mnt. The service restart after the update will apply the new group membership."
}

configure_nfs_client() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if command -v mount.nfs >/dev/null 2>&1; then
    info "NFS client helper is installed."
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    warn "mount.nfs is missing; install the NFS client package for this Linux distribution."
    return 1
  fi
  command -v sudo >/dev/null 2>&1 || {
    warn "mount.nfs is missing and sudo is unavailable; install nfs-common to enable NFS mounts."
    return 1
  }

  info "Installing nfs-common (provides mount.nfs)..."
  sudo apt-get install -y nfs-common || {
    warn "Could not install nfs-common; NFS mounting will continue to fail."
    return 1
  }
  command -v mount.nfs >/dev/null 2>&1 || {
    warn "nfs-common installed, but mount.nfs is still unavailable in PATH."
    return 1
  }
  info "NFS client helper is ready."
}

configure_usb_automount() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if [ ! -d /run/systemd/system ] || ! command -v udevadm >/dev/null 2>&1; then
    warn "systemd/udev is unavailable; skipping USB auto-mount setup."
    return 1
  fi

  resolve_service_user
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    warn "Cannot find service user '$SERVICE_USER'; skipping USB auto-mount setup."
    return 1
  fi

  local service_uid service_gid helper_path unit_path rules_path
  service_uid="$(id -u "$SERVICE_USER")"
  service_gid="$(id -g "$SERVICE_USER")"
  helper_path="/usr/local/libexec/hyperdeck-usb-mount"
  unit_path="/etc/systemd/system/hyperdeck-usb-mount@.service"
  rules_path="/etc/udev/rules.d/99-hyperdeck-usb.rules"

  command -v sudo >/dev/null 2>&1 || {
    warn "sudo is unavailable; cannot install USB auto-mount support."
    return 1
  }
  sudo -v || {
    warn "Could not obtain administrator privileges; USB auto-mount support was not installed."
    return 1
  }

  if ! command -v setfacl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get install -y acl || warn "Could not install acl; POSIX USB volumes may remain unwritable."
    else
      warn "setfacl is unavailable; POSIX USB volumes may remain unwritable."
    fi
  fi

  info "Installing USB auto-mount support for '$SERVICE_USER'..."
  sudo install -D -o root -g root -m 0755 \
    "$REPO_DIR/scripts/hyperdeck-usb-mount" "$helper_path" || {
    warn "Could not install the USB mount helper."
    return 1
  }

  if ! {
    printf '[Unit]\nDescription=Mount USB filesystem for HyperDeck Tools (%%I)\nBindsTo=dev-%%i.device\nAfter=dev-%%i.device\n\n'
    printf '[Service]\nType=oneshot\nRemainAfterExit=yes\nEnvironment=HYPERDECK_USB_UID=%s\nEnvironment=HYPERDECK_USB_GID=%s\n' \
      "$service_uid" "$service_gid"
    printf 'ExecStart=%s mount %%I\nExecStop=%s unmount %%I\n' \
      "$helper_path" "$helper_path"
  } | sudo tee "$unit_path" >/dev/null; then
    warn "Could not install the USB systemd unit."
    return 1
  fi

  if ! printf '%s\n' \
    'ACTION=="add", SUBSYSTEM=="block", ENV{ID_BUS}=="usb", ENV{ID_FS_USAGE}=="filesystem", TAG+="systemd", ENV{SYSTEMD_WANTS}+="hyperdeck-usb-mount@%k.service"' \
    | sudo tee "$rules_path" >/dev/null; then
    warn "Could not install the USB udev rule."
    return 1
  fi

  sudo systemctl daemon-reload || {
    warn "systemd could not reload the USB mount unit."
    return 1
  }
  sudo udevadm control --reload-rules || {
    warn "udev could not reload the USB mount rule."
    return 1
  }
  info "USB auto-mount is ready under /mnt/hyperdeck-usb. Reconnect any currently attached drive to apply it."
}

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

ensure_systemd_service() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd is unavailable; skipping automatic service setup/restart."
    return 1
  fi

  if ! systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
    resolve_service_user
    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
      warn "Cannot find service user '$SERVICE_USER'; cannot create the systemd service."
      return 1
    fi

    local python_executable
    if [ -x "$REPO_DIR/.venv/bin/python" ]; then
      python_executable="$REPO_DIR/.venv/bin/python"
    elif [ -x "$REPO_DIR/venv/bin/python" ]; then
      python_executable="$REPO_DIR/venv/bin/python"
    else
      python_executable="$(command -v python3)"
    fi

    info "Creating the $SERVICE_NAME systemd unit for '$SERVICE_USER'..."
    if ! {
      printf '[Unit]\nDescription=HyperDeck Tools\nAfter=network-online.target\nWants=network-online.target\n\n'
      printf '[Service]\nType=simple\nUser=%s\nWorkingDirectory=%s\nExecStart=%s %s\nRestart=on-failure\nRestartSec=5\n\n' \
        "$SERVICE_USER" "$(systemd_quote "$REPO_DIR")" \
        "$(systemd_quote "$python_executable")" \
        "$(systemd_quote "$REPO_DIR/run_both.py")"
      printf '[Install]\nWantedBy=multi-user.target\n'
    } | sudo tee "/etc/systemd/system/$SERVICE_NAME" >/dev/null; then
      warn "Could not create $SERVICE_NAME."
      return 1
    fi
    sudo systemctl daemon-reload || {
      warn "systemd could not reload the new unit."
      return 1
    }
    sudo systemctl enable "$SERVICE_NAME" || {
      warn "Could not enable $SERVICE_NAME."
      return 1
    }
  fi

  info "Restarting $SERVICE_NAME..."
  sudo systemctl restart "$SERVICE_NAME" || {
    warn "The update completed, but $SERVICE_NAME failed to start/restart. Check: sudo systemctl status $SERVICE_NAME"
    return 1
  }
  info "$SERVICE_NAME is running with the updated code."
}

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

# --- Configure NFS mount-point permissions ---
if ! configure_mount_permissions; then
  warn "NFS mount-point permissions may need to be configured manually."
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

# --- Ensure the NFS mount helper is installed ---
if ! configure_nfs_client; then
  warn "NFS mounts may fail until the NFS client package is installed."
fi

# --- Configure USB auto-mount before restarting the application ---
if ! configure_usb_automount; then
  warn "USB auto-mount support may need to be configured manually."
fi

# --- Create or restart the systemd service after the update ---
if ! ensure_systemd_service; then
  warn "Restart HyperDeck Tools manually to apply the update."
fi

# --- Summary ---
echo ""
info "Update complete."
echo ""
git log --oneline -5
echo ""
