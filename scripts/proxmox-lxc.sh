#!/usr/bin/env bash
#
# Creates an LXC container on a Proxmox VE host and installs BotPanel into it.
#
# Run on the Proxmox host shell:
#
#   bash -c "$(wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
#
# The `bash -c "$(...)"` form matters: piping into bash would consume stdin and
# the prompts below could not read your answers.
#
# Every prompt can be preset, which also makes the run non-interactive:
#
#   CTID=210 CT_HOSTNAME=bots DISK_GB=12 RAM_MB=2048 CORES=2 \
#   STORAGE=local-lvm BRIDGE=vmbr0 ASSUME_YES=1 \
#   bash -c "$(wget -qO- .../proxmox-lxc.sh)"
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/CaptainGuinea/Discord-Bot-Panel}"
BRANCH="${BRANCH:-main}"
INSTALL_URL="${INSTALL_URL:-https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/${BRANCH}/install.sh}"

OS_TEMPLATE_PREFIX="${OS_TEMPLATE_PREFIX:-debian-13-standard}"
OS_TEMPLATE_FALLBACK="${OS_TEMPLATE_FALLBACK:-debian-12-standard}"

DISK_GB="${DISK_GB:-8}"
RAM_MB="${RAM_MB:-1024}"
SWAP_MB="${SWAP_MB:-512}"
CORES="${CORES:-2}"
CT_HOSTNAME="${CT_HOSTNAME:-botpanel}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_CONFIG="${NET_CONFIG:-dhcp}"     # dhcp, or CIDR such as 192.168.1.50/24
GATEWAY="${GATEWAY:-}"               # required when NET_CONFIG is not dhcp
PANEL_PORT="${PANEL_PORT:-8080}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
START_ON_BOOT="${START_ON_BOOT:-1}"
CT_PASSWORD="${CT_PASSWORD:-}"       # empty means console access only
ASSUME_YES="${ASSUME_YES:-0}"

bold()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  \033[36m→\033[0m %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

ask() {
  # ask <prompt> <default> <variable name>; skipped when the value is preset
  local prompt="$1" default="$2" varname="$3" answer
  if [[ "$ASSUME_YES" == "1" || ! -t 0 ]]; then
    printf '  %s: \033[1m%s\033[0m\n' "$prompt" "$default"
    return
  fi
  read -rp "  $(printf '%-28s' "$prompt")[$default]: " answer </dev/tty || true
  [[ -n "$answer" ]] && printf -v "$varname" '%s' "$answer"
}

# --- Host checks -------------------------------------------------------------

[[ $EUID -eq 0 ]] || fail "Run this as root on the Proxmox host."
command -v pct >/dev/null 2>&1 || fail "This script must run on a Proxmox VE host (pct was not found)."
command -v pvesm >/dev/null 2>&1 || fail "pvesm was not found. Is this a Proxmox VE host?"

bold "BotPanel — Proxmox LXC installer"
info "Proxmox $(pveversion | cut -d/ -f2)"

# --- Container ID ------------------------------------------------------------

if [[ -z "${CTID:-}" ]]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null || echo 200)"
fi
ask "Container ID" "$CTID" CTID

if pct status "$CTID" >/dev/null 2>&1; then
  fail "Container $CTID already exists. Choose a different ID with CTID=<id>."
fi

# --- Storage -----------------------------------------------------------------

mapfile -t ROOT_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}')
[[ ${#ROOT_STORAGES[@]} -gt 0 ]] || fail "No storage on this host accepts container volumes."

STORAGE="${STORAGE:-${ROOT_STORAGES[0]}}"
if [[ ${#ROOT_STORAGES[@]} -gt 1 ]]; then
  info "Container storage available: ${ROOT_STORAGES[*]}"
fi
ask "Container storage" "$STORAGE" STORAGE

printf '%s\n' "${ROOT_STORAGES[@]}" | grep -qx "$STORAGE" \
  || fail "Storage '$STORAGE' cannot hold containers. Options: ${ROOT_STORAGES[*]}"

mapfile -t TEMPLATE_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1}')
[[ ${#TEMPLATE_STORAGES[@]} -gt 0 ]] || fail "No storage on this host holds container templates."
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-${TEMPLATE_STORAGES[0]}}"

# --- Remaining settings ------------------------------------------------------

ask "Hostname" "$CT_HOSTNAME" CT_HOSTNAME
ask "Disk size (GB)" "$DISK_GB" DISK_GB
ask "Memory (MB)" "$RAM_MB" RAM_MB
ask "CPU cores" "$CORES" CORES
ask "Network bridge" "$BRIDGE" BRIDGE
ask "IP (dhcp or CIDR)" "$NET_CONFIG" NET_CONFIG

if [[ "$NET_CONFIG" != "dhcp" ]]; then
  [[ "$NET_CONFIG" == */* ]] || fail "A static address needs a prefix, for example 192.168.1.50/24."
  if [[ -z "$GATEWAY" ]]; then
    GATEWAY="$(ip route | awk '/^default/ {print $3; exit}')"
  fi
  ask "Gateway" "$GATEWAY" GATEWAY
  [[ -n "$GATEWAY" ]] || fail "A gateway is required for a static address."
fi

# --- Template ----------------------------------------------------------------

info "Refreshing the template catalogue"
pveam update >/dev/null 2>&1 || warn "Could not refresh the catalogue; using what is cached."

pick_template() {
  local prefix="$1"
  pveam available --section system 2>/dev/null \
    | awk '{print $2}' | grep "^${prefix}" | sort -V | tail -n1
}

TEMPLATE="${TEMPLATE:-$(pick_template "$OS_TEMPLATE_PREFIX")}"
[[ -n "$TEMPLATE" ]] || TEMPLATE="$(pick_template "$OS_TEMPLATE_FALLBACK")"
[[ -n "$TEMPLATE" ]] || fail "No Debian template found in the catalogue."

# Reuse an already downloaded copy when there is one.
TEMPLATE_VOLUME=""
for store in "${TEMPLATE_STORAGES[@]}"; do
  if pveam list "$store" 2>/dev/null | awk '{print $1}' | grep -q "/${TEMPLATE}$"; then
    TEMPLATE_VOLUME="${store}:vztmpl/${TEMPLATE}"
    info "Using cached template ${TEMPLATE}"
    break
  fi
done

if [[ -z "$TEMPLATE_VOLUME" ]]; then
  info "Downloading ${TEMPLATE} to ${TEMPLATE_STORAGE}"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null \
    || fail "Template download failed."
  TEMPLATE_VOLUME="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
fi

# --- Confirm -----------------------------------------------------------------

bold "About to create container ${CTID}"
cat <<EOF
  Hostname     ${CT_HOSTNAME}
  Template     ${TEMPLATE}
  Storage      ${STORAGE}
  Disk         ${DISK_GB} GB
  Memory       ${RAM_MB} MB (swap ${SWAP_MB} MB)
  Cores        ${CORES}
  Network      ${BRIDGE}, ${NET_CONFIG}$( [[ "$NET_CONFIG" != dhcp ]] && echo ", gateway ${GATEWAY}" )
  Unprivileged $( [[ "$UNPRIVILEGED" == 1 ]] && echo yes || echo no )
EOF

if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
  read -rp $'\n  Create it? [Y/n]: ' confirm </dev/tty || true
  [[ -z "$confirm" || "$confirm" =~ ^[Yy] ]] || fail "Cancelled."
fi

# --- Create ------------------------------------------------------------------

NET_STRING="name=eth0,bridge=${BRIDGE}"
if [[ "$NET_CONFIG" == "dhcp" ]]; then
  NET_STRING+=",ip=dhcp"
else
  NET_STRING+=",ip=${NET_CONFIG},gw=${GATEWAY}"
fi

bold "Creating the container"
CREATE_ARGS=(
  "$CTID" "$TEMPLATE_VOLUME"
  --hostname "$CT_HOSTNAME"
  --cores "$CORES"
  --memory "$RAM_MB"
  --swap "$SWAP_MB"
  --rootfs "${STORAGE}:${DISK_GB}"
  --net0 "$NET_STRING"
  --unprivileged "$UNPRIVILEGED"
  --onboot "$START_ON_BOOT"
  --features nesting=1
  --description "BotPanel — ${REPO_URL}"
)
[[ -n "$CT_PASSWORD" ]] && CREATE_ARGS+=(--password "$CT_PASSWORD")

pct create "${CREATE_ARGS[@]}" >/dev/null || fail "Container creation failed."
ok "Container ${CTID} created"

info "Starting it"
pct start "$CTID" >/dev/null || fail "The container did not start."

# --- Wait for the network ----------------------------------------------------

info "Waiting for network"
CT_IP=""
for _ in $(seq 1 45); do
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ -n "$CT_IP" ]] && break
  sleep 2
done
[[ -n "$CT_IP" ]] || fail "The container never got an IP address. Check the bridge and DHCP, then run: pct enter $CTID"
ok "Address ${CT_IP}"

# Name resolution has to work before the installer can fetch anything.
for _ in $(seq 1 15); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done

# --- Install -----------------------------------------------------------------

bold "Installing BotPanel inside the container"
echo
pct exec "$CTID" -- bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates >/dev/null
  PANEL_PORT='${PANEL_PORT}' REPO_URL='${REPO_URL}.git' BRANCH='${BRANCH}' \
    bash -c \"\$(curl -fsSL '${INSTALL_URL}')\"
" || fail "The installer failed inside the container. Inspect it with: pct enter $CTID"

# --- Done --------------------------------------------------------------------

bold "Done"
cat <<EOF

  BotPanel        http://${CT_IP}:${PANEL_PORT}
  Open that address to create your administrator account.

  Container       ${CTID} (${CT_HOSTNAME})
  Shell           pct enter ${CTID}
  Logs            pct exec ${CTID} -- journalctl -u botpanel -f
  Upgrade later   pct exec ${CTID} -- bash -c "\$(curl -fsSL ${INSTALL_URL})"

EOF
