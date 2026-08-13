import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config, DATA_DIR, IS_WINDOWS } from './config.js';
import { listBots } from './bots.js';
import { run } from './db.js';
import { publish } from './hub.js';
import { snapshot, updateResourceSample } from './supervisor.js';

/**
 * Resource sampling.
 *
 * On Linux this reads /proc directly, then walks each bot's process tree,
 * because a bot's real cost is usually its children (npm wrapping node, python
 * spawning ffmpeg) rather than the shell the panel started.
 */

const CLOCK_TICKS = 100; // USER_HZ, 100 on mainstream Linux builds

const history = new Map();
const previousCpu = new Map();
let previousHostCpu = null;
let lastPersistedAt = 0;

function readLinuxProcesses() {
  const table = new Map();

  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return table;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;

    let raw;
    try {
      raw = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue; // Exited between readdir and read.
    }

    // The comm field can contain spaces and parentheses, so parse after the last ')'.
    const close = raw.lastIndexOf(')');
    if (close === -1) continue;

    const fields = raw.slice(close + 2).split(' ');
    table.set(Number(entry), {
      ppid: Number(fields[1]),
      jiffies: Number(fields[11]) + Number(fields[12]),
      rss: Number(fields[21]) * 4096,
    });
  }
  return table;
}

function windowsProcesses() {
  return new Promise((resolve) => {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const table = new Map();
        if (err || !stdout) return resolve(table);

        try {
          const rows = JSON.parse(stdout);
          for (const row of Array.isArray(rows) ? rows : [rows]) {
            table.set(Number(row.ProcessId), {
              ppid: Number(row.ParentProcessId),
              // 100 ns units, scaled to match Linux jiffies.
              jiffies: (Number(row.UserModeTime) + Number(row.KernelModeTime)) / 100_000,
              rss: Number(row.WorkingSetSize),
            });
          }
        } catch {
          // Report nothing this tick.
        }
        resolve(table);
      },
    );
  });
}

function processTree(table, rootPid) {
  const childrenOf = new Map();
  for (const [pid, info] of table) {
    if (!childrenOf.has(info.ppid)) childrenOf.set(info.ppid, []);
    childrenOf.get(info.ppid).push(pid);
  }

  const collected = [];
  const seen = new Set();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);

    if (table.has(pid)) collected.push(pid);
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return collected;
}

function hostCpuPercent() {
  let idle = 0;
  let total = 0;

  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    for (const value of Object.values(cpu.times)) total += value;
  }

  const previous = previousHostCpu;
  previousHostCpu = { idle, total };
  if (!previous) return 0;

  const totalDelta = total - previous.total;
  if (totalDelta <= 0) return 0;

  return Math.max(0, Math.min(100, (1 - (idle - previous.idle) / totalDelta) * 100));
}

async function diskUsage() {
  try {
    const stats = await fs.promises.statfs(DATA_DIR);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

export async function hostStats() {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    cores: os.cpus().length,
    cpu: hostCpuPercent(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    memUsed: os.totalmem() - os.freemem(),
    uptime: os.uptime(),
    panelUptime: process.uptime(),
    panelMem: process.memoryUsage().rss,
    disk: await diskUsage(),
  };
}

async function tick() {
  const bots = listBots();
  const table = IS_WINDOWS ? await windowsProcesses() : readLinuxProcesses();
  const now = Date.now();
  const perBot = {};

  for (const bot of bots) {
    const current = snapshot(bot.id);

    if (!current.pid || !table.has(current.pid)) {
      updateResourceSample(bot.id, 0, 0);
      previousCpu.delete(bot.id);
      perBot[bot.id] = { cpu: 0, mem: 0 };
      continue;
    }

    let jiffies = 0;
    let rss = 0;
    for (const pid of processTree(table, current.pid)) {
      jiffies += table.get(pid).jiffies;
      rss += table.get(pid).rss;
    }

    const previous = previousCpu.get(bot.id);
    previousCpu.set(bot.id, { jiffies, ts: now });

    let cpu = 0;
    if (previous) {
      const elapsedSeconds = (now - previous.ts) / 1000;
      if (elapsedSeconds > 0) {
        // Percent of a single core, the figure top reports.
        cpu = Math.max(0, Math.round(((jiffies - previous.jiffies) / (CLOCK_TICKS * elapsedSeconds)) * 1000) / 10);
      }
    }

    updateResourceSample(bot.id, cpu, rss);
    perBot[bot.id] = { cpu, mem: rss };

    const series = history.get(bot.id) ?? [];
    series.push({ ts: now, cpu, mem: rss });
    if (series.length > config.metricsHistory) series.shift();
    history.set(bot.id, series);
  }

  publish('stats', 'sample', { ts: now, host: await hostStats(), bots: perBot });

  // Persist a downsampled point per minute for the longer-range charts.
  if (now - lastPersistedAt > 60_000) {
    lastPersistedAt = now;

    for (const [botId, sample] of Object.entries(perBot)) {
      if (sample.mem === 0 && sample.cpu === 0) continue;
      try {
        run('INSERT INTO metrics (bot_id, ts, cpu, mem) VALUES (?, ?, ?, ?)', botId, now, sample.cpu, Math.round(sample.mem));
      } catch {
        // Bot deleted mid-tick.
      }
    }
  }
}

export const recentHistory = (botId) => history.get(botId) ?? [];

let timer = null;

export function startSampling() {
  if (timer) return;

  const loop = () => tick().catch((err) => console.error('[metrics]', err.message));
  loop();
  timer = setInterval(loop, config.metricsIntervalMs);
  timer.unref?.();
}

export function stopSampling() {
  clearInterval(timer);
  timer = null;
}
