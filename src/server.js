import './preflight.js';

import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { COOKIE_NAME, publicUser, resolveSession } from './auth.js';
import { PUBLIC_DIR, config } from './config.js';
import { pruneOldRows } from './db.js';
import { addClient, subscribe, unsubscribe } from './hub.js';
import * as logstore from './logstore.js';
import { startSampling, stopSampling } from './metrics.js';
import { router, webhookRouter } from './routes.js';
import { allSnapshots, startAutostartBots, stopAll } from './supervisor.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;

  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;

      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      try {
        req.cookies[key] = decodeURIComponent(value);
      } catch {
        req.cookies[key] = value;
      }
    }
  }
  next();
});

app.use((req, _res, next) => {
  req.clientIp = config.trustProxy
    ? (req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress)
    : req.socket.remoteAddress;
  next();
});

/**
 * The panel has no third-party API consumers, so refusing cross-origin writes
 * outright is both simpler and stricter than issuing CSRF tokens.
 */
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/hooks/')) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-origin request refused' });
    }
  } catch {
    return res.status(403).json({ error: 'Bad origin header' });
  }
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use('/api', router);
app.use('/hooks', webhookRouter);

/**
 * Assets are served under a version-stamped prefix, which is what makes an
 * upgrade take effect immediately without a build step. ES module imports are
 * cached per URL and resolve relative to the importing module, so serving
 * `/assets/<version>/js/app.js` also moves every module it imports to a fresh
 * URL. That lets these responses be cached indefinitely and still never go
 * stale, while index.html — which carries the current version — is always
 * revalidated.
 */
const ASSET_BASE = `/assets/${config.version}`;

app.use(`${ASSET_BASE}`, express.static(PUBLIC_DIR, {
  index: false,
  immutable: true,
  maxAge: '1y',
}));

const indexHtml = () =>
  fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replaceAll('__ASSET_BASE__', ASSET_BASE);

// Read once in production; re-read every request in development so editing the
// shell does not need a restart.
const cachedIndex = process.env.NODE_ENV === 'production' ? indexHtml() : null;

function sendIndex(_req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(cachedIndex ?? indexHtml());
}

// Anything else in public/ (favicons, images added later) stays available at
// its plain path.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/hooks/')) return next();
  sendIndex(req, res);
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(status).json({ error: err.message ?? 'Something went wrong', details: err.details });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  const match = (req.headers.cookie ?? '').match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  const session = match ? resolveSession(decodeURIComponent(match[1])) : null;

  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, publicUser(session)));
});

wss.on('connection', (ws, _req, user) => {
  const client = addClient(ws, user);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    channel: 'bots',
    type: 'hello',
    data: { user, states: allSnapshots() },
    ts: Date.now(),
  }));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const channels = Array.isArray(message.channels) ? message.channels : [];
    if (message.action === 'subscribe') subscribe(client, channels);
    else if (message.action === 'unsubscribe') unsubscribe(client, channels);
    else if (message.action === 'ping') ws.send(JSON.stringify({ channel: 'system', type: 'pong', ts: Date.now() }));
  });
});

// Drop sockets that stopped answering: sleeping laptops, discarded tabs.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

const housekeeping = setInterval(pruneOldRows, 6 * 60 * 60 * 1000);
housekeeping.unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Stop the other process, or set PORT.\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  Not allowed to bind port ${config.port}. Ports below 1024 require root.\n`);
  } else {
    console.error('[panel] server error:', err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, async () => {
  console.log(`\n  BotPanel ${config.version}`);
  console.log(`  Listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`);

  pruneOldRows();
  startSampling();
  await startAutostartBots();
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[panel] ${signal} received, shutting down`);
  clearInterval(heartbeat);
  clearInterval(housekeeping);
  stopSampling();

  for (const ws of wss.clients) ws.close(1001, 'Panel restarting');
  server.close();

  await stopAll();
  logstore.closeAll();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[unhandled rejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaught exception]', err));
