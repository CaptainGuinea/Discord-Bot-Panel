#!/usr/bin/env bash
#
# Creates an LXC container on a Proxmox VE host and installs BotPanel into it.
# Uses whiptail dialogs (like the Proxmox community scripts): pick Default
# Install for sensible defaults or Advanced Install to change every setting.
#
# Run on the Proxmox host shell:
#
#   bash -c "$(wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
#
# Every setting can be preset with an environment variable, and ASSUME_YES=1
# skips the dialogs entirely for fully non-interactive runs:
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
VLAN="${VLAN:-}"                     # optional VLAN tag
PANEL_PORT="${PANEL_PORT:-8080}"
UNPRIVILEGED="${UNPRIVILEGED:-1}"
START_ON_BOOT="${START_ON_BOOT:-1}"
CT_PASSWORD="${CT_PASSWORD:-}"       # empty means console access only
ASSUME_YES="${ASSUME_YES:-0}"

APP="BotPanel"
BACKTITLE="BotPanel LXC installer"

bold()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  \033[36m→\033[0m %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }
# Printed to stderr and exits non-zero so it also aborts the script when a
# dialog was cancelled inside a $(...) command substitution.
cancel(){ printf '\n  \033[33mInstallation cancelled — nothing was changed.\033[0m\n\n' >&2; exit 1; }

# --- Host checks -------------------------------------------------------------

[[ $EUID -eq 0 ]] || fail "Run this as root on the Proxmox host."
command -v pct >/dev/null 2>&1 || fail "This script must run on a Proxmox VE host (pct was not found)."
command -v pvesm >/dev/null 2>&1 || fail "pvesm was not found. Is this a Proxmox VE host?"

INTERACTIVE=1
if [[ "$ASSUME_YES" == "1" ]] || ! command -v whiptail >/dev/null 2>&1 || ! { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=0
fi

# --- Dialog helpers ----------------------------------------------------------
# All whiptail calls read/draw on /dev/tty so the script works when its body is
# fetched with wget/curl. The chosen value comes back on stdout via the fd swap.

wt() {
  whiptail --backtitle "$BACKTITLE" "$@" 3>&1 1>&2 2>&3 </dev/tty >/dev/tty
}

# wt_msg <title> <text> <height> <width> — informational box; ESC just closes it
wt_msg() {
  wt --title "$1" --msgbox "$2" "$3" "$4" || true
}

# wt_input <title> <prompt> <default> -> echoes the value, exits on Cancel
wt_input() {
  local value
  value=$(wt --title "$1" --inputbox "$2" 11 62 "$3") || cancel
  echo "$value"
}

# ask_int <title> <prompt> <default> <min> [max]
ask_int() {
  local title="$1" prompt="$2" default="$3" min="$4" max="${5:-}" value
  while true; do
    value=$(wt_input "$title" "$prompt" "$default")
    if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= min )) && { [[ -z "$max" ]] || (( value <= max )); }; then
      echo "$value"; return
    fi
    wt_msg "Invalid value" "'${value}' is not valid here.\n\nEnter a whole number$( [[ -n "$max" ]] && echo " between ${min} and ${max}" || echo " of at least ${min}" )." 11 62
  done
}

valid_ipv4() {
  local ip="$1" o
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  for o in ${ip//./ }; do (( o <= 255 )) || return 1; done
}

valid_cidr() {
  [[ "$1" == */* ]] || return 1
  valid_ipv4 "${1%/*}" || return 1
  [[ "${1#*/}" =~ ^[0-9]{1,2}$ ]] && (( ${1#*/} >= 1 && ${1#*/} <= 32 ))
}

# --- Gather host facts (storage, bridges, next free ID) ------------------------

mapfile -t ROOT_STORAGES < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}')
[[ ${#ROOT_STORAGES[@]} -gt 0 ]] || fail "No storage on this host accepts container volumes."

mapfile -t TEMPLATE_STORAGES < <(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 {print $1}')
[[ ${#TEMPLATE_STORAGES[@]} -gt 0 ]] || fail "No storage on this host holds container templates."
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-${TEMPLATE_STORAGES[0]}}"

mapfile -t BRIDGES < <(ls /sys/class/net 2>/dev/null | grep -E '^vmbr[0-9]+$' | sort -V)
[[ ${#BRIDGES[@]} -gt 0 ]] && BRIDGE="${BRIDGE:-${BRIDGES[0]}}"

STORAGE_PRESET="${STORAGE:-}"
STORAGE="${STORAGE:-${ROOT_STORAGES[0]}}"

if [[ -z "${CTID:-}" ]]; then
  CTID="$(pvesh get /cluster/nextid 2>/dev/null || echo 200)"
fi

# pick_storage <title> <storage list...> -> radiolist when there is a choice
pick_storage() {
  local title="$1"; shift
  local current="$1"; shift
  local items=() s size
  for s in "$@"; do
    size="$(pvesm status 2>/dev/null | awk -v s="$s" '$1==s {printf "%.1fG free", $6/1024/1024; exit}')"
    items+=("$s" "${size:-storage}" "$( [[ "$s" == "$current" ]] && echo ON || echo OFF )")
  done
  wt --title "$title" --radiolist "Choose with SPACE, confirm with ENTER." 16 62 "$(( $# > 8 ? 8 : $# ))" "${items[@]}" || cancel
}

# --- Advanced dialog flow ------------------------------------------------------

advanced_settings() {
  while true; do
    CTID=$(ask_int "Container ID" "Unique ID for the new container.\nNext free ID on this host: ${CTID}" "$CTID" 100 999999999)
    pct status "$CTID" >/dev/null 2>&1 || break
    wt_msg "ID in use" "Container ${CTID} already exists.\nPick a different ID." 9 50
  done

  while true; do
    CT_HOSTNAME=$(wt_input "Hostname" "Hostname for the container." "$CT_HOSTNAME")
    [[ "$CT_HOSTNAME" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]] && break
    wt_msg "Invalid hostname" "'${CT_HOSTNAME}' is not a valid hostname.\n\nUse letters, digits and dashes only." 10 60
  done

  DISK_GB=$(ask_int "Disk size" "Root disk size in GB.\nBotPanel itself needs about 1 GB; add room for your bots." "$DISK_GB" 4)
  CORES=$(ask_int "CPU cores" "Number of CPU cores." "$CORES" 1 "$(nproc)")
  RAM_MB=$(ask_int "Memory" "Memory in MB.\n1024 MB is enough for the panel and a few bots." "$RAM_MB" 256)
  SWAP_MB=$(ask_int "Swap" "Swap in MB (0 to disable)." "$SWAP_MB" 0)

  if [[ ${#ROOT_STORAGES[@]} -gt 1 ]]; then
    STORAGE=$(pick_storage "Container storage" "$STORAGE" "${ROOT_STORAGES[@]}")
  fi

  if [[ ${#BRIDGES[@]} -gt 1 ]]; then
    local items=() b
    for b in "${BRIDGES[@]}"; do
      items+=("$b" "bridge" "$( [[ "$b" == "$BRIDGE" ]] && echo ON || echo OFF )")
    done
    BRIDGE=$(wt --title "Network bridge" --radiolist "Choose with SPACE, confirm with ENTER." 16 62 "$(( ${#BRIDGES[@]} > 8 ? 8 : ${#BRIDGES[@]} ))" "${items[@]}") || cancel
  fi

  local ip_mode
  ip_mode=$(wt --title "IPv4 address" --menu "How should the container get its address?" 12 62 2 \
    "dhcp"   "Automatic (recommended)" \
    "static" "Enter a fixed address" ) || cancel

  if [[ "$ip_mode" == "static" ]]; then
    while true; do
      NET_CONFIG=$(wt_input "Static address" "Address in CIDR form, for example 192.168.1.50/24" "$( [[ "$NET_CONFIG" == dhcp ]] && echo "" || echo "$NET_CONFIG" )")
      valid_cidr "$NET_CONFIG" && break
      wt_msg "Invalid address" "'${NET_CONFIG}' is not valid.\n\nUse address/prefix form, for example 192.168.1.50/24." 10 62
    done
    [[ -z "$GATEWAY" ]] && GATEWAY="$(ip route | awk '/^default/ {print $3; exit}')"
    while true; do
      GATEWAY=$(wt_input "Gateway" "IPv4 gateway for this network." "$GATEWAY")
      valid_ipv4 "$GATEWAY" && break
      wt_msg "Invalid gateway" "'${GATEWAY}' is not a valid IPv4 address." 9 55
    done
  else
    NET_CONFIG="dhcp"
  fi

  while true; do
    VLAN=$(wt_input "VLAN tag" "VLAN tag for the network interface.\nLeave empty for none." "$VLAN")
    [[ -z "$VLAN" || ( "$VLAN" =~ ^[0-9]+$ && "$VLAN" -ge 1 && "$VLAN" -le 4094 ) ]] && break
    wt_msg "Invalid VLAN" "'${VLAN}' is not a valid VLAN tag (1-4094)." 9 55
  done

  PANEL_PORT=$(ask_int "Panel port" "Port the BotPanel web interface listens on." "$PANEL_PORT" 1 65535)

  if wt --title "Container type" --yes-button "Unprivileged" --no-button "Privileged" \
       --yesno "Create an unprivileged container?\n\nUnprivileged is safer and recommended." 11 62; then
    UNPRIVILEGED=1
  else
    UNPRIVILEGED=0
  fi

  if wt --title "Start on boot" --yesno "Start the container automatically when the Proxmox host boots?" 9 62; then
    START_ON_BOOT=1
  else
    START_ON_BOOT=0
  fi

  CT_PASSWORD=$(wt --title "Root password" --passwordbox "Root password for the container.\nLeave empty for console-only access (pct enter ${CTID})." 11 62) || cancel
}

# --- Choose install mode -------------------------------------------------------

if [[ "$INTERACTIVE" == "1" ]]; then
  CHOICE=$(wt --title "${APP} LXC installer" --menu "\
This installs ${APP} into a new LXC container.\n\nDefault settings:\n\n\
  Container ID   ${CTID}\n\
  Hostname       ${CT_HOSTNAME}\n\
  Disk / Cores   ${DISK_GB} GB / ${CORES}\n\
  Memory / Swap  ${RAM_MB} MB / ${SWAP_MB} MB\n\
  Storage        ${STORAGE}\n\
  Network        ${BRIDGE}, DHCP, unprivileged\n" 24 62 3 \
    "1" "Default Install (use settings above)" \
    "2" "Advanced Install (change every setting)" \
    "3" "Exit") || cancel
  case "$CHOICE" in
    1) : ;;
    2) advanced_settings ;;
    *) cancel ;;
  esac

  # In default mode the only choice that matters is storage, when several exist.
  if [[ "$CHOICE" == "1" && ${#ROOT_STORAGES[@]} -gt 1 && -z "${STORAGE_PRESET:-}" ]]; then
    STORAGE=$(pick_storage "Container storage" "$STORAGE" "${ROOT_STORAGES[@]}")
  fi
else
  bold "BotPanel — Proxmox LXC installer (non-interactive)"
fi

info "Proxmox $(pveversion | cut -d/ -f2)"

# Final safety checks, also for values that came from environment presets.
pct status "$CTID" >/dev/null 2>&1 && fail "Container $CTID already exists. Choose a different ID."
printf '%s\n' "${ROOT_STORAGES[@]}" | grep -qx "$STORAGE" \
  || fail "Storage '$STORAGE' cannot hold containers. Options: ${ROOT_STORAGES[*]}"
[[ "$DISK_GB$RAM_MB$SWAP_MB$CORES" =~ ^[0-9]+$ ]] || fail "Disk, memory, swap and cores must be numbers."
if [[ "$NET_CONFIG" != "dhcp" ]]; then
  valid_cidr "$NET_CONFIG" || fail "A static address needs CIDR form, for example 192.168.1.50/24."
  [[ -z "$GATEWAY" ]] && GATEWAY="$(ip route | awk '/^default/ {print $3; exit}')"
  valid_ipv4 "$GATEWAY" || fail "A valid gateway is required for a static address."
fi

if [[ "$INTERACTIVE" == "1" ]]; then
  wt --title "Ready to create" --yes-button "Create" --no-button "Cancel" --yesno "\
Create this container and install ${APP}?\n\n\
  Container ID   ${CTID}\n\
  Hostname       ${CT_HOSTNAME}\n\
  Disk / Cores   ${DISK_GB} GB / ${CORES}\n\
  Memory / Swap  ${RAM_MB} MB / ${SWAP_MB} MB\n\
  Storage        ${STORAGE}\n\
  Network        ${BRIDGE}, ${NET_CONFIG}$( [[ "$NET_CONFIG" != dhcp ]] && echo ", gw ${GATEWAY}" )$( [[ -n "$VLAN" ]] && echo ", VLAN ${VLAN}" )\n\
  Type           $( [[ "$UNPRIVILEGED" == 1 ]] && echo unprivileged || echo privileged )\n\
  Panel port     ${PANEL_PORT}" 21 62 || cancel
fi

# --- Template ----------------------------------------------------------------

bold "Creating the ${APP} container"
for line in \
  "Container ID: ${CTID}" \
  "Hostname: ${CT_HOSTNAME}" \
  "Disk: ${DISK_GB} GB on ${STORAGE}" \
  "Cores: ${CORES}   Memory: ${RAM_MB} MB   Swap: ${SWAP_MB} MB" \
  "Network: ${BRIDGE}, ${NET_CONFIG}$( [[ "$NET_CONFIG" != dhcp ]] && echo ", gateway ${GATEWAY}" )$( [[ -n "$VLAN" ]] && echo ", VLAN ${VLAN}" )" \
  "Type: $( [[ "$UNPRIVILEGED" == 1 ]] && echo unprivileged || echo privileged ), start on boot: $( [[ "$START_ON_BOOT" == 1 ]] && echo yes || echo no )"
do ok "$line"; done

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

# --- Create ------------------------------------------------------------------

NET_STRING="name=eth0,bridge=${BRIDGE}"
if [[ "$NET_CONFIG" == "dhcp" ]]; then
  NET_STRING+=",ip=dhcp"
else
  NET_STRING+=",ip=${NET_CONFIG},gw=${GATEWAY}"
fi
[[ -n "$VLAN" ]] && NET_STRING+=",tag=${VLAN}"

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

info "Creating the container"
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
