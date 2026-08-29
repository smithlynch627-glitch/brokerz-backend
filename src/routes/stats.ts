import { Router } from 'express';
import { getStats } from '../services/statsService.js';
import { getHolderStats } from '../services/holderIndexer.js';
import { pollerState } from '../services/chainPoller.js';
import { getRecentActivity } from '../services/activityService.js';

export const statsRouter = Router();

// GET /api/stats - everything the hero stats bar / progress bars need in one call.
statsRouter.get('/', async (_req, res) => {
  try {
    const [stats, holders] = await Promise.all([getStats(), Promise.resolve(getHolderStats())]);
    res.json({ ...stats, holders });
  } catch (err) {
    res.status(502).json({ error: 'Failed to read contract state', detail: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/stats/debug — poller health. Public because it exposes nothing
// that isn't already readable on the explorer, and being able to check it
// from a browser beats digging through deployment logs.
statsRouter.get('/debug', (_req, res) => {
  res.json({
    poller: pollerState(),
    activityItems: getRecentActivity().length,
    holders: getHolderStats(),
  });
});
