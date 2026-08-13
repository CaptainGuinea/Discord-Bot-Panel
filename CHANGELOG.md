# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
