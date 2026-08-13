# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The Proxmox LXC installer picked the wrong CPU architecture when the
  template catalogue lists several (for example `amd64` and `arm64` variants
  on Proxmox VE 9.1): version-sorting made it grab the `arm64` template on
  x86 hosts, and the container then failed to start with
  `Exec format error - Failed to exec "/sbin/init"` (surfaced by Proxmox as
  `sync_wait: 34 ... Failed to spawn container`). Templates are now filtered
  by the host's architecture before the newest version is chosen.

### Changed

- The Proxmox LXC installer now uses whiptail dialogs like the community
  scripts: a Default/Advanced Install menu, pick-lists for storage and network
  bridge, validated inputs (numbers, hostname, CIDR, gateway, VLAN) and a
  confirmation summary before the container is created. Previously a stray
  answer such as `y` to a value prompt reached `pct create` unchecked and
  failed with "Parameter verification failed".
- The Proxmox LXC installer verifies template archives before using them
  (deleting and re-downloading corrupt cached copies), checks that the new
  container's `/sbin/init` is a valid binary for the host architecture before
  starting it, and collects an LXC debug log automatically when a start fails.
  Previously a corrupt template — for example from a flaky USB drive — was
  reused forever and every container built from it failed with the opaque
  "sync_wait: 34 ... Failed to spawn container" error.

## [1.0.0] — 2026-08-12

First release.

### Added

- Process supervision with per-bot restart policies, exponential backoff and
  crash-loop detection. Bots run in their own process group so child processes
  are stopped with them.
- Git deploys: clone, fast-forward, force sync, branch and commit checkout, and
  a per-bot webhook for auto-deploy on push.
- Live consoles over WebSocket with ANSI colour, filtering, stdin, and rotating
  log files on disk.
- Environment variable management with automatic masking of secrets and
  optional `.env` file generation.
- File browser with an in-browser editor and drag-and-drop upload.
- Per-bot CPU and memory charts sampled from the whole process tree.
- Backups as tarballs, excluding reinstallable directories.
- Accounts with `admin` and `operator` roles, optional open registration, and
  an audit trail.
- Instance branding: name and accent colour, editable from the Administration
  page.
- Docker image, Compose file and a bare-metal installer with a systemd unit.

[1.0.0]: https://github.com/CaptainGuinea/Discord-Bot-Panel/releases/tag/v1.0.0
