#!/usr/bin/env bash
#
# BotPanel installer for Debian and Ubuntu.
#
# Run it straight from the internet on any VM, LXC container or VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh | sudo bash
#
# Or from a checkout, which installs the code you have rather than cloning:
#
#   sudo bash install.sh
#
# Re-running it upgrades an existing installation in place.
#
# Override any of these with environment variables (use `sudo -E` when piping):
#
#   INSTALL_DIR=/srv/botpanel PANEL_PORT=9000 sudo -E bash install.sh
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/CaptainGuinea/Discord-Bot-Panel.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/botpanel}"
SERVICE_USER="${SERVICE_USER:-botpanel}"
SERVICE_NAME="${SERVICE_NAME:-botpanel}"
PANEL_PORT="${PANEL_PORT:-8080}"
NODE_MAJOR="${NODE_MAJOR:-24}"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this as root, for example: curl -fsSL <url> | sudo bash"
command -v apt-get >/dev/null || fail "This installer supports Debian and Ubuntu. For other systems see the manual steps in README.md."

# When piped through bash there is no script file on disk, so fall back to
# cloning the repository instead of copying from a checkout.
SOURCE_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  CANDIDATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$CANDIDATE/package.json" && -d "$CANDIDATE/src" ]] && SOURCE_DIR="$CANDIDATE"
fi

UPGRADE=false
[[ -d "$INSTALL_DIR/src" ]] && UPGRADE=true

if [[ "$UPGRADE" == true ]]; then
  bold "Upgrading BotPanel in ${INSTALL_DIR}"
else
  bold "Installing BotPanel into ${INSTALL_DIR}"
fi

info "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git tar gzip python3 python3-venv >/dev/null

if command -v node >/dev/null 2>&1 && [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge "$NODE_MAJOR" ]]; then
  info "Using existing Node.js $(node -v)"
else
  info "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  info "Installed Node.js $(node -v)"
fi

# Stop the service before replacing files so running bots are shut down cleanly.
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  info "Stopping ${SERVICE_NAME}"
  systemctl stop "$SERVICE_NAME"
fi

if [[ -n "$SOURCE_DIR" ]]; then
  info "Copying files from ${SOURCE_DIR}"
  mkdir -p "$INSTALL_DIR"
  # Preserve data/ and .env; everything else is replaced.
  for item in src public scripts package.json package-lock.json install.sh README.md LICENSE; do
    [[ -e "$SOURCE_DIR/$item" ]] && cp -r "$SOURCE_DIR/$item" "$INSTALL_DIR/"
  done
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating the existing checkout"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH" -q
  git -C "$INSTALL_DIR" reset --hard "origin/${BRANCH}" -q
else
  info "Cloning ${REPO_URL} (${BRANCH})"
  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    # An existing non-git directory: clone beside it and move the code in so
    # that data/ and .env survive.
    TEMP_DIR="$(mktemp -d)"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TEMP_DIR" -q
    cp -r "$TEMP_DIR/." "$INSTALL_DIR/"
    rm -rf "$TEMP_DIR"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" -q
  fi
fi

cd "$INSTALL_DIR"

info "Installing dependencies"
npm install --omit=dev --no-audit --no-fund --loglevel=error

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating service account '${SERVICE_USER}'"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  info "Writing ${INSTALL_DIR}/.env"
  cat > "$INSTALL_DIR/.env" <<EOF
HOST=0.0.0.0
PORT=${PANEL_PORT}
DATA_DIR=./data
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
else
  info "Keeping the existing .env"
  PANEL_PORT="$(grep -E '^PORT=' "$INSTALL_DIR/.env" | cut -d= -f2 | tr -d '[:space:]' || echo "$PANEL_PORT")"
fi

info "Writing the ${SERVICE_NAME} service"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BotPanel
Documentation=${REPO_URL%.git}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/src/server.js
Restart=always
RestartSec=5

# The panel supervises child processes, so allow time to stop them and let
# systemd clean up anything that outlives the main process.
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=45

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
systemctl restart "$SERVICE_NAME"

sleep 3

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  warn "The service failed to start. Recent output:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager
  exit 1
fi

IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"

if [[ "$UPGRADE" == true ]]; then
  bold "BotPanel upgraded"
else
  bold "BotPanel is ready"
fi

cat <<EOF

  Open  http://${IP_ADDR:-localhost}:${PANEL_PORT}
  $( [[ "$UPGRADE" == true ]] && echo "Your data and accounts were left untouched." || echo "The first screen creates your administrator account." )

  Logs      journalctl -u ${SERVICE_NAME} -f
  Restart   systemctl restart ${SERVICE_NAME}
  Upgrade   re-run this installer
  Config    ${INSTALL_DIR}/.env
  Data      ${INSTALL_DIR}/data

EOF
