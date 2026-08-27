import { Router } from 'express';
import { getStats } from '../services/statsService.js';
import { getHolderStats } from '../services/holderIndexer.js';

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
