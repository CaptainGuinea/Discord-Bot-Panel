import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

/**
 * Git access.
 *
 * Private repos authenticate with a personal access token injected into the
 * remote URL for the duration of a single command. The token is never written
 * to .git/config, and `scrub()` strips it from anything we log or return.
 */

export function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Rewrites an https remote to carry a token. Other schemes pass through. */
export function authUrl(url, token) {
  if (!token || !url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return url;
    parsed.username = 'x-access-token';
    parsed.password = token;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function scrub(text, token) {
  let output = String(text ?? '');
  if (token) output = output.split(token).join('***');
  // Catch any other credential-in-URL forms git may echo back.
  return output.replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***@');
}

/**
 * Runs a git command. `onOutput` receives each line as it arrives, which is
 * what makes the deploy console feel live.
 */
export function git(args, { cwd, token = null, onOutput = null, timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',   // never block waiting for credentials
        GIT_ASKPASS: 'echo',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        stderr += '\ngit command timed out';
      }
    }, timeout);

    const forward = (chunk, sink) => {
      const text = scrub(chunk.toString('utf8'), token);
      if (sink === 'out') stdout += text;
      else stderr += text;
      if (onOutput) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onOutput(line);
        }
      }
    };

    child.stdout.on('data', (chunk) => forward(chunk, 'out'));
    child.stderr.on('data', (chunk) => forward(chunk, 'err'));

    child.on('error', (err) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout: '',
        stderr: err.code === 'ENOENT' ? 'git is not installed on this host' : err.message,
      });
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Same as `git()` but throws on a non-zero exit. */
export async function gitOrThrow(args, options) {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new HttpError(400, result.stderr || result.stdout || `git ${args[0]} failed`);
  }
  return result;
}

/**
 * Populates an empty-ish bot directory from a remote.
 *
 * This is `init` + `fetch` + `checkout` rather than `git clone`, because the
 * directory usually already holds the panel-generated .env — and clone refuses
 * to write into a non-empty directory. The same path also lets you attach a
 * repository to files that were uploaded over SFTP first.
 */
export async function clone({ url, branch, token, dir, onOutput }) {
  fs.mkdirSync(dir, { recursive: true });
  const target = branch || 'main';

  const init = await git(['init', '-q'], { cwd: dir, token, onOutput });
  if (init.code !== 0) throw new HttpError(400, init.stderr || 'git init failed');

  // Store the clean URL so the token never lands in .git/config.
  await git(['remote', 'add', 'origin', url], { cwd: dir, token });

  onOutput?.(`Fetching ${target}…`);
  const fetched = await git(['fetch', '--depth', '50', authUrl(url, token), target], { cwd: dir, token, onOutput });
  if (fetched.code !== 0) {
    throw new HttpError(400, fetched.stderr || `Could not fetch ${target} — check the URL, branch and token`);
  }

  const checkedOut = await git(['checkout', '-B', target, 'FETCH_HEAD'], { cwd: dir, token, onOutput });
  if (checkedOut.code !== 0) {
    throw new HttpError(400, checkedOut.stderr || 'Could not check out the fetched branch');
  }

  // Point the branch at origin so plain `git pull` works inside the directory.
  await git(['branch', `--set-upstream-to=origin/${target}`, target], { cwd: dir, token });

  // The panel writes .env and runtimes create .venv/node_modules; excluding
  // them locally keeps the working tree honestly "clean" instead of always
  // showing changes the user did not make.
  try {
    fs.appendFileSync(
      path.join(dir, '.git', 'info', 'exclude'),
      '\n# Added by BotPanel\n.env\n.venv/\nnode_modules/\n__pycache__/\n',
    );
  } catch {
    // Not fatal — this is cosmetic.
  }

  return checkedOut;
}

/**
 * Fetches the configured branch and fast-forwards onto it. `force` throws away
 * local modifications instead of refusing to move.
 */
export async function sync({ dir, branch, token, url, force = false, onOutput }) {
  const remote = authUrl(url, token);

  const fetched = await git(['fetch', '--depth', '50', remote, branch], { cwd: dir, token, onOutput });
  if (fetched.code !== 0) throw new HttpError(400, fetched.stderr || 'Fetch failed');

  if (force) {
    await gitOrThrow(['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, token, onOutput });
    // Keep the panel-managed .env; drop everything else that is not tracked.
    await git(['clean', '-fd', '-e', '.env', '-e', '.venv', '-e', 'node_modules'], { cwd: dir, token, onOutput });
    return;
  }

  const merged = await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: dir, token, onOutput });
  if (merged.code !== 0) {
    throw new HttpError(
      409,
      'Cannot fast-forward — this checkout has local commits or uncommitted changes. Re-run the deploy with "force sync" to discard them.',
    );
  }
}

export async function head(dir) {
  if (!isRepo(dir)) return null;
  const result = await git(['log', '-1', '--pretty=format:%H%n%h%n%an%n%aI%n%s'], { cwd: dir });
  if (result.code !== 0) return null;
  const [sha, shortSha, author, date, ...subject] = result.stdout.split('\n');
  return { sha, shortSha, author, date, subject: subject.join('\n') };
}

export async function history(dir, limit = 20) {
  if (!isRepo(dir)) return [];
  const separator = String.fromCharCode(31); // ASCII unit separator: never appears in a commit subject
  const result = await git(
    ['log', `-${limit}`, `--pretty=format:%H${separator}%h${separator}%an${separator}%aI${separator}%s`],
    { cwd: dir },
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, date, subject] = line.split(separator);
      return { sha, shortSha, author, date, subject };
    });
}

export async function status(dir) {
  if (!isRepo(dir)) return { repo: false };

  const [branchResult, statusResult, remoteResult] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
    git(['status', '--porcelain'], { cwd: dir }),
    git(['remote', 'get-url', 'origin'], { cwd: dir }),
  ]);

  const dirtyFiles = statusResult.stdout.split('\n').filter(Boolean);
  return {
    repo: true,
    branch: branchResult.stdout || 'unknown',
    dirty: dirtyFiles.length > 0,
    dirtyFiles: dirtyFiles.slice(0, 50),
    remote: scrub(remoteResult.stdout, null),
    head: await head(dir),
  };
}

export async function branches({ dir, url, token }) {
  if (url) {
    const result = await git(['ls-remote', '--heads', authUrl(url, token)], { cwd: dir, token });
    if (result.code === 0) {
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('refs/heads/')[1])
        .filter(Boolean);
    }
  }
  if (!isRepo(dir)) return [];
  const local = await git(['branch', '--format=%(refname:short)'], { cwd: dir });
  return local.stdout.split('\n').filter(Boolean);
}

export async function checkout({ dir, ref, token, url, onOutput }) {
  if (!isRepo(dir)) throw new HttpError(400, 'This bot has no git repository');
  // Make sure the ref exists locally before switching to it.
  await git(['fetch', authUrl(url, token), ref], { cwd: dir, token, onOutput });
  const result = await git(['checkout', ref], { cwd: dir, token, onOutput });
  if (result.code !== 0) {
    const fallback = await git(['checkout', '-B', ref, 'FETCH_HEAD'], { cwd: dir, token, onOutput });
    if (fallback.code !== 0) throw new HttpError(400, fallback.stderr || `Could not check out ${ref}`);
  }
}
