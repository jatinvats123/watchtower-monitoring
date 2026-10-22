import { channelDao, notificationLogDao } from '../dao/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { sendEmail } from '../services/sendEmail.js';
import { assertPublicUrl } from '../utils/egress.js';
import logger from '../config/logger.js';

const TYPES = ['Email', 'Slack', 'Webhook', 'SMS'];

// Delivered by POSTing to the target (webhook.notifier.js), so it must be a URL
// the egress guard will let the server reach.
const URL_TYPES = ['Slack', 'Webhook'];

async function assertDeliverable(type, target) {
  if (!URL_TYPES.includes(type)) return;
  try {
    await assertPublicUrl(target);
  } catch (err) {
    throw new ApiError(
      400,
      err.code === 'ERR_EGRESS_BLOCKED'
        ? err.message
        : `${type} target must be an http:// or https:// URL`
    );
  }
}

export const listChannels = asyncHandler(async (req, res) => {
  const channels = await channelDao.find(
    req.user.id,
    {},
    { sort: { createdAt: 1 } }
  );
  res
    .status(200)
    .json(new ApiResponse(200, channels, 'Channels retrieved successfully'));
});

export const createChannel = asyncHandler(async (req, res) => {
  const { type, target } = req.body;

  if (!target || !String(target).trim()) {
    throw new ApiError(400, 'Target is required');
  }
  if (type && !TYPES.includes(type)) {
    throw new ApiError(400, `Type must be one of: ${TYPES.join(', ')}`);
  }
  if ((type || 'Email') === 'Email' && !/^\S+@\S+\.\S+$/.test(target)) {
    throw new ApiError(400, 'Enter a valid email address');
  }
  await assertDeliverable(type || 'Email', String(target).trim());

  const exists = await channelDao.findOne(req.user.id, {
    type: type || 'Email',
    target: String(target).trim(),
  });
  if (exists) throw new ApiError(409, 'That channel already exists');

  const channel = await channelDao.create(req.user.id, {
    type: type || 'Email',
    target: String(target).trim(),
  });

  res
    .status(201)
    .json(new ApiResponse(201, channel, 'Channel created successfully'));
});

export const updateChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const update = {};
  if (typeof req.body.active === 'boolean') update.active = req.body.active;
  if (req.body.target) update.target = String(req.body.target).trim();
  if (req.body.type) {
    if (!TYPES.includes(req.body.type)) throw new ApiError(400, 'Invalid type');
    update.type = req.body.type;
  }

  // Either half can change on its own, so judge the pair as it will be stored.
  if (update.target || update.type) {
    const current = await channelDao.findById(req.user.id, channelId);
    if (!current) throw new ApiError(404, 'Channel not found');
    await assertDeliverable(
      update.type ?? current.type,
      update.target ?? current.target
    );
  }

  const channel = await channelDao.updateById(req.user.id, channelId, update);
  if (!channel) throw new ApiError(404, 'Channel not found');

  res
    .status(200)
    .json(new ApiResponse(200, channel, 'Channel updated successfully'));
});

export const deleteChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const channel = await channelDao.deleteById(req.user.id, channelId);
  if (!channel) throw new ApiError(404, 'Channel not found');

  res
    .status(200)
    .json(new ApiResponse(200, channel, 'Channel deleted successfully'));
});

// Send a real test message so the user can confirm the channel works
export const testChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const channel = await channelDao.findById(req.user.id, channelId);
  if (!channel) throw new ApiError(404, 'Channel not found');

  let status = 'Delivered';
  let detail = 'Test dispatch sent';

  try {
    if (channel.type === 'Email') {
      await sendEmail({
        email: channel.target,
        subject: 'WatchTower test notification',
        html: `<p>This is a test notification from WatchTower.</p>
               <p>If you received this, your <strong>${channel.type}</strong> channel is configured correctly.</p>`,
      });
    } else {
      status = 'Skipped';
      detail = `${channel.type} delivery is not configured on this deployment`;
    }
  } catch (err) {
    logger.error({ err }, 'Test dispatch failed');
    status = 'Failed';
    detail = err?.message || 'Dispatch failed';
  }

  await notificationLogDao.create(req.user.id, {
    event: 'TEST_DISPATCH',
    channel: channel.type,
    target: channel.target,
    status,
    detail,
  });

  if (status === 'Failed') throw new ApiError(502, detail);

  res.status(200).json(new ApiResponse(200, { status, detail }, detail));
});

// Transmission Log — real dispatch history for this user
export const listNotificationLogs = asyncHandler(async (req, res) => {
  const logs = await notificationLogDao.find(
    req.user.id,
    {},
    {
      sort: { createdAt: -1 },
      limit: 50,
      populate: { path: 'monitorId', select: 'title url' },
    }
  );

  res
    .status(200)
    .json(
      new ApiResponse(200, logs, 'Notification logs retrieved successfully')
    );
});
