import { Router } from 'express';
import { getRecentActivity, onActivity } from '../services/activityService.js';
import { streamRateLimit } from '../middleware/rateLimit.js';

export const activityRouter = Router();

// GET /api/activity - snapshot of recent activity, for the initial page load
// or as a polling fallback if a client can't hold an SSE connection open.
activityRouter.get('/', (_req, res) => {
  res.json({ items: getRecentActivity() });
});

// SECURITY: streamRateLimit caps how many NEW stream connections an IP can
// open per minute, but says nothing about how many can stay open at once -
// a patient client opening just under that limit, repeatedly, without ever
// disconnecting could still accumulate an unbounded number of long-lived
// connections over time. This caps total concurrent streams server-wide,
// independent of per-IP behavior.
const MAX_CONCURRENT_STREAMS = 500;
let openStreamCount = 0;

// GET /api/activity/stream - Server-Sent Events. One-directional,
// server-to-client, auto-reconnects on its own in the browser (EventSource
// handles that natively) - simpler than a full WebSocket for a feed that
// only ever pushes one direction.
activityRouter.get('/stream', streamRateLimit, (req, res) => {
  if (openStreamCount >= MAX_CONCURRENT_STREAMS) {
    res.status(503).json({ error: 'Too many active connections - try again shortly.' });
    return;
  }
  openStreamCount++;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send what's already known immediately, so a client that just connected
  // isn't staring at an empty feed until the next new event happens.
  res.write(`event: snapshot\ndata: ${JSON.stringify(getRecentActivity())}\n\n`);

  const unsubscribe = onActivity((item) => {
    res.write(`event: activity\ndata: ${JSON.stringify(item)}\n\n`);
  });

  // Keep the connection alive through idle proxies/load balancers that
  // might otherwise time out a silent HTTP connection.
  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    openStreamCount--;
  });
});
