import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import http from 'node:http';
import nock from 'nock';
import app from '../../src/app.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../helpers/db.js';
import { createUser, createMonitor, as } from '../helpers/factories.js';
import monitorModel from '../../src/models/monitor.model.js';
import channelModel from '../../src/models/channel.model.js';
import {
  EgressError,
  assertPublicUrl,
  blockedRange,
  checkUrl,
  guardedLookup,
  privateTargetsAllowed,
} from '../../src/utils/egress.js';
import { probeOnce } from '../../src/services/monitor.service.js';
import {
  webhookNotifier,
  postJson,
} from '../../src/notifications/webhook.notifier.js';
import { IncidentEvent } from '../../src/notifications/notifier.js';

/**
 * SSRF: the egress guard in front of every user-chosen outbound request.
 *
 * The "internal service" below is a real loopback server that counts every
 * request it receives. The assertion that matters in each attack case is that
 * the count stays at zero: a blocked target must never be contacted at all,
 * not merely reported as DOWN afterwards.
 *
 * DNS is replaced by a scripted resolver (the guard takes one by injection), so
 * rebinding can be simulated deterministically and nothing here needs network.
 */

/** A dns.lookup stand-in that answers from a script, one entry per call. */
function scriptedResolver(...answers) {
  const calls = [];
  const resolve = (hostname, options, callback) => {
    calls.push(hostname);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) return process.nextTick(callback, answer);
    const list = [answer].flat().map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    process.nextTick(() =>
      options?.all
        ? callback(null, list)
        : callback(null, list[0].address, list[0].family)
    );
  };
  resolve.calls = calls;
  return resolve;
}

const thrown = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

const lookupOnce = (resolve, host, options = { all: true }) =>
  new Promise((done) =>
    guardedLookup(resolve)(host, options, (err, ...answer) =>
      done({ err, answer })
    )
  );

describe('Egress guard (SSRF)', () => {
  let internal;
  let port;
  let hits = 0;

  beforeAll(async () => {
    internal = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('internal secret');
    });
    await new Promise((resolve) => internal.listen(0, '127.0.0.1', resolve));
    port = internal.address().port;
    await connectTestDb();
  });

  afterAll(async () => {
    await new Promise((resolve) => internal.close(resolve));
    await disconnectTestDb();
  });

  beforeEach(() => {
    hits = 0;
    delete process.env.ALLOW_PRIVATE_TARGETS;
  });

  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_TARGETS;
    nock.abortPendingRequests();
    nock.cleanAll();
  });

  describe('address ranges', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['127.255.255.254', 'loopback'],
      ['::1', 'loopback'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['192.168.1.1', 'private'],
      ['169.254.169.254', 'link-local'],
      ['fe80::1', 'link-local'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['100.127.255.255', 'carrier-grade NAT'],
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'unspecified'],
      ['::', 'unspecified'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.250', 'multicast'],
      ['ff02::1', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
      ['192.0.2.10', 'reserved'],
      ['198.18.0.1', 'reserved'],
      ['2001:db8::1', 'reserved'],
      ['100::1', 'reserved'],
      ['2002:7f00:1::', 'reserved'],
      ['fc00::1', 'unique-local'],
      ['fd12:3456:789a::1', 'unique-local'],
      ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
      ['::ffff:7f00:1', 'IPv4-mapped loopback'],
      ['::ffff:169.254.169.254', 'IPv4-mapped link-local'],
      ['::ffff:10.0.0.1', 'IPv4-mapped private'],
      ['::ffff:100.64.0.1', 'IPv4-mapped carrier-grade NAT'],
      ['::ffff:0.0.0.0', 'IPv4-mapped unspecified'],
      ['64:ff9b::a9fe:a9fe', 'NAT64 link-local'],
    ])('blocks %s (%s)', (address, label) => {
      expect(blockedRange(address)).toBe(label);
    });

    it.each([
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '100.63.255.255', // just below CGNAT
      '100.128.0.0', // just above it
      '172.15.255.255',
      '172.32.0.0',
      '169.253.255.255',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
    ])('allows public %s', (address) => {
      expect(blockedRange(address)).toBeNull();
    });
  });

  describe('IP literals, however they are spelled', () => {
    it.each([
      ['http://2130706433/', '127.0.0.1'], // decimal
      ['http://0177.0.0.1/', '127.0.0.1'], // octal
      ['http://0x7f.0.0.1/', '127.0.0.1'], // hex octet
      ['http://0x7f000001/', '127.0.0.1'], // hex
      ['http://127.1/', '127.0.0.1'], // shortened
      ['http://2852039166/latest/meta-data/', '169.254.169.254'],
      ['http://0251.0376.0251.0376/', '169.254.169.254'],
      ['http://0xa9fea9fe/', '169.254.169.254'],
      ['http://0/', '0.0.0.0'],
      ['http://[::1]:8080/', '::1'],
      ['http://[0:0:0:0:0:0:0:1]/', '::1'],
      ['http://[::ffff:127.0.0.1]/', '::ffff:7f00:1'],
      ['http://[::ffff:a9fe:a9fe]/', '::ffff:a9fe:a9fe'],
      ['http://[fd00::1]/', 'fd00::1'],
    ])('%s is judged as %s', (url, address) => {
      const err = thrown(() => checkUrl(url));
      expect(err).toBeInstanceOf(EgressError);
      expect(err.code).toBe('ERR_EGRESS_BLOCKED');
      expect(err.message).toContain(`${address} is not a public address`);
    });

    it.each([
      'http://localhost/',
      'http://LOCALHOST./',
      'http://api.localhost:3000/',
    ])('blocks the loopback name %s without asking DNS', (url) => {
      expect(thrown(() => checkUrl(url))?.message).toMatch(/loopback/);
    });

    it.each([
      'ftp://example.com/',
      'file:///etc/passwd',
      'gopher://example.com:70/',
      'dict://example.com:11211/',
      'javascript:alert(1)',
    ])('refuses the scheme of %s', (url) => {
      expect(thrown(() => checkUrl(url))?.code).toBe(
        'ERR_UNSUPPORTED_PROTOCOL'
      );
    });

    it('lets public hosts and public literals through', () => {
      expect(checkUrl('https://example.com/').hostname).toBe('example.com');
      expect(checkUrl('http://93.184.216.34:8080/x').port).toBe('8080');
      expect(thrown(() => checkUrl('https://[2606:4700::1111]/'))).toBeNull();
    });

    it('refuses something that is not a URL at all', () => {
      expect(thrown(() => checkUrl('not a url'))?.code).toBe('ERR_INVALID_URL');
    });
  });

  describe('connect-time lookup', () => {
    it('rejects the target when ANY resolved address is internal', async () => {
      const resolve = scriptedResolver(['93.184.216.34', '10.0.0.7']);
      const { err } = await lookupOnce(resolve, 'mixed.test');

      expect(err.code).toBe('ERR_EGRESS_BLOCKED');
      expect(err.message).toContain('mixed.test resolves to 10.0.0.7');
    });

    it('hands back exactly the addresses it validated', async () => {
      const resolve = scriptedResolver('93.184.216.34');

      const all = await lookupOnce(resolve, 'public.test', { all: true });
      expect(all.err).toBeNull();
      expect(all.answer[0]).toEqual([{ address: '93.184.216.34', family: 4 }]);

      const one = await lookupOnce(resolve, 'public.test', {});
      expect(one.answer).toEqual(['93.184.216.34', 4]);
    });

    it('passes a resolver failure through unchanged', async () => {
      const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
      const { err } = await lookupOnce(scriptedResolver(notFound), 'gone.test');
      expect(err.code).toBe('ENOTFOUND');
    });

    it('treats an empty answer as unresolvable', async () => {
      const { err } = await lookupOnce(scriptedResolver([]), 'empty.test');
      expect(err.code).toBe('ENOTFOUND');
    });

    it('refuses a rebound answer: public on the first lookup, private on the next', async () => {
      const resolve = scriptedResolver('93.184.216.34', '127.0.0.1');

      expect((await lookupOnce(resolve, 'rebind.test')).err).toBeNull();
      const second = await lookupOnce(resolve, 'rebind.test');
      expect(second.err.code).toBe('ERR_EGRESS_BLOCKED');
    });
  });

  describe('HTTP probe', () => {
    it('refuses a redirect to a private address and never contacts it', async () => {
      nock('https://public.test')
        .get('/')
        .reply(302, '', { Location: `http://127.0.0.1:${port}/admin` });

      const result = await probeOnce('https://public.test/');

      expect(result.status).toBe('DOWN');
      expect(result.errorCode).toBe('ERR_EGRESS_BLOCKED');
      expect(result.retryable).toBe(false);
      expect(result.redirects).toBe(1);
      expect(hits).toBe(0);
    });

    it('refuses a redirect to the cloud metadata service', async () => {
      nock('https://public.test').get('/').reply(301, '', {
        Location: 'http://169.254.169.254/latest/meta-data/',
      });

      const result = await probeOnce('https://public.test/');
      expect(result.errorCode).toBe('ERR_EGRESS_BLOCKED');
      expect(result.error).toMatch(/169\.254\.169\.254.*link-local/);
    });

    it('refuses a redirect to a name that resolves to a private address', async () => {
      nock('https://public.test')
        .get('/')
        .reply(302, '', { Location: `http://internal.test:${port}/` });
      const resolve = scriptedResolver('127.0.0.1');

      const result = await probeOnce('https://public.test/', {
        dnsLookup: resolve,
      });

      expect(result.errorCode).toBe('ERR_EGRESS_BLOCKED');
      expect(resolve.calls).toEqual(['internal.test']);
      expect(hits).toBe(0);
    });

    it('DNS rebinding: public when the monitor is saved, private when it is checked', async () => {
      const url = `http://rebind.test:${port}/`;
      const resolve = scriptedResolver('93.184.216.34', '127.0.0.1');

      // Save time: the name looks public, so the API would accept it.
      await expect(
        assertPublicUrl(url, { dnsLookup: resolve })
      ).resolves.toBeInstanceOf(URL);

      // Check time: the same name now answers 127.0.0.1. The guard judges the
      // answer the socket would use, so the internal service is never reached.
      const result = await probeOnce(url, { dnsLookup: resolve });
      expect(result.status).toBe('DOWN');
      expect(result.errorCode).toBe('ERR_EGRESS_BLOCKED');
      expect(result.error).toContain('rebind.test resolves to 127.0.0.1');
      expect(hits).toBe(0);
    });

    it("connects with the guard's own answer: one resolution per request", async () => {
      // Opt-out on, so the loopback answer may be used. The point is the count:
      // the socket connected using the lookup's answer and the HTTP client did
      // not resolve the name a second time, which is what makes the validated
      // address and the connected address the same one.
      process.env.ALLOW_PRIVATE_TARGETS = 'true';
      const resolve = scriptedResolver('127.0.0.1');

      const result = await probeOnce(`http://svc.test:${port}/`, {
        dnsLookup: resolve,
      });

      expect(result.status).toBe('UP');
      expect(resolve.calls).toEqual(['svc.test']);
      expect(hits).toBe(1);
    });

    it('still reaches public targets, including through a public redirect', async () => {
      nock('https://public.test')
        .get('/')
        .reply(302, '', { Location: 'https://cdn.test/home' });
      nock('https://cdn.test').get('/home').reply(200, 'ok');

      const result = await probeOnce('https://public.test/');
      expect(result.status).toBe('UP');
      expect(result.redirects).toBe(1);
    });

    it('blocks an internal literal by default and allows it with the opt-out', async () => {
      const blocked = await probeOnce(`http://127.0.0.1:${port}/`);
      expect(blocked.errorCode).toBe('ERR_EGRESS_BLOCKED');
      expect(hits).toBe(0);

      process.env.ALLOW_PRIVATE_TARGETS = 'true';
      const allowed = await probeOnce(`http://127.0.0.1:${port}/`);
      expect(allowed.status).toBe('UP');
      expect(hits).toBe(1);
    });
  });

  describe('webhooks', () => {
    let owner;

    beforeEach(async () => {
      await clearTestDb();
      owner = await createUser();
    });

    const payload = async () => ({
      event: IncidentEvent.OPENED,
      incident: { _id: '64b7f9f9f9f9f9f9f9f9f9f9', reason: 'HTTP 503' },
      monitor: await createMonitor(owner.id),
      user: owner.user,
      occurredAt: new Date(),
    });

    it('refuses to deliver to an internal receiver saved before the guard existed', async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Webhook',
        target: `http://127.0.0.1:${port}/hook`,
      });

      const [result] = await webhookNotifier.send(await payload());

      expect(result.status).toBe('Failed');
      expect(result.detail).toMatch(/not a public address \(loopback\)/);
      expect(hits).toBe(0);
    });

    it("does not follow a receiver's redirect", async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Webhook',
        target: 'https://hooks.test/moved',
      });
      nock('https://hooks.test')
        .post('/moved')
        .reply(307, '', { Location: `http://127.0.0.1:${port}/hook` });

      const [result] = await webhookNotifier.send(await payload());

      expect(result.status).toBe('Failed');
      expect(result.detail).toMatch(/redirects are not followed/);
      expect(hits).toBe(0);
    });

    it('refuses a receiver whose name resolves to a private address', async () => {
      await expect(
        postJson(`http://hooks.internal.test:${port}/`, '{}', {
          dnsLookup: scriptedResolver('10.0.0.5'),
        })
      ).rejects.toMatchObject({ code: 'ERR_EGRESS_BLOCKED' });
      expect(hits).toBe(0);
    });

    it('gives up on a receiver that never answers', async () => {
      process.env.ALLOW_PRIVATE_TARGETS = 'true';
      const silent = http.createServer(() => {});
      await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));

      try {
        await expect(
          postJson(`http://127.0.0.1:${silent.address().port}/`, '{}', {
            timeoutMs: 200,
          })
        ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      } finally {
        silent.closeAllConnections();
        await new Promise((resolve) => silent.close(resolve));
      }
    });
  });

  describe('API', () => {
    let alice;

    beforeEach(async () => {
      await clearTestDb();
      alice = await createUser();
    });

    it.each([
      ['http://169.254.169.254/latest/meta-data/', /link-local/],
      ['localhost:6379', /loopback/], // no scheme: normalised to https://
      ['http://0x7f000001/', /loopback/],
      ['http://[fd00::1]/', /unique-local/],
      ['http://100.64.0.1/', /carrier-grade NAT/],
    ])('refuses to create a monitor for %s with a 400', async (url, reason) => {
      const res = await as(app, alice).post('/api/monitor').send({ url });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not a public address/);
      expect(res.body.message).toMatch(reason);
      expect(await monitorModel.countDocuments()).toBe(0);
    });

    it('still creates a monitor for a public target', async () => {
      await as(app, alice)
        .post('/api/monitor')
        .send({ url: 'https://93.184.216.34/' })
        .expect(201);
    });

    it('refuses to move an existing monitor onto an internal address', async () => {
      const monitor = await createMonitor(alice.id, {
        url: 'https://public.example.test/',
      });

      const res = await as(app, alice)
        .put(`/api/monitor/${monitor._id}`)
        .send({ url: 'http://10.0.0.1/' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/private/);
      const stored = await monitorModel.findById(monitor._id);
      expect(stored.url).toBe('https://public.example.test/');
    });

    it('refuses an internal webhook and a webhook that is not a URL', async () => {
      const blocked = await as(app, alice)
        .post('/api/channels')
        .send({ type: 'Webhook', target: `http://127.0.0.1:${port}/hook` });
      expect(blocked.status).toBe(400);
      expect(blocked.body.message).toMatch(/loopback/);

      const notUrl = await as(app, alice)
        .post('/api/channels')
        .send({ type: 'Slack', target: '#ops-alerts' });
      expect(notUrl.status).toBe(400);
      expect(notUrl.body.message).toMatch(/http:\/\/ or https:\/\//);

      expect(await channelModel.countDocuments()).toBe(0);
    });

    it('accepts a public webhook, then refuses to repoint it internally', async () => {
      const created = await as(app, alice)
        .post('/api/channels')
        .send({ type: 'Webhook', target: 'https://93.184.216.34/hook' })
        .expect(201);
      const id = created.body.data._id;

      const res = await as(app, alice)
        .patch(`/api/channels/${id}`)
        .send({ target: 'http://[::1]/hook' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/loopback/);
      expect((await channelModel.findById(id)).target).toBe(
        'https://93.184.216.34/hook'
      );
    });

    it('lets a self-hosted instance opt out with ALLOW_PRIVATE_TARGETS=true', async () => {
      process.env.ALLOW_PRIVATE_TARGETS = 'true';
      await as(app, alice)
        .post('/api/monitor')
        .send({ url: `http://127.0.0.1:${port}/` })
        .expect(201);
    });
  });

  describe('save-time pre-check', () => {
    it('reports a name that resolves internally', async () => {
      await expect(
        assertPublicUrl('https://db.internal.test/', {
          dnsLookup: scriptedResolver('10.1.2.3'),
        })
      ).rejects.toThrow('db.internal.test resolves to 10.1.2.3');
    });

    it('lets an unresolvable or slow name through to the connect-time guard', async () => {
      const notFound = Object.assign(new Error('ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
      await expect(
        assertPublicUrl('https://not-yet.test/', {
          dnsLookup: scriptedResolver(notFound),
        })
      ).resolves.toBeInstanceOf(URL);

      await expect(
        assertPublicUrl('https://slow.test/', {
          dnsLookup: () => {}, // never answers
          timeoutMs: 50,
        })
      ).resolves.toBeInstanceOf(URL);
    });

    it('is on unless ALLOW_PRIVATE_TARGETS is exactly "true"', () => {
      expect(privateTargetsAllowed()).toBe(false);
      for (const value of ['false', '1', 'yes', '']) {
        process.env.ALLOW_PRIVATE_TARGETS = value;
        expect(privateTargetsAllowed()).toBe(false);
      }
      process.env.ALLOW_PRIVATE_TARGETS = 'TRUE';
      expect(privateTargetsAllowed()).toBe(true);
    });
  });
});
