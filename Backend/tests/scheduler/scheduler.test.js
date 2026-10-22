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
import {
  connectTestDb,
  disconnectTestDb,
  clearTestDb,
  syncIndexes,
} from '../helpers/db.js';
import { createUser, createMonitor } from '../helpers/factories.js';
import { MonitorScheduler } from '../../src/jobs/scheduler.js';
import { SchedulerLock } from '../../src/services/lock.service.js';
import monitorModel from '../../src/models/monitor.model.js';
import incidentModel from '../../src/models/incidents.model.js';
import logModel from '../../src/models/logs.model.js';
import { notifierRegistry } from '../../src/notifications/index.js';
import { encryptSecret } from '../../src/utils/crypto.js';

/**
 * Scheduler behaviour against a real database.
 *
 * Real timers here: these tests assert what a tick DOES (which monitors it
 * picks up, what it writes, which transitions it fires), not when it fires.
 * Cadence is covered separately in loop.test.js with fake timers.
 *
 * Ticks are driven explicitly rather than by the loop, so each assertion
 * corresponds to exactly one check.
 */
describe('Scheduler behaviour', () => {
  let owner;
  let scheduler;
  let sentEvents;

  beforeAll(async () => {
    await connectTestDb();
    await syncIndexes(monitorModel, incidentModel, logModel);
  });

  afterAll(async () => {
    notifierRegistry.clear();
    // Unpatch node:http for the next suite in this worker (see probe.test.js).
    nock.restore();
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    owner = await createUser();

    // Swap the real notifiers for a recorder: proves transitions fire without
    // touching SMTP, and lets us count them exactly.
    sentEvents = [];
    notifierRegistry.clear().register({
      name: 'Email',
      supports: () => true,
      send: async (payload) => {
        sentEvents.push(payload.event);
        return { status: 'Delivered', target: 'recorder@example.test' };
      },
    });

    scheduler = new MonitorScheduler({
      enabled: true,
      concurrency: 4,
      lock: new SchedulerLock({ owner: 'test-leader', ttlMs: 60_000 }),
    });
  });

  afterEach(() => nock.cleanAll());

  /** Force a monitor due, then run exactly one tick. */
  const step = async (monitor) => {
    await monitorModel.updateOne(
      { _id: monitor._id },
      { $set: { nextCheckAt: new Date(0) } }
    );
    await scheduler.tick();
  };

  const reload = (monitor) => monitorModel.findById(monitor._id);
  const ongoingCount = (monitor) =>
    incidentModel.countDocuments({ monitorId: monitor._id, status: 'ONGOING' });

  /**
   * A target whose health can be flipped mid-test.
   *
   * Sequenced interceptors (`.reply(503).reply(200)`) are the obvious approach
   * and the wrong one here: a single check may issue several requests because of
   * the retry ladder, so the sequence gets consumed at a rate the test cannot
   * predict. Replying from a mutable mode makes each assertion depend on the
   * monitor's state rather than on interceptor arithmetic.
   */
  const switchableTarget = (host) => {
    const state = { up: true };
    nock(host)
      .persist()
      .get('/')
      .reply(() => (state.up ? [200, 'ok'] : [503, 'down']));
    return {
      goDown: () => {
        state.up = false;
      },
      goUp: () => {
        state.up = true;
      },
    };
  };

  const failingTarget = (host) => {
    const target = switchableTarget(host);
    target.goDown();
    return target;
  };
  const healthyTarget = (host) => switchableTarget(host);

  describe('due selection', () => {
    it('checks a monitor whose nextCheckAt has passed', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://due.test/',
      });
      healthyTarget('https://due.test');

      await step(monitor);

      expect(scheduler.stats.checksExecuted).toBe(1);
      expect((await reload(monitor)).lastCheckStatus).toBe('UP');
    });

    it('skips a monitor that is not yet due', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://notdue.test/',
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        { $set: { nextCheckAt: new Date(Date.now() + 3_600_000) } }
      );

      await scheduler.tick();
      expect(scheduler.stats.checksExecuted).toBe(0);
    });

    it('skips a PAUSED monitor entirely', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://paused.test/',
        active: false,
      });

      await step(monitor);
      expect(scheduler.stats.checksExecuted).toBe(0);
    });

    it('reschedules from NOW rather than incrementing the old deadline', async () => {
      // Incrementing accumulates drift as checks take real time, and after
      // downtime would fire one catch-up check per missed interval.
      const monitor = await createMonitor(owner.id, {
        url: 'https://resched.test/',
        interval: 60,
      });
      healthyTarget('https://resched.test');

      const before = Date.now();
      await step(monitor);
      const after = await reload(monitor);

      const delta = after.nextCheckAt.getTime() - before;
      expect(delta).toBeGreaterThan(55_000);
      expect(delta).toBeLessThan(65_000);
    });

    it('does not stampede catch-up checks after long downtime', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://stampede.test/',
        interval: 60,
      });
      healthyTarget('https://stampede.test');

      // Overdue by ~24 hours — the equivalent of 1440 missed intervals.
      await monitorModel.updateOne(
        { _id: monitor._id },
        { $set: { nextCheckAt: new Date(Date.now() - 86_400_000) } }
      );
      await scheduler.tick();

      // Exactly one check, not one per missed interval. Backfilling would mean
      // a thundering herd at the moment the system is least healthy.
      expect(scheduler.stats.checksExecuted).toBe(1);
      expect((await reload(monitor)).nextCheckAt.getTime()).toBeGreaterThan(
        Date.now()
      );
    });

    it('treats a BACKWARD clock jump as due rather than going blind', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://clock.test/',
      });

      // A backward step leaves nextCheckAt far in the future; without the
      // lastChecked guard the monitor would silently stop being checked.
      await monitorModel.updateOne(
        { _id: monitor._id },
        {
          $set: {
            nextCheckAt: new Date(Date.now() + 3_600_000),
            lastChecked: new Date(Date.now() + 3_600_000),
          },
        }
      );

      const due = await scheduler.findDueMonitors(new Date());
      expect(due.map((m) => String(m._id))).toContain(String(monitor._id));
    });
  });

  describe('overlap policy (skip)', () => {
    it('never starts a second check for a monitor already in flight', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://inflight.test/',
      });

      scheduler.inFlight.add(String(monitor._id));
      await step(monitor);

      // Skipped, and COUNTED — scheduler lag must be observable, not silent.
      expect(scheduler.stats.skippedOverlap).toBe(1);
      expect(scheduler.stats.checksExecuted).toBe(0);
    });
  });

  describe('flap detection', () => {
    it('opens an incident only after N consecutive failures', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://flap.test/',
        failureThreshold: 3,
        successThreshold: 2,
      });
      failingTarget('https://flap.test');

      await step(monitor);
      expect((await reload(monitor)).consecutiveFailures).toBe(1);
      expect(await ongoingCount(monitor)).toBe(0);
      // Confirmed status stays UP while the failure is unconfirmed...
      expect((await reload(monitor)).status).toBe('UP');
      // ...but the RAW result is visible immediately.
      expect((await reload(monitor)).lastCheckStatus).toBe('DOWN');

      await step(monitor);
      expect((await reload(monitor)).consecutiveFailures).toBe(2);
      expect(await ongoingCount(monitor)).toBe(0);

      await step(monitor);
      expect((await reload(monitor)).consecutiveFailures).toBe(3);
      expect(await ongoingCount(monitor)).toBe(1);
      expect((await reload(monitor)).status).toBe('DOWN');
    });

    it('honours a per-monitor threshold of 1', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://sensitive.test/',
        failureThreshold: 1,
      });
      failingTarget('https://sensitive.test');

      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(1);
    });

    it('honours a high per-monitor threshold', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://noisy.test/',
        failureThreshold: 5,
      });
      failingTarget('https://noisy.test');

      for (let i = 0; i < 4; i += 1) await step(monitor);
      expect(await ongoingCount(monitor)).toBe(0);

      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(1);
    });

    it('resets the failure streak on any success', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://reset.test/',
        failureThreshold: 3,
      });
      const target = failingTarget('https://reset.test');

      await step(monitor);
      await step(monitor);
      expect((await reload(monitor)).consecutiveFailures).toBe(2);

      target.goUp();
      await step(monitor);
      expect((await reload(monitor)).consecutiveFailures).toBe(0);

      // A blip must not be allowed to carry over and open an incident early.
      target.goDown();
      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(0);
    });

    it('closes only after M consecutive successes', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://recover.test/',
        failureThreshold: 1,
        successThreshold: 3,
      });
      const target = failingTarget('https://recover.test');

      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(1);
      target.goUp();

      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(1);
      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(1);

      await step(monitor);
      expect(await ongoingCount(monitor)).toBe(0);
      expect((await reload(monitor)).status).toBe('UP');
    });

    it('survives a restart mid-streak by persisting counters', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://restart.test/',
        failureThreshold: 3,
      });
      failingTarget('https://restart.test');

      await step(monitor);
      await step(monitor);

      // Simulate a process restart: the outgoing instance releases its lease on
      // graceful shutdown, then a brand-new scheduler starts with no in-memory
      // state at all. (Without the release the newcomer correctly refuses to do
      // any work, which is the leader-election behaviour asserted elsewhere.)
      await scheduler.lock.release();

      const restarted = new MonitorScheduler({
        enabled: true,
        lock: new SchedulerLock({ owner: 'restarted', ttlMs: 60_000 }),
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        { $set: { nextCheckAt: new Date(0) } }
      );
      await restarted.tick();

      // Resumes at 3 rather than starting the threshold over.
      expect((await reload(monitor)).consecutiveFailures).toBe(3);
      expect(await ongoingCount(monitor)).toBe(1);
    });
  });

  describe('incident notifications', () => {
    it('fires exactly once per transition, not once per failing check', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://notify.test/',
        failureThreshold: 1,
        successThreshold: 1,
      });
      const target = failingTarget('https://notify.test');

      await step(monitor);
      await step(monitor);
      await step(monitor);

      // The old code called createIncident on every DOWN→DOWN check and relied
      // on a downstream lookup to swallow the duplicate.
      expect(sentEvents.filter((e) => e === 'incident.opened')).toHaveLength(1);
      expect(await ongoingCount(monitor)).toBe(1);

      target.goUp();
      await step(monitor);
      await step(monitor);

      expect(sentEvents.filter((e) => e === 'incident.closed')).toHaveLength(1);
    });

    it('records a durable check result even when notification fails', async () => {
      notifierRegistry.clear().register({
        name: 'Email',
        supports: () => true,
        send: async () => {
          throw new Error('SMTP is down');
        },
      });

      const monitor = await createMonitor(owner.id, {
        url: 'https://notifyfail.test/',
        failureThreshold: 1,
      });
      failingTarget('https://notifyfail.test');

      await step(monitor);

      // Delivery is best effort; the incident is the source of truth.
      expect(await ongoingCount(monitor)).toBe(1);
      expect(await logModel.countDocuments({ monitorId: monitor._id })).toBe(1);
    });
  });

  describe('check results', () => {
    it('writes one log row per check, with real timings', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://logged.test/',
      });
      healthyTarget('https://logged.test');

      await step(monitor);

      const rows = await logModel.find({ monitorId: monitor._id });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('UP');
      expect(rows[0].statusCode).toBe(200);
      expect(typeof rows[0].timings.total).toBe('number');
      expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
    });

    it('records the attempt count from the retry ladder', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://retried.test/',
      });
      failingTarget('https://retried.test');

      await step(monitor);

      const row = await logModel.findOne({ monitorId: monitor._id });
      expect(row.attempts).toBeGreaterThan(1);
    });

    it('sends decrypted auth headers to a protected target', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://protected.test/',
        authHeaders: encryptSecret(
          JSON.stringify({ Authorization: 'Bearer scheduler-secret' })
        ),
      });

      const scope = nock('https://protected.test', {
        reqheaders: { authorization: 'Bearer scheduler-secret' },
      })
        .get('/')
        .reply(200);

      await step(monitor);

      expect(scope.isDone()).toBe(true);
      expect((await reload(monitor)).lastCheckStatus).toBe('UP');
    });
  });

  describe('circuit breaker integration', () => {
    it('skips a check entirely while the breaker is open', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://broken.test/',
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        {
          $set: {
            breakerState: 'OPEN',
            breakerRetryAt: new Date(Date.now() + 600_000),
          },
        }
      );

      // No nock interceptor: if a request were made, it would error loudly.
      await step(monitor);

      expect(scheduler.stats.skippedBreaker).toBe(1);
      expect(scheduler.stats.checksExecuted).toBe(0);
      // No fabricated DOWN row — we do not invent data for checks we skipped.
      expect(await logModel.countDocuments({ monitorId: monitor._id })).toBe(0);
    });

    it('probes once with NO retries when half-open', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://halfopen.test/',
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        {
          $set: {
            breakerState: 'OPEN',
            breakerRetryAt: new Date(Date.now() - 1),
          },
        }
      );

      const scope = nock('https://halfopen.test').get('/').reply(503);
      await step(monitor);

      // Exactly one request: the breaker is open precisely because this
      // endpoint does not deserve a retry ladder.
      expect(scope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toHaveLength(0);
      const row = await logModel.findOne({ monitorId: monitor._id });
      expect(row.attempts).toBe(1);
    });

    it('closes the breaker when a half-open probe succeeds', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://healed.test/',
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        {
          $set: {
            breakerState: 'OPEN',
            breakerRetryAt: new Date(Date.now() - 1),
            breakerConsecutiveOpens: 2,
          },
        }
      );
      nock('https://healed.test').get('/').reply(200);

      await step(monitor);

      const after = await reload(monitor);
      expect(after.breakerState).toBe('CLOSED');
      expect(after.breakerConsecutiveOpens).toBe(0);
    });
  });

  describe('leadership', () => {
    it('does no work when another instance holds the lease', async () => {
      const incumbent = new SchedulerLock({
        owner: 'other-instance',
        ttlMs: 60_000,
      });
      await incumbent.acquire();

      const follower = new MonitorScheduler({
        enabled: true,
        lock: new SchedulerLock({ owner: 'follower', ttlMs: 60_000 }),
      });

      const monitor = await createMonitor(owner.id, {
        url: 'https://follower.test/',
      });
      await monitorModel.updateOne(
        { _id: monitor._id },
        { $set: { nextCheckAt: new Date(0) } }
      );

      await follower.tick();

      // Duplicate checks are duplicate alert emails to a customer.
      expect(follower.stats.isLeader).toBe(false);
      expect(follower.stats.checksExecuted).toBe(0);
      expect(await logModel.countDocuments({ monitorId: monitor._id })).toBe(0);
    });
  });

  describe('resilience', () => {
    it('keeps checking other monitors when one check crashes', async () => {
      const good = await createMonitor(owner.id, { url: 'https://good.test/' });
      const bad = await createMonitor(owner.id, { url: 'https://bad.test/' });
      healthyTarget('https://good.test');

      const original = scheduler.runCheck.bind(scheduler);
      scheduler.runCheck = jest.fn(async (monitor, breaker) => {
        if (String(monitor._id) === String(bad._id)) {
          throw new Error('check exploded');
        }
        return original(monitor, breaker);
      });

      await monitorModel.updateMany({}, { $set: { nextCheckAt: new Date(0) } });
      await scheduler.tick();

      // Promise.all would have lost the healthy check too.
      expect(scheduler.stats.errors).toBeGreaterThanOrEqual(1);
      expect(await logModel.countDocuments({ monitorId: good._id })).toBe(1);
    });

    it('bounds concurrency across many due monitors', async () => {
      for (let i = 0; i < 12; i += 1) {
        const host = `https://bulk${i}.test`;
        await createMonitor(owner.id, { url: `${host}/` });
        nock(host).get('/').reply(200);
      }

      let active = 0;
      let peak = 0;
      const original = scheduler.runCheck.bind(scheduler);
      scheduler.runCheck = async (monitor, breaker) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await original(monitor, breaker);
        } finally {
          active -= 1;
        }
      };

      await monitorModel.updateMany({}, { $set: { nextCheckAt: new Date(0) } });
      await scheduler.tick();

      expect(scheduler.stats.checksExecuted).toBe(12);
      expect(peak).toBeLessThanOrEqual(4); // configured concurrency
    });
  });

  describe('observability', () => {
    it('reports scheduler lag from the most overdue monitor', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://lag.test/',
      });
      healthyTarget('https://lag.test');

      await monitorModel.updateOne(
        { _id: monitor._id },
        { $set: { nextCheckAt: new Date(Date.now() - 30_000) } }
      );
      await scheduler.tick();

      expect(scheduler.stats.maxLagMs).toBeGreaterThan(25_000);
    });

    it('exposes counters for health and metrics endpoints', async () => {
      const monitor = await createMonitor(owner.id, {
        url: 'https://stats.test/',
      });
      healthyTarget('https://stats.test');
      await step(monitor);

      const stats = scheduler.getStats();
      expect(stats.checksExecuted).toBe(1);
      expect(stats.checksSucceeded).toBe(1);
      expect(stats.isLeader).toBe(true);
      expect(stats.lastTickAt).toBeInstanceOf(Date);
      expect(stats.inFlight).toBe(0);
    });
  });
});
