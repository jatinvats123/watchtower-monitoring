# WatchTower

Uptime and incident monitoring for HTTP and API endpoints, with live status over
WebSockets.

[![CI](https://github.com/jatinvats123/watchtower-monitoring/actions/workflows/ci.yml/badge.svg)](https://github.com/jatinvats123/watchtower-monitoring/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jatinvats123/watchtower-monitoring/main/.github/badges/coverage.json)](https://github.com/jatinvats123/watchtower-monitoring/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022-green)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-blue)](https://react.dev)
[![License](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)

**[Live demo →](https://watchtower-monitoring.onrender.com)**
 · [API docs](https://watchtower-monitoring.onrender.com/api/docs)

> Free-tier hosting sleeps when idle. A scheduled workflow
> ([keep-warm.yml](.github/workflows/keep-warm.yml)) keeps the demo awake from
> about 08:30 to 21:30 IST; outside those hours the first request can take up
> to a minute.

> **Origin:** WatchTower began as a hackathon project built by a team of four.
> It has since been rebuilt for production. See
> [CONTRIBUTORS.md](CONTRIBUTORS.md) for who owned what — the split is derived
> from the git history, not from memory.

---

## Overview

WatchTower polls the endpoints you register at configurable intervals, records
latency and status for each check, opens an incident when a target fails
consistently, and closes it when the target recovers. Live status changes stream
to connected dashboards over Socket.IO.

The interesting engineering is in the scheduler rather than the CRUD. It skips
overlapping checks when a target responds more slowly than its own interval,
survives process restarts without losing schedule state, uses a TTL-based
distributed lock so multiple instances do not double-poll, and applies flap
detection so a single blip does not page anyone.

Design decisions and their costs are recorded in [`docs/adr/`](docs/adr/).

---

## Features

**Monitoring**

- HTTP and API endpoint checks at configurable intervals
- Per-check timeouts, retry with jittered exponential backoff, and a circuit
  breaker per target
- Real connection-phase latency recorded per check — DNS, TCP, TLS, TTFB, total
  — measured from the socket, with a TTL index bounding storage growth
- Uptime over 24h / 7d / 30d computed by a single MongoDB aggregation
- TLS certificate validation on by default, because an expired certificate is an
  outage

**Incidents**

- Flap detection: an incident opens only after N consecutive failures and closes
  after M consecutive successes, both configurable per monitor
- Incident timeline with the check history that triggered it
- Email notification on open and close, behind a pluggable notifier interface
  (a webhook/Slack notifier was added without touching incident logic)

**Status pages**

- Public availability pages at `/status/:slug`, readable without an account —
  the one unauthenticated read in the product
- The published payload is an allow-list, not a redaction: display name, state,
  uptime and average latency. Monitored URLs, stored request credentials, owner
  and monitor ids never leave the server
- Paused monitors are reported as `PAUSED`, and uptime with no checks behind it
  as `null` rather than 100% — a status page that rounds up is worse than none
- Its own rate-limit budget, because a status page gets its heaviest traffic
  during exactly the incident it exists to report

**Platform**

- Real-time status over Socket.IO with JWT-authorised, room-scoped delivery
- Centralised log views and dashboard analytics
- Prometheus metrics at `/metrics` — the monitoring service monitors itself
- Liveness and readiness endpoints, including a scheduler heartbeat
- OpenAPI 3.1 spec with Swagger UI at `/api/docs`

**Security**

- JWT authentication, bcrypt hashing, email verification, password reset
- Optional Google sign-in (Google Identity Services), with the ID token verified
  server-side against Google's keys and its `aud` claim checked — an existing
  local account is linked only on a Google-verified address
- Password reset tokens stored as SHA-256 hashes, single-use, 15-minute expiry,
  and the request endpoint answers identically for unknown addresses so it
  cannot be used to enumerate accounts
- Every query owner-scoped at the data-access layer — an unscoped query throws
  rather than returning every tenant's data
- Helmet, tiered rate limiting, request sanitisation, CORS allow-list
- Outbound monitor credentials encrypted at rest (AES-256-GCM)
- Threat model in [SECURITY.md](SECURITY.md), including accepted risks

---

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, Vite, React Router 7, Redux Toolkit, Socket.IO client, Recharts |
| Backend | Node.js 20, Express 5, MongoDB 7, Mongoose, Socket.IO |
| Auth | JWT, bcryptjs, Nodemailer |
| Testing | Jest, Supertest, nock, mongodb-memory-server |
| Ops | Docker, Docker Compose, GitHub Actions, Pino, prom-client, Trivy |
| Hosting | Render |

---

## Architecture

```
                       ┌──────────────────┐
   Browser ──────────► │   React SPA      │
                       └────┬─────────┬───┘
                     REST   │         │  Socket.IO (JWT handshake,
                            │         │            user-scoped rooms)
                            ▼         ▼
                       ┌──────────────────┐
                       │   Express API    │
                       │   + DAO layer    │
                       └────┬─────────┬───┘
                            │         │
              ┌─────────────┘         └──────────────┐
              ▼                                      ▼
      ┌────────────────┐                    ┌─────────────────┐
      │   Scheduler    │                    │  Notifiers      │
      │ · TTL lock     │                    │  (email/webhook)│
      │ · backoff      │                    └─────────────────┘
      │ · circuit brkr │
      │ · flap detect  │
      └───────┬────────┘
              │ checks
              ▼
   ┌─────────────────────┐        ┌──────────────┐
   │  Monitored targets  │        │   MongoDB    │
   │  (external HTTP)    │        │ monitors     │
   └─────────────────────┘        │ logs (TTL)   │
                                  │ incidents    │
                                  │ users        │
                                  └──────────────┘
```

The SPA is built into `Backend/public/dist` and served by the same Express
process, so production is a single service and a single origin.

Detailed request-flow and scheduler-execution diagrams:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Folder structure

```
watchtower-monitoring/
├── Backend/
│   ├── server.js
│   └── src/
│       ├── app.js
│       ├── config/          # env validation, db, logger, scheduler config
│       ├── routes/
│       ├── middlewares/     # auth, sanitisation, rate limits, error handler
│       ├── controllers/
│       ├── dao/             # owner-scoped data access
│       ├── services/        # probe, incidents, uptime, lock, circuit breaker
│       ├── models/
│       ├── jobs/            # scheduler
│       ├── notifications/   # registry, email, webhook, templates
│       ├── observability/   # metrics, request context
│       ├── sockets/         # authorised rooms + event emission
│       └── docs/            # openapi.yaml
│   └── tests/               # 323 tests
│
├── Frontend/
│   └── src/
│       ├── app/             # routes (lazy), store, shell
│       ├── components/ui/   # error boundary, skeletons, status, empty states
│       ├── features/
│       │   ├── auth/
│       │   └── monitoring/
│       └── lib/             # api client, socket + reconnection
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SCHEDULER.md
│   ├── RUNBOOK.md
│   ├── PRODUCTION-READINESS.md
│   └── adr/
├── scripts/                 # audit gate, coverage badge, lockfile sync
├── .github/workflows/
├── docker-compose.yml
└── README.md
```

---

## Setup

**Prerequisites:** Node.js 20 or 22, Docker (recommended) or MongoDB 7+

```bash
git clone https://github.com/jatinvats123/watchtower-monitoring.git
cd watchtower-monitoring

cp Backend/.env.example Backend/.env
# Set JWT_SECRET at minimum. See the table below.

docker compose up --build        # app :8000 · mongo :27017
```

The backend image builds the SPA itself, so there is no separate frontend build
step. Open <http://localhost:8000>.

### Local without Docker

```bash
npm run install:all
npm run dev:backend       # :8000
npm run dev:frontend      # :5173, proxied to the backend
```

### Scripts

```bash
npm run lint              # both packages
npm run format            # prettier
npm test                  # full backend suite
npm run test:coverage     # with the 60% gate
npm run audit             # dependency gate with documented allowlist
npm run docker:up         # compose up --build
npm run lockfiles:sync    # regenerate lockfiles on Linux (see note below)
```

> **Lockfiles.** npm resolves optional native dependencies differently per
> platform, so an `npm install` on Windows or macOS can desync the lockfile for
> the Docker build and CI. Run `npm run lockfiles:sync` after changing
> dependencies on a non-Linux machine.

---

## Environment variables

### `Backend/.env`

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | API port. Defaults to `8000` |
| `NODE_ENV` | yes | `development` \| `production` \| `test` |
| `MONGO_URL` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Signing secret, 32+ random bytes |
| `JWT_EXPIRY` | yes | e.g. `7d` |
| `CORS_ORIGIN` | yes | Comma-separated allow-list. `*` is rejected at boot |
| `FRONTEND_URL` | yes | Used in emailed links |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | yes | Mail transport for verification and alerts |
| `CREDENTIALS_ENCRYPTION_KEY` | no | 32 bytes hex. Required only to store outbound monitor credentials |
| `MISTRAL_API_KEY` | no | AI incident summaries. Degrades gracefully if unset |
| `GOOGLE_CLIENT_ID` | no | Enables Google sign-in. Left empty the route returns 501, the button is not rendered, and the CSP keeps its strict default |
| `AUTO_VERIFY_USERS` | no | Skips email verification. Defaults `true` — see SECURITY.md §5 |
| `SCHEDULER_ENABLED` | no | Set `false` on replicas that should not poll |
| `SCHEDULER_TICK_MS` | no | Scheduler wake-up. Defaults `5000` |
| `SCHEDULER_CONCURRENCY` | no | Max concurrent checks. Defaults `10` |
| `SCHEDULER_LOCK_TTL_MS` | no | Leader lease TTL. Defaults `30000` |
| `CHECK_MAX_RETRIES` | no | Retries per check. Defaults `2` |
| `BREAKER_FAILURE_THRESHOLD` | no | Consecutive failures before the breaker opens. Defaults `5` |
| `LOG_RETENTION_DAYS` | no | TTL on check history. Defaults `30` |
| `LOG_LEVEL` | no | Pino level |
| `METRICS_TOKEN` | no | Requires a bearer token on `/metrics` when set |
| `ALLOW_PRIVATE_TARGETS` | no | Defaults `false`. Set `true` only on a self-hosted instance that must monitor internal services: monitors and webhooks may then reach loopback, private and link-local addresses. See [Security](#security) |

Per-monitor `interval`, `timeout`, `failureThreshold` and `successThreshold`
override the global defaults.

### `Frontend/.env`

Every value defaults to same-origin and **nothing is required** — the SPA is
served by the API, so relative paths are correct out of the box.

| Variable | Required | Description |
|---|---|---|
| `VITE_BACKEND_URL` | no | Only for split-origin deployments |
| `VITE_GOOGLE_CLIENT_ID` | no | Must match `GOOGLE_CLIENT_ID` in the backend. Read at **build** time, so changing it needs a rebuild, not a restart. Empty hides the button |

---

## Testing

```bash
npm run test:coverage --prefix Backend
```

323 tests across 19 suites: auth lifecycle, tenancy isolation, the DAO's refusal
of unscoped queries, Socket.IO room isolation, scheduler behaviour (fake timers
for cadence, real timers for behaviour), incident lifecycle, notification
channels, uptime aggregation, the HTTP probe, health/metrics, and the OpenAPI
spec.

Coverage is gated at 60% statements in CI; the DAO and scheduler carry stricter
per-file gates because a regression there is expensive.

---

## Deployment

CI runs lint, tests across Node 20 and 22, a dependency-audit gate, Trivy scans,
both Docker builds, and a `docker compose` integration smoke test that asserts
health, readiness, the served SPA, a rejected unauthenticated request, and a
clean SIGTERM drain.

On merge to `main`, images are published to GHCR tagged with both `latest` and
the commit SHA, the Render deploy is triggered via API, and a post-deploy health
check runs. **If it fails, the previously-live deploy is restored automatically**
and the run still reports failure — a rollback is not a successful deploy.

Deploy requires `RENDER_API_KEY` and `RENDER_SERVICE_ID` as GitHub repository
secrets (Settings → Secrets and variables → Actions).

---

## Operations

- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — seven alerts with diagnosis and recovery
- [`docs/SCHEDULER.md`](docs/SCHEDULER.md) — the scheduler's behavioural contract
- [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md) — before/after
  measurements and honest remaining limitations
- `/api/health` · `/api/health/ready` · `/metrics` · `/api/docs`

---

## Security

Monitors and webhooks make the server send requests to URLs that users type in.
Every one of those requests goes through one egress guard
([`Backend/src/utils/egress.js`](Backend/src/utils/egress.js)) so it cannot be
turned against internal networks (SSRF):

- **Schemes:** only `http` and `https`.
- **Addresses:** the hostname is resolved and the target is refused if _any_
  address is loopback, private (RFC 1918), link-local (including the cloud
  metadata service at `169.254.169.254`), CGNAT (`100.64.0.0/10`),
  `0.0.0.0/8`, multicast, reserved, IPv6 unique-local, or an IPv4-mapped IPv6
  form of any of these. IP literals get the same verdict however they are
  written: decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f000001`,
  bracketed IPv6.
- **No DNS rebinding:** the check runs in the socket's `lookup`, so the address
  that was validated is the address that is connected to.
- **Redirects:** every hop of a monitor check is checked again (5 hops at most).
  Webhook redirects are not followed.
- **Clear errors:** creating or editing a monitor or webhook with an internal
  target returns `400` with the reason, and the UI shows it.

Self-hosting and need to monitor internal services? Set
`ALLOW_PRIVATE_TARGETS=true`. It is off by default and should stay off anywhere
people you don't trust can sign up. The scheme check applies either way. Threat
model: [`SECURITY.md`](SECURITY.md) T9.

---

## Future improvements

- Additional check types: TCP port, DNS resolution, SSL expiry, keyword assertion
- Public per-tenant status pages with subscriber notifications
- Escalation policies and on-call rotations
- Move time-series storage to TimescaleDB
  ([ADR 0002](docs/adr/0002-mongodb-for-time-series.md) describes the trigger)
- Multi-region checking, to distinguish "target is down" from "our region cannot
  reach it"
- Partitioned scheduling, so replicas scale checking and not just the API
- Anomaly detection on latency rather than fixed thresholds

---

## License

Released under the ISC License. See [LICENSE](LICENSE).

---

## Contact

**Jatin Vats** — Full Stack Developer, Delhi, India
[Email](mailto:jatinvats653@gmail.com) · [GitHub](https://github.com/jatinvats123)
