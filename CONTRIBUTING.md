# Contributing

Thanks for taking an interest. This document covers how to run the project
locally and what the code expects of a change.

## Running locally

```bash
git clone <your fork>
cd botpanel
npm install
npm run dev
```

`npm run dev` restarts on file changes. The panel serves on
<http://localhost:8080>; the first screen creates an administrator account.

You need **Node.js 24 or newer** — the panel uses the built-in `node:sqlite`
module, which is why nothing needs to compile.

Nothing is bundled or transpiled. `public/` is served as written, so a browser
refresh is the whole frontend build step.

## Project layout

```
src/
  server.js      HTTP, WebSocket upgrade, static files, shutdown
  routes.js      the entire REST API
  supervisor.js  process lifecycle, restart policy, crash-loop handling
  deploy.js      pull, install, restart pipeline
  git.js         git plumbing and credential handling
  logstore.js    per-bot ring buffer and rotating log file
  metrics.js     /proc sampling and host stats
  bots.js        bot records, runtimes, environment variables
  settings.js    instance settings
  auth.js        accounts, sessions, roles
  files.js       file manager and backups
  db.js          schema and query helpers
public/
  index.html     app shell and icon sprite
  css/app.css    design tokens and every component
  js/app.js      router and views
  js/api.js      REST client and reconnecting WebSocket
  js/ui.js       formatting, charts, toasts, modals
```

## Style

The code aims to read like one person wrote it in one sitting.

- Comments explain **why**, not what. If the code already says it, delete the
  comment. Section-divider banners in backend files are not used.
- Prefer clear names over short ones. `consecutiveFailures`, not `n`.
- Handle the error case first and return early.
- No new runtime dependencies without a strong reason. The install being a
  single `npm install` with nothing to compile is a feature.
- Frontend: no framework and no build step. Escape everything interpolated into
  HTML with `esc()`.

Before opening a pull request:

```bash
npm run check
```

That syntax-checks every file and confirms the backend modules import cleanly.

## Pull requests

- One change per pull request.
- Describe what breaks if the change is wrong; that tells reviewers where to
  look.
- Say how you tested it. "Started a bot, killed it, watched it back off and
  restart" is worth more than a screenshot.
- Update `README.md` when you change behaviour a user can see, and
  `.env.example` when you add configuration.

## Reporting bugs

Include the panel version (Settings → Host), how the panel is installed
(Docker, bare metal), your Node.js version, and the relevant lines from
`journalctl -u botpanel` or `docker logs botpanel`.

Security issues go through [SECURITY.md](SECURITY.md) instead, not the public
issue tracker.
