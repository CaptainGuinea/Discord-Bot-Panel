import crypto from 'node:crypto';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps an async route so rejections reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function newId(len = 12) {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const newToken = () => crypto.randomBytes(32).toString('hex');

export function slugify(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'bot';
}

/** SQLite has no boolean type and node:sqlite rejects JS booleans as bindings. */
export const bool = (value) => (value ? 1 : 0);

export const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Joins a user-supplied path onto a base directory, rejecting anything that
 * escapes it. Every file operation goes through this.
 */
export function safeJoin(base, relative = '') {
  const cleaned = String(relative).replace(/^[/\\]+/, '');
  const target = path.resolve(base, cleaned);
  const root = path.resolve(base);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(403, 'Path escapes the bot directory');
  }
  return target;
}

export function timingSafeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
export const stripAnsi = (text) => String(text).replace(ANSI_PATTERN, '');

export function parseEnvText(text) {
  const pairs = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) pairs.push({ key, value });
  }
  return pairs;
}

export const toEnvText = (pairs) =>
  pairs
    .map(({ key, value }) => {
      const text = String(value ?? '');
      const needsQuotes = /[\s#"']/.test(text);
      return `${key}=${needsQuotes ? `"${text.replace(/"/g, '\\"')}"` : text}`;
    })
    .join('\n') + '\n';
