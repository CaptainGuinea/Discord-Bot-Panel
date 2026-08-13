import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  COOKIE_NAME, ROLES, changePassword, cookieOptions, createUser, deleteUser, destroySession,
  listSessions, listUsers, login, needsSetup, publicUser, requireAdmin, requireAuth,
  resolveSession, secretMatches, setPassword, updateUser,
} from './auth.js';
import {
  RUNTIMES, botDir, createBot, deleteBot, getBot, getEnvRows, listBots, looksSecret,
  publicBot, rotateWebhookSecret, setEnv, updateBot, writeEnvFile,
} from './bots.js';
import { config } from './config.js';
import { get, logEvent, query } from './db.js';
import * as deploy from './deploy.js';
import * as fileApi from './files.js';
import * as gitApi from './git.js';
import { clientCount, disconnectUser } from './hub.js';
import * as logs from './logstore.js';
import { hostStats, recentHistory } from './metrics.js';
import * as settings from './settings.js';
import * as supervisor from './supervisor.js';
import { HttpError, wrap } from './util.js';

export const router = express.Router();

const withState = (bot) => ({ ...publicBot(bot), state: supervisor.snapshot(bot.id) });

const loadBot = wrap((req, _res, next) => {
  req.bot = getBot(req.params.id);
  next();
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: config.version, uptime: Math.round(process.uptime()) });
});

router.get('/instance', (_req, res) => res.json(settings.branding()));

router.get('/auth/state', (req, res) => {
  const session = resolveSession(req.cookies?.[COOKIE_NAME]);
  res.json({
    needsSetup: needsSetup(),
    user: session ? publicUser(session) : null,
    instance: settings.branding(),
  });
});

router.post('/setup', wrap(async (req, res) => {
  if (!needsSetup()) throw new HttpError(409, 'This instance already has an account');

  const user = await createUser({
    username: req.body?.username,
    email: req.body?.email,
    password: req.body?.password,
    role: 'admin',
  });

  const session = await login({
    username: req.body.username,
    password: req.body.password,
    ip: req.clientIp,
    userAgent: req.get('user-agent'),
  });

  logEvent({ userId: user.id, type: 'auth.setup', message: `Instance claimed by ${user.username}` });
  res.cookie(COOKIE_NAME, session.token, cookieOptions());
  res.status(201).json({ user: session.user });
}));

router.post('/auth/register', wrap(async (req, res) => {
  if (needsSetup()) throw new HttpError(409, 'Complete the initial setup first');
  if (!settings.value('allowRegistration')) throw new HttpError(403, 'Registration is disabled on this instance');

  // Self-registered accounts get the lower-privilege role by design.
  const user = await createUser({
    username: req.body?.username,
    email: req.body?.email,
    password: req.body?.password,
    role: 'operator',
  });

  const session = await login({
    username: req.body.username,
    password: req.body.password,
    ip: req.clientIp,
    userAgent: req.get('user-agent'),
  });

  logEvent({ userId: user.id, type: 'auth.register', message: `${user.username} registered` });
  res.cookie(COOKIE_NAME, session.token, cookieOptions());
  res.status(201).json({ user: session.user });
}));

router.post('/auth/login', wrap(async (req, res) => {
  const session = await login({
    username: req.body?.username,
    password: req.body?.password,
    ip: req.clientIp,
    userAgent: req.get('user-agent'),
  });
  res.cookie(COOKIE_NAME, session.token, cookieOptions());
  res.json({ user: session.user });
}));

router.post('/auth/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.use(requireAuth);

router.get('/auth/me', (req, res) => res.json({ user: req.user }));

router.get('/auth/sessions', (req, res) => {
  res.json({
    sessions: listSessions(req.user.id).map((session) => ({
      id: session.token.slice(0, 12),
      current: session.token === req.sessionToken,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      ip: session.ip,
      userAgent: session.user_agent,
    })),
  });
});

router.post('/auth/password', wrap(async (req, res) => {
  await changePassword(req.user.id, req.body?.currentPassword, req.body?.newPassword);
  disconnectUser(req.user.id);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

router.get('/system', wrap(async (req, res) => {
  const snapshots = listBots().map((bot) => supervisor.snapshot(bot.id));
  res.json({
    host: await hostStats(),
    version: config.version,
    counts: {
      bots: snapshots.length,
      running: snapshots.filter((entry) => entry.status === 'running').length,
      crashed: snapshots.filter((entry) => entry.status === 'crashed').length,
      connectedClients: clientCount(),
    },
  });
}));

router.get('/runtimes', (_req, res) => {
  res.json({
    runtimes: Object.entries(RUNTIMES).map(([id, preset]) => ({ id, ...preset })),
    accents: settings.ACCENTS,
  });
});

router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({
    events: req.query.botId
      ? query('SELECT * FROM events WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?', req.query.botId, limit)
      : query('SELECT * FROM events ORDER BY created_at DESC LIMIT ?', limit),
  });
});

router.get('/settings', requireAdmin, (_req, res) => res.json({ settings: settings.all() }));

router.patch('/settings', requireAdmin, wrap(async (req, res) => {
  const updated = settings.update(req.body ?? {});
  logEvent({ userId: req.user.id, type: 'instance.update', message: `${req.user.username} updated instance settings` });
  res.json({ settings: updated });
}));

router.get('/users', requireAdmin, (_req, res) => res.json({ users: listUsers(), roles: ROLES }));

router.post('/users', requireAdmin, wrap(async (req, res) => {
  const user = await createUser({
    username: req.body?.username,
    email: req.body?.email,
    password: req.body?.password,
    role: req.body?.role ?? 'operator',
  });
  logEvent({ userId: req.user.id, type: 'user.create', message: `${req.user.username} created user ${user.username}` });
  res.status(201).json({ user: publicUser(user) });
}));

router.patch('/users/:userId', requireAdmin, wrap(async (req, res) => {
  const user = updateUser(req.params.userId, req.body ?? {});

  if (req.body?.password) {
    await setPassword(req.params.userId, req.body.password);
    disconnectUser(req.params.userId);
  }

  logEvent({ userId: req.user.id, type: 'user.update', message: `${req.user.username} updated user ${user.username}` });
  res.json({ user });
}));

router.delete('/users/:userId', requireAdmin, wrap(async (req, res) => {
  if (req.params.userId === req.user.id) throw new HttpError(400, 'You cannot delete your own account');

  const removed = deleteUser(req.params.userId);
  disconnectUser(req.params.userId);
  logEvent({ userId: req.user.id, type: 'user.delete', message: `${req.user.username} deleted user ${removed.username}` });
  res.json({ ok: true });
}));

router.get('/bots', (_req, res) => res.json({ bots: listBots().map(withState) }));

router.post('/bots', requireAdmin, wrap(async (req, res) => {
  const bot = createBot(req.body ?? {});
  if (Array.isArray(req.body?.env) && req.body.env.length > 0) setEnv(bot.id, req.body.env);

  logEvent({ botId: bot.id, userId: req.user.id, type: 'bot.create', message: `${bot.name} created` });

  // A bot created from a repository has no code until the first deploy runs.
  if (bot.git_url && req.body?.deployNow !== false) {
    deploy.runDeploy(bot.id, { userId: req.user.id, trigger: 'create' })
      .catch((err) => console.error('[deploy]', err.message));
  }

  res.status(201).json({ bot: withState(bot) });
}));

router.get('/bots/:id', loadBot, wrap(async (req, res) => {
  const dir = botDir(req.bot.id);
  res.json({
    bot: withState(req.bot),
    git: await gitApi.status(dir),
    diskUsage: fileApi.directorySize(dir),
    webhookUrl: `${settings.baseUrl(req)}/hooks/${req.bot.id}/${req.bot.webhook_secret}`,
  });
}));

router.patch('/bots/:id', loadBot, requireAdmin, wrap(async (req, res) => {
  const updated = updateBot(req.bot.id, req.body ?? {});
  writeEnvFile(updated);
  logEvent({ botId: updated.id, userId: req.user.id, type: 'bot.update', message: `${updated.name} settings updated` });
  res.json({ bot: withState(updated) });
}));

router.delete('/bots/:id', loadBot, requireAdmin, wrap(async (req, res) => {
  const { id, name } = req.bot;

  await supervisor.stop(id, { userId: req.user.id, force: true });
  logs.clear(id);
  deleteBot(id);

  logEvent({ userId: req.user.id, type: 'bot.delete', message: `${name} deleted` });
  res.json({ ok: true });
}));

router.post('/bots/:id/start', loadBot, wrap(async (req, res) => {
  supervisor.resetFailures(req.bot.id);
  res.json({ state: supervisor.start(req.bot.id, { userId: req.user.id }) });
}));

router.post('/bots/:id/stop', loadBot, wrap(async (req, res) => {
  res.json({ state: await supervisor.stop(req.bot.id, { userId: req.user.id }) });
}));

router.post('/bots/:id/kill', loadBot, wrap(async (req, res) => {
  res.json({ state: await supervisor.stop(req.bot.id, { userId: req.user.id, force: true }) });
}));

router.post('/bots/:id/restart', loadBot, wrap(async (req, res) => {
  supervisor.resetFailures(req.bot.id);
  res.json({ state: await supervisor.restart(req.bot.id, { userId: req.user.id }) });
}));

router.post('/bots/:id/stdin', loadBot, wrap(async (req, res) => {
  const text = String(req.body?.text ?? '');
  if (!text.trim()) throw new HttpError(400, 'Nothing to send');

  supervisor.sendStdin(req.bot.id, text);
  res.json({ ok: true });
}));

router.get('/bots/:id/logs', loadBot, (req, res) => {
  res.json({ lines: logs.tail(req.bot.id, Math.min(Number(req.query.limit) || 500, 5000)) });
});

router.delete('/bots/:id/logs', loadBot, (req, res) => {
  logs.clear(req.bot.id);
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'logs.clear', message: `Console cleared for ${req.bot.name}` });
  res.json({ ok: true });
});

router.get('/bots/:id/logs/download', loadBot, (req, res) => {
  const file = logs.logFilePath(req.bot.id);
  if (!fs.existsSync(file)) throw new HttpError(404, 'No log file yet');
  res.download(file, `${req.bot.slug}.log`);
});

router.get('/bots/:id/env', loadBot, (req, res) => {
  const reveal = req.query.reveal === '1' && req.user.role === 'admin';

  res.json({
    env: getEnvRows(req.bot.id).map((row) => ({
      key: row.key,
      value: row.is_secret && !reveal ? null : row.value,
      isSecret: Boolean(row.is_secret),
      masked: Boolean(row.is_secret) && !reveal,
    })),
  });
});

router.put('/bots/:id/env', loadBot, requireAdmin, wrap(async (req, res) => {
  const incoming = Array.isArray(req.body?.env) ? req.body.env : [];
  const existing = new Map(getEnvRows(req.bot.id).map((row) => [row.key, row]));

  // A null value means unchanged: the client never received the secret, so it
  // cannot send it back.
  const resolved = incoming.map((pair) => ({
    key: pair.key,
    value: pair.value ?? existing.get(pair.key)?.value ?? '',
    isSecret: pair.isSecret ?? existing.get(pair.key)?.is_secret ?? looksSecret(pair.key ?? ''),
  }));

  setEnv(req.bot.id, resolved);
  writeEnvFile(getBot(req.bot.id));

  logEvent({
    botId: req.bot.id,
    userId: req.user.id,
    type: 'env.update',
    message: `Environment updated for ${req.bot.name} (${resolved.length} variables)`,
  });
  res.json({ ok: true, count: resolved.length });
}));

router.get('/bots/:id/metrics', loadBot, (req, res) => {
  const since = Date.now() - (Number(req.query.hours) || 6) * 3_600_000;
  res.json({
    live: recentHistory(req.bot.id),
    stored: query('SELECT ts, cpu, mem FROM metrics WHERE bot_id = ? AND ts > ? ORDER BY ts ASC', req.bot.id, since),
  });
});

router.get('/bots/:id/git', loadBot, wrap(async (req, res) => {
  const dir = botDir(req.bot.id);
  res.json({ status: await gitApi.status(dir), commits: await gitApi.history(dir, 15) });
}));

router.get('/bots/:id/git/branches', loadBot, wrap(async (req, res) => {
  res.json({
    branches: await gitApi.branches({
      dir: botDir(req.bot.id),
      url: req.bot.git_url,
      token: req.bot.git_token,
    }),
  });
}));

router.post('/bots/:id/git/checkout', loadBot, requireAdmin, wrap(async (req, res) => {
  const ref = String(req.body?.ref ?? '').trim();
  if (!ref) throw new HttpError(400, 'A branch or commit is required');

  await gitApi.checkout({
    dir: botDir(req.bot.id),
    ref,
    token: req.bot.git_token,
    url: req.bot.git_url,
  });

  updateBot(req.bot.id, { gitBranch: ref });
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'git.checkout', message: `${req.bot.name} switched to ${ref}` });
  res.json({ ok: true, status: await gitApi.status(botDir(req.bot.id)) });
}));

router.post('/bots/:id/deploy', loadBot, wrap(async (req, res) => {
  // Output streams over the websocket; the request returns once it has started.
  deploy.runDeploy(req.bot.id, {
    userId: req.user.id,
    trigger: 'manual',
    force: Boolean(req.body?.force),
    skipInstall: Boolean(req.body?.skipInstall),
    restart: req.body?.restart !== false,
  }).catch(() => {});

  res.status(202).json({ ok: true });
}));

router.get('/bots/:id/deploys', loadBot, (req, res) => {
  res.json({ deploys: deploy.listDeploys(req.bot.id, Math.min(Number(req.query.limit) || 20, 100)) });
});

router.get('/bots/:id/deploys/:deployId', loadBot, (req, res) => {
  const record = deploy.getDeploy(req.params.deployId);
  if (!record || record.bot_id !== req.bot.id) throw new HttpError(404, 'Deploy not found');
  res.json({ deploy: record });
});

router.post('/bots/:id/webhook/rotate', loadBot, requireAdmin, (req, res) => {
  const secret = rotateWebhookSecret(req.bot.id);
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'webhook.rotate', message: `Webhook URL rotated for ${req.bot.name}` });
  res.json({ webhookUrl: `${settings.baseUrl(req)}/hooks/${req.bot.id}/${secret}` });
});

router.get('/bots/:id/files', loadBot, wrap(async (req, res) => {
  res.json(fileApi.list(req.bot.id, String(req.query.path ?? '')));
}));

router.get('/bots/:id/files/read', loadBot, wrap(async (req, res) => {
  res.json(fileApi.readFile(req.bot.id, String(req.query.path ?? '')));
}));

router.put('/bots/:id/files/write', loadBot, requireAdmin, wrap(async (req, res) => {
  const target = String(req.body?.path ?? '');
  if (!target) throw new HttpError(400, 'A path is required');

  const result = fileApi.writeFile(req.bot.id, target, req.body?.content);
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'file.write', message: `Edited ${target}` });
  res.json(result);
}));

router.post('/bots/:id/files/create', loadBot, requireAdmin, wrap(async (req, res) => {
  res.status(201).json(fileApi.createEntry(
    req.bot.id,
    String(req.body?.path ?? ''),
    req.body?.type === 'dir' ? 'dir' : 'file',
  ));
}));

router.post('/bots/:id/files/rename', loadBot, requireAdmin, wrap(async (req, res) => {
  fileApi.rename(req.bot.id, String(req.body?.from ?? ''), String(req.body?.to ?? ''));
  res.json({ ok: true });
}));

router.delete('/bots/:id/files', loadBot, requireAdmin, wrap(async (req, res) => {
  const target = String(req.query.path ?? '');
  fileApi.remove(req.bot.id, target);
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'file.delete', message: `Deleted ${target}` });
  res.json({ ok: true });
}));

router.get('/bots/:id/files/download', loadBot, wrap(async (req, res) => {
  const target = fileApi.downloadPath(req.bot.id, String(req.query.path ?? ''));
  res.download(target, path.basename(target));
}));

router.get('/bots/:id/backups', loadBot, (req, res) => {
  res.json({ backups: fileApi.listBackups(req.bot.id) });
});

router.post('/bots/:id/backups', loadBot, wrap(async (req, res) => {
  const backup = await fileApi.createBackup(req.bot.id, req.bot.name);
  logEvent({ botId: req.bot.id, userId: req.user.id, type: 'backup.create', message: `Backup created for ${req.bot.name}` });
  res.status(201).json({ backup });
}));

router.get('/bots/:id/backups/:name', loadBot, wrap(async (req, res) => {
  res.download(fileApi.backupPath(req.bot.id, req.params.name), `${req.bot.slug}-${req.params.name}`);
}));

router.delete('/bots/:id/backups/:name', loadBot, requireAdmin, wrap(async (req, res) => {
  fileApi.deleteBackup(req.bot.id, req.params.name);
  res.json({ ok: true });
}));

/** Unauthenticated: mounted separately in server.js. */
export const webhookRouter = express.Router();

webhookRouter.post('/:botId/:secret', wrap(async (req, res) => {
  const bot = get('SELECT * FROM bots WHERE id = ?', req.params.botId);

  // Identical response either way, so the endpoint cannot be probed for ids.
  if (!bot || !secretMatches(req.params.secret, bot.webhook_secret)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const ref = req.body?.ref;
  if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
    const branch = ref.slice('refs/heads/'.length);
    if (branch !== bot.git_branch) {
      return res.json({ ok: true, skipped: `push was to ${branch}, this bot tracks ${bot.git_branch}` });
    }
  }

  if (deploy.isDeploying(bot.id)) return res.status(409).json({ error: 'A deploy is already running' });

  logEvent({ botId: bot.id, type: 'webhook.received', message: 'Auto-deploy triggered by webhook' });
  deploy.runDeploy(bot.id, { trigger: 'webhook' }).catch((err) => console.error('[webhook deploy]', err.message));

  res.status(202).json({ ok: true, deploying: bot.name });
}));
