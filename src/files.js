import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BACKUPS_DIR } from './config.js';
import { botDir } from './bots.js';
import { HttpError, safeJoin } from './util.js';

const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/** Extensions the in-browser editor opens with syntax-appropriate hints. */
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.txt', '.md', '.yml', '.yaml',
  '.env', '.toml', '.ini', '.cfg', '.conf', '.sh', '.sql', '.html', '.css', '.xml', '.lua',
  '.gitignore', '.example', '.lock', '.log', '.properties',
]);

const isProbablyText = (name) =>
  TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
  !path.extname(name) ||
  name.startsWith('.');

export function list(botId, relativePath = '') {
  const root = botDir(botId);
  const target = safeJoin(root, relativePath);

  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    throw new HttpError(404, 'That folder does not exist');
  }
  if (!stats.isDirectory()) throw new HttpError(400, 'Not a directory');

  const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => {
    const full = path.join(target, entry.name);
    let size = 0;
    let mtime = 0;
    try {
      const entryStats = fs.statSync(full);
      size = entryStats.size;
      mtime = entryStats.mtimeMs;
    } catch {
      // Broken symlink or a file that vanished mid-listing.
    }
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size,
      mtime,
      editable: entry.isFile() && size <= MAX_EDITABLE_BYTES && isProbablyText(entry.name),
    };
  });

  // Folders first, then alphabetical — the ordering people expect.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    path: relativePath.replace(/^[/\\]+/, ''),
    parent: relativePath ? path.dirname(relativePath).replace(/^\.$/, '') : null,
    entries,
  };
}

export function readFile(botId, relativePath) {
  const target = safeJoin(botDir(botId), relativePath);
  const stats = fs.statSync(target);
  if (stats.isDirectory()) throw new HttpError(400, 'That is a directory');
  if (stats.size > MAX_EDITABLE_BYTES) {
    throw new HttpError(413, `File is too large to edit here (${Math.round(stats.size / 1024)} KB)`);
  }

  const buffer = fs.readFileSync(target);
  // A NUL byte in the first chunk is the classic binary tell.
  if (buffer.subarray(0, 8000).includes(0)) throw new HttpError(415, 'This looks like a binary file');

  return { path: relativePath, size: stats.size, mtime: stats.mtimeMs, content: buffer.toString('utf8') };
}

export function writeFile(botId, relativePath, content) {
  const target = safeJoin(botDir(botId), relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content ?? ''), 'utf8');
  const stats = fs.statSync(target);
  return { path: relativePath, size: stats.size, mtime: stats.mtimeMs };
}

export function createEntry(botId, relativePath, type) {
  const target = safeJoin(botDir(botId), relativePath);
  if (fs.existsSync(target)) throw new HttpError(409, 'Something with that name already exists');

  if (type === 'dir') {
    fs.mkdirSync(target, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
  }
  return { path: relativePath, type };
}

export function remove(botId, relativePath) {
  if (!relativePath || relativePath === '/' || relativePath === '.') {
    throw new HttpError(400, 'Refusing to delete the bot root');
  }
  const target = safeJoin(botDir(botId), relativePath);
  fs.rmSync(target, { recursive: true, force: true });
}

export function rename(botId, fromPath, toPath) {
  const root = botDir(botId);
  const source = safeJoin(root, fromPath);
  const destination = safeJoin(root, toPath);
  if (fs.existsSync(destination)) throw new HttpError(409, 'The destination already exists');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

export function downloadPath(botId, relativePath) {
  const target = safeJoin(botDir(botId), relativePath);
  const stats = fs.statSync(target);
  if (stats.isDirectory()) throw new HttpError(400, 'Cannot download a directory');
  return target;
}

/** Backups archive the bot directory, minus everything reinstallable. */
const backupDir = (botId) => {
  const dir = path.join(BACKUPS_DIR, botId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export function createBackup(botId, botName) {
  return new Promise((resolve, reject) => {
    const source = botDir(botId);
    if (!fs.existsSync(source)) return reject(new HttpError(404, 'This bot has no files yet'));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${stamp}.tar.gz`;
    const outputDir = backupDir(botId);
    const destination = path.join(outputDir, fileName);

    const args = [
      '-czf', fileName,
      '--exclude', 'node_modules',
      '--exclude', '.venv',
      '--exclude', '__pycache__',
      '--exclude', '.git',
      '-C', source, '.',
    ];

    // Run from the backup directory and keep -f relative: an absolute Windows
    // path like C:\… looks like a remote host spec to GNU tar.
    execFile('tar', args, { cwd: outputDir, timeout: 10 * 60 * 1000 }, (err) => {
      if (err) {
        return reject(new HttpError(500, `Backup failed: ${err.message}`));
      }
      const stats = fs.statSync(destination);
      resolve({ name: fileName, size: stats.size, createdAt: stats.mtimeMs, botName });
    });
  });
}

export function listBackups(botId) {
  const dir = backupDir(botId);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.tar.gz'))
    .map((name) => {
      const stats = fs.statSync(path.join(dir, name));
      return { name, size: stats.size, createdAt: stats.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function backupPath(botId, name) {
  if (!/^[\w.-]+\.tar\.gz$/.test(name)) throw new HttpError(400, 'Invalid backup name');
  const target = path.join(backupDir(botId), name);
  if (!fs.existsSync(target)) throw new HttpError(404, 'Backup not found');
  return target;
}

export function deleteBackup(botId, name) {
  fs.rmSync(backupPath(botId, name), { force: true });
}

/** Recursive directory size, skipping the folders backups already exclude. */
export function directorySize(dir) {
  const skip = new Set(['node_modules', '.venv', '.git', '__pycache__']);
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Vanished mid-walk.
        }
      }
    }
  };
  walk(dir);
  return total;
}
