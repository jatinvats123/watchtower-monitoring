# ADR 0001 — Interval polling rather than push

**Status:** Accepted · **Date:** 2026-07-28

## Context

WatchTower must detect when a customer's HTTP endpoint stops responding. There
are two families of approach:

1. **Poll** — we send a request on a schedule and observe the answer.
2. **Push** — the target reports its own health to us (an agent, a heartbeat
   ping, a webhook on deploy events).

## Decision

Poll on a per-monitor interval. Do not offer push as the primary mechanism.

## Rationale

**Push cannot detect the failure that matters most.** If a target is completely
down — process dead, host unreachable, DNS broken — it also cannot send us a
heartbeat. Push therefore degrades to "we noticed the absence of a message",
which is polling with extra steps and a worse failure mode: silence is
indistinguishable from a broken agent, a network partition on the customer's
side, or a firewall rule changed last Tuesday.

**Polling measures what the user experiences.** A heartbeat says "the process
believes it is alive". A poll from outside says "a request from the public
internet completed in 340ms with a valid TLS certificate". Those are different
claims, and only the second one is what a customer's users actually experience.
Polling naturally captures DNS resolution, TCP connect, TLS validity and TTFB —
none of which an in-process agent can observe about itself.

**Zero integration cost.** A customer registers a URL. They install nothing,
deploy nothing, and grant us no access to their infrastructure. For a product
whose value is realised in the first sixty seconds, this matters more than any
technical elegance: an agent-based product that requires a deploy to evaluate
has already lost most of its trial users.

**The security posture is better in both directions.** We hold no credentials to
their infrastructure and run no code inside it. They accept no inbound
connection from us beyond ordinary HTTP traffic they already serve publicly.

## Consequences

**Detection is bounded by the interval.** A 60-second interval means up to 60
seconds of undetected downtime, and flap thresholds (N consecutive failures)
extend that further — the default `failureThreshold: 3` means confirmation takes
up to three intervals. This is a deliberate trade against alert noise, and both
values are configurable per monitor.

**Load scales with monitors × frequency.** Every monitor is a recurring
outbound request forever. This drove several other decisions: a bounded worker
pool, a per-monitor circuit breaker so a dead endpoint stops consuming a full
retry ladder, a 5-second floor on intervals so no one can configure us into
hammering a third party, and single-leader scheduling
([ADR 0004](0004-mongodb-ttl-distributed-lock.md)) so N replicas do not multiply
outbound traffic by N.

**We only see the target from one place.** A network fault between our host and
theirs is indistinguishable from the target being down. Multi-region checking is
the standard mitigation and is not implemented — recorded honestly as a
limitation in `docs/PRODUCTION-READINESS.md`.

**Polling third-party URLs is a request-forgery primitive.** A user can point a
monitor at `169.254.169.254` or an internal address and infer reachability from
status codes and timing. Partially mitigated at first (response bodies are
never returned, only status and timings; bodies capped; redirects capped; hard
deadline), and since closed by an egress guard that refuses internal addresses
at connect time — see SECURITY.md T9.

## Alternatives considered

**Agent-based push.** Rejected as primary for the reasons above. It remains the
right answer for metrics polling cannot obtain — queue depth, disk usage,
application-internal state — and would be a complement, not a replacement.

**Webhook-on-event.** Useful for enriching an incident timeline with deploy
markers. Useless for detecting outages, for the same reason as heartbeats.

**Hybrid: poll plus optional heartbeat.** Genuinely attractive — a heartbeat
that *stops* is a faster signal than a poll that fails, since it can be noticed
within one heartbeat period rather than one check interval. Deferred because it
doubles the state machine (a monitor would have two independent health signals
that can disagree) for a latency improvement that flap thresholds largely erase
anyway.
