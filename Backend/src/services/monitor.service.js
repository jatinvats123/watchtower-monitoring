import http from 'node:http';
import https from 'node:https';
import { schedulerConfig } from '../config/scheduler.config.js';
import { checkUrl, egressAgent, HTTP_PROTOCOLS } from '../utils/egress.js';

/**
 * HTTP probe.
 *
 * Implemented directly on node:http/node:https rather than axios because axios
 * gives us no access to the underlying socket lifecycle, and the connection
 * phases (DNS / TCP / TLS / TTFB) are exactly the signal a monitoring product
 * exists to report. "Total round-trip was 3s" is not actionable; "DNS took 2.8s
 * of a 3s round-trip" is.
 */

// Never read an unbounded body into memory — we only need timing and status.
// A monitored endpoint streaming gigabytes must not OOM the monitor.
const MAX_BODY_BYTES = 512 * 1024;

const MS = 1_000_000n; // hrtime nanoseconds per millisecond

/** Monotonic clock. Immune to NTP steps, DST and VM suspend/resume. */
const now = () => process.hrtime.bigint();
const msSince = (from) => Number((now() - from) / MS);

/**
 * Transport-level error codes worth retrying: transient by nature, where an
 * immediate second attempt genuinely can succeed.
 *
 * Deliberately excluded: ENOTFOUND (a stable DNS answer) and every TLS
 * certificate error (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT, ...). Those
 * are real, durable answers about the target's health — retrying them just
 * burns worker-pool slots to arrive at the same conclusion.
 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN', // transient DNS failure (vs. ENOTFOUND, which is an answer)
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'ESOCKETTIMEDOUT',
  'ERR_CHECK_TIMEOUT',
]);

/** A response is retryable if the server itself signalled overload/failure. */
const isRetryableStatus = (statusCode) =>
  statusCode === 408 || statusCode === 429 || statusCode >= 500;

/** scheme://host:port — the unit that outbound credentials are bound to. */
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * One HTTP attempt, following redirects, with genuine phase timings.
 *
 * Timing semantics across a redirect chain:
 *  - `dns`, `tcp`, `tls` are CUMULATIVE across every hop (total connection setup
 *    cost paid to serve this request);
 *  - `ttfb` is measured from the start of the chain to the first byte of the
 *    FINAL response;
 *  - `total` covers the whole chain including body drain.
 * A phase is null when it was never observed (no TLS on plain HTTP, no DNS for
 * an IP literal, nothing at all if the failure preceded that phase).
 *
 * Every hop goes through the egress guard (utils/egress.js): its URL is checked
 * before the request, and its socket can only connect to addresses the guard's
 * lookup approved. A target that is internal, or that redirects somewhere
 * internal, is reported DOWN with ERR_EGRESS_BLOCKED and is never contacted.
 *
 * @returns {Promise<object>} never rejects — a failed probe is a result, not an
 *   exception. The scheduler treats a thrown error and a DOWN result very
 *   differently, and "the target is down" must always be the latter.
 */
export function probeOnce(
  rawUrl,
  {
    timeoutMs = 10_000,
    ignoreTlsErrors = false,
    maxRedirects = 5,
    headers = {},
    // dns.lookup-compatible resolver for the egress guard; injectable for tests.
    dnsLookup,
  } = {}
) {
  return new Promise((resolve) => {
    const started = now();
    // The origin the monitor was configured against. Credentials are bound to
    // it and are dropped the moment a redirect leaves it.
    const initialOrigin = originOf(rawUrl);

    const timings = {
      dns: null,
      tcp: null,
      tls: null,
      ttfb: null,
      total: null,
    };
    let redirects = 0;
    let settled = false;
    let currentReq = null;

    // One deadline for the entire attempt, redirects included. Enforced with an
    // explicit timer rather than only the socket idle timeout: a target that
    // trickles one byte at a time never goes idle and would otherwise hold a
    // worker slot indefinitely.
    const deadline = setTimeout(() => {
      finish({
        status: 'DOWN',
        statusCode: null,
        error: `Check exceeded ${timeoutMs}ms deadline`,
        errorCode: 'ERR_CHECK_TIMEOUT',
        retryable: true,
      });
    }, timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      timings.total = msSince(started);
      resolve({
        redirects,
        responseTime: timings.total,
        timings,
        ...result,
      });

      // Tear the request down on EVERY settle path, not just the deadline.
      //
      // Several paths finish while the exchange is still open — the redirect cap,
      // the body-size cap, any error mid-response. Resolving the promise does not
      // close the connection, so without this the socket stays open until the
      // peer or the OS gives up. A scheduler running thousands of checks leaks
      // file descriptors that way, and the symptom (EMFILE, much later, under
      // load) points nowhere near the cause.
      //
      // After `settled = true`, so the ECONNRESET / premature-close that destroy
      // provokes lands on `fail` and is swallowed by the guard above rather than
      // escaping as an unhandled 'error' event.
      currentReq?.destroy();
    }

    function fail(err) {
      finish({
        status: 'DOWN',
        statusCode: null,
        error: err?.message || 'Request failed',
        errorCode: err?.code || 'ERR_UNKNOWN',
        retryable: RETRYABLE_CODES.has(err?.code),
      });
    }

    function request(targetUrl) {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return finish({
          status: 'DOWN',
          statusCode: null,
          error: `Invalid URL: ${targetUrl}`,
          errorCode: 'ERR_INVALID_URL',
          retryable: false, // a malformed URL will never fix itself
        });
      }

      // Checked on EVERY hop, not just the first: a public URL that 302s to
      // http://169.254.169.254/ is the oldest SSRF trick there is. Neither a bad
      // scheme nor an internal address fixes itself, so neither is retryable.
      try {
        checkUrl(parsed, { protocols: HTTP_PROTOCOLS });
      } catch (err) {
        return finish({
          status: 'DOWN',
          statusCode: null,
          error: err.message,
          errorCode: err.code,
          retryable: false,
        });
      }

      const isHttps = parsed.protocol === 'https:';

      // Credentials must never survive a cross-origin redirect. A monitored
      // endpoint that 302s to another host would otherwise be handed the
      // customer's Authorization header — an open redirect on their side would
      // become credential exfiltration on ours.
      const sameOrigin = originOf(targetUrl) === initialOrigin;
      const outboundAuth = sameOrigin ? headers : {};

      const transport = isHttps ? https : http;
      const hopStart = now();

      const req = transport.request(
        targetUrl,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'WatchTower/1.0 (+uptime monitoring)',
            Accept: '*/*',
            // We drain and discard the body; no reason to pay for compression.
            'Accept-Encoding': 'identity',
            // Caller-supplied last so a monitor can override defaults, but only
            // on the origin it was configured for (see sameOrigin above).
            ...outboundAuth,
          },
          // A fresh agent, and so a fresh socket, per attempt. Connection reuse
          // would make DNS/TCP/TLS read as 0ms on every check after the first —
          // technically true, but it hides exactly the regressions we are here
          // to catch. Its lookup is the egress guard, so the address that was
          // validated is the address that gets connected to.
          agent: egressAgent(parsed.protocol, { dnsLookup }),
          // Certificate validation defaults ON. An expired cert is an outage,
          // and the previous implementation disabled this globally, making the
          // monitor structurally blind to it.
          rejectUnauthorized: !ignoreTlsErrors,
        },
        (res) => {
          timings.ttfb = msSince(started);

          const location = res.headers.location;
          if (
            location &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            redirects < maxRedirects
          ) {
            redirects += 1;
            res.resume(); // discard body, free the socket
            // Location may be relative; resolve against the current URL.
            return request(new URL(location, targetUrl).toString());
          }

          if (location && redirects >= maxRedirects) {
            res.resume();
            return finish({
              status: 'DOWN',
              statusCode: res.statusCode,
              error: `Exceeded ${maxRedirects} redirects`,
              errorCode: 'ERR_TOO_MANY_REDIRECTS',
              retryable: false,
            });
          }

          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) res.destroy();
          });
          res.on('error', () => {
            // A body that fails mid-stream after headers arrived still tells us
            // the server answered; grade on the status code we already have.
            settleWithStatus(res.statusCode);
          });
          res.on('end', () => settleWithStatus(res.statusCode));
          res.on('close', () => settleWithStatus(res.statusCode));
        }
      );

      function settleWithStatus(statusCode) {
        // 2xx/3xx = UP, matching the previous behaviour.
        const up = statusCode >= 200 && statusCode < 400;
        finish({
          status: up ? 'UP' : 'DOWN',
          statusCode,
          error: up ? null : `HTTP ${statusCode}`,
          errorCode: up ? null : `HTTP_${statusCode}`,
          retryable: up ? false : isRetryableStatus(statusCode),
        });
      }

      currentReq = req;

      req.on('socket', (socket) => {
        // A socket can emit 'error' independently of the request — and can do
        // so AFTER we have already settled (a late RST, or a redirect hop whose
        // predecessor is still tearing down). An 'error' event with no listener
        // is thrown as an uncaught exception and takes the process down, so a
        // monitoring service must never leave one unhandled. `fail` is
        // idempotent via the `settled` guard, so a late error is a no-op.
        socket.on('error', fail);

        // `connecting === false` means a pooled socket; with agent:false that
        // should not happen, but guard rather than record misleading zeroes.
        if (!socket.connecting) return;

        // Phase marks are HOP-LOCAL. The cumulative `timings.*` totals must not
        // be used to derive them, or hop 2 would subtract hop 1's accumulated
        // time from its own elapsed and go negative.
        let hopDns = null;
        let hopTcp = null;

        socket.once('lookup', () => {
          hopDns = msSince(hopStart);
          timings.dns = (timings.dns ?? 0) + hopDns;
        });
        socket.once('connect', () => {
          hopTcp = Math.max(0, msSince(hopStart) - (hopDns ?? 0));
          timings.tcp = (timings.tcp ?? 0) + hopTcp;
        });
        socket.once('secureConnect', () => {
          const hopTls = Math.max(
            0,
            msSince(hopStart) - (hopDns ?? 0) - (hopTcp ?? 0)
          );
          timings.tls = (timings.tls ?? 0) + hopTls;
        });
      });

      req.on('error', fail);
      req.end();
    }

    request(rawUrl);
  });
}

/** `delay = random(0, min(base * 2^attempt, cap))` — exponential, full jitter. */
export function backoffDelay(
  attempt,
  base = schedulerConfig.RETRY_BASE_MS,
  cap = schedulerConfig.RETRY_CAP_MS
) {
  const ceiling = Math.min(base * 2 ** attempt, cap);
  // Full jitter, not fixed backoff: without it every monitor failing against a
  // shared upstream retries in lockstep and hammers it in synchronised waves.
  return Math.floor(Math.random() * ceiling);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A complete check: one probe plus its retry ladder.
 *
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.timeoutMs   per-attempt deadline
 * @param {number} opts.maxRetries  0 disables retries (used for HALF_OPEN probes)
 * @param {boolean} opts.ignoreTlsErrors
 * @returns {Promise<object>} the final attempt's result, plus `attempts`
 */
export async function checkMonitor(url, opts = {}) {
  const {
    timeoutMs = 10_000,
    maxRetries = schedulerConfig.MAX_RETRIES,
    ignoreTlsErrors = false,
    headers = {},
  } = opts;

  let result;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    result = await probeOnce(url, { timeoutMs, ignoreTlsErrors, headers });
    result.attempts = attempt + 1;

    if (result.status === 'UP' || !result.retryable) return result;

    if (attempt < maxRetries) await sleep(backoffDelay(attempt));
  }
  return result;
}

export default { checkMonitor, probeOnce, backoffDelay };
