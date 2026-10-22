# Security Policy & Threat Model

WatchTower is a multi-tenant monitoring platform: every user's monitors,
incidents, logs and alert channels are private to them, and the service holds
outbound credentials for third-party endpoints. This document states what we
defend against, how, and — just as importantly — what we currently do not.

It began as a four-person hackathon project. Several items below are honest
records of accepted risk rather than claims of completeness.

---

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the
maintainer listed in `CONTRIBUTORS.md`. Please do not open a public issue for an
unpatched vulnerability.

Include: affected endpoint or component, reproduction steps, and what an
attacker gains. We aim to acknowledge within 72 hours.

---

## 1. Assets

Ranked by what an attacker gains from compromising them.

| Asset | Why it matters |
|---|---|
| **Outbound monitor credentials** | Auth headers for customers' *internal* APIs. Compromise pivots the attacker into systems that are not ours. Highest value in the system. |
| **User credentials** | Password hashes, reset tokens, session JWTs. |
| **Tenant monitoring data** | Which endpoints a customer runs, their URLs, and when they were down. Commercially sensitive and a reconnaissance map of their infrastructure. |
| **Notification channels** | Email addresses and webhook URLs — an abuse channel for phishing under our name. |
| **The scheduler itself** | Makes authenticated outbound requests on a timer. An attacker who controls monitor URLs has a request-forgery primitive. |

## 2. Trust boundaries

```
 Browser ──HTTPS──▶ Express (REST)     ─┐
    │                                   ├─▶ DAO layer ──▶ MongoDB
    └───WSS───▶ Socket.IO (rooms)      ─┘
                       │
 Scheduler (leader) ───┴──▶ outbound HTTP to customer-supplied URLs
                            outbound SMTP / webhooks
```

Untrusted input crosses three boundaries: the browser (request bodies, query
strings, socket frames), **the monitored targets** (their response bodies,
headers, redirects and TLS certificates), and the AI provider's output.
Responses from monitored targets are attacker-controlled from our perspective —
anyone can point a monitor at a server they own.

---

## 3. Threats and controls

### T1 — Cross-tenant data access *(the defect this project actually had)*

A data-exposure bug was patched late in the hackathon (commit `e7c8494`) with no
test to keep it closed. Phase 0 confirmed the REST leaks were shut, but tenancy
was enforced *by convention*: every controller individually had to remember
`{ userId }`. One forgotten filter would reopen it.

**Controls**

- **Owner-scoped DAO layer** (`src/dao/`). Queries take an owner id as their
  first argument and **throw `UnscopedQueryError` if it is missing or
  malformed**. There is no code path that reads a collection unscoped.
- The owner filter is applied by the DAO and **intersected** (`$and`) with any
  caller filter, so a hostile `{ userId: <someone else> }` yields an empty
  result rather than a wider one. Queries fail closed.
- `create()` stamps ownership from the session; `userId` in a request body is
  ignored.
- By-id misses return **404, not 403**, so the API cannot be used to confirm
  that an id exists.
- Zod schemas strip undeclared fields at the edge — a second, independent layer.

**Verification** — `tests/security/tenancy.test.js` and `dao.test.js`: two
tenants with identical data shapes; every read path asserted by id and by list.
`aggregate()` forces the owner `$match` into the first stage.

### T2 — Cross-tenant leakage over WebSockets

Realtime is the easiest place to leak tenancy: rooms are invisible in the HTTP
surface, and a single `io.emit` reaches every connected customer.

**Controls**

- JWT verified **at handshake**; a socket with no valid token never connects.
  A token that verifies but carries no subject is also rejected — an unscopeable
  socket must not exist.
- Each socket joins exactly one room, derived from the **verified token**, never
  from client input. There is deliberately no `join`/`subscribe` handler, so
  membership cannot be widened after connect.
- All tenant data goes through `emitToUser()`, which is room-addressed. Nothing
  in the codebase calls `io.emit`.
- `emitToUser` with a falsy id is a **no-op, never a broadcast**: the failure
  mode of a bug here must be "nobody is notified".
- A second, **unauthenticated** Socket.IO server existed at `src/config/socket.js`
  (no `io.use`, no rooms). It was unused but one stray import from being live.
  **Deleted.**

**Verification** — `tests/security/socket.test.js`, including a test that Bob's
socket receives nothing when an event is emitted to Alice.

### T3 — NoSQL operator injection

`{"email": {"$gt": ""}}` in a login body would match the first user in the
collection and return a session for an account the caller does not own.

**Controls** — `express-mongo-sanitize` strips `$`-prefixed and dotted keys from
body, query and params; `hpp` collapses duplicated parameters so an array cannot
be smuggled where a scalar is expected.

> **Express 5 note.** Both libraries work by reassigning `req.query`, which is a
> getter-only property in Express 5 — unpatched, every request 500s. A shim
> (`makeQueryWritable`) redefines the slot as writable. Verified against
> express 5.2.1 / express-mongo-sanitize 2.2.0 / hpp 0.2.3.

### T4 — Credential theft from the database

Monitors may store `Authorization` headers for targets behind auth. Plaintext
storage would mean one database dump hands an attacker working credentials to
every customer's internal APIs — strictly worse than losing our own data.

**Controls**

- **AES-256-GCM** envelope encryption (`src/utils/crypto.js`), format
  `v1:<iv>:<tag>:<ciphertext>`. GCM is authenticated, so tampered ciphertext
  fails loudly instead of decrypting to garbage that then gets sent as a header.
- Key from `CREDENTIALS_ENCRYPTION_KEY`, never in the repo. The version prefix
  exists so the key can be rotated without guessing how a row was written.
- The field is `select: false` — it cannot be returned by accident; the
  scheduler opts in explicitly. The API returns only a `hasAuthHeaders` boolean.
- If no key is configured, storing credentials **errors** rather than silently
  writing plaintext into a field named "encrypted".

### T5 — Credential leakage via redirect

A monitored endpoint we send an `Authorization` header to could `302` to a host
the attacker controls. An open redirect on the customer's side would become
credential exfiltration on ours.

**Control** — outbound credentials are bound to the monitor's original origin
and dropped the moment a redirect leaves it.

### T6 — Brute force and credential stuffing

The single 300-req/15-min limiter permitted roughly 20 password guesses a minute,
indefinitely.

**Controls**

- `/api/auth/login|register|verify|change-password`: **10 per 15 min**, with
  `skipSuccessfulRequests` so a legitimate user behind NAT is not locked out by
  their own success.
- `/api/auth/forgot-password|reset-password`: **5 per hour** — each request
  sends real email, so an unthrottled endpoint is both an enumeration oracle and
  a way to spend our SMTP reputation spamming a third party.
- Passwords hashed with bcrypt; `password` is `select: false`.

### T7 — Secret leakage through logs

`registerUser` opened with `console.log(req.body)`, writing every new user's
**plaintext password** to stdout and onward into the platform's log aggregator,
where it is retained and searchable.

**Control** — removed. Never log a request body on a credential endpoint.
Phase 6 adds structured logging with explicit redaction.

### T8 — CORS misconfiguration

**Controls** — env-driven allow-list. `config.js` **throws at boot** if
`CORS_ORIGIN` contains `*`, or if it is empty in production. Socket.IO now uses
the same allow-list as the REST API rather than a separate single-origin value.

### T9 — Server-side request forgery

The scheduler fetches user-supplied URLs and webhooks POST to them. Unguarded, a
user could point a monitor at `http://169.254.169.254/` or an internal address
and infer reachability from status codes and latency.

**Controls** — every user-chosen outbound request goes through one egress guard,
`Backend/src/utils/egress.js`:

- only `http:` and `https:` are allowed;
- the target is refused if any resolved address is loopback, RFC 1918,
  link-local, CGNAT, `0.0.0.0/8`, multicast, reserved, IPv6 unique-local, or the
  IPv4-mapped or NAT64 form of one of these. The URL parser canonicalises IP
  literals first, so decimal, octal and hex spellings get the same verdict;
- the check runs in the agent's `lookup`, so the validated address is the one
  connected to (no DNS-rebinding window), on every retry and every redirect hop;
- webhooks do not follow redirects;
- creating or updating a monitor or webhook with an internal target returns 400.

Response bodies are still never returned (status and timings only), bodies are
capped at 512 KB, redirects at 5, and every check has a hard deadline.

`ALLOW_PRIVATE_TARGETS=true` turns the address checks off for self-hosted
instances that monitor internal services. It must stay off wherever untrusted
users can register, which includes the public demo.

### T10 — Denial of service against monitored targets

An unbounded scheduler is an outbound attack tool. Controls: per-monitor
interval floor of **5 s**, bounded worker pool, per-monitor circuit breaker, and
skip-not-queue overlap handling so a struggling target is never piled onto. See
`docs/SCHEDULER.md`.

### T11 — XSS via injected content in alert emails

Monitor titles are free text, and AI summaries derive from remote servers'
error strings — both attacker-influenced, both previously interpolated raw into
alert email HTML.

**Control** — all template interpolation is HTML-escaped
(`src/notifications/templates.js`).

---

## 4. Authentication & session model

- JWT in an **httpOnly, `sameSite: 'strict'`** cookie; `secure` in production.
- `sameSite: 'strict'` is the primary CSRF control. There is no separate CSRF
  token — see §5.
- Same cookie and secret for REST and Socket.IO, from a single
  `config.AUTH_COOKIE` constant so the two cannot drift apart.

---

## 5. Known limitations — accepted, not solved

Stated plainly because a threat model that claims completeness is not credible.

| # | Limitation | Risk | Why it stands |
|---|---|---|---|
| 1 | **`AUTO_VERIFY_USERS` defaults to on** — registration skips email verification | Account spam under arbitrary addresses | Was a hardcoded `user.isVerified = true` marked "remove in production". Now a single env var, and it warns loudly at boot in production. Default preserved so the live demo keeps working; set `AUTO_VERIFY_USERS=false` to close it. |
| 2 | **No CSRF token** | Relies solely on `sameSite: 'strict'` | Adequate against classic CSRF in current browsers, but defence in depth is missing. |
| 3 | **JWT returned in the response body** as well as the cookie | Widens exposure to any XSS | Kept because the current frontend reads it. Should be cookie-only. |
| 4 | **No token revocation** | A stolen JWT is valid until expiry | Needs a denylist or short-lived tokens plus refresh. |
| 5 | **No audit log** of security-relevant actions | Weak forensics after an incident | Notification dispatch is logged; auth events are not. |
| 6 | **Secrets in platform env vars**, no managed secret store or rotation | Broad blast radius if the platform account is compromised | Appropriate to the current deployment tier. |
| 7 | **No account lockout** after repeated failures | Rate limiting only | Lockout introduces its own DoS vector; deliberately deferred. |
| 8 | **Dependency vulnerabilities unaudited** at time of writing | Unknown | `npm audit` reports outstanding advisories. Phase 5 adds an audit gate to CI. |

---

## 6. Security testing

`tests/security/` — 62 assertions covering tenancy isolation by id and by list
across monitors, incidents, logs and metrics; DAO refusal of unscoped queries;
Socket.IO handshake auth and room isolation; NoSQL operator injection; and
credential encryption at rest.

These sit inside a wider suite of **284 tests** (auth lifecycle, scheduler,
incident lifecycle, notification channels, uptime aggregation, HTTP probe),
gated at 60% statement coverage in CI.

Run with `npm test --prefix Backend`.

These are regression tests. The point is not that the system is secure today —
it is that the specific defect this project actually shipped cannot come back
silently.
