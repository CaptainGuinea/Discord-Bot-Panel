import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { get, query, run, logEvent } from './db.js';
import { HttpError, newId, newToken, timingSafeEqual } from './util.js';

export const COOKIE_NAME = 'bp_session';

/**
 * Two roles, because a shared instance usually needs someone who can keep bots
 * running without also being able to reconfigure or delete them.
 *
 *   admin     everything, including users and instance settings
 *   operator  start/stop/restart/deploy, read logs, files and metrics
 */
export const ROLES = ['admin', 'operator'];

const SESSION_MS = () => config.sessionDays * 86_400_000;

export const userCount = () => get('SELECT COUNT(*) AS n FROM users').n;
export const needsSetup = () => userCount() === 0;

export const publicUser = (user) => (user ? {
  id: user.id,
  username: user.username,
  email: user.email,
  role: user.role,
  createdAt: user.created_at,
  lastLoginAt: user.last_login_at ?? null,
} : null);

export async function createUser({ username, email, password, role = 'admin' }) {
  const name = String(username ?? '').trim();

  if (name.length < 3) throw new HttpError(400, 'Username must be at least 3 characters');
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new HttpError(400, 'Username may only contain letters, numbers, dots, dashes and underscores');
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
  if (get('SELECT id FROM users WHERE lower(username) = lower(?)', name)) throw new HttpError(409, 'That username is taken');

  const id = newId();
  run(
    'INSERT INTO users (id, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, name, email?.trim() || null, await bcrypt.hash(password, 12), role, Date.now(),
  );
  return get('SELECT * FROM users WHERE id = ?', id);
}

export const listUsers = () =>
  query('SELECT * FROM users ORDER BY created_at ASC').map(publicUser);

export function updateUser(id, patch) {
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new HttpError(404, 'User not found');

  if (patch.role && patch.role !== user.role) {
    if (!ROLES.includes(patch.role)) throw new HttpError(400, 'Unknown role');
    // Locking every admin out of an instance is unrecoverable without shell access.
    if (user.role === 'admin' && patch.role !== 'admin' && adminCount() <= 1) {
      throw new HttpError(400, 'This is the only admin — promote someone else first');
    }
    run('UPDATE users SET role = ? WHERE id = ?', patch.role, id);
  }

  if (patch.email !== undefined) {
    run('UPDATE users SET email = ? WHERE id = ?', String(patch.email).trim() || null, id);
  }

  return publicUser(get('SELECT * FROM users WHERE id = ?', id));
}

export function deleteUser(id) {
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role === 'admin' && adminCount() <= 1) throw new HttpError(400, 'Cannot delete the only admin');

  run('DELETE FROM users WHERE id = ?', id);
  return user;
}

export async function setPassword(id, password) {
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(password, 12), id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
}

const adminCount = () => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;

// Per-IP login throttling. In memory: it resets on restart, which is acceptable
// for a single-instance app and keeps the dependency count at zero.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function checkThrottle(ip) {
  const record = attempts.get(ip);
  if (!record) return;

  if (Date.now() - record.first > WINDOW_MS) {
    attempts.delete(ip);
    return;
  }
  if (record.count >= MAX_ATTEMPTS) {
    const minutes = Math.ceil((WINDOW_MS - (Date.now() - record.first)) / 60_000);
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute(s).`);
  }
}

function recordFailure(ip) {
  const record = attempts.get(ip);
  if (!record || Date.now() - record.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else record.count += 1;
}

export async function login({ username, password, ip, userAgent }) {
  checkThrottle(ip);

  const user = get('SELECT * FROM users WHERE lower(username) = lower(?)', String(username ?? ''));

  // Always compare against something so a missing user and a wrong password
  // take the same amount of time.
  const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password ?? ''), hash);

  if (!user || !ok) {
    recordFailure(ip);
    throw new HttpError(401, 'Incorrect username or password');
  }

  attempts.delete(ip);

  const token = newToken();
  const timestamp = Date.now();
  run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    token, user.id, timestamp, timestamp + SESSION_MS(), ip ?? null, userAgent ?? null,
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', timestamp, user.id);
  logEvent({ userId: user.id, type: 'auth.login', message: `${user.username} signed in from ${ip}` });

  return { token, user: publicUser(user) };
}

export function resolveSession(token) {
  if (!token) return null;

  const row = get(
    'SELECT s.token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    token,
  );
  if (!row) return null;

  if (row.expires_at < Date.now()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return row;
}

export const destroySession = (token) => {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
};

export async function changePassword(userId, currentPassword, newPassword) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'User not found');

  if (!await bcrypt.compare(String(currentPassword ?? ''), user.password_hash)) {
    throw new HttpError(403, 'Current password is incorrect');
  }

  await setPassword(userId, newPassword);
  logEvent({ userId, type: 'auth.password', message: `${user.username} changed their password` });
}

export const listSessions = (userId) =>
  query('SELECT token, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC', userId);

export function requireAuth(req, res, next) {
  const session = resolveSession(req.cookies?.[COOKIE_NAME]);
  if (!session) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = publicUser(session);
  req.sessionToken = session.token;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'This action requires an administrator account' });
    return;
  }
  next();
}

export const cookieOptions = (maxAgeMs = SESSION_MS()) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.secureCookies,
  maxAge: maxAgeMs,
  path: '/',
});

export const secretMatches = (provided, expected) =>
  Boolean(expected) && timingSafeEqual(provided ?? '', expected);
