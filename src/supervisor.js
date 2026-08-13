import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { config, IS_WINDOWS } from './config.js';
import { botDir, envMap, findBot, listBots, writeEnvFile } from './bots.js';
import { logEvent } from './db.js';
import { publish } from './hub.js';
import * as logs from './logstore.js';
import { HttpError, sleep } from './util.js';

export const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  BACKOFF: 'backoff',
  CRASHED: 'crashed',
};

// Runtime state is in-memory only: a panel restart begins from a known state.
const states = new Map();

function state(botId) {
  let entry = states.get(botId);
  if (!entry) {
    entry = {
      botId,
      status: STATUS.STOPPED,
      child: null,
      pid: null,
      startedAt: null,
      exitCode: null,
      exitSignal: null,
      restarts: 0,
      consecutiveFailures: 0,
      backoffTimer: null,
      killTimer: null,
      intentionalStop: false,
      deploying: false,
      cpu: 0,
      mem: 0,
      exitWaiters: [],
    };
    states.set(botId, entry);
  }
  return entry;
}

export function snapshot(botId) {
  const entry = state(botId);
  return {
    botId,
    status: entry.status,
    pid: entry.pid,
    startedAt: entry.startedAt,
    uptime: entry.startedAt ? Date.now() - entry.startedAt : 0,
    restarts: entry.restarts,
    exitCode: entry.exitCode,
    exitSignal: entry.exitSignal,
    deploying: entry.deploying,
    cpu: entry.cpu,
    mem: entry.mem,
  };
}

export const allSnapshots = () =>
  Object.fromEntries(listBots().map((bot) => [bot.id, snapshot(bot.id)]));

export const isRunning = (botId) =>
  [STATUS.RUNNING, STATUS.STARTING, STATUS.STOPPING].includes(state(botId).status);

function setStatus(botId, status) {
  const entry = state(botId);
  if (entry.status === status) return;
  entry.status = status;
  publish('bots', 'status', snapshot(botId));
}

export function setDeploying(botId, value) {
  state(botId).deploying = Boolean(value);
  publish('bots', 'status', snapshot(botId));
}

export function updateResourceSample(botId, cpu, mem) {
  const entry = state(botId);
  entry.cpu = cpu;
  entry.mem = mem;
}

/**
 * A login shell so PATH additions from nvm, pyenv and /etc/profile.d apply,
 * matching what happens when you run the bot by hand over SSH.
 */
function shellFor(command) {
  if (IS_WINDOWS) {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-lc', command] };
}

// Panel plumbing that would mislead a bot if it leaked into its environment.
const PANEL_ONLY_VARS = new Set([
  'PORT', 'HOST', 'DATA_DIR', 'SESSION_SECRET', 'SESSION_DAYS', 'SECURE_COOKIES',
  'TRUST_PROXY', 'PUBLIC_URL', 'INSTANCE_NAME', 'LOG_RING_SIZE', 'LOG_MAX_BYTES',
  'METRICS_INTERVAL_MS', 'METRICS_HISTORY', 'METRICS_RETENTION_DAYS', 'STOP_GRACE_MS',
  'INSTALL_TIMEOUT_MS', 'NODE_OPTIONS',
]);

export function buildEnv(bot) {
  const inherited = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!PANEL_ONLY_VARS.has(key)) inherited[key] = value;
  }

  return {
    ...inherited,
    NODE_ENV: 'production',
    PYTHONUNBUFFERED: '1',
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    BOTPANEL: '1',
    BOTPANEL_BOT_ID: bot.id,
    BOTPANEL_BOT_NAME: bot.name,
    ...envMap(bot.id),
  };
}

/**
 * Signals the whole process group. Bots routinely spawn children — npm wrapping
 * node, ffmpeg for voice — and signalling only the shell orphans them.
 */
function killTree(pid, signal) {
  if (!pid) return;

  if (IS_WINDOWS) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead.
    }
  }
}

export function start(botId, { userId = null, reason = 'manual' } = {}) {
  const bot = findBot(botId);
  if (!bot) throw new HttpError(404, 'Bot not found');

  const entry = state(botId);
  if (entry.child) throw new HttpError(409, 'That bot is already running');
  if (!bot.start_cmd?.trim()) throw new HttpError(400, 'No start command is configured for this bot');

  clearTimeout(entry.backoffTimer);
  entry.backoffTimer = null;
  entry.intentionalStop = false;
  entry.exitCode = null;
  entry.exitSignal = null;

  const cwd = botDir(botId);
  fs.mkdirSync(cwd, { recursive: true });
  writeEnvFile(bot);

  setStatus(botId, STATUS.STARTING);
  logs.system(botId, `Starting: ${bot.start_cmd}`);

  const { file, args } = shellFor(bot.start_cmd);
  let child;

  try {
    child = spawn(file, args, {
      cwd,
      env: buildEnv(bot),
      detached: !IS_WINDOWS,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    setStatus(botId, STATUS.CRASHED);
    logs.system(botId, `Failed to spawn: ${err.message}`);
    throw new HttpError(500, `Could not start the bot: ${err.message}`);
  }

  entry.child = child;
  entry.pid = child.pid;
  entry.startedAt = Date.now();

  child.stdout.on('data', (chunk) => logs.ingest(botId, chunk, 'stdout'));
  child.stderr.on('data', (chunk) => logs.ingest(botId, chunk, 'stderr'));
  child.on('error', (err) => logs.system(botId, `Process error: ${err.message}`));
  child.once('exit', (code, signal) => handleExit(botId, code, signal));

  setStatus(botId, STATUS.RUNNING);
  logEvent({ botId, userId, type: 'bot.start', message: `${bot.name} started (${reason}), pid ${child.pid}` });
  return snapshot(botId);
}

function handleExit(botId, code, signal) {
  const entry = state(botId);
  const bot = findBot(botId);
  const uptime = entry.startedAt ? Date.now() - entry.startedAt : 0;

  logs.flush(botId);
  clearTimeout(entry.killTimer);
  entry.killTimer = null;
  entry.child = null;
  entry.pid = null;
  entry.exitCode = code;
  entry.exitSignal = signal;
  entry.startedAt = null;

  const describe = signal ? `signal ${signal}` : `exit code ${code}`;
  logs.system(botId, `Process ended (${describe}) after ${Math.round(uptime / 1000)}s`);

  for (const resolve of entry.exitWaiters.splice(0)) resolve();

  if (entry.intentionalStop || !bot) {
    entry.consecutiveFailures = 0;
    setStatus(botId, STATUS.STOPPED);
    return;
  }

  // A process that ran for a while before dying is a new incident, not a
  // continuation of an earlier crash loop.
  if (uptime > 60_000) entry.consecutiveFailures = 0;

  const clean = code === 0;
  const policy = bot.restart_policy;
  const shouldRestart = policy === 'always' || (policy === 'on-failure' && !clean);

  if (!shouldRestart) {
    setStatus(botId, clean ? STATUS.STOPPED : STATUS.CRASHED);
    logEvent({ botId, type: 'bot.exit', message: `${bot.name} ended (${describe}); restart policy "${policy}"` });
    return;
  }

  entry.consecutiveFailures += 1;

  if (entry.consecutiveFailures > bot.max_restarts) {
    setStatus(botId, STATUS.CRASHED);
    logs.system(botId, `Crash loop detected — gave up after ${bot.max_restarts} restart attempts. Fix the error above, then start it again.`);
    logEvent({ botId, type: 'bot.crashloop', message: `${bot.name} hit its restart limit (${bot.max_restarts})` });
    return;
  }

  // Exponential backoff so a bot failing on bad credentials does not spin.
  const delay = Math.min(bot.restart_delay * 2 ** (entry.consecutiveFailures - 1), 60_000);
  setStatus(botId, STATUS.BACKOFF);
  logs.system(botId, `Restarting in ${Math.round(delay / 1000)}s (attempt ${entry.consecutiveFailures}/${bot.max_restarts})`);

  entry.backoffTimer = setTimeout(() => {
    entry.backoffTimer = null;
    entry.restarts += 1;
    try {
      start(botId, { reason: 'auto-restart' });
    } catch (err) {
      logs.system(botId, `Auto-restart failed: ${err.message}`);
      setStatus(botId, STATUS.CRASHED);
    }
  }, delay);
}

export function stop(botId, { userId = null, force = false } = {}) {
  const entry = state(botId);
  const bot = findBot(botId);

  clearTimeout(entry.backoffTimer);
  entry.backoffTimer = null;
  entry.intentionalStop = true;
  entry.consecutiveFailures = 0;

  if (!entry.child) {
    setStatus(botId, STATUS.STOPPED);
    return Promise.resolve(snapshot(botId));
  }

  setStatus(botId, STATUS.STOPPING);
  logs.system(botId, force ? 'Force killing process tree…' : 'Stopping (SIGTERM)…');
  logEvent({
    botId,
    userId,
    type: force ? 'bot.kill' : 'bot.stop',
    message: `${bot?.name ?? botId} ${force ? 'killed' : 'stopped'}`,
  });

  const pid = entry.pid;
  const done = new Promise((resolve) => entry.exitWaiters.push(resolve));

  killTree(pid, force ? 'SIGKILL' : 'SIGTERM');

  if (!force) {
    entry.killTimer = setTimeout(() => {
      if (entry.child) {
        logs.system(botId, `Still running after ${config.stopGraceMs / 1000}s — sending SIGKILL`);
        killTree(pid, 'SIGKILL');
      }
    }, config.stopGraceMs);
  }

  return done.then(() => snapshot(botId));
}

export async function restart(botId, { userId = null } = {}) {
  await stop(botId, { userId });
  await sleep(250);
  return start(botId, { userId, reason: 'restart' });
}

export function sendStdin(botId, text) {
  const entry = state(botId);
  if (!entry.child?.stdin?.writable) throw new HttpError(409, 'That bot is not running');

  entry.child.stdin.write(`${text}\n`);
  logs.append(botId, `> ${text}`, 'stdin');
}

/** Clears a crash-loop lockout so the UI can offer a plain start again. */
export function resetFailures(botId) {
  const entry = state(botId);
  entry.consecutiveFailures = 0;
  if (entry.status === STATUS.CRASHED) setStatus(botId, STATUS.STOPPED);
}

export async function startAutostartBots() {
  const bots = listBots().filter((bot) => bot.autostart && bot.start_cmd);
  if (bots.length === 0) return;

  console.log(`[supervisor] autostarting ${bots.length} bot(s)`);

  for (const bot of bots) {
    try {
      start(bot.id, { reason: 'autostart' });
    } catch (err) {
      console.error(`[supervisor] autostart failed for ${bot.name}: ${err.message}`);
    }
    await sleep(1200);
  }
}

export async function stopAll() {
  const running = [...states.values()].filter((entry) => entry.child);
  if (running.length === 0) return;

  console.log(`[supervisor] stopping ${running.length} bot(s)`);
  await Promise.all(running.map((entry) =>
    Promise.race([stop(entry.botId), sleep(config.stopGraceMs + 2000)])));
}
