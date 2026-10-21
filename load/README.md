# Load test: scheduler capacity and API latency

Answers two questions with numbers measured on one machine:

1. **How many monitors does one instance keep on schedule?** Measured as
   _scheduling drift_: when a check actually started minus when it was due.
2. **How fast is the dashboard API while the scheduler is busy?** Measured as
   p50/p95/p99 latency of the requests the Dashboard page makes.

Everything here is a script you can rerun. The results below come from the
JSON files in [`results/`](results/), written by exactly the commands shown.

## Summary

On one laptop (Intel Core i5-13420H, 16 GB, Windows 11; details below):

| Setup                                                     | Holds, with drift stable        | Ceiling        |
| --------------------------------------------------------- | ------------------------------- | -------------- |
| Default settings, target answers immediately               | 2,000 monitors, drift p95 8.6 s | 63 checks/s    |
| Default settings, target answers in 100 ms                 | 1,000 monitors, drift p95 6.9 s | 34–38 checks/s |
| `SCHEDULER_TICK_MS=1000`, `SCHEDULER_CONCURRENCY=50`, 100 ms target | 3,000 monitors, drift p95 2.8 s | 99 checks/s    |

All monitors use a 30 s interval. _Holds_ is the largest step that stayed below
the 500-checks-per-tick cap with drift not growing across the window. The next
step in each sweep hit the cap (485–499 checks per tick) and fell 26–33% short
of the checks/s it needed. On defaults with an instant target, 2,000 monitors
already ran 470 checks per tick, so little headroom is left there. In every
step every check returned UP, none was retried or skipped, and every monitor
was checked at least once in each 150 s window.

The ceiling is not CPU: the server used at most 31% of one core in the default
runs. It is the loop's shape. Each tick takes at most 500 due monitors
(`MAX_BATCH` in `scheduler.js`), and the next tick starts `SCHEDULER_TICK_MS`
after the previous one finishes. Past the ceiling nothing is dropped: monitors
are served most-overdue first and every monitor's effective interval stretches
to about N ÷ ceiling.

Dashboard API, at 1,000 monitors with default settings: p95 178 ms at 99 req/s
(10 concurrent clients). One Node process saturates at about 117 req/s, at 93%
of one core, and while it does, the scheduler slows down too.

## What the harness does

`run.mjs` runs each step against a fresh database:

1. boots a throwaway `mongod` (via `mongodb-memory-server`, already a Backend
   devDependency) or uses `--mongo-url` (loopback only, because the harness
   drops its `watchtower_load` database before every step);
2. starts [`target.mjs`](target.mjs), a local HTTP server that answers `200`
   (after `--target-delay-ms`, default 0). Every monitor points at it, so no
   third-party site is ever probed;
3. starts the real server, **unmodified**: `node Backend/server.js` with
   `NODE_ENV=production` and default scheduler settings unless `--server-env`
   overrides them. It runs from a scratch directory so a developer's
   `Backend/.env` is never loaded, and its SMTP/API keys are blanked;
4. inserts N monitors (30 s interval, 20 per owner) straight into the
   `monitors` collection, with their first `nextCheckAt` spread evenly over one
   interval, as if they had been created at unrelated times;
5. warms up for 60 s, then measures for 150 s.

**Drift** comes from the app's own `logs` rows, not from instrumentation added
to it. `scheduler.js` stores each check with `timestamp = T` and sets
`nextCheckAt = T + interval`, so the next check of that monitor was due at
`T + 30 s`. It started at its own `timestamp − latency`. Drift is the
difference, for every check that started inside the window.

**Resources** come from the app's Prometheus endpoint (`/metrics`, scraped
every 10 s): CPU from `process_cpu_seconds_total` and peak RSS. `mongod` CPU and
RSS come from the OS.

**Dashboard reads** (one step only): N virtual users each repeat what the
Dashboard page loads, `GET /api/monitor`, `GET /api/incidents` and
`GET /api/metrics/latency/:id`, with no think time, while the scheduler keeps
running. The users are real accounts registered through
`POST /api/auth/register`. Each request carries a random `X-Forwarded-For`; the
app trusts one proxy hop (as on Render), so this models many separate browsers.
The per-IP limiter (300 requests per 15 min) stays in the request path but
never trips. Without the header, a single load-test IP would be limited after
300 requests.

## Run it

```bash
npm --prefix Backend ci
node load/run.mjs
```

The three sweeps below were produced by:

```bash
node load/run.mjs --monitors 100,500,1000,1500,2000,2500,3000 --api-at 1000 --api-concurrency 10,50 --out load/results/run-a-target-0ms.json
```

```bash
node load/run.mjs --monitors 500,1000,1500,2000 --target-delay-ms 100 --api-at 0 --out load/results/run-b-target-100ms.json
```

```bash
node load/run.mjs --monitors 1000,2000,3000,4000 --target-delay-ms 100 --api-at 0 --server-env SCHEDULER_TICK_MS=1000 --server-env SCHEDULER_CONCURRENCY=50 --out load/results/run-c-tuned-target-100ms.json
```

Options (defaults in brackets): `--monitors` [100,500,1000,2000,3000],
`--interval` [30], `--target-delay-ms` [0], `--warmup` [60], `--measure` [150],
`--api-at` [1000; 0 skips the API phase], `--api-concurrency` [10,50],
`--api-duration` [30], `--server-env KEY=VALUE` (repeatable), `--mongo-url`,
`--out`, `--label`. Each step takes about 4 minutes.

The server's own logs for each step are kept in a temporary `wt-load-*`
directory; the run prints its path.

## Results

Measured 22 Oct 2026 (01:10–02:10 IST), app at commit `d8f3f80` (main).

| Machine           |                                                                            |
| ----------------- | -------------------------------------------------------------------------- |
| CPU               | Intel Core i5-13420H, 8 cores / 12 threads                                 |
| Memory            | 16 GB                                                                      |
| OS                | Windows 11 Home, build 26200; on AC power, Balanced power plan             |
| Node              | v24.13.0 (the Docker image uses Node 20)                                   |
| MongoDB           | 8.2.6, WiredTiger, started by `mongodb-memory-server`                      |
| Everything else   | server, mongod, target and load generator all on this machine, with ordinary desktop apps running |

Columns: _needed_ is N ÷ 30 s. _Effective interval_ is N ÷ achieved checks/s.
_Checks per tick_ is achieved checks/s × (tick sleep + mean tick duration); 500
is the cap. _Check latency_ is the probe's own `latency` field, p50.

### A. Default settings (tick 5 s, concurrency 10), target answers immediately

| Monitors | Needed /s | Achieved /s | Effective interval | Drift p50 | Drift p95 | Drift p99 | Drift max | Mean tick | Checks per tick | Check latency | Server CPU (one core) | Server RSS | mongod CPU |
| -------: | --------: | ----------: | -----------------: | --------: | --------: | --------: | --------: | --------: | --------------: | ------------: | --------------------: | ---------: | ---------: |
|      100 |       3.3 |         3.2 |             31.0 s |     0.8 s |     1.1 s |     1.1 s |     1.2 s |    0.13 s |              17 |         18 ms |                    3% |     164 MB |         3% |
|      500 |      16.7 |        14.1 |             35.4 s |     3.6 s |     4.7 s |     4.8 s |     4.9 s |    0.60 s |              79 |         23 ms |                    9% |     176 MB |         5% |
|    1,000 |      33.3 |        30.2 |             33.1 s |     1.6 s |     5.9 s |     6.5 s |     6.6 s |    1.23 s |             188 |         22 ms |                   17% |     253 MB |         9% |
|    1,500 |      50.0 |        42.4 |             35.4 s |     6.1 s |     7.1 s |     7.3 s |     7.3 s |    2.26 s |             308 |         27 ms |                   26% |     289 MB |        12% |
|    2,000 |      66.7 |        56.1 |             35.6 s |     5.6 s |     8.6 s |     8.9 s |     9.0 s |    3.38 s |             470 |         18 ms |                   30% |     251 MB |        13% |
|    2,500 |      83.3 |        61.9 |             40.4 s |     9.5 s |    10.1 s |    10.3 s |    10.7 s |    2.89 s |             489 |         14 ms |                   29% |     323 MB |        14% |
|    3,000 |     100.0 |        63.3 |             47.4 s |    17.0 s |    17.8 s |    17.9 s |    18.0 s |    2.84 s |             496 |         19 ms |                   31% |     278 MB |        15% |

### B. Default settings, target answers after 100 ms

| Monitors | Needed /s | Achieved /s | Effective interval | Drift p50 | Drift p95 | Drift p99 | Drift max | Mean tick | Checks per tick | Check latency | Server CPU (one core) | Server RSS | mongod CPU |
| -------: | --------: | ----------: | -----------------: | --------: | --------: | --------: | --------: | --------: | --------------: | ------------: | --------------------: | ---------: | ---------: |
|      500 |      16.7 |        14.7 |             34.0 s |     2.9 s |     3.5 s |     3.5 s |     3.6 s |    1.55 s |              96 |        122 ms |                    8% |     201 MB |         5% |
|    1,000 |      33.3 |        28.5 |             35.1 s |     5.5 s |     6.9 s |     6.9 s |     7.0 s |    3.96 s |             255 |        122 ms |                   16% |     278 MB |         8% |
|    1,500 |      50.0 |        33.5 |             44.8 s |    14.5 s |    16.2 s |    16.8 s |    17.0 s |    9.50 s |             485 |        131 ms |                   31% |     304 MB |        15% |
|    2,000 |      66.7 |        38.2 |             52.3 s |    21.1 s |    23.3 s |    23.4 s |    23.5 s |    7.84 s |             491 |        118 ms |                   24% |     276 MB |        11% |

### C. `SCHEDULER_TICK_MS=1000`, `SCHEDULER_CONCURRENCY=50`, target answers after 100 ms

| Monitors | Needed /s | Achieved /s | Effective interval | Drift p50 | Drift p95 | Drift p99 | Drift max | Mean tick | Checks per tick | Check latency | Server CPU (one core) | Server RSS | mongod CPU |
| -------: | --------: | ----------: | -----------------: | --------: | --------: | --------: | --------: | --------: | --------------: | ------------: | --------------------: | ---------: | ---------: |
|    1,000 |      33.3 |        33.0 |             30.3 s |     0.5 s |     1.1 s |     1.2 s |     1.5 s |    0.29 s |              43 |        150 ms |                   12% |     257 MB |         7% |
|    2,000 |      66.7 |        64.2 |             31.1 s |     1.4 s |     2.2 s |     2.4 s |     2.5 s |    0.91 s |             123 |        176 ms |                   26% |     247 MB |        15% |
|    3,000 |     100.0 |        93.6 |             32.1 s |     2.0 s |     2.8 s |     3.2 s |     3.7 s |    1.59 s |             242 |        180 ms |                   38% |     306 MB |        20% |
|    4,000 |     133.3 |        99.0 |             40.4 s |     8.2 s |    15.2 s |    15.6 s |    15.9 s |    4.04 s |             499 |        213 ms |                   50% |     271 MB |        22% |

### Dashboard API (sweep A, 1,000 monitors, default settings)

| Concurrent clients | Requests in 30 s | Req/s | p50    | p95    | p99    | Server CPU (one core) | Scheduler meanwhile           |
| -----------------: | ---------------: | ----: | -----: | -----: | -----: | --------------------: | ----------------------------- |
|                 10 |            2,994 |    99 |  92 ms | 178 ms | 230 ms |                   93% | 24.0 checks/s, drift p95 9.0 s  |
|                 50 |            3,564 |   117 | 407 ms | 622 ms | 708 ms |                   93% | 18.6 checks/s, drift p95 16.2 s |

Every request returned 200. p95 by route at 10 clients: `GET /api/monitor`
180 ms, `GET /api/incidents` 149 ms, `GET /api/metrics/latency/:id` 203 ms.
Without API load, the same step ran 30.2 checks/s with drift p95 5.9 s.

## What the numbers say

**Drift has a floor set by the tick.** The loop sleeps `SCHEDULER_TICK_MS`
between ticks, and `nextCheckAt` is anchored to when the previous check
finished, so a monitor usually falls due during a sleep and waits for the next
tick. Drift therefore grows with the tick period (sleep plus tick work): 1.1 s
p95 at 100 monitors, 8.6 s at 2,000. With a 1 s tick (sweep C) it drops to
1.1–2.8 s up to 3,000 monitors.

**Throughput has a ceiling set by the batch cap.** At most 500 checks run per
tick, so checks/s ≤ 500 ÷ (tick sleep + time to run a 500-check tick). The
model matches all three sweeps:

| Sweep | Mean tick at the cap | Model           | Measured    |
| ----- | -------------------- | --------------- | ----------- |
| A     | 2.84 s               | 500 ÷ 7.84 s = 63.8 /s | 63.3 /s |
| B     | 7.84 s               | 500 ÷ 12.84 s = 38.9 /s | 38.2 /s |
| C     | 4.04 s               | 500 ÷ 5.04 s = 99.2 /s | 99.0 /s |

**Slow targets make concurrency the bottleneck.** With 10 slots and every
check holding one for at least 100 ms, a full tick takes 7.8–9.5 s instead of
under 3 s, so the default instance tops out between 1,000 and 1,500 monitors
against 100 ms endpoints. Raising `SCHEDULER_CONCURRENCY` to 50 (sweep C) moved
that to between 3,000 and 4,000. It cost some latency: with 50 sockets in
flight on one event loop, the probe's own latency rose from about 122 ms to
150–180 ms up to 3,000 monitors.

**Past the ceiling, monitors run late rather than being skipped.** At 3,000
monitors on defaults, each was still checked, every 47.4 s on average instead
of every 30 s, and drift barely moved within the window (p95 17.4 s in the
first half, 17.8 s in the second).

**API and scheduler share one event loop.** Under 10–50 concurrent dashboard
clients the server process sat at 93% of one core and topped out at about
117 req/s; extra clients only added queueing. The scheduler slowed with it,
from 30.2 to 18.6 checks/s. `SCHEDULER_ENABLED=false` plus the leader lock
already allow API-only instances next to one scheduler instance; this run did
not test that layout.

## Caveats

- One laptop, not the hosted demo. Render's free instance is far smaller, and
  these numbers do not transfer to it. Server, database, target and load
  generator also competed for the same CPU.
- The target is on loopback: no DNS, no TLS, no real network. Probes use a
  fresh connection per check (`agent: false`), so HTTPS targets would add a
  TLS handshake to every check.
- Node 24 here; the Docker image runs Node 20 (`engines` is `>=20 <23`, npm
  only warned).
- Monitors were inserted directly; the `POST /api/monitor` path was not
  measured.
- No Socket.IO clients were connected, so the per-check `emitToUser` cost was
  near zero.
- The API test is closed-loop with no think time: it measures saturation, not
  the latency of a lightly used server.
- Drift oscillates with the tick phase within a 150 s window. Each JSON file
  also records drift p95 for the first and second half of the window, and the
  event-loop lag, which is inflated on Windows by its ~15.6 ms timer
  granularity and is not used above.
