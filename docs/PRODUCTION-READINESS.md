# Production Readiness

What changed between the hackathon artefact and what is in `main` now, measured
rather than asserted — and what is still wrong with it.

---

## 1. Before and after

| | Before | After | Method |
|---|---|---|---|
| **Tests** | 0 | **323** across 19 suites | `npm run test:coverage --prefix Backend` |
| **Coverage (statements)** | 0% | **~80%**, gated at 60% in CI | Jest, `coverageThreshold` |
| **CI/CD** | none | lint · Node 20+22 matrix · audit gate · Trivy · image builds · compose smoke test · deploy with rollback | `.github/workflows/` |
| **Backend image** | 361 MB | **365 MB** | `docker images` |
| **Frontend image** | 517 MB | **92 MB** | `docker images` |
| **HIGH/CRITICAL CVEs in the backend image** | 18 | **0** | Trivy, `--ignore-unfixed` |
| **Runs as root** | yes, both images | **no**, both images | asserted in CI |
| **Graceful shutdown** | never ran in a container | drains, releases lease, clean exit | asserted in CI |
| **Lighthouse — performance** | 79 | **84** | median of 3 runs, `/login` |
| **Lighthouse — accessibility** | 92 | **100** | " |
| **Lighthouse — best practices** | 96 | 96 | " |
| **Lighthouse — SEO** | 82 | **100** | " |
| **FCP / LCP** | 3.6 s / 4.1 s | **3.3 s / 3.5 s** | " |
| **Entry JS bundle** | 260 KB | **22.5 KB** | vite build output |
| **High/critical advisories** | 31 (23 high) | **0 blocking** (1 documented, unreachable) | `npm run audit` |
| **API p95 latency** | unmeasurable — no instrumentation existed | reproducible via script; exported as a histogram | `scripts/measure-latency.mjs`, §2 |

**On the backend image size.** It ends up 4 MB *larger* than it started, which
is the honest number. The multi-stage rebuild cut it to 323 MB; Phases 6 and 8
then added pino, prom-client and swagger-ui-express, which cost more than the
packaging saved. What actually improved is what the image contains: no
devDependencies, no build toolchain, no npm at runtime, a non-root user, and
working signal handling. Size was never the goal — it is reported because the
brief asked for it.

The frontend image is the real packaging result: 517 MB → 92 MB, and that is a
correctness fix rather than an optimisation. The old image ran `npm run dev`
and shipped the Vite dev server as a production artefact.

**On the zero-CVE figure.** Reached by deleting npm and corepack from the
runtime image rather than by suppressing findings. The container's command is
`node server.js`; it never invokes a package manager, and npm's vendored tree
(tar, minimatch, glob, cross-spawn, sigstore) accounted for 16 of the 18
findings. The remaining two were OS packages fixed by `apk upgrade`.

### Scale of change

| | Commits | Tests | Docs |
|---|---:|---:|---:|
| Hackathon (4 people, 4 days) | ~120 | 0 | 1 README |
| Production rebuild (1 person) | ~40 | 323 | 9 documents |

---

## 2. Latency

Reproduce with:

```bash
docker compose up -d --build
node scripts/measure-latency.mjs
```

The script reports p50/p95/p99 for the health, readiness, monitor list, incident
list and uptime-aggregation endpoints, discarding a warm-up window and draining
each response body (timing only the headers would flatter every number).

Numbers are for a warm process on a developer laptop, not a load test on
production hardware — they establish a baseline and catch regressions, not a
capacity figure. **This repository does not check in a p95 number**, because a
figure from one laptop presented as a property of the system is exactly the kind
of unearned claim the rest of this document exists to avoid. Run the script on
the hardware you care about.

There was no "before" measurement to compare against: the pre-existing code had
no instrumentation, and the dashboard queries it served were doing full
collection scans on an unindexed `logs` collection. The meaningful change is not
a percentage — it is that `logs` now has a `{ monitorId, timestamp }` compound
index and uptime is a single aggregation rather than documents counted in
application memory over unbounded history.

Ongoing p95 is exposed as `watchtower_http_request_duration_seconds` and
alertable per §3.7 of the [runbook](RUNBOOK.md).

---

## 3. What was actually broken

Not a list of improvements — a list of defects that existed and were fixed. Each
was verified, not inferred.

| Defect | Consequence | Found by |
|---|---|---|
| No cross-process coordination in the scheduler | Every replica checked every monitor: duplicate checks, duplicate incidents, **duplicate alert emails to customers** | Phase 0 audit |
| `pre('save')` hook declared `next` and never called it | Every incident create and resolve **hung forever**, wedging the tick that awaited it | Probing the installed kareem directly |
| Console transport disabled in production | The deployed service logged **nowhere** the platform could see | Running the container |
| `npm start` as the container command | SIGTERM never reached Node, so graceful shutdown never ran; every deploy killed checks mid-flight and held the lease until expiry | Running the container |
| SPA built with no `VITE_*` values in the image | The Docker image served an app that **could never render** — blank page | Lighthouse `NO_FCP` |
| `console.log(req.body)` on registration | Plaintext passwords written to stdout and into log retention | Phase 0 audit |
| TLS validation globally disabled | The monitor was structurally blind to expired certificates — a primary outage signal | Phase 0 audit |
| `logs` had no TTL and no index | Unbounded growth; every dashboard query a full collection scan | Phase 0 audit |
| Charts sorted ascending, limited 100 | After 100 checks every chart froze on the **oldest** data forever | Reading the query |
| Dashboard "Uptime" donut | Showed % of monitors up *right now*; read 100% during an hour-old outage | Reading the component |
| Hardcoded fake uptime series | A chart of seven invented numbers on a monitoring product | Reading the component |
| `forgotPassword` fired `sendEmail` unawaited | Unhandled rejection — on Node 15+ that terminates the process | Auth test suite |
| `verifyUser` awaited the confirmation email | SMTP outage → 500 to a user whose account **had** been verified | Auth test suite |
| Winston `mkdir logs` as non-root | Crash loop before serving a request | Running as non-root |
| Late socket errors unhandled | An `'error'` with no listener is rethrown — one badly-timed RST kills the scheduler | Flaky test |
| Metrics absent until first incremented | Dashboards showed "No data"; the alert meant to fire on the *first* failure had no baseline | Scraping a real container |
| Unauthenticated second Socket.IO server in-tree | One stray import from an anonymous realtime channel | Phase 0 audit |

---

## 4. Remaining limitations

Stated plainly. A readiness document that claims none is not credible.

### Architecture

1. **Active/passive scheduling.** One leader does all checking. Replicas scale
   the API but not the polling. Beyond ~`SCHEDULER_CONCURRENCY` saturation the
   answer is partitioned scheduling, which is a real change, not a config flag.
2. **MongoDB for time-series.** Roughly 10× the storage a columnar store would
   use, and 30-day aggregations scan raw rows. Migration trigger and target
   (TimescaleDB) in [ADR 0002](adr/0002-mongodb-for-time-series.md).
3. **Single checking region.** A network fault between us and a target is
   indistinguishable from the target being down.
4. **Lease, not fencing.** A partitioned leader may briefly overlap with its
   successor. Tolerable because checks are idempotent and duplicate incidents
   are prevented by a unique index — this reasoning would not survive if checks
   became destructive.
5. **Socket.IO scale-out needs sticky sessions** or the Redis adapter.

### Security

6. **SSRF: resolved.** Monitor checks and webhooks go through an egress guard
   that refuses loopback, private, link-local, CGNAT and reserved addresses at
   connect time, which also closes DNS rebinding. `SECURITY.md` T9.
7. **`AUTO_VERIFY_USERS` defaults on.** Registration skips email verification.
   Now one env var rather than a hardcoded line, and it warns at boot in
   production, but the default is still permissive so the live demo works.
8. **No CSRF token.** Relies on `SameSite=Strict` alone. Adequate against
   classic CSRF; defence in depth is missing.
9. **JWT returned in the response body** as well as the httpOnly cookie, which
   widens exposure to any XSS. Kept because the current frontend reads it.
10. **No token revocation.** A stolen JWT is valid until expiry.
11. **One dependency advisory carried** — react-router RSC-mode CSRF, not
    reachable from a client-only SPA; the fix requires Node ≥ 22.22, which would
    drop the Node 20 support this project targets. Allowlisted with a review
    date, enforced by `scripts/audit-gate.mjs`.

### Product and testing

12. **`StatusPages` is still mock data.** The page renders hardcoded values. It
    is the one screen that has not been rebuilt.
13. **No frontend test suite.** All 323 tests are backend. The frontend is
    covered only by Lighthouse and the CI smoke test.
14. **Notification delivery is best effort.** A failed send is recorded and
    counted but never retried.
15. **AI summaries are unvalidated model output** stored on the incident record.
16. **Load characteristics are unmeasured.** No sustained load test; the
    concurrency ceiling is reasoned about, not proven.

---

## 5. Ten questions, answered

### 1. What was your specific contribution versus your teammates'?

The hackathon was four people over four days and the split is in the git history,
not my memory — `git shortlog -sne --all` reproduces it.

Gaurav owned most of the backend domain: the `Monitor` and `Incident` schemas,
the monitor/incident/metrics routes and controllers, and the original check loop.
Satyajit built the frontend authentication end to end — hooks, Redux slices, API
layer, protected routes — plus monitoring state management. Rajiv created the
initial backend scaffolding and the `User` model, and did most of the
integration and bug-fixing across the frontend/backend boundary. In that window
I worked on the frontend shell, routing and styling, and some controllers.

Afterwards I built the real-time Socket.IO layer and the AI assistant, and then
did the entire production rebuild alone — every commit from 28 July onward. That
is the scheduler correctness work, the DAO tenancy layer, 323 tests from zero,
CI/CD, observability, and the frontend overhaul.

So: I led the project and own what it is now, but I did not write the original
domain model, and three other people's work is still in it. The honest framing
is that the hackathon produced a demo and I turned it into something that could
be operated — those are different skills and I would rather be precise about
which one I am demonstrating.

### 2. What happens when your monitoring service goes down?

The uncomfortable honest answer first: **nobody is told, and nothing external
notices.** That is the defining failure mode of this product. When WatchTower
stops, the API still answers, dashboards still render the last known state, and
customers' outages go unreported. A healthy WatchTower and a dead one look
identical from the outside — which is precisely why silence cannot be treated as
health.

What exists to address that:

- **`/api/health/ready` checks the scheduler heartbeat**, not just the process.
  A scheduler that has not ticked recently fails readiness, so the platform
  pulls the instance out of rotation.
- **`watchtower_scheduler_last_tick_timestamp_seconds`** is the alert that
  matters. `time() - that > 120` is the single most important rule in
  [the runbook](RUNBOOK.md), and it is first in the list because every customer
  is silently unmonitored while it fires.
- **Leader failover** means one instance dying is not an outage: another
  acquires the lease within 30 seconds, and because scheduling state is
  persisted on each monitor, no checks are lost.
- **Graceful shutdown** releases the lease explicitly, so a deploy hands over
  immediately rather than pausing monitoring for a lease period.

What is still missing, and I would say so unprompted: **the alerting is
self-hosted.** Prometheus scrapes `/metrics` from the same deployment. If the
whole platform is down, the thing that would tell us is down with it. The real
answer is an external dead-man's switch — a third-party service that alerts when
WatchTower *stops* checking in. That is a genuine gap, not an oversight I would
defend.

### 3. Why interval polling instead of push?

Push cannot detect the failure that matters most: a target that is completely
down cannot send a heartbeat either, so push degrades to "we noticed the absence
of a message" — polling with extra steps and a worse failure mode, because
silence is indistinguishable from a broken agent or a firewall change.

Polling also measures what a user actually experiences: DNS, TCP, TLS validity,
TTFB, from outside. An in-process agent cannot observe any of that about itself.
And it needs zero integration — a customer pastes a URL rather than deploying
software.

The cost is that detection is bounded by the interval, and that load scales with
monitors × frequency, which drove the worker pool, the circuit breaker and the
5-second interval floor. [ADR 0001](adr/0001-interval-polling-over-push.md).

### 4. Why MongoDB for time-series data, and what would you use at scale?

MongoDB because it was already the datastore, and a second store means a second
connection pool, backup procedure, failure mode and monitoring surface — paid
immediately for a benefit that only arrives at volume this deployment does not
have. The access pattern is narrow ("recent checks for one monitor", "aggregate
one window for one monitor"), which a compound index serves directly.

At roughly 10 million checks/day, or the first uptime query over a second, I
would move to **TimescaleDB**: it is PostgreSQL, so the relational data can share
the database with real foreign keys; hypertables partition by time; compression
reaches 10–20× on this shape; and continuous aggregates make a one-year query
read pre-rolled buckets instead of raw rows.

Not Prometheus, despite the fit — it is built for monitoring your own
infrastructure with a global label namespace, and per-tenant isolation and
retention are awkward on top of it. Tenancy is a hard requirement here.
[ADR 0002](adr/0002-mongodb-for-time-series.md).

### 5. How does the distributed lock work, and where does it break?

A lease document in MongoDB, `_id: "monitor-scheduler"`, holding `owner` and
`expiresAt`. Acquisition and renewal are one atomic `findOneAndUpdate` upsert
filtered on `expiresAt <= now OR owner = me`. Atomicity comes from the unique
`_id` index: two racing instances cannot both win, and the loser's duplicate-key
error is treated as "someone else leads".

The detail I would want an interviewer to ask about: **the TTL index is garbage
collection, not correctness.** MongoDB's TTL monitor sweeps about once a minute,
so an expired lock can linger well past `expiresAt`. Correctness comes from the
comparison inside the query. A design that waited for physical deletion would
stall failover for up to a minute.

Where it breaks: it is a lease, not a fencing token. During a partition a leader
may not yet know it has lost the lease and can keep checking until its next
failed renewal, so two writers can briefly overlap. Tolerable because a duplicate
check costs one extra HTTP request and one log row, and the genuinely dangerous
duplicate — opening the same incident twice — is prevented independently by a
partial unique index. If checks were destructive this reasoning would not hold.
[ADR 0004](adr/0004-mongodb-ttl-distributed-lock.md).

### 6. A target takes 90 seconds to respond but its interval is 60. What happens?

It is skipped, not queued, and the skip is counted.

Queueing builds an unbounded backlog against a target that is already
struggling — every queued check is stale on arrival, and we would be amplifying
load on a failing endpoint, which for a monitoring product means becoming the
thing that finishes off a customer's service. Cancelling the in-flight check and
starting fresh throws away the measurement in progress, and a check that is
taking a long time *is* the measurement.

Skipping keeps samples evenly spaced, bounds load at one in-flight request per
monitor, and self-heals when the target speeds up. The check is bounded anyway
by its per-check deadline, so a skipped cycle is a bounded delay. Skips are
exported as `watchtower_checks_skipped_total{reason="overlap"}` so scheduler lag
is observable rather than silent.

### 7. How do you stop one tenant reading another's data?

The original defect was patched before I started, but tenancy was enforced *by
convention*: every controller had to remember `{ userId }`. That works until
someone forgets once, and nothing tested it.

So it moved into a DAO layer where the default is inverted. A scoped DAO cannot
be queried without an owner — omitting one throws `UnscopedQueryError` rather
than silently reading the collection. The owner filter is applied by the DAO and
*intersected* with any caller filter, so a hostile `{ userId: someoneElse }`
yields an empty result rather than a wider one: queries fail closed. `create()`
stamps ownership from the session, so a `userId` in a request body is ignored.
Aggregations force the owner `$match` into the first stage.

By-id misses return **404, not 403**, because a 403 confirms the id exists.

On the realtime side, each socket joins exactly one room derived from the
verified token, and there is deliberately no client-controlled join handler.

All of it is regression-tested with two tenants owning identical data shapes —
that symmetry matters, because if the other tenant owned nothing every assertion
would pass trivially.

### 8. Your alerting depends on email. What if SMTP is down?

Delivery is best effort by design, and the incident is the source of truth. A
notifier that throws never rolls back a transition — the incident is recorded
correctly even when the alert did not arrive.

Every attempt is written to `notificationlogs` with its outcome, so "was the
customer actually told?" is answerable rather than inferred. Failures increment
`watchtower_notification_failures_total`, which has its own runbook alert
precisely because an incident detected correctly but never delivered is, from
the customer's side, indistinguishable from not monitoring them at all.

What is missing: **there is no retry.** A failed send stays failed. Given the
notifier interface is pluggable, a retrying notifier with a dead-letter record is
the natural next step, and I would rather name that gap than imply the
notification path is robust.

### 9. Why did coverage stop at 60% rather than 90%?

60% is the gate; the suite currently sits around 80%. The gate exists to catch
regressions, not to be scraped past.

I did not chase a higher global number because the remaining uncovered surface
is mostly defensive error handling around external I/O — SMTP failing, Mongo
unreachable, the AI provider timing out. Covering those exhaustively means
mocking every provider's failure taxonomy for assertions that mostly restate the
`try/catch` beneath them.

Where a regression is actually expensive, the bar is higher and enforced
per-file: the DAO sits near 90% and the scheduler at 85%, because those are the
tenancy boundary and the product's core loop. A flat global target would have
let those slip while the number stayed green — which is the failure mode of
coverage as a metric.

### 10. What would you do next, with a week?

Three things, in order of what actually reduces risk:

**An external dead-man's switch.** The largest remaining hole is that our own
alerting rides on the deployment it monitors. A third-party service that pages
when WatchTower stops checking in closes it, and it is perhaps a day's work.

**Frontend tests.** All 323 tests are backend. The frontend is covered by
Lighthouse and a smoke test, which would not catch a broken reconnect-resync or
a tenancy mistake in a component. Vitest plus Testing Library on the auth flow,
the realtime hook and the status components.

After that: rebuilding `StatusPages` on real data, since it is the last screen
still rendering mock values, and a sustained load test to replace reasoning about
the concurrency ceiling with a measurement.
