# Architecture

How WatchTower is put together and why. For the reasoning behind individual
choices see [`adr/`](adr/); for operating it see [`RUNBOOK.md`](RUNBOOK.md); for
the scheduler's full behavioural contract see [`SCHEDULER.md`](SCHEDULER.md).

---

## 1. Shape of the system

One Node process serves three things: the REST API, the Socket.IO server, and
the built React SPA. The scheduler runs inside that same process, gated by a
leader lease so only one instance polls.

```mermaid
graph TB
    Browser["Browser · React SPA"]

    subgraph Node["Node process"]
        API["Express API<br/>routes · controllers"]
        DAO["DAO layer<br/>owner-scoped"]
        IO["Socket.IO<br/>per-tenant rooms"]
        SCHED["Scheduler<br/>lease · pool · breaker"]
        NOTIF["Notifier registry"]
    end

    Mongo[("MongoDB<br/>users · monitors<br/>logs (TTL) · incidents")]
    Targets["Customer endpoints"]
    Email["SMTP / webhooks"]
    Prom["Prometheus"]

    Browser -->|"REST + cookie JWT"| API
    Browser <-->|"WSS · JWT handshake"| IO
    API --> DAO
    DAO --> Mongo
    SCHED --> Mongo
    SCHED -->|"HTTP checks"| Targets
    SCHED -->|"status + incidents"| IO
    SCHED --> NOTIF
    NOTIF --> Email
    Node -->|"/metrics"| Prom
```

**Why one process.** The SPA is served by the API from `public/dist`, so there
is no CORS in production, no second deployment, and the auth cookie is
same-origin by construction. The cost is that the API and the scheduler share a
CPU: a slow scheduler tick can add latency to requests. Acceptable at this size
and reversible — `SCHEDULER_ENABLED=false` turns any instance into an API-only
replica without a code change.

---

## 2. Request flow

Every authenticated request passes through the same chain. The order is not
arbitrary; each position is load-bearing.

```mermaid
sequenceDiagram
    autonumber
    participant C as Browser
    participant M as Middleware chain
    participant R as Route + validator
    participant Ctl as Controller
    participant D as DAO
    participant DB as MongoDB

    C->>M: GET /api/monitor (cookie)

    Note over M: request-id + logging FIRST<br/>so even rejected requests are traceable
    M->>M: helmet · CORS allow-list
    M->>M: body parse · cookie parse
    M->>M: mongo-sanitize · hpp
    M->>M: rate limit (tiered)

    M->>R: verifyJWT
    alt no / invalid / expired token
        R-->>C: 401
    end

    R->>R: Zod validate → strips undeclared fields
    R->>Ctl: req.user.id + clean body

    Ctl->>D: monitorDao.find(userId)
    Note over D: owner scope injected here,<br/>not in the controller
    alt ownerId missing
        D-->>Ctl: throw UnscopedQueryError
    end
    D->>DB: find({ userId })
    DB-->>D: documents
    D-->>Ctl: documents
    Ctl-->>C: 200 ApiResponse

    Note over C,DB: any throw → error middleware →<br/>ApiError envelope, stack hidden outside development
```

**Correlation before security.** The request-id and access logger are the first
middleware, ahead of helmet and CORS. A request rejected by the path blocklist
still needs to appear in the logs with an id — a 403 nobody can correlate is a
log line nobody can act on.

**Sanitisation after parsing, before routing.** `express-mongo-sanitize` and
`hpp` need the parsed body and query to exist, and must run before any route
reads them. Both libraries reassign `req.query`, which is getter-only in Express
5, so a shim makes the slot writable — see `app.middleware.js`.

**Validation strips, it does not just check.** Zod schemas are an allow-list:
the parsed result is written back over `req.body`, so a field the schema does not
declare never reaches a controller. That is the outer layer; the DAO stamping
ownership is the inner one, and neither relies on the other being correct.

**The DAO is where tenancy lives.** Controllers pass an owner id; they cannot
construct an unscoped query. The original data-exposure defect was possible
because tenancy was enforced by convention in every controller — which works
until someone forgets once. See [ADR 0004](adr/) context and `SECURITY.md` T1.

---

## 3. Scheduler execution

The product's actual work. Full contract in [`SCHEDULER.md`](SCHEDULER.md).

```mermaid
flowchart TD
    T["Tick · every 5s<br/>self-rescheduling timeout"] --> L{"Acquire /<br/>renew lease?"}

    L -->|no| F["Follower — do nothing<br/>keep ticking, keep trying"]
    F --> T

    L -->|yes| Q["Find due monitors<br/>active AND (nextCheckAt ≤ now<br/>OR lastChecked > now)"]
    Q --> E{"Any due?"}
    E -->|no| T

    E -->|yes| G["For each due monitor"]
    G --> OV{"Already<br/>in flight?"}
    OV -->|yes| SKIP1["SKIP · count it<br/>never queue, never cancel"]
    OV -->|no| BR{"Breaker state?"}

    BR -->|OPEN, cooling| SKIP2["SKIP · no worker slot<br/>record nothing"]
    BR -->|OPEN, cooled| HALF["HALF_OPEN · 1 attempt, no retries"]
    BR -->|CLOSED| FULL["Full retry ladder"]

    HALF --> POOL
    FULL --> POOL["Bounded pool<br/>max SCHEDULER_CONCURRENCY"]

    POOL --> CHK["probe: DNS→TCP→TLS→TTFB<br/>hard per-attempt deadline"]
    CHK --> RES{"Result"}
    RES -->|"UP"| CNT
    RES -->|"DOWN, retryable"| RETRY["backoff = random(0, min(base·2ⁿ, cap))"]
    RETRY --> CHK
    RES -->|"DOWN, terminal"| CNT

    CNT["Update counters<br/>consecutiveFailures / Successes<br/>persisted on the monitor"]
    CNT --> W["Write: log row + timings<br/>nextCheckAt = now + interval"]

    W --> FLAP{"Threshold<br/>crossed?"}
    FLAP -->|"N consecutive failures<br/>and status UP"| OPEN["Open incident<br/>edge-triggered, exactly once"]
    FLAP -->|"M consecutive successes<br/>and status DOWN"| CLOSE["Close incident"]
    FLAP -->|no| EMIT

    OPEN --> NOTE["Notify · registry fan-out"]
    CLOSE --> NOTE
    NOTE --> EMIT["Emit into owner's room"]
    EMIT --> T
```

### The properties worth knowing

**Skip, never queue.** A monitor slower than its own interval is skipped, not
backlogged. Queueing piles load onto a target that is already struggling and
every queued check is stale on arrival; cancelling throws away the measurement
in progress, which *is* the signal. Skips are counted so lag is observable.

**No catch-up stampede.** After downtime every monitor is overdue. Each is
checked *once* and rescheduled from now — never one check per missed interval,
which would fire a thundering herd at every customer simultaneously at the
moment the system is least healthy.

**Durable scheduling state.** `nextCheckAt` and the flap counters live on the
monitor document, so a restart mid-streak resumes rather than restarting the
threshold. Nothing is written until a check completes, so an interrupted check
leaves no partial state.

**Monotonic durations, wall-clock deadlines.** Durations use
`process.hrtime.bigint()` so an NTP step cannot produce a negative latency.
Persisted times are wall-clock because that is what "checked at 14:32" means. A
backward clock jump is detected via `lastChecked > now` and re-anchors the
schedule.

**The breaker protects the pool, not the data.** While open, no check runs and
**nothing is recorded** — we do not fabricate `DOWN` rows for checks we never
performed, because that would corrupt the uptime denominator. The consequence is
a genuine gap in the series for a long-dead endpoint, which is strictly better
than invented data.

---

## 4. Data model

```mermaid
erDiagram
    USER ||--o{ MONITOR : owns
    USER ||--o{ CHANNEL : owns
    MONITOR ||--o{ LOG : "produces (TTL 30d)"
    MONITOR ||--o{ INCIDENT : "opens at most 1 ongoing"
    INCIDENT ||--o{ NOTIFICATION_LOG : "dispatch audit"

    USER { objectid _id string email string password_hash bool isVerified }
    MONITOR { objectid userId string url int interval int failureThreshold string status string breakerState date nextCheckAt string authHeaders_encrypted }
    LOG { objectid monitorId string status int latency object timings date timestamp }
    INCIDENT { objectid monitorId objectid userId string status date startTime date endTime int duration }
    CHANNEL { objectid userId string type string target bool active }
    NOTIFICATION_LOG { objectid userId string event string channel string status }
```

**Indexes that carry weight**

| Index | Purpose |
|---|---|
| `monitors { active, nextCheckAt }` | The scheduler's hot query, every tick |
| `logs { monitorId, timestamp: -1 }` | Every dashboard query; without it, full scans |
| `logs { timestamp }` TTL 30d | Bounds growth; matches the widest uptime window |
| `incidents { monitorId }` unique, partial `status: ONGOING` | Makes a duplicate open **impossible**, not merely improbable |
| `scheduler_locks { expiresAt }` TTL | Garbage collection only — correctness is the query comparison |

**Two status fields, deliberately.** `status` is the *confirmed* state, debounced
by the flap thresholds and always in step with incidents. `lastCheckStatus` is
the raw result of the most recent check. Without both, the dashboard either lies
during a failure streak or contradicts the incident list.

---

## 5. Tenancy

Every tenant boundary is enforced in one of three places, never by a controller
remembering:

| Surface | Mechanism |
|---|---|
| REST | DAO injects the owner filter; missing owner **throws** |
| REST by-id | 404 for both "missing" and "not yours" — a 403 confirms the id exists |
| Realtime | Room derived from the verified token; no client-controlled join |
| Aggregations | Owner `$match` forced into the **first** pipeline stage |
| Writes | `create()` stamps ownership from the session; body `userId` ignored |

Logs and incidents carry no owner field of their own and are scoped through
monitor ownership. That costs one extra query and is correct for rows written
before the denormalisation existed — a `userId` scope would have silently hidden
every historical row from its rightful owner.

---

## 6. Observability

```mermaid
graph LR
    R["Request"] --> ID["x-request-id<br/>AsyncLocalStorage"]
    ID --> LOG["pino · JSON<br/>secrets redacted"]
    ID --> MET["prom-client"]
    SCHED["Scheduler"] --> MET
    NOTIF["Notifiers"] --> MET
    LOG --> OUT["stdout → platform"]
    MET --> EP["/metrics"]
    DB[("MongoDB")] --> RDY["/api/health/ready"]
    SCHED --> RDY
```

The request id propagates through `AsyncLocalStorage`, so a log line emitted
deep in the DAO carries the id of the request that caused it without any
function taking a `requestId` parameter.

**Liveness never touches a dependency.** `/api/health` is static; a liveness
probe that checks the database restarts every replica during a database outage,
turning a recoverable failure into a crash loop. `/api/health/ready` does check
— MongoDB with a real ping, plus the scheduler heartbeat — and returns 503 so a
broken replica leaves the load balancer while staying alive to recover.

**The scheduler heartbeat is the metric that matters.** A stopped scheduler is
this product's defining silent failure: the API answers, dashboards render the
last known state, and nobody is told their service is down. Nothing outside the
process can detect it.

---

## 7. Deployment

```mermaid
graph LR
    PR["Push / PR"] --> CI["CI"]
    CI --> L["lint + format"]
    CI --> T["tests · Node 20 + 22<br/>60% coverage gate"]
    CI --> S["audit gate + Trivy"]
    CI --> D["build both images<br/>assert non-root"]
    D --> SM["compose up<br/>health · SPA · 401 · SIGTERM"]
    SM --> OK["ci-ok"]
    OK -->|"merge to main"| DEP["deploy.yml"]
    DEP --> GH["push to GHCR<br/>latest + SHA"]
    GH --> RN["Render API deploy"]
    RN --> HC{"health check"}
    HC -->|pass| DONE["live"]
    HC -->|fail| RB["roll back to<br/>previously-live deploy"]
```

The rollback target is captured *before* anything changes — a rollback target
that moves is not a rollback target. A run that rolled back still reports
failure: a rollback is not a successful deploy.

Images are multi-stage, non-root, with `dumb-init` as PID 1. That last detail is
load-bearing: `npm start` does not forward SIGTERM, so the graceful shutdown
that drains in-flight checks and releases the scheduler lease never ran in a
container until it was fixed.

---

## 8. Known architectural limits

Stated here rather than discovered later.

| Limit | Consequence | Where it goes |
|---|---|---|
| Active/passive scheduling | Replicas scale the API, not the checking | Partitioned scheduling ([ADR 0004](adr/0004-mongodb-ttl-distributed-lock.md)) |
| MongoDB for time-series | ~10× storage overhead; 30d aggregation ceiling | TimescaleDB ([ADR 0002](adr/0002-mongodb-for-time-series.md)) |
| Single checking region | Cannot distinguish "target down" from "we can't reach it" | Multi-region probes |
| Lease, not fencing | A partitioned leader may overlap briefly | Tolerable: checks are idempotent |
| Socket.IO sticky sessions | Polling fallback needs sticky routing to scale out | Redis adapter |
