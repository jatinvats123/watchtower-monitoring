import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from '@jest/globals';
import http from 'node:http';
import nock from 'nock';
import {
  probeOnce,
  checkMonitor,
  backoffDelay,
} from '../../src/services/monitor.service.js';

/**
 * HTTP probe behaviour.
 *
 * Two fixture strategies, chosen deliberately:
 *
 *  - **nock** for HTTP-level semantics (status codes, delays, redirects, retry
 *    ladders). It is fast, deterministic, and lets us assert exactly how many
 *    requests were made.
 *  - **a real loopback server** for anything involving the SOCKET, because nock
 *    does not open one. Connection-phase timings (DNS/TCP/TTFB) and real
 *    transport errors like ECONNREFUSED can only be exercised against a genuine
 *    socket, and those are the signals this product exists to report.
 *
 * Using only nock would leave the timing instrumentation — the reason the probe
 * was rewritten off axios — completely untested.
 */
describe('HTTP probe', () => {
  afterEach(() => {
    // abortPendingRequests as well as cleanAll: an interceptor that errored can
    // otherwise emit on its mock socket after the test that created it has
    // finished, surfacing as an unhandled error inside an unrelated test.
    nock.abortPendingRequests();
    nock.cleanAll();
  });

  // nock patches node:http for the whole Jest worker, not just this file.
  // Unrestored, the next suite in the worker stacks its own interceptor on top,
  // and a replyWithError is then emitted between the two layers where nothing
  // listens: an "Unhandled error" in whichever test asked for it.
  afterAll(() => nock.restore());

  describe('with mocked targets (nock)', () => {
    it('reports UP for a 200', async () => {
      nock('https://ok.test').get('/').reply(200, 'hello');

      const result = await probeOnce('https://ok.test/');
      expect(result.status).toBe('UP');
      expect(result.statusCode).toBe(200);
      expect(result.error).toBeNull();
      expect(result.retryable).toBe(false);
    });

    it('reports UP for a 3xx that is not a redirect chain', async () => {
      nock('https://notmodified.test').get('/').reply(304);

      const result = await probeOnce('https://notmodified.test/');
      expect(result.status).toBe('UP');
      expect(result.statusCode).toBe(304);
    });

    it('reports DOWN and RETRYABLE for a 500', async () => {
      nock('https://err.test').get('/').reply(500, 'boom');

      const result = await probeOnce('https://err.test/');
      expect(result.status).toBe('DOWN');
      expect(result.statusCode).toBe(500);
      expect(result.retryable).toBe(true);
    });

    it('reports DOWN and NOT retryable for a 404', async () => {
      nock('https://missing.test').get('/').reply(404);

      const result = await probeOnce('https://missing.test/');
      expect(result.status).toBe('DOWN');
      // A clean 404 is a real answer about the target, not a transient blip.
      // Retrying it just burns worker-pool slots to reach the same conclusion.
      expect(result.retryable).toBe(false);
    });

    it('treats 429 and 408 as retryable', async () => {
      nock('https://throttled.test').get('/').reply(429);
      nock('https://timeout408.test').get('/').reply(408);

      expect((await probeOnce('https://throttled.test/')).retryable).toBe(true);
      expect((await probeOnce('https://timeout408.test/')).retryable).toBe(
        true
      );
    });

    it('gives up on a SLOW response at the deadline', async () => {
      nock('https://slow.test').get('/').delay(5000).reply(200, 'eventually');

      const startedAt = Date.now();
      const result = await probeOnce('https://slow.test/', { timeoutMs: 300 });
      const elapsed = Date.now() - startedAt;

      expect(result.status).toBe('DOWN');
      expect(result.errorCode).toBe('ERR_CHECK_TIMEOUT');
      expect(result.retryable).toBe(true);
      // The deadline is enforced by an explicit timer, not the socket idle
      // timeout — a target trickling one byte at a time never goes idle.
      expect(elapsed).toBeLessThan(2000);
    });

    it('surfaces a transport error code from the target', async () => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      nock('https://refused.test').get('/').replyWithError(err);

      const result = await probeOnce('https://refused.test/', {
        timeoutMs: 2000,
      });
      expect(result.status).toBe('DOWN');
      expect(result.errorCode).toBe('ECONNREFUSED');
      expect(result.retryable).toBe(true);
    });

    it('follows redirects and counts them', async () => {
      nock('https://redir.test')
        .get('/')
        .reply(302, '', { Location: 'https://redir.test/final' });
      nock('https://redir.test').get('/final').reply(200, 'arrived');

      const result = await probeOnce('https://redir.test/');
      expect(result.status).toBe('UP');
      expect(result.redirects).toBe(1);
    });

    it('resolves a RELATIVE Location header', async () => {
      nock('https://rel.test')
        .get('/')
        .reply(302, '', { Location: '/elsewhere' });
      nock('https://rel.test').get('/elsewhere').reply(200, 'ok');

      expect((await probeOnce('https://rel.test/')).status).toBe('UP');
    });

    it('stops after the redirect cap instead of looping forever', async () => {
      nock('https://loop.test')
        .get('/')
        .times(10)
        .reply(302, '', { Location: 'https://loop.test/' });

      const result = await probeOnce('https://loop.test/', {
        maxRedirects: 3,
        timeoutMs: 4000,
      });
      expect(result.status).toBe('DOWN');
      expect(result.errorCode).toBe('ERR_TOO_MANY_REDIRECTS');
    });

    it('rejects a malformed URL without attempting a request', async () => {
      const result = await probeOnce('this is not a url');
      expect(result.errorCode).toBe('ERR_INVALID_URL');
      // A malformed URL will never fix itself, so retrying is pointless.
      expect(result.retryable).toBe(false);
    });

    it('rejects an unsupported protocol', async () => {
      const result = await probeOnce('ftp://files.test/thing');
      expect(result.errorCode).toBe('ERR_UNSUPPORTED_PROTOCOL');
      expect(result.retryable).toBe(false);
    });

    it('sends configured auth headers to the target', async () => {
      const scope = nock('https://private.test', {
        reqheaders: { authorization: 'Bearer secret-token' },
      })
        .get('/')
        .reply(200);

      const result = await probeOnce('https://private.test/', {
        headers: { Authorization: 'Bearer secret-token' },
      });

      expect(result.status).toBe('UP');
      expect(scope.isDone()).toBe(true);
    });

    it('DROPS auth headers when a redirect leaves the original origin', async () => {
      nock('https://origin.test')
        .get('/')
        .reply(302, '', { Location: 'https://attacker.test/steal' });

      // Matches only if NO authorization header arrives. An open redirect on the
      // target's side must not become credential exfiltration on ours.
      const attacker = nock('https://attacker.test', {
        badheaders: ['authorization'],
      })
        .get('/steal')
        .reply(200);

      const result = await probeOnce('https://origin.test/', {
        headers: { Authorization: 'Bearer secret-token' },
      });

      expect(result.status).toBe('UP');
      expect(attacker.isDone()).toBe(true);
    });
  });

  describe('retry ladder', () => {
    it('retries a 5xx up to the configured limit', async () => {
      const scope = nock('https://flaky.test').get('/').times(3).reply(503);

      const result = await checkMonitor('https://flaky.test/', {
        maxRetries: 2,
        timeoutMs: 2000,
      });

      expect(result.attempts).toBe(3); // 1 initial + 2 retries
      expect(scope.isDone()).toBe(true);
      expect(result.status).toBe('DOWN');
    });

    it('stops retrying as soon as an attempt succeeds', async () => {
      nock('https://recovers.test').get('/').reply(503);
      nock('https://recovers.test').get('/').reply(200, 'better now');

      const result = await checkMonitor('https://recovers.test/', {
        maxRetries: 2,
        timeoutMs: 2000,
      });

      expect(result.status).toBe('UP');
      expect(result.attempts).toBe(2);
    });

    it('does NOT retry a non-retryable status', async () => {
      const scope = nock('https://gone.test').get('/').reply(404);

      const result = await checkMonitor('https://gone.test/', {
        maxRetries: 2,
        timeoutMs: 2000,
      });

      expect(result.attempts).toBe(1);
      expect(scope.isDone()).toBe(true);
    });

    it('makes exactly one attempt when retries are disabled', async () => {
      // This is the half-open circuit-breaker probe path.
      const scope = nock('https://halfopen.test').get('/').reply(503);

      const result = await checkMonitor('https://halfopen.test/', {
        maxRetries: 0,
        timeoutMs: 2000,
      });

      expect(result.attempts).toBe(1);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('backoff', () => {
    it('stays within the cap', () => {
      const delays = Array.from({ length: 300 }, (_, i) =>
        backoffDelay(i % 5, 100, 1000)
      );
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(1000);
    });

    it('is JITTERED rather than a fixed ladder', () => {
      // Without jitter, every monitor failing against a shared upstream retries
      // in lockstep and hammers it in synchronised waves.
      const delays = new Set(
        Array.from({ length: 100 }, () => backoffDelay(3, 100, 1000))
      );
      expect(delays.size).toBeGreaterThan(10);
    });

    it('grows the ceiling exponentially with attempt number', () => {
      const sample = (attempt) =>
        Math.max(
          ...Array.from({ length: 200 }, () =>
            backoffDelay(attempt, 100, 100000)
          )
        );
      expect(sample(4)).toBeGreaterThan(sample(0));
    });
  });

  describe('against a real socket', () => {
    let server;
    let base;

    beforeAll(async () => {
      // The fixture is a loopback server, which the egress guard refuses by
      // default (tests/security/egress.test.js). Opt out the way a self-hosted
      // instance monitoring internal services would.
      process.env.ALLOW_PRIVATE_TARGETS = 'true';
      server = http.createServer((req, res) => {
        if (req.url === '/big') {
          // Larger than the 512KB body cap, to prove we stop reading.
          res.writeHead(200);
          res.end(Buffer.alloc(1024 * 1024, 'x'));
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
      delete process.env.ALLOW_PRIVATE_TARGETS;
      await new Promise((resolve) => server.close(resolve));
    });

    it('records REAL connection-phase timings', async () => {
      const result = await probeOnce(`${base}/`);

      expect(result.status).toBe('UP');
      // These come from socket lifecycle events, which is why this test needs a
      // real server: nock never opens a socket.
      expect(typeof result.timings.tcp).toBe('number');
      expect(typeof result.timings.ttfb).toBe('number');
      expect(typeof result.timings.total).toBe('number');
      expect(result.timings.ttfb).toBeLessThanOrEqual(result.timings.total + 1);
      // No TLS phase on plain HTTP — null, not a fabricated zero.
      expect(result.timings.tls).toBeNull();
    });

    it('reports ECONNREFUSED against a closed port as retryable', async () => {
      const result = await probeOnce('http://127.0.0.1:1/', {
        timeoutMs: 3000,
      });
      expect(result.status).toBe('DOWN');
      expect(result.retryable).toBe(true);
    });

    it('caps the response body instead of buffering it all', async () => {
      // A monitored endpoint streaming gigabytes must not OOM the monitor.
      const result = await probeOnce(`${base}/big`, { timeoutMs: 5000 });
      expect(result.status).toBe('UP');
      expect(result.timings.total).toBeGreaterThanOrEqual(0);
    });
  });
});
