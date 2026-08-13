import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, config } from './config.js';

export const db = new DatabaseSync(DB_PATH);

// WAL keeps reads responsive while the metrics sampler writes in the background.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bots (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  description     TEXT,
  accent          TEXT NOT NULL DEFAULT 'indigo',
  runtime         TEXT NOT NULL DEFAULT 'node',
  git_url         TEXT,
  git_branch      TEXT NOT NULL DEFAULT 'main',
  git_token       TEXT,
  install_cmd     TEXT,
  start_cmd       TEXT,
  autostart       INTEGER NOT NULL DEFAULT 1,
  restart_policy  TEXT NOT NULL DEFAULT 'on-failure',
  max_restarts    INTEGER NOT NULL DEFAULT 10,
  restart_delay   INTEGER NOT NULL DEFAULT 3000,
  write_env_file  INTEGER NOT NULL DEFAULT 1,
  webhook_secret  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_env (
  bot_id    TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, key)
);

CREATE TABLE IF NOT EXISTS deploys (
  id           TEXT PRIMARY KEY,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  commit_sha   TEXT,
  commit_msg   TEXT,
  log          TEXT NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deploys_bot ON deploys(bot_id, started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT,
  user_id    TEXT,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

CREATE TABLE IF NOT EXISTS metrics (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  ts     INTEGER NOT NULL,
  cpu    REAL NOT NULL DEFAULT 0,
  mem    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_bot ON metrics(bot_id, ts DESC);
`);

export const query = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

/** Audit logging must never break the action it is recording. */
export function logEvent({ botId = null, userId = null, type, message }) {
  try {
    run(
      'INSERT INTO events (bot_id, user_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)',
      botId, userId, type, message, Date.now(),
    );
  } catch (err) {
    console.error('[events] could not record:', err.message);
  }
}

export function pruneOldRows() {
  run('DELETE FROM metrics WHERE ts < ?', Date.now() - config.metricsRetentionDays * 86_400_000);
  run('DELETE FROM events WHERE created_at < ?', Date.now() - 60 * 86_400_000);
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}
