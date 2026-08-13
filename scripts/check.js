#!/usr/bin/env node
/**
 * Syntax-checks every source file and confirms the backend modules import
 * cleanly. Run by CI and by `npm run check`.
 */

import { execFile } from 'node:child_process';
import { readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const red = (text) => `\x1b[31m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;

async function jsFilesIn(dir) {
  const entries = await readdir(path.join(root, dir));
  return entries.filter((name) => name.endsWith('.js')).map((name) => path.join(dir, name));
}

const failures = [];

const files = [
  ...await jsFilesIn('src'),
  ...await jsFilesIn('public/js'),
  ...await jsFilesIn('scripts'),
];

for (const file of files) {
  try {
    await run(process.execPath, ['--check', path.join(root, file)]);
    console.log(`${green('ok')}   ${file}`);
  } catch (err) {
    failures.push(file);
    console.error(`${red('fail')} ${file}\n${err.stderr ?? err.message}`);
  }
}

// Import the backend into a scratch data directory so the check never touches a
// real installation.
const scratch = await mkdtemp(path.join(tmpdir(), 'botpanel-check-'));
const modules = ['config', 'util', 'db', 'settings', 'auth', 'bots', 'hub',
  'logstore', 'supervisor', 'metrics', 'git', 'deploy', 'files', 'routes'];

try {
  await run(
    process.execPath,
    ['-e', `Promise.all(${JSON.stringify(modules)}.map((m) => import('./src/' + m + '.js'))).then(() => process.exit(0))`],
    { cwd: root, env: { ...process.env, DATA_DIR: scratch } },
  );
  console.log(`${green('ok')}   all backend modules import cleanly`);
} catch (err) {
  failures.push('module imports');
  console.error(`${red('fail')} module imports\n${err.stderr ?? err.message}`);
}

if (failures.length > 0) {
  console.error(`\n${red(`${failures.length} check(s) failed`)}`);
  process.exit(1);
}

console.log(`\n${green(`All ${files.length + 1} checks passed`)}`);
