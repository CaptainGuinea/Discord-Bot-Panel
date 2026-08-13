<div align="center">

# BotPanel

**A self-hosted control panel for Discord bots.**

Deploy from Git, keep bots running, watch their consoles — from one web interface.

[![CI](https://github.com/CaptainGuinea/Discord-Bot-Panel/actions/workflows/ci.yml/badge.svg)](https://github.com/CaptainGuinea/Discord-Bot-Panel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/node-24%2B-brightgreen.svg)](https://nodejs.org)

</div>

---

BotPanel is one Node.js process. No Docker-in-Docker, no agent daemon on every
node, no external database, no build step. You point it at a repository and it
clones the code, installs the dependencies, starts the bot, restarts it when it
dies, and shows you the console while it happens.

It is built for the machine you already have — a VPS, a home server, a spare
container — and it is meant to be *yours*: name it, colour it, put it on your
own domain.

## Features

- **Process supervision.** Each bot runs in its own process group under a login
  shell, so `nvm` and `pyenv` paths behave exactly as they do over SSH. Stopping
  a bot signals the whole tree, so `npm → node` and `python → ffmpeg` children
  go down with it. Restart policies are per bot, with exponential backoff and a
  crash-loop cutoff so a bot failing on a bad token cannot spin your CPU.
- **Git deploys.** Clone from any repository, fast-forward on later deploys, or
  force-sync to discard local edits. Private repositories authenticate with a
  token that is never written to `.git/config` and never sent to the browser.
  Each bot gets a webhook URL for auto-deploy on push.
- **Live consoles.** stdout and stderr stream over a WebSocket with ANSI colour
  intact, plus filtering and an stdin field for bots with a command interface.
  Output is also written to rotating log files, so history survives restarts.
- **Environment management.** Variables live in the database, are injected into
  the process, and can be mirrored to a `.env` file for bots using dotenv.
  Anything token-shaped is masked automatically.
- **Files and backups.** Browse and edit files in the browser, drag text files
  in to upload, and archive a bot to a tarball that skips `node_modules`,
  `.venv` and `.git`.
- **Metrics.** Per-bot CPU and memory sampled across the entire process tree,
  because a bot's real cost is usually its children.
- **Multi-user.** `admin` and `operator` roles, so you can let someone restart a
  stuck bot without handing them the keys. Optional open registration.
- **Yours.** Set the instance name, accent colour and public URL from the
  Administration page. No branding you did not choose.

## Install

### Proxmox VE — one line, builds its own container

Run this in the **Proxmox host shell** (node → Shell, or over SSH). It creates
an LXC container, installs everything inside it, and prints the URL:

```bash
bash -c "$(wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
```

<sub>Prefer curl? `bash -c "$(curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"`</sub>

It opens a dialog menu, just like the Proxmox community scripts. **Default
Install** creates an unprivileged Debian container with 8 GB disk, 1 GB RAM,
2 cores and DHCP on the next free container ID. **Advanced Install** walks you
through every setting — ID, hostname, disk, cores, memory, swap, storage and
bridge pick-lists, DHCP or a static address, VLAN tag, panel port, container
type, start-on-boot and root password — validating each answer as you go. A
summary screen asks for confirmation before anything is created, and the Debian
template is downloaded only if your host does not already have it.

Skip the dialogs entirely by presetting values and adding `ASSUME_YES=1`:

```bash
CTID=210 CT_HOSTNAME=bots DISK_GB=12 RAM_MB=2048 CORES=2 \
STORAGE=local-lvm NET_CONFIG=192.168.1.50/24 GATEWAY=192.168.1.1 ASSUME_YES=1 \
bash -c "$(wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/scripts/proxmox-lxc.sh)"
```

Afterwards: `pct enter <id>` for a shell, `pct exec <id> -- journalctl -u botpanel -f`
for logs.

> Use `bash -c "$(...)"` rather than piping into `bash`. Piping hands the script
> to bash on stdin, which leaves nothing for the dialogs to read from.

### Any VM, container or VPS — one line

On any existing Debian or Ubuntu machine:

```bash
curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh | sudo bash
```

```bash
wget -qO- https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh | sudo bash
```

This installs Node.js 24 if needed, clones the panel to `/opt/botpanel`,
creates a service account, writes a hardened systemd unit and starts it. It
prints the URL when it is done.

**Re-run the same command to upgrade.** It stops the service, updates the code,
reinstalls dependencies and restarts — leaving your database, `.env` and bot
directories untouched.

Change the defaults with environment variables (note `sudo -E`):

```bash
INSTALL_DIR=/srv/botpanel PANEL_PORT=9000 curl -fsSL <url>/install.sh | sudo -E bash
```

### Docker

```bash
curl -O https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/docker-compose.yml
docker compose up -d
```

Data lives in the `botpanel-data` volume: database, bot checkouts, logs and
backups. Back that up and you have backed up everything.

### From source

```bash
git clone https://github.com/CaptainGuinea/Discord-Bot-Panel.git
cd botpanel
npm install
npm start
```

Requires **Node.js 24 or newer**, plus `git` and `tar` on the host. Nothing
compiles: the panel uses Node's built-in `node:sqlite`.

Whichever route you take, open the printed address and the first screen creates
your administrator account.

## Adding your first bot

1. **New bot.** Give it a name and your repository URL. For a private
   repository, paste a personal access token. The first deploy starts
   automatically and detects whether it is a Node.js or Python project.
2. **Environment.** Open the *Environment* tab and paste your existing `.env`
   into the import box. `DISCORD_TOKEN` and similar keys are masked
   automatically.
3. **Check the start command.** *Settings* shows what was detected —
   `npm start`, `node index.js`, `./.venv/bin/python bot.py`. Adjust it if your
   entry point is unusual.
4. **Start it** and watch the *Console* tab.

No repository? Create the bot without a URL, then drop files onto the *Files*
tab or copy them into `data/bots/<bot id>/`.

## Auto-deploy on push

Each bot's *Git & deploys* tab shows a webhook URL. In your repository settings,
add it as a webhook with content type `application/json` and the push event.
Pushes to the tracked branch will pull, reinstall and restart.

The panel must be reachable from your Git host for this. On a private network,
use the **Deploy now** button instead, or expose the panel through a tunnel.

## Running behind a reverse proxy

Set `PUBLIC_URL` so generated webhook URLs are correct, and turn on
`TRUST_PROXY` and `SECURE_COOKIES`. The panel uses WebSockets, so the proxy must
forward upgrade headers.

<details>
<summary><b>Caddy</b></summary>

```caddy
bots.example.com {
    reverse_proxy localhost:8080
}
```

Caddy handles WebSockets and TLS with no extra configuration.
</details>

<details>
<summary><b>nginx</b></summary>

```nginx
server {
    listen 443 ssl;
    server_name bots.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Deploy output can be quiet for a while during a long install.
        proxy_read_timeout 3600s;
    }
}
```
</details>

<details>
<summary><b>Traefik (Compose labels)</b></summary>

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.botpanel.rule=Host(`bots.example.com`)
  - traefik.http.routers.botpanel.entrypoints=websecure
  - traefik.http.routers.botpanel.tls.certresolver=letsencrypt
  - traefik.http.services.botpanel.loadbalancer.server.port=8080
```
</details>

## Configuration

Everything is optional; see [`.env.example`](.env.example) for the full list.
Instance name, accent colour and public URL can also be changed from the
Administration page without a restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8080` | Bind port |
| `PUBLIC_URL` | — | External URL, used to build webhook links |
| `DATA_DIR` | `./data` | Database, bot checkouts, logs, backups |
| `INSTANCE_NAME` | `BotPanel` | Name before an admin sets one |
| `SESSION_SECRET` | generated | Persisted to `<DATA_DIR>/secret.key` if unset |
| `SESSION_DAYS` | `30` | Sign-in lifetime |
| `SECURE_COOKIES` | `0` | Set to `1` when served over HTTPS |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `STOP_GRACE_MS` | `10000` | Time a bot gets to exit before being killed |

## Upgrading

Re-run whichever installer you used. Your database, `.env` and bot directories
are left alone.

```bash
# Bare metal, VM or LXC
curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh | sudo bash

# Inside a Proxmox container, from the host
pct exec <id> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/CaptainGuinea/Discord-Bot-Panel/main/install.sh)"

# Docker
docker compose pull && docker compose up -d
```

Running bots are stopped cleanly before the upgrade and started again
afterwards if they are set to autostart.

## Uninstalling

```bash
sudo bash /opt/botpanel/scripts/uninstall.sh              # keeps your data
REMOVE_DATA=1 sudo -E bash /opt/botpanel/scripts/uninstall.sh   # removes everything
```

For a Proxmox container, `pct stop <id> && pct destroy <id>` removes the lot.

## Data layout

```
data/
  panel.db          SQLite: users, bots, environment, deploys, audit trail
  secret.key        session signing key
  bots/<id>/        one directory per bot — this is the Git checkout
  logs/<id>.log     rotating console log
  backups/<id>/     tarballs
```

## Security

BotPanel runs commands you configure. An administrator account is equivalent to
shell access on the host — that is what a process manager is. **Do not expose it
directly to the internet.** Put it behind a reverse proxy with TLS, or reach it
over a VPN.

Within that boundary it is properly locked down: bcrypt password hashing,
server-side sessions in httpOnly cookies, per-IP sign-in rate limiting,
cross-origin write rejection, path-traversal guards on every file operation, and
Git tokens that never reach the browser or `.git/config`.

Full details and reporting instructions are in [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the layout,
the house style and how to run the checks.

## License

[MIT](LICENSE).
