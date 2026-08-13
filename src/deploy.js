import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { IS_WINDOWS, config } from './config.js';
import { botDir, findBot, writeEnvFile, detectRuntime, suggestStartCommand, updateBot, RUNTIMES } from './bots.js';
import { get, query, run, logEvent } from './db.js';
import * as gitApi from './git.js';
import { publish } from './hub.js';
import * as logs from './logstore.js';
import * as supervisor from './supervisor.js';
import { HttpError, newId } from './util.js';

/** One deploy per bot at a time — concurrent installs corrupt node_modules. */
const active = new Map(); // botId -> deployId

export const isDeploying = (botId) => active.has(botId);

/** Streams a shell command, forwarding every line to the deploy console. */
function runShell(command, { cwd, env, onLine, timeout = config.installTimeoutMs }) {
  return new Promise((resolve) => {
    const shell = IS_WINDOWS
      ? { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-lc', command] };

    const child = spawn(shell.file, shell.args, {
      cwd,
      env,
      windowsHide: true,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const consume = (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    };

    const timer = setTimeout(() => {
      onLine('!! Install timed out — killing it.');
      try {
        process.kill(IS_WINDOWS ? child.pid : -child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeout);

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (err) => {
      clearTimeout(timer);
      onLine(`!! ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) onLine(buffer);
      resolve(code ?? 1);
    });
  });
}

/**
 * The full pipeline: pull the code, install dependencies, bring the bot back.
 * Every line is streamed to `deploy:<botId>` and also kept for the history.
 */
export async function runDeploy(botId, {
  userId = null,
  trigger = 'manual',
  force = false,
  skipInstall = false,
  restart = true,
} = {}) {
  const bot = findBot(botId);
  if (!bot) throw new HttpError(404, 'Bot not found');
  if (active.has(botId)) throw new HttpError(409, 'A deploy is already running for this bot');

  const deployId = newId();
  const startedAt = Date.now();
  const collected = [];

  active.set(botId, deployId);
  supervisor.setDeploying(botId, true);

  run(
    'INSERT INTO deploys (id, bot_id, status, trigger_type, started_at) VALUES (?, ?, ?, ?, ?)',
    deployId, botId, 'running', trigger, startedAt,
  );

  const emit = (text, level = 'info') => {
    const line = { ts: Date.now(), level, text: String(text) };
    collected.push(`${new Date(line.ts).toISOString()} ${text}`);
    publish(`deploy:${botId}`, 'line', { deployId, ...line });
  };

  publish('bots', 'deploy-start', { botId, deployId });
  emit(`Deploy started (${trigger})`, 'step');

  const dir = botDir(botId);
  const wasRunning = supervisor.isRunning(botId);
  let status = 'success';
  let failure = null;

  try {
    fs.mkdirSync(dir, { recursive: true });

    // --- 1. Source ---------------------------------------------------------
    if (bot.git_url) {
      if (!gitApi.isRepo(dir)) {
        emit(`Cloning ${bot.git_url} (${bot.git_branch})`, 'step');
        await gitApi.clone({
          url: bot.git_url,
          branch: bot.git_branch,
          token: bot.git_token,
          dir,
          onOutput: (line) => emit(line),
        });

        // First clone: fill in commands that match what actually landed.
        const detected = detectRuntime(dir);
        const patch = {};
        if (bot.runtime === 'custom' && detected !== 'custom') patch.runtime = detected;

        const runtime = patch.runtime ?? bot.runtime;
        if (!bot.start_cmd) patch.startCmd = suggestStartCommand(dir, runtime);
        if (!bot.install_cmd && RUNTIMES[runtime]?.install) patch.installCmd = RUNTIMES[runtime].install;

        if (Object.keys(patch).length > 0) {
          updateBot(botId, patch);
          emit(`Detected ${runtime} project${patch.startCmd ? ` — start command set to "${patch.startCmd}"` : ''}`, 'step');
          if (patch.installCmd) emit(`Install command set to "${patch.installCmd}"`, 'step');
        }
      } else {
        emit(`Fetching ${bot.git_branch} from origin`, 'step');
        await gitApi.sync({
          dir,
          branch: bot.git_branch,
          token: bot.git_token,
          url: bot.git_url,
          force,
          onOutput: (line) => emit(line),
        });
      }

      const commit = await gitApi.head(dir);
      if (commit) {
        emit(`Now at ${commit.shortSha} — ${commit.subject} (${commit.author})`, 'step');
        run('UPDATE deploys SET commit_sha = ?, commit_msg = ? WHERE id = ?', commit.sha, commit.subject, deployId);
      }
    } else {
      emit('No git remote configured — deploying the files already on disk', 'step');
    }

    // --- 2. Environment ----------------------------------------------------
    const current = findBot(botId);
    writeEnvFile(current);

    // --- 3. Dependencies ---------------------------------------------------
    if (!skipInstall && current.install_cmd?.trim()) {
      emit(`Installing dependencies: ${current.install_cmd}`, 'step');
      const code = await runShell(current.install_cmd, {
        cwd: dir,
        env: supervisor.buildEnv(current),
        onLine: (line) => emit(line),
      });
      if (code !== 0) throw new HttpError(400, `Install command exited with code ${code}`);
      emit('Dependencies installed', 'step');
    } else if (skipInstall) {
      emit('Skipping dependency install', 'step');
    }

    // --- 4. Restart --------------------------------------------------------
    if (restart && (wasRunning || current.autostart)) {
      emit('Restarting the bot', 'step');
      supervisor.resetFailures(botId);
      await supervisor.stop(botId, { userId });
      supervisor.start(botId, { userId, reason: 'deploy' });
      emit('Bot started', 'step');
      logs.system(botId, `Deployed by ${trigger}`);
    } else if (restart) {
      emit('Bot was not running — leaving it stopped', 'step');
    }

    emit(`Deploy finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`, 'success');
  } catch (err) {
    status = 'failed';
    failure = err.message;
    emit(`Deploy failed: ${err.message}`, 'error');

    // A failed deploy should not leave a previously healthy bot down.
    if (wasRunning && !supervisor.isRunning(botId)) {
      emit('Bringing the previous version back up', 'step');
      try {
        supervisor.start(botId, { userId, reason: 'deploy-rollback' });
      } catch (restartErr) {
        emit(`Could not restart: ${restartErr.message}`, 'error');
      }
    }
  } finally {
    active.delete(botId);
    supervisor.setDeploying(botId, false);
    run(
      'UPDATE deploys SET status = ?, finished_at = ?, log = ? WHERE id = ?',
      status, Date.now(), collected.join('\n'), deployId,
    );
    logEvent({
      botId,
      userId,
      type: `deploy.${status}`,
      message: `${bot.name} deploy ${status}${failure ? `: ${failure}` : ''}`,
    });
    publish('bots', 'deploy-end', { botId, deployId, status });
  }

  return getDeploy(deployId);
}

export const listDeploys = (botId, limit = 20) =>
  query(
    `SELECT id, bot_id, status, trigger_type, commit_sha, commit_msg, started_at, finished_at
       FROM deploys WHERE bot_id = ? ORDER BY started_at DESC LIMIT ?`,
    botId, limit,
  );

export const getDeploy = (deployId) => get('SELECT * FROM deploys WHERE id = ?', deployId);
