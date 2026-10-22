import http from 'node:http';
import https from 'node:https';
import { IncidentEvent } from './notifier.js';
import channelModel from '../models/channel.model.js';
import logger from '../config/logger.js';
import { checkUrl, egressAgent, HTTP_PROTOCOLS } from '../utils/egress.js';

/**
 * Webhook / Slack notifier.
 *
 * This channel exists primarily to prove the plug-in seam is real: it was added
 * without touching `incident.service.js` or the incident state machine at all.
 * Slack incoming-webhooks accept the same POST shape, so both channel types are
 * served here.
 */

const TIMEOUT_MS = 5_000;

/**
 * POST a JSON body through the egress guard, so a webhook cannot be aimed at
 * localhost, a private range or the cloud metadata service.
 *
 * node:http rather than fetch: fetch cannot take an agent, so it cannot use
 * the guard's connect-time lookup. Redirects are not followed, as with GitHub
 * and Stripe webhooks: a receiver that answers 3xx is reported, not chased.
 *
 * @returns {Promise<number>} the receiver's status code
 */
export function postJson(
  target,
  body,
  { timeoutMs = TIMEOUT_MS, dnsLookup } = {}
) {
  return new Promise((settle, reject) => {
    let url;
    try {
      url = checkUrl(target, { protocols: HTTP_PROTOCOLS });
    } catch (err) {
      return reject(err);
    }

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'WatchTower/1.0 (+webhook)',
        },
        agent: egressAgent(url.protocol, { dnsLookup }),
      },
      (res) => {
        // The receiver's body is irrelevant; drain it so the socket closes.
        res.on('error', () => {});
        res.resume();
        settle(res.statusCode);
      }
    );

    // A hung receiver must not hold an incident transition open.
    const timer = setTimeout(() => {
      const err = new Error(`Receiver did not answer within ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

/** Slack renders `text`; a generic receiver gets the structured fields. */
function buildBody({ event, monitor, incident, occurredAt }) {
  const opened = event === IncidentEvent.OPENED;
  const title = monitor?.title || 'Untitled monitor';

  return {
    text: opened
      ? `🚨 *${title}* is DOWN — ${incident?.reason || 'monitor is down'}`
      : `✅ *${title}* is back UP after ${incident?.duration ?? 0}s`,
    event,
    status: opened ? 'DOWN' : 'UP',
    monitor: {
      id: String(monitor?._id ?? ''),
      title,
      url: monitor?.url,
    },
    incident: {
      id: String(incident?._id ?? ''),
      reason: incident?.reason,
      startedAt: incident?.startTime,
      resolvedAt: incident?.endTime,
      durationSeconds: incident?.duration,
    },
    occurredAt: (occurredAt || new Date()).toISOString(),
  };
}

export const webhookNotifier = {
  name: 'Webhook',

  supports: (event) =>
    event === IncidentEvent.OPENED || event === IncidentEvent.CLOSED,

  async send(payload) {
    const { user } = payload;

    let channels;
    try {
      channels = await channelModel.find({
        userId: user?._id || user?.id,
        type: { $in: ['Webhook', 'Slack'] },
        active: true,
      });
    } catch (err) {
      logger.error(`[notify] could not load webhook channels: ${err.message}`);
      return [];
    }

    // No configured webhooks is the normal case — emit nothing rather than a
    // "Skipped" audit row per incident, which would bury the real entries.
    if (channels.length === 0) return [];

    const body = JSON.stringify(buildBody(payload));

    return Promise.all(
      channels.map(async (channel) => {
        try {
          const statusCode = await postJson(channel.target, body);

          if (statusCode < 200 || statusCode >= 300) {
            return {
              channel: channel.type,
              status: 'Failed',
              target: channel.target,
              detail:
                statusCode < 400
                  ? `Receiver redirected (HTTP ${statusCode}); webhook redirects are not followed`
                  : `Receiver returned HTTP ${statusCode}`,
            };
          }

          return {
            channel: channel.type,
            status: 'Delivered',
            target: channel.target,
          };
        } catch (err) {
          logger.error(
            `[notify] webhook to ${channel.target} failed: ${err.message}`
          );
          return {
            channel: channel.type,
            status: 'Failed',
            target: channel.target,
            detail: err?.message || 'Webhook delivery failed',
          };
        }
      })
    );
  },
};

export default webhookNotifier;
