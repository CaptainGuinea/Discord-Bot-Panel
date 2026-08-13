import fs from 'node:fs';
import path from 'node:path';
import { BOTS_DIR, IS_WINDOWS } from './config.js';
import { get, query, run } from './db.js';
import * as settings from './settings.js';
import { HttpError, newId, newToken, slugify, bool, toEnvText } from './util.js';

export const ACCENTS = settings.ACCENTS;

export const RUNTIMES = {
  node: {
    label: 'Node.js',
    install: 'npm install --omit=dev',
    start: 'node index.js',
  },
  python: {
    label: 'Python',
    install: IS_WINDOWS
      ? 'python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt'
      : 'python3 -m venv .venv && ./.venv/bin/pip install --upgrade pip && ./.venv/bin/pip install -r requirements.txt',
    start: IS_WINDOWS ? '.venv\\Scripts\\python bot.py' : './.venv/bin/python bot.py',
  },
  custom: { label: 'Custom', install: '', start: '' },
};

export const botDir = (botId) => path.join(BOTS_DIR, botId);

export function detectRuntime(dir) {
  const has = (file) => fs.existsSync(path.join(dir, file));
  if (has('package.json')) return 'node';
  if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile')) return 'python';
  return 'custom';
}

/** Picks a start command based on what the repository actually contains. */
export function suggestStartCommand(dir, runtime) {
  if (runtime === 'node') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.scripts?.start) return 'npm start';
      if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return `node ${pkg.main}`;
    } catch {
      // Fall through to the candidate scan.
    }

    for (const candidate of ['index.js', 'bot.js', 'main.js', 'src/index.js', 'src/bot.js', 'index.mjs']) {
      if (fs.existsSync(path.join(dir, candidate))) return `node ${candidate}`;
    }
    return RUNTIMES.node.start;
  }

  if (runtime === 'python') {
    const python = IS_WINDOWS ? '.venv\\Scripts\\python' : './.venv/bin/python';
    for (const candidate of ['bot.py', 'main.py', 'app.py', 'src/bot.py', '__main__.py']) {
      if (fs.existsSync(path.join(dir, candidate))) return `${python} ${candidate}`;
    }
    return RUNTIMES.python.start;
  }

  return '';
}

export const listBots = () => query('SELECT * FROM bots ORDER BY name COLLATE NOCASE ASC');

export const findBot = (id) => get('SELECT * FROM bots WHERE id = ?', id);

export function getBot(id) {
  const bot = findBot(id);
  if (!bot) throw new HttpError(404, 'Bot not found');
  return bot;
}

function uniqueSlug(name) {
  const base = slugify(name);
  let candidate = base;
  let counter = 2;

  while (get('SELECT id FROM bots WHERE slug = ?', candidate)) candidate = `${base}-${counter++}`;
  return candidate;
}

export function createBot(input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new HttpError(400, 'A name is required');

  const runtime = RUNTIMES[input.runtime] ? input.runtime : 'node';
  const id = newId();
  const timestamp = Date.now();

  run(
    `INSERT INTO bots
       (id, name, slug, description, accent, runtime, git_url, git_branch, git_token,
        install_cmd, start_cmd, autostart, restart_policy, max_restarts, restart_delay,
        write_env_file, webhook_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    name,
    uniqueSlug(name),
    input.description?.trim() || null,
    ACCENTS.includes(input.accent) ? input.accent : ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
    runtime,
    input.gitUrl?.trim() || null,
    input.gitBranch?.trim() || 'main',
    input.gitToken?.trim() || null,
    input.installCmd ?? RUNTIMES[runtime].install,
    input.startCmd ?? RUNTIMES[runtime].start,
    bool(input.autostart ?? true),
    ['always', 'on-failure', 'never'].includes(input.restartPolicy)
      ? input.restartPolicy
      : settings.value('defaultRestartPolicy'),
    Number(input.maxRestarts) > 0 ? Number(input.maxRestarts) : 10,
    Number(input.restartDelay) > 0 ? Number(input.restartDelay) : 3000,
    bool(input.writeEnvFile ?? true),
    newToken(),
    timestamp,
    timestamp,
  );

  fs.mkdirSync(botDir(id), { recursive: true });
  return getBot(id);
}

const UPDATABLE = {
  name: 'name',
  description: 'description',
  accent: 'accent',
  runtime: 'runtime',
  gitUrl: 'git_url',
  gitBranch: 'git_branch',
  gitToken: 'git_token',
  installCmd: 'install_cmd',
  startCmd: 'start_cmd',
  autostart: 'autostart',
  restartPolicy: 'restart_policy',
  maxRestarts: 'max_restarts',
  restartDelay: 'restart_delay',
  writeEnvFile: 'write_env_file',
};

export function updateBot(id, patch) {
  getBot(id);

  const assignments = [];
  const values = [];

  for (const [key, column] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    let value = patch[key];

    if (key === 'autostart' || key === 'writeEnvFile') value = bool(value);
    else if (key === 'maxRestarts' || key === 'restartDelay') value = Number(value) || 0;
    else if (key === 'restartPolicy' && !['always', 'on-failure', 'never'].includes(value)) continue;
    else if (key === 'runtime' && !RUNTIMES[value]) continue;
    else if (key === 'accent' && !ACCENTS.includes(value)) continue;
    else if (typeof value === 'string') value = value.trim() || null;

    assignments.push(`${column} = ?`);
    values.push(value ?? null);
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = ?');
    values.push(Date.now(), id);
    run(`UPDATE bots SET ${assignments.join(', ')} WHERE id = ?`, ...values);
  }
  return getBot(id);
}

export function deleteBot(id) {
  getBot(id);
  run('DELETE FROM bots WHERE id = ?', id);
  fs.rmSync(botDir(id), { recursive: true, force: true });
}

export function rotateWebhookSecret(id) {
  const secret = newToken();
  run('UPDATE bots SET webhook_secret = ?, updated_at = ? WHERE id = ?', secret, Date.now(), id);
  return secret;
}

export const getEnvRows = (botId) =>
  query('SELECT key, value, is_secret FROM bot_env WHERE bot_id = ? ORDER BY key ASC', botId);

export function envMap(botId) {
  const map = {};
  for (const row of getEnvRows(botId)) map[row.key] = row.value;
  return map;
}

/** Anything token-shaped is masked in the UI unless explicitly revealed. */
export const looksSecret = (key) =>
  /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE|WEBHOOK|DSN|AUTH)/i.test(key);

/** Replaces the whole set: the editor always submits the complete list. */
export function setEnv(botId, pairs) {
  const seen = new Set();
  run('DELETE FROM bot_env WHERE bot_id = ?', botId);

  for (const pair of pairs) {
    const key = String(pair.key ?? '').trim();
    if (!key || seen.has(key)) continue;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new HttpError(400, `"${key}" is not a valid environment variable name`);
    }

    seen.add(key);
    run(
      'INSERT INTO bot_env (bot_id, key, value, is_secret) VALUES (?, ?, ?, ?)',
      botId, key, String(pair.value ?? ''), bool(pair.isSecret ?? looksSecret(key)),
    );
  }
  return getEnvRows(botId);
}

/** Mirrors variables to .env so bots using dotenv work without code changes. */
export function writeEnvFile(bot) {
  if (!bot.write_env_file) return;

  const dir = botDir(bot.id);
  if (!fs.existsSync(dir)) return;

  const rows = getEnvRows(bot.id);
  if (rows.length === 0) return;

  fs.writeFileSync(
    path.join(dir, '.env'),
    '# Managed by BotPanel — regenerated on deploy.\n' + toEnvText(rows),
    { mode: 0o600 },
  );
}

export const publicBot = (bot) => ({
  id: bot.id,
  name: bot.name,
  slug: bot.slug,
  description: bot.description,
  accent: bot.accent,
  runtime: bot.runtime,
  gitUrl: bot.git_url,
  gitBranch: bot.git_branch,
  hasGitToken: Boolean(bot.git_token),
  installCmd: bot.install_cmd,
  startCmd: bot.start_cmd,
  autostart: Boolean(bot.autostart),
  restartPolicy: bot.restart_policy,
  maxRestarts: bot.max_restarts,
  restartDelay: bot.restart_delay,
  writeEnvFile: Boolean(bot.write_env_file),
  createdAt: bot.created_at,
  updatedAt: bot.updated_at,
});
