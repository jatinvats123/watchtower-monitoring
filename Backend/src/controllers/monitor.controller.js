import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { monitorDao } from '../dao/index.js';
import { encryptSecret, hasCredentials } from '../utils/crypto.js';
import { assertPublicUrl } from '../utils/egress.js';
import logger from '../config/logger.js';

/**
 * Fields a user may set on their own monitor. Anything outside this list
 * (status, breaker state, consecutive counters, nextCheckAt, userId) is owned
 * by the scheduler or the DAO — accepting them from a request body would let a
 * client forge its own uptime history or reassign ownership.
 */
function pickWritableFields(body = {}) {
  const patch = {};
  const assign = (key, value) => {
    if (value !== undefined) patch[key] = value;
  };

  assign('type', body.type);
  assign('title', body.title ?? body.name);
  assign('description', body.description);
  assign('interval', body.interval);
  assign('timeout', body.timeout);
  assign('active', body.active);
  assign('ignoreTlsErrors', body.ignoreTlsErrors);

  // Flap thresholds are per monitor so a noisy target can be tuned without a
  // code change. Clamped to sane values: a threshold of 0 would mean "open an
  // incident before observing anything".
  if (body.failureThreshold !== undefined) {
    patch.failureThreshold = Math.max(1, Number(body.failureThreshold) || 1);
  }
  if (body.successThreshold !== undefined) {
    patch.successThreshold = Math.max(1, Number(body.successThreshold) || 1);
  }

  // Outbound credentials for targets behind auth are encrypted before they ever
  // reach the database, and are never echoed back on read.
  if (body.authHeaders !== undefined) {
    patch.authHeaders = hasCredentials(body.authHeaders)
      ? encryptSecret(JSON.stringify(body.authHeaders))
      : null;
  }

  return patch;
}

const normalizeUrl = (url) =>
  /^https?:\/\//i.test(url) ? url : `https://${url}`;

/**
 * Refuse an internal target when the monitor is saved, with a message the UI
 * can show. The probe's connect-time guard is what enforces the rule on every
 * check; this only makes the refusal immediate and explicit.
 */
async function assertMonitorTarget(url) {
  try {
    await assertPublicUrl(url);
  } catch (err) {
    throw new ApiError(400, err.message);
  }
}

/**
 * Strip encrypted credentials from anything returned to a client. The
 * ciphertext is useless without the key, but there is no reason to ship it to
 * the browser, and doing so would expose it to any XSS that lands.
 */
const present = (monitor) => {
  if (!monitor) return monitor;
  const obj = monitor.toObject ? monitor.toObject() : { ...monitor };
  obj.hasAuthHeaders = Boolean(obj.authHeaders);
  delete obj.authHeaders;
  return obj;
};

export const createMonitorController = asyncHandler(async (req, res) => {
  const { url } = req.body;

  if (!url) {
    throw new ApiError(400, 'URL is required');
  }

  const normalizedUrl = normalizeUrl(url);
  await assertMonitorTarget(normalizedUrl);

  const isAlreadyMonitored = await monitorDao.findOne(req.user.id, {
    url: normalizedUrl,
  });

  if (isAlreadyMonitored) {
    throw new ApiError(409, 'This URL is already being monitored');
  }

  try {
    // The DAO stamps ownership; userId is never read from the request body.
    const monitor = await monitorDao.create(req.user.id, {
      ...pickWritableFields(req.body),
      url: normalizedUrl,
      // Due immediately — a user who just added a monitor expects a result now,
      // not one interval from now.
      nextCheckAt: new Date(),
    });

    return res
      .status(201)
      .json(
        new ApiResponse(201, present(monitor), 'Monitor created successfully')
      );
  } catch (error) {
    logger.error({ err: error }, 'Error creating monitor');
    throw new ApiError(500, 'Internal server error');
  }
});

export const getAllMonitorsController = asyncHandler(async (req, res) => {
  const monitors = await monitorDao.find(req.user?.id);
  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        monitors.map(present),
        'Monitors retrieved successfully'
      )
    );
});

export const deleteMonitorController = asyncHandler(async (req, res) => {
  const monitor = await monitorDao.deleteById(
    req.user?.id,
    req.params.monitorId
  );

  if (!monitor) {
    // 404 rather than 403 so we don't confirm the id exists.
    throw new ApiError(404, 'Monitor not found');
  }

  return res
    .status(200)
    .json(new ApiResponse(200, null, 'Monitor deleted successfully'));
});

export const updateMonitorController = asyncHandler(async (req, res) => {
  const patch = pickWritableFields(req.body);
  if (req.body.url) {
    patch.url = normalizeUrl(req.body.url);
    await assertMonitorTarget(patch.url);
  }

  const updatedMonitor = await monitorDao.updateById(
    req.user?.id,
    req.params.monitorId,
    patch
  );

  if (!updatedMonitor) {
    throw new ApiError(404, 'Monitor not found');
  }

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        present(updatedMonitor),
        'Monitor updated successfully'
      )
    );
});
