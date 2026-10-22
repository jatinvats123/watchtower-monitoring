/**
 * Dummy HTTP target for the scheduler load test.
 *
 * Every seeded monitor points here, so the test never probes a third-party
 * site. It answers 200 after an optional fixed delay (to model a real
 * endpoint's response time) and counts what it served, so the harness can
 * cross-check the app's own logs against an independent request count.
 *
 *   node load/target.mjs --port 8098 --delay-ms 0
 *
 * Binds to 127.0.0.1 only.
 */
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8098' },
    'delay-ms': { type: 'string', default: '0' },
  },
});

const port = Number(values.port);
const delayMs = Number(values['delay-ms']);

const stats = { requests: 0, startedAt: new Date().toISOString() };

const server = http.createServer((req, res) => {
  if (req.url === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  stats.requests += 1;
  const reply = () => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  };
  if (delayMs > 0) setTimeout(reply, delayMs);
  else reply();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[target] listening on 127.0.0.1:${port} (delay ${delayMs}ms)`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
