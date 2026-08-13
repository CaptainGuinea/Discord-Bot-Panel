import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR, config } from './config.js';
import { publish } from './hub.js';
import { stripAnsi } from './util.js';

/**
 * Each bot gets an in-memory ring buffer for instant console backfill plus a
 * rotating file on disk so history survives a panel restart.
 */

const rings = new Map();
const writers = new Map();
const partials = new Map();

const logPath = (botId) => path.join(LOGS_DIR, `${botId}.log`);

function ring(botId) {
  let entry = rings.get(botId);
  if (!entry) {
    entry = { lines: [], seq: 0 };
    rings.set(botId, entry);
  }
  return entry;
}

function rotateIfNeeded(botId) {
  try {
    if (fs.statSync(logPath(botId)).size < config.logFileMaxBytes) return;

    fs.renameSync(logPath(botId), `${logPath(botId)}.1`);
    writers.get(botId)?.end();
    writers.delete(botId);
  } catch {
    // No file yet.
  }
}

function writer(botId) {
  const existing = writers.get(botId);
  if (existing) return existing;

  rotateIfNeeded(botId);
  const stream = fs.createWriteStream(logPath(botId), { flags: 'a' });
  stream.on('error', (err) => console.error(`[logs] ${botId}:`, err.message));
  writers.set(botId, stream);
  return stream;
}

export function append(botId, text, stream = 'stdout') {
  const entry = ring(botId);
  const line = { seq: ++entry.seq, ts: Date.now(), stream, text: String(text) };

  entry.lines.push(line);
  if (entry.lines.length > config.logRingSize) {
    entry.lines.splice(0, entry.lines.length - config.logRingSize);
  }

  writer(botId).write(`[${new Date(line.ts).toISOString()}] [${stream}] ${stripAnsi(line.text)}\n`);
  publish(`logs:${botId}`, 'line', line);
  return line;
}

/** Panel-generated notices, rendered differently from bot output. */
export const system = (botId, text) => append(botId, text, 'system');

/** Splits a raw chunk on newlines, holding back a trailing partial line. */
export function ingest(botId, chunk, stream) {
  const buffered = (partials.get(botId) ?? '') + chunk.toString('utf8');
  const parts = buffered.split(/\r?\n/);
  partials.set(botId, parts.pop() ?? '');

  for (const part of parts) append(botId, part, stream);

  const leftover = partials.get(botId);
  if (leftover && leftover.length > 8192) {
    append(botId, leftover, stream);
    partials.set(botId, '');
  }
}

export function flush(botId) {
  const leftover = partials.get(botId);
  if (leftover) {
    append(botId, leftover, 'stdout');
    partials.set(botId, '');
  }
}

function readFromDisk(botId, limit) {
  try {
    return fs.readFileSync(logPath(botId), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line, index) => {
        const match = line.match(/^\[([^\]]+)\] \[([^\]]+)\] ([\s\S]*)$/);
        return {
          seq: index + 1,
          ts: match ? Date.parse(match[1]) : Date.now(),
          stream: match ? match[2] : 'stdout',
          text: match ? match[3] : line,
        };
      });
  } catch {
    return [];
  }
}

export function tail(botId, limit = 500) {
  const entry = rings.get(botId);
  if (entry && entry.lines.length > 0) return entry.lines.slice(-limit);
  return readFromDisk(botId, limit);
}

export function clear(botId) {
  rings.delete(botId);
  writers.get(botId)?.end();
  writers.delete(botId);

  for (const file of [logPath(botId), `${logPath(botId)}.1`]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
  publish(`logs:${botId}`, 'cleared', {});
}

export const logFilePath = logPath;

export function closeAll() {
  for (const stream of writers.values()) stream.end();
  writers.clear();
}
