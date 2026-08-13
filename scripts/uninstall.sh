#!/usr/bin/env bash
#
# Removes a BotPanel installation made by install.sh.
#
#   sudo bash scripts/uninstall.sh
#
# Your data is kept by default. To remove it as well:
#
#   REMOVE_DATA=1 sudo -E bash scripts/uninstall.sh
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/botpanel}"
SERVICE_USER="${SERVICE_USER:-botpanel}"
SERVICE_NAME="${SERVICE_NAME:-botpanel}"
REMOVE_DATA="${REMOVE_DATA:-0}"
ASSUME_YES="${ASSUME_YES:-0}"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '  \033[36m→\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run this as root."

bold "Uninstalling BotPanel"
echo "  Directory  ${INSTALL_DIR}"
echo "  Service    ${SERVICE_NAME}"
echo "  Data       $( [[ "$REMOVE_DATA" == 1 ]] && echo 'WILL BE DELETED' || echo "kept in ${INSTALL_DIR}/data" )"

if [[ "$REMOVE_DATA" == 1 && "$ASSUME_YES" != "1" && -t 0 ]]; then
  warn "This deletes every bot, log and backup on this host."
  read -rp "  Type 'delete' to confirm: " confirm </dev/tty || true
  [[ "$confirm" == "delete" ]] || fail "Cancelled."
fi

if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  info "Stopping and removing the service"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl reset-failed >/dev/null 2>&1 || true
fi

if [[ "$REMOVE_DATA" == 1 ]]; then
  info "Removing ${INSTALL_DIR}"
  rm -rf "$INSTALL_DIR"

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    info "Removing the ${SERVICE_USER} account"
    userdel "$SERVICE_USER" >/dev/null 2>&1 || true
  fi
else
  info "Removing application files, keeping data"
  for item in src public scripts node_modules package.json package-lock.json install.sh README.md LICENSE; do
    rm -rf "${INSTALL_DIR:?}/${item}"
  done
  warn "Kept ${INSTALL_DIR}/data and ${INSTALL_DIR}/.env"
fi

bold "Done"
echo
echo "  Node.js was left installed; remove it with: apt-get remove nodejs"
echo
