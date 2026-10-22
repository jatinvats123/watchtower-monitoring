import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import nock from 'nock';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../helpers/db.js';
import { createUser, createMonitor } from '../helpers/factories.js';
import { webhookNotifier } from '../../src/notifications/webhook.notifier.js';
import { IncidentEvent } from '../../src/notifications/notifier.js';
import {
  incidentOpenedEmail,
  incidentClosedEmail,
  escapeHtml,
} from '../../src/notifications/templates.js';
import channelModel from '../../src/models/channel.model.js';

/**
 * The concrete delivery channels.
 *
 * The registry contract is covered in notifier.test.js; this suite exercises
 * what each channel actually does on the wire.
 */
describe('Notification channels', () => {
  let owner;
  let monitor;

  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  // Unpatch node:http for the next suite in this worker (see probe.test.js).
  afterAll(() => nock.restore());

  beforeEach(async () => {
    await clearTestDb();
    owner = await createUser({ email: 'owner@example.test' });
    monitor = await createMonitor(owner.id, { title: 'Checkout API' });
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  const payload = (overrides = {}) => ({
    event: IncidentEvent.OPENED,
    incident: {
      _id: '64b7f9f9f9f9f9f9f9f9f9f9',
      reason: 'HTTP 503',
      startTime: new Date(),
      duration: 42,
    },
    monitor,
    user: owner.user,
    occurredAt: new Date(),
    ...overrides,
  });

  describe('webhook notifier', () => {
    it('emits nothing when no webhooks are configured', async () => {
      // Not a "Skipped" row per incident — that would bury the real entries.
      await expect(webhookNotifier.send(payload())).resolves.toEqual([]);
    });

    it('POSTs a structured body to a configured webhook', async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Webhook',
        target: 'https://hooks.test/incoming',
        active: true,
      });

      let received;
      const scope = nock('https://hooks.test')
        .post('/incoming', (body) => {
          received = body;
          return true;
        })
        .reply(200);

      const results = await webhookNotifier.send(payload());

      expect(scope.isDone()).toBe(true);
      expect(results[0].status).toBe('Delivered');
      expect(received.event).toBe(IncidentEvent.OPENED);
      expect(received.status).toBe('DOWN');
      expect(received.monitor.title).toBe('Checkout API');
      expect(received.text).toMatch(/Checkout API/);
    });

    it('describes a recovery differently from an outage', async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Slack',
        target: 'https://hooks.test/slack',
        active: true,
      });

      let received;
      nock('https://hooks.test')
        .post('/slack', (body) => {
          received = body;
          return true;
        })
        .reply(200);

      await webhookNotifier.send(payload({ event: IncidentEvent.CLOSED }));

      expect(received.status).toBe('UP');
      expect(received.text).toMatch(/back UP/);
    });

    it('reports a non-2xx receiver as Failed', async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Webhook',
        target: 'https://hooks.test/bad',
        active: true,
      });
      nock('https://hooks.test').post('/bad').reply(500);

      const results = await webhookNotifier.send(payload());
      expect(results[0].status).toBe('Failed');
      expect(results[0].detail).toMatch(/500/);
    });

    it('reports a transport error as Failed rather than throwing', async () => {
      await channelModel.create({
        userId: owner.id,
        type: 'Webhook',
        target: 'https://hooks.test/dead',
        active: true,
      });
      nock('https://hooks.test')
        .post('/dead')
        .replyWithError(new Error('socket hang up'));

      const results = await webhookNotifier.send(payload());
      expect(results[0].status).toBe('Failed');
    });

    it('delivers to several webhooks independently', async () => {
      for (const path of ['/one', '/two']) {
        await channelModel.create({
          userId: owner.id,
          type: 'Webhook',
          target: `https://hooks.test${path}`,
          active: true,
        });
      }
      nock('https://hooks.test').post('/one').reply(200);
      nock('https://hooks.test').post('/two').reply(500);

      const results = await webhookNotifier.send(payload());
      expect(results.map((r) => r.status).sort()).toEqual([
        'Delivered',
        'Failed',
      ]);
    });
  });

  describe('templates', () => {
    it('escapes HTML in every interpolated value', () => {
      // Monitor titles are free text and AI summaries derive from remote error
      // strings — both attacker-influenced, both previously injected raw.
      const { html } = incidentOpenedEmail({
        user: { username: '<script>alert(1)</script>' },
        monitor: {
          title: '<img src=x onerror=alert(1)>',
          url: 'https://a.test',
        },
        incident: { reason: '"><b>injected</b>', aiSummary: '<svg/onload=1>' },
        occurredAt: new Date(),
      });

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<svg/onload');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders an opened email with the monitor identity', () => {
      const { subject, html } = incidentOpenedEmail({
        user: { username: 'alice' },
        monitor: {
          title: 'Checkout API',
          url: 'https://a.test',
          failureThreshold: 3,
        },
        incident: { reason: 'HTTP 503' },
        occurredAt: new Date(),
      });

      expect(subject).toMatch(/Checkout API/);
      expect(subject).toMatch(/DOWN/);
      expect(html).toContain('HTTP 503');
    });

    it('omits the AI section entirely when there is no summary', () => {
      const { html } = incidentOpenedEmail({
        user: { username: 'alice' },
        monitor: { title: 'API', url: 'https://a.test' },
        incident: { reason: 'HTTP 503' },
        occurredAt: new Date(),
      });

      // Better an absent section than an apology string in a customer's alert.
      expect(html).not.toMatch(/AI Analysis/);
    });

    it('renders durations in human units', () => {
      const seconds = incidentClosedEmail({
        user: { username: 'a' },
        monitor: { title: 'API', url: 'https://a.test' },
        incident: { duration: 45 },
        occurredAt: new Date(),
      }).html;
      const minutes = incidentClosedEmail({
        user: { username: 'a' },
        monitor: { title: 'API', url: 'https://a.test' },
        incident: { duration: 600 },
        occurredAt: new Date(),
      }).html;
      const hours = incidentClosedEmail({
        user: { username: 'a' },
        monitor: { title: 'API', url: 'https://a.test' },
        incident: { duration: 7200 },
        occurredAt: new Date(),
      }).html;

      expect(seconds).toMatch(/45 seconds/);
      expect(minutes).toMatch(/10\.0 minutes/);
      expect(hours).toMatch(/2\.0 hours/);
    });

    it('escapeHtml handles every dangerous character', () => {
      expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });
});
