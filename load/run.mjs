/**
 * WatchTower load test: how many monitors does one instance keep on schedule,
 * and how fast is the dashboard API while it does?
 *
 * For each step it boots the real server (`node Backend/server.js`, unmodified,
 * NODE_ENV=production) against a fresh database, seeds N monitors pointing at
 * load/target.mjs, lets the scheduler warm up, then measures:
 *
 *   - scheduling drift: when a check actually started minus when it was due.
 *     Both come from the app's own `logs` rows: a check stored at time T is due
 *     again at T + interval (that is exactly how scheduler.js sets
 *     nextCheckAt), and the next check started at its timestamp minus its
 *     measured latency;
 *   - achieved checks/s against the rate the monitors ask for;
 *   - server CPU, RSS, heap and event-loop lag from the app's /metrics;
 *   - mongod CPU and RSS from the OS.
 *
 * Optionally, at one step, it also runs closed-loop dashboard reads against the
 * API while the scheduler keeps working.
 *
 * Usage and the measured results: load/README.md.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  LOAD_DIR,
  BACKEND_DIR,
  backendRequire,
  sleep,
  summarize,
  parseProm,
  metricSum,
  processStats,
  spawnLogged,
  stopChild,
  waitForHttp,
  gitHead,
} from './lib.mjs';

const { values: opt } = parseArgs({
  options: {
    monitors: { type: 'string', default: '100,500,1000,2000,3000' },
    interval: { type: 'string', default: '30' },
    'target-delay-ms': { type: 'string', default: '0' },
    warmup: { type: 'string', default: '60' },
    measure: { type: 'string', default: '150' },
    'api-at': { type: 'string', default: '1000' },
    'api-concurrency': { type: 'string', default: '10,50' },
    'api-duration': { type: 'string', default: '30' },
    'monitors-per-user': { type: 'string', default: '20' },
    'mongo-url': { type: 'string' },
    'server-env': { type: 'string', multiple: true, default: [] },
    'server-port': { type: 'string', default: '8099' },
    'target-port': { type: 'string', default: '8098' },
    out: { type: 'string' },
    label: { type: 'string', default: '' },
  },
});

const steps = opt.monitors.split(',').map(Number);
const intervalS = Number(opt.interval);
const intervalMs = intervalS * 1000;
const warmupMs = Number(opt.warmup) * 1000;
const measureMs = Number(opt.measure) * 1000;
const apiAt = Number(opt['api-at']);
const apiConcurrency = opt['api-concurrency'].split(',').map(Number);
const apiDurationMs = Number(opt['api-duration']) * 1000;
const perUser = Number(opt['monitors-per-user']);
const serverPort = Number(opt['server-port']);
const targetPort = Number(opt['target-port']);
const baseUrl = `http://127.0.0.1:${serverPort}`;

// The harness drops this database before every step. It refuses to touch
// anything but a loopback mongod, so a stray MONGO_URL can never point it at
// real data.
const DB_NAME = 'watchtower_load';

const serverEnvOverrides = Object.fromEntries(
  opt['server-env'].map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  })
);
const tickMs = Number(serverEnvOverrides.SCHEDULER_TICK_MS ?? 5000);
const concurrency = Number(serverEnvOverrides.SCHEDULER_CONCURRENCY ?? 10);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-load-'));
const log = (...args) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const mongoose = backendRequire('mongoose');
const { ObjectId } = mongoose.Types;

const children = new Set();
let memoryServer = null;

async function cleanup() {
  for (const child of children) await stopChild(child);
  if (memoryServer) await memoryServer.stop();
}
process.on('SIGINT', () => cleanup().finally(() => process.exit(130)));

function assertLoopback(url) {
  const hosts = new URL(url).host.split(',').map((h) => h.replace(/:\d+$/, ''));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  if (!hosts.every((h) => loopback.includes(h))) {
    throw new Error(
      `Refusing to run against ${url}: the harness drops its database, so it only accepts a loopback mongod.`
    );
  }
}

async function startMongo() {
  if (opt['mongo-url']) {
    assertLoopback(opt['mongo-url']);
    const u = new URL(opt['mongo-url']);
    u.pathname = `/${DB_NAME}`;
    return { url: u.toString(), pid: null };
  }
  const { MongoMemoryServer } = backendRequire('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60_000, storageEngine: 'wiredTiger' },
  });
  return {
    url: `${memoryServer.getUri()}${DB_NAME}`,
    pid: memoryServer.instanceInfo?.instance?.mongodProcess?.pid ?? null,
  };
}

function startTarget() {
  const child = spawnLogged(
    process.execPath,
    [
      path.join(LOAD_DIR, 'target.mjs'),
      '--port',
      String(targetPort),
      '--delay-ms',
      opt['target-delay-ms'],
    ],
    {
      env: process.env,
      cwd: workDir,
      logFile: path.join(workDir, 'target.log'),
    }
  );
  children.add(child);
  return child;
}

async function startServer(mongoUrl, step) {
  const env = {
    ...process.env,
    PORT: String(serverPort),
    MONGO_URL: mongoUrl,
    NODE_ENV: 'production',
    CORS_ORIGIN: baseUrl,
    FRONTEND_URL: baseUrl,
    // Nothing should send mail (every monitor stays UP, so no incident opens),
    // and if something tried, there is nothing listening here.
    SMTP_HOST: '127.0.0.1',
    SMTP_USER: 'load-test@example.invalid',
    SMTP_PASS: 'unused',
    BREVO_API_KEY: '',
    MISTRAL_API_KEY: '',
    GOOGLE_CLIENT_ID: '',
    METRICS_TOKEN: '',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_EXPIRY: '1h',
    CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    AUTO_VERIFY_USERS: 'true',
    // The dummy target listens on loopback, which the SSRF guard refuses by
    // default. This is the self-hosted opt-out, used here for the same reason.
    ALLOW_PRIVATE_TARGETS: 'true',
    LOG_LEVEL: 'info',
    LOG_TO_FILE: 'false',
    DOTENV_CONFIG_QUIET: 'true',
    ...serverEnvOverrides,
  };
  // cwd is a scratch directory, so dotenv cannot pick up a developer's
  // Backend/.env (and whatever real credentials are in it).
  const child = spawnLogged(
    process.execPath,
    [path.join(BACKEND_DIR, 'server.js')],
    { env, cwd: workDir, logFile: path.join(workDir, `server-${step}.log`) }
  );
  children.add(child);
  await waitForHttp(`${baseUrl}/api/health`);
  return child;
}

const randomIp = () =>
  `10.${crypto.randomInt(256)}.${crypto.randomInt(256)}.${crypto.randomInt(1, 255)}`;

/**
 * Register real accounts through the API. The auth cookie carries a JWT whose
 * payload holds the user id, which the seeded monitors are then owned by.
 */
async function registerUsers(count) {
  const users = [];
  for (let i = 0; i < count; i += 1) {
    const name = `load${i}${crypto.randomBytes(3).toString('hex')}`;
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': randomIp(),
      },
      body: JSON.stringify({
        username: name,
        fullname: `Load User ${i}`,
        email: `${name}@example.invalid`,
        password: crypto.randomBytes(12).toString('hex'),
      }),
    });
    await res.arrayBuffer();
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('uptimeaitoken='))
      ?.split(';')[0];
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`register failed: HTTP ${res.status}`);
    }
    const payload = JSON.parse(
      Buffer.from(cookie.split('=')[1].split('.')[1], 'base64url').toString()
    );
    users.push({ id: new ObjectId(payload.id), cookie, monitorIds: [] });
  }
  return users;
}

async function seedMonitors(db, count, users) {
  const now = Date.now();
  const docs = [];
  for (let i = 0; i < count; i += 1) {
    const owner = users[i % users.length];
    const _id = new ObjectId();
    owner.monitorIds.push(String(_id));
    docs.push({
      _id,
      userId: owner.id,
      title: `load-${i}`,
      name: `load-${i}`,
      description: '',
      type: 'api',
      url: `http://127.0.0.1:${targetPort}/m/${i}`,
      interval: intervalS,
      timeout: 10,
      status: 'UP',
      lastCheckStatus: null,
      active: true,
      // Spread evenly over one interval, as if the monitors had been created
      // at unrelated times, rather than all falling due on the first tick.
      nextCheckAt: new Date(now + Math.random() * intervalMs),
      authHeaders: null,
      ignoreTlsErrors: false,
      failureThreshold: 3,
      successThreshold: 2,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      breakerState: 'CLOSED',
      breakerOpenedAt: null,
      breakerRetryAt: null,
      breakerConsecutiveOpens: 0,
      timestamp: new Date(now),
      __v: 0,
    });
  }
  for (let i = 0; i < docs.length; i += 1000) {
    await db.collection('monitors').insertMany(docs.slice(i, i + 1000));
  }
}

async function scrape() {
  const res = await fetch(`${baseUrl}/metrics`);
  return parseProm(await res.text());
}

const targetCount = async () =>
  (await (await fetch(`http://127.0.0.1:${targetPort}/__stats`)).json())
    .requests;

/**
 * Resource usage over [start, end). /metrics is scraped every 10 s, which also
 * gives a peak RSS and the worst event-loop p99 of any 10 s slice (prom-client
 * resets the event-loop histogram on every scrape).
 */
async function observeWindow(mongodPid, durationMs, during = async () => {}) {
  const P = 'watchtower_';
  const m0 = await scrape();
  const mongo0 = await processStats(mongodPid);
  const target0 = await targetCount();
  const start = Date.now();

  let peakRss = 0;
  let peakHeap = 0;
  let worstLagP99 = 0;
  let worstLagMax = 0;
  let last = m0;
  const sampler = (async () => {
    while (Date.now() - start < durationMs - 10_000) {
      await sleep(10_000);
      last = await scrape();
      peakRss = Math.max(
        peakRss,
        metricSum(last, `${P}process_resident_memory_bytes`)
      );
      peakHeap = Math.max(
        peakHeap,
        metricSum(last, `${P}nodejs_heap_size_used_bytes`)
      );
      worstLagP99 = Math.max(
        worstLagP99,
        metricSum(last, `${P}nodejs_eventloop_lag_p99_seconds`)
      );
      worstLagMax = Math.max(
        worstLagMax,
        metricSum(last, `${P}nodejs_eventloop_lag_max_seconds`)
      );
    }
  })();
  const extra = await during();
  await sampler;
  const remaining = durationMs - (Date.now() - start);
  if (remaining > 0) await sleep(remaining);

  const m1 = await scrape();
  const end = Date.now();
  const mongo1 = await processStats(mongodPid);
  const target1 = await targetCount();
  const seconds = (end - start) / 1000;
  const delta = (name, where) =>
    metricSum(m1, name, where) - metricSum(m0, name, where);

  peakRss = Math.max(
    peakRss,
    metricSum(m1, `${P}process_resident_memory_bytes`)
  );
  peakHeap = Math.max(
    peakHeap,
    metricSum(m1, `${P}nodejs_heap_size_used_bytes`)
  );
  worstLagP99 = Math.max(
    worstLagP99,
    metricSum(m1, `${P}nodejs_eventloop_lag_p99_seconds`)
  );
  worstLagMax = Math.max(
    worstLagMax,
    metricSum(m1, `${P}nodejs_eventloop_lag_max_seconds`)
  );

  const ticks = delta(`${P}scheduler_tick_duration_seconds_count`);
  return {
    start,
    end,
    extra,
    resources: {
      serverCpuPctOfOneCore:
        (100 * delta(`${P}process_cpu_seconds_total`)) / seconds,
      serverPeakRssMb: peakRss / 2 ** 20,
      serverPeakHeapUsedMb: peakHeap / 2 ** 20,
      eventLoopLagP99Ms: worstLagP99 * 1000,
      eventLoopLagMaxMs: worstLagMax * 1000,
      mongodCpuPctOfOneCore:
        mongo0 && mongo1
          ? (100 * (mongo1.cpuSeconds - mongo0.cpuSeconds)) / seconds
          : null,
      mongodRssMb: mongo1 ? mongo1.rssBytes / 2 ** 20 : null,
    },
    scheduler: {
      ticks,
      tickMeanMs: ticks
        ? (1000 * delta(`${P}scheduler_tick_duration_seconds_sum`)) / ticks
        : null,
      checksUp: delta(`${P}checks_executed_total`, (l) => l.status === 'UP'),
      checksDown: delta(
        `${P}checks_executed_total`,
        (l) => l.status === 'DOWN'
      ),
      skippedOverlap: delta(
        `${P}checks_skipped_total`,
        (l) => l.reason === 'overlap'
      ),
      skippedBreaker: delta(
        `${P}checks_skipped_total`,
        (l) => l.reason === 'breaker_open'
      ),
      targetRequests: target1 - target0,
    },
  };
}

/**
 * Drift of every check that STARTED inside [from, to), computed from the
 * app's own log rows.
 */
async function driftStats(db, monitorCount, from, to) {
  const rows = await db
    .collection('logs')
    .find(
      {},
      {
        projection: {
          monitorId: 1,
          timestamp: 1,
          latency: 1,
          status: 1,
          attempts: 1,
        },
      }
    )
    .sort({ monitorId: 1, timestamp: 1 })
    .toArray();

  const drift = [];
  const latency = [];
  const firstHalf = [];
  const secondHalf = [];
  const checked = new Set();
  const mid = (from + to) / 2;
  let checks = 0;
  let notUp = 0;
  let retried = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const b = rows[i];
    const started = b.timestamp.getTime() - (b.latency ?? 0);
    if (started < from || started >= to) continue;
    checks += 1;
    latency.push(b.latency ?? 0);
    checked.add(String(b.monitorId));
    if (b.status !== 'UP') notUp += 1;
    if ((b.attempts ?? 1) > 1) retried += 1;

    const a = rows[i - 1];
    if (!a || String(a.monitorId) !== String(b.monitorId)) continue;
    const d = started - (a.timestamp.getTime() + intervalMs);
    drift.push(d);
    (started < mid ? firstHalf : secondHalf).push(d);
  }

  const seconds = (to - from) / 1000;
  return {
    checks,
    requiredChecksPerSec: monitorCount / intervalS,
    achievedChecksPerSec: checks / seconds,
    monitorsNotCheckedInWindow: monitorCount - checked.size,
    notUp,
    retried,
    driftMs: summarize(drift),
    checkLatencyMs: summarize(latency),
    driftP95FirstHalfMs: summarize(firstHalf).p95 ?? null,
    driftP95SecondHalfMs: summarize(secondHalf).p95 ?? null,
  };
}

/**
 * Closed-loop dashboard reads: each virtual user repeatedly loads what the
 * Dashboard page loads (monitor list, incidents, one latency chart) with no
 * think time.
 *
 * Every request carries a random X-Forwarded-For. The app trusts one proxy
 * hop (as on Render), so this models many distinct clients; the per-IP limiter
 * (300 req / 15 min) stays in the request path but never trips.
 */
async function dashboardReads(users, vus, durationMs) {
  const latencies = [];
  const byRoute = {};
  const statuses = {};
  const deadline = Date.now() + durationMs;

  async function vu(k) {
    const user = users[k % users.length];
    while (Date.now() < deadline) {
      const monitorId =
        user.monitorIds[crypto.randomInt(user.monitorIds.length)];
      for (const [route, url] of [
        ['GET /api/monitor', '/api/monitor'],
        ['GET /api/incidents', '/api/incidents'],
        ['GET /api/metrics/latency/:id', `/api/metrics/latency/${monitorId}`],
      ]) {
        const t0 = performance.now();
        let status;
        try {
          const res = await fetch(baseUrl + url, {
            headers: { Cookie: user.cookie, 'X-Forwarded-For': randomIp() },
          });
          await res.arrayBuffer();
          status = res.status;
        } catch {
          status = 'network-error';
        }
        const ms = performance.now() - t0;
        statuses[status] = (statuses[status] ?? 0) + 1;
        if (status === 200) {
          latencies.push(ms);
          (byRoute[route] ??= []).push(ms);
        }
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: vus }, (_, k) => vu(k)));
  const seconds = (Date.now() - started) / 1000;
  const total = Object.values(statuses).reduce((a, b) => a + b, 0);
  return {
    virtualUsers: vus,
    requests: total,
    requestsPerSec: total / seconds,
    statuses,
    latencyMs: summarize(latencies),
    byRouteP95Ms: Object.fromEntries(
      Object.entries(byRoute).map(([r, v]) => [r, summarize(v).p95])
    ),
  };
}

async function runStep(mongo, conn, n) {
  log(`step: ${n} monitors`);
  await conn.db.dropDatabase();
  const server = await startServer(mongo.url, n);

  const withApi = n === apiAt;
  const userCount = Math.max(
    1,
    withApi
      ? Math.max(Math.ceil(n / perUser), Math.max(...apiConcurrency))
      : Math.ceil(n / perUser)
  );
  // Real accounts only where the API is exercised; elsewhere the scheduler
  // needs nothing but an owner id on each monitor.
  const users = withApi
    ? await registerUsers(userCount)
    : Array.from({ length: userCount }, () => ({
        id: new ObjectId(),
        monitorIds: [],
      }));

  await seedMonitors(conn.db, n, users);
  log(
    `  seeded ${n} monitors for ${users.length} users; warming up ${warmupMs / 1000}s`
  );
  await sleep(warmupMs);

  log(`  measuring ${measureMs / 1000}s`);
  const w = await observeWindow(mongo.pid, measureMs);
  const result = {
    monitors: n,
    scheduler: {
      ...(await driftStats(conn.db, n, w.start, w.end)),
      ...w.scheduler,
    },
    resources: w.resources,
  };
  printStep(result);

  if (withApi) {
    result.api = [];
    for (const vus of apiConcurrency) {
      log(
        `  dashboard reads: ${vus} virtual users for ${apiDurationMs / 1000}s`
      );
      const a = await observeWindow(mongo.pid, apiDurationMs, () =>
        dashboardReads(users, vus, apiDurationMs)
      );
      const entry = {
        ...a.extra,
        schedulerDuringApi: {
          ...(await driftStats(conn.db, n, a.start, a.end)),
          ...a.scheduler,
        },
        resources: a.resources,
      };
      result.api.push(entry);
      log(
        `    ${entry.requests} req, ${entry.requestsPerSec.toFixed(0)} req/s, ` +
          `p50 ${entry.latencyMs.p50?.toFixed(1)} ms, p95 ${entry.latencyMs.p95?.toFixed(1)} ms, ` +
          `p99 ${entry.latencyMs.p99?.toFixed(1)} ms, statuses ${JSON.stringify(entry.statuses)}; ` +
          `drift p95 meanwhile ${entry.schedulerDuringApi.driftMs.p95} ms`
      );
    }
  }

  await stopChild(server);
  children.delete(server);
  return result;
}

const fmt = (v, digits = 0) => (v == null ? '-' : Number(v).toFixed(digits));

function printStep(r) {
  const s = r.scheduler;
  log(
    `  ${r.monitors} monitors: need ${fmt(s.requiredChecksPerSec, 1)}/s, did ${fmt(s.achievedChecksPerSec, 1)}/s; ` +
      `drift p50 ${s.driftMs.p50} ms, p95 ${s.driftMs.p95} ms, p99 ${s.driftMs.p99} ms, max ${s.driftMs.max} ms ` +
      `(p95 1st half ${s.driftP95FirstHalfMs}, 2nd half ${s.driftP95SecondHalfMs}); ` +
      `not checked ${s.monitorsNotCheckedInWindow}, not UP ${s.notUp}; tick mean ${fmt(s.tickMeanMs)} ms; ` +
      `CPU ${fmt(r.resources.serverCpuPctOfOneCore)}%, RSS ${fmt(r.resources.serverPeakRssMb)} MB, ` +
      `loop p99 ${fmt(r.resources.eventLoopLagP99Ms, 1)} ms, mongod CPU ${fmt(r.resources.mongodCpuPctOfOneCore)}%`
  );
}

function markdownTable(results) {
  const lines = [
    '| Monitors | Needed checks/s | Achieved checks/s | Drift p50 | Drift p95 | Drift p99 | Drift max | p95 1st → 2nd half | Mean tick | Server CPU | Server RSS | Loop lag p99 | mongod CPU |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    const s = r.scheduler;
    const res = r.resources;
    lines.push(
      `| ${r.monitors} | ${fmt(s.requiredChecksPerSec, 1)} | ${fmt(s.achievedChecksPerSec, 1)} | ` +
        `${fmt(s.driftMs.p50)} ms | ${fmt(s.driftMs.p95)} ms | ${fmt(s.driftMs.p99)} ms | ${fmt(s.driftMs.max)} ms | ` +
        `${fmt(s.driftP95FirstHalfMs)} → ${fmt(s.driftP95SecondHalfMs)} ms | ${fmt(s.tickMeanMs)} ms | ` +
        `${fmt(res.serverCpuPctOfOneCore)}% | ${fmt(res.serverPeakRssMb)} MB | ${fmt(res.eventLoopLagP99Ms, 1)} ms | ` +
        `${fmt(res.mongodCpuPctOfOneCore)}% |`
    );
  }
  return lines.join('\n');
}

async function main() {
  const mongo = await startMongo();
  const conn = await mongoose.createConnection(mongo.url).asPromise();
  const mongodVersion = (await conn.db.admin().serverInfo()).version;
  startTarget();
  await waitForHttp(`http://127.0.0.1:${targetPort}/__stats`);

  const cpus = os.cpus();
  const meta = {
    label: opt.label,
    date: new Date().toISOString(),
    commit: await gitHead(),
    node: process.version,
    mongod: mongodVersion,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model.trim()} (${cpus.length} logical CPUs)`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    config: {
      intervalS,
      targetDelayMs: Number(opt['target-delay-ms']),
      warmupS: warmupMs / 1000,
      measureS: measureMs / 1000,
      schedulerTickMs: tickMs,
      schedulerConcurrency: concurrency,
      serverEnvOverrides,
      monitorsPerUser: perUser,
    },
  };
  log(
    `${meta.cpu}, ${meta.memoryGb} GB, Node ${meta.node}, mongod ${meta.mongod}`
  );
  log(`work dir (server logs): ${workDir}`);

  const results = [];
  for (const n of steps) results.push(await runStep(mongo, conn, n));

  await conn.close();
  await cleanup();

  const out = opt.out ?? path.join(LOAD_DIR, 'results', `${runId}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ meta, results }, null, 2)}\n`);
  console.log(`\n${markdownTable(results)}\n`);
  log(`results written to ${out}`);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
