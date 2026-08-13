import { config } from './config.js';
import { get, query, run } from './db.js';
import { HttpError } from './util.js';

/**
 * Instance settings are stored in the database rather than the environment so
 * an operator can rebrand and reconfigure a running deployment from the UI,
 * the way Jellyfin and Immich do, without editing files and restarting.
 */

const ACCENTS = ['indigo', 'violet', 'sky', 'emerald', 'amber', 'rose', 'cyan', 'lime'];

const DEFINITIONS = {
  instanceName: {
    type: 'string',
    default: () => config.defaultInstanceName,
    max: 40,
  },
  instanceAccent: {
    type: 'enum',
    values: ACCENTS,
    default: () => 'indigo',
  },
  publicUrl: {
    type: 'string',
    default: () => config.publicUrl,
    max: 200,
  },
  allowRegistration: {
    type: 'boolean',
    default: () => false,
  },
  defaultRestartPolicy: {
    type: 'enum',
    values: ['always', 'on-failure', 'never'],
    default: () => 'on-failure',
  },
  logRetentionDays: {
    type: 'number',
    min: 1,
    max: 365,
    default: () => 14,
  },
};

function parse(name, raw) {
  const definition = DEFINITIONS[name];
  if (raw === undefined || raw === null) return definition.default();

  switch (definition.type) {
    case 'boolean':
      return raw === '1' || raw === 'true';
    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : definition.default();
    }
    case 'enum':
      return definition.values.includes(raw) ? raw : definition.default();
    default:
      return String(raw);
  }
}

function serialise(name, value) {
  const definition = DEFINITIONS[name];
  if (!definition) throw new HttpError(400, `Unknown setting "${name}"`);

  switch (definition.type) {
    case 'boolean':
      return value ? '1' : '0';
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new HttpError(400, `"${name}" must be a number`);
      return String(Math.min(Math.max(number, definition.min), definition.max));
    }
    case 'enum':
      if (!definition.values.includes(value)) {
        throw new HttpError(400, `"${name}" must be one of: ${definition.values.join(', ')}`);
      }
      return value;
    default: {
      const text = String(value ?? '').trim();
      if (definition.max && text.length > definition.max) {
        throw new HttpError(400, `"${name}" is too long (max ${definition.max} characters)`);
      }
      return text;
    }
  }
}

export function all() {
  const stored = Object.fromEntries(query('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
  const result = {};
  for (const name of Object.keys(DEFINITIONS)) result[name] = parse(name, stored[name]);
  return result;
}

export const value = (name) => parse(name, get('SELECT value FROM settings WHERE key = ?', name)?.value);

export function update(patch) {
  for (const [name, raw] of Object.entries(patch)) {
    if (!(name in DEFINITIONS)) continue;
    run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      name, serialise(name, raw),
    );
  }
  return all();
}

/**
 * Branding needed before sign-in. Deliberately excludes anything that would
 * tell an anonymous visitor about the deployment beyond how to render the page.
 */
export function branding() {
  const settings = all();
  return {
    instanceName: settings.instanceName,
    instanceAccent: settings.instanceAccent,
    allowRegistration: settings.allowRegistration,
    version: config.version,
  };
}

/**
 * Absolute base URL for links handed to third parties, such as webhook targets.
 * Falls back to the request's own origin when no public URL is configured.
 */
export function baseUrl(req) {
  const configured = value('publicUrl');
  if (configured) return configured.replace(/\/+$/, '');

  const proto = config.trustProxy ? (req.headers['x-forwarded-proto']?.split(',')[0] ?? req.protocol) : req.protocol;
  const host = config.trustProxy ? (req.headers['x-forwarded-host'] ?? req.get('host')) : req.get('host');
  return `${proto}://${host}`;
}

export { ACCENTS };
