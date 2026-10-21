/**
 * Helpers shared by the load scripts.
 *
 * The harness has no dependencies of its own. It borrows mongoose and
 * mongodb-memory-server from Backend/node_modules, so `npm --prefix Backend ci`
 * is the only install step.
 */
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

export const LOAD_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(LOAD_DIR, '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'Backend');

export const backendRequire = createRequire(
  path.join(BACKEND_DIR, 'package.json')
);

const execFileP = promisify(execFile);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nearest-rank percentiles. */
export function summarize(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** Prometheus text exposition -> [{ name, labels, value }]. */
export function parseProm(text) {
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    for (const [, k, v] of (m[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
      labels[k] = v;
    }
    samples.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return samples;
}

export const metricSum = (samples, name, where = () => true) =>
  samples
    .filter((s) => s.name === name && where(s.labels))
    .reduce((a, s) => a + s.value, 0);

/** CPU seconds and resident memory of another process, or null. */
export async function processStats(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('powershell.exe', [
        '-NoProfile',
        '-Command',
        `$p = Get-Process -Id ${pid}; "$([long]$p.TotalProcessorTime.TotalMilliseconds) $($p.WorkingSet64)"`,
      ]);
      const [cpuMs, rss] = stdout.trim().split(/\s+/).map(Number);
      return { cpuSeconds: cpuMs / 1000, rssBytes: rss };
    }
    if (process.platform === 'linux') {
      // Fields 14/15 of /proc/<pid>/stat are utime/stime in clock ticks (100/s
      // on every mainstream kernel config).
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rssKb = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
      return { cpuSeconds: ticks / 100, rssBytes: rssKb * 1024 };
    }
    const { stdout } = await execFileP('ps', [
      '-o',
      'time=,rss=',
      '-p',
      String(pid),
    ]);
    const [time, rssKb] = stdout.trim().split(/\s+/);
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
    const seconds = clock
      .split(':')
      .reverse()
      .reduce((acc, part, i) => acc + Number(part) * 60 ** i, 0);
    return {
      cpuSeconds: Number(days) * 86400 + seconds,
      rssBytes: Number(rssKb) * 1024,
    };
  } catch {
    return null;
  }
}

/** Start a child process with stdout/stderr appended to a log file. */
export function spawnLogged(command, args, { env, cwd, logFile }) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(command, args, {
    env,
    cwd,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', () => fs.closeSync(out));
  return child;
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, sleep(5000)]);
}

export async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(
    `${url} not ready after ${timeoutMs}ms: ${lastError?.message}`
  );
}

export async function gitHead() {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
