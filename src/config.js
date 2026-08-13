import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const env = (key, fallback) => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const envInt = (key, fallback) => {
  const parsed = Number.parseInt(env(key, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const envBool = (key, fallback) => {
  const value = env(key, null);
  if (value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const resolveFromRoot = (target) => (path.isAbsolute(target) ? target : path.resolve(ROOT, target));

export const DATA_DIR = resolveFromRoot(env('DATA_DIR', './data'));
export const BOTS_DIR = path.join(DATA_DIR, 'bots');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const DB_PATH = path.join(DATA_DIR, 'panel.db');
export const PUBLIC_DIR = path.join(ROOT, 'public');

for (const dir of [DATA_DIR, BOTS_DIR, LOGS_DIR, BACKUPS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadSecret() {
  const fromEnv = env('SESSION_SECRET', null);
  if (fromEnv) return fromEnv;

  const secretFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();

  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export const config = {
  version: readVersion(),

  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 8080),

  // Only needed when the panel sits behind a proxy on a different hostname than
  // it binds to; webhook URLs shown in the UI are built from it.
  publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),

  sessionSecret: loadSecret(),
  sessionDays: envInt('SESSION_DAYS', 30),
  secureCookies: envBool('SECURE_COOKIES', false),
  trustProxy: envBool('TRUST_PROXY', false),

  defaultInstanceName: env('INSTANCE_NAME', 'BotPanel'),

  logRingSize: envInt('LOG_RING_SIZE', 2000),
  logFileMaxBytes: envInt('LOG_MAX_BYTES', 5 * 1024 * 1024),
  metricsIntervalMs: envInt('METRICS_INTERVAL_MS', 3000),
  metricsHistory: envInt('METRICS_HISTORY', 120),
  metricsRetentionDays: envInt('METRICS_RETENTION_DAYS', 7),

  // How long a bot gets to exit after SIGTERM before it is killed.
  stopGraceMs: envInt('STOP_GRACE_MS', 10_000),
  installTimeoutMs: envInt('INSTALL_TIMEOUT_MS', 20 * 60 * 1000),
};

export const IS_WINDOWS = process.platform === 'win32';
