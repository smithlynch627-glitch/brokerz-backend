import { Router } from 'express';
import { getWalletStatus } from '../services/walletService.js';
import { getTokensOwnedBy } from '../services/holderIndexer.js';
import { getTokenMetadataBatch } from '../services/tokenMetadataService.js';
import { isAddress } from 'viem';

export const walletRouter = Router();

// GET /api/wallet/:address - called once a wallet connects, and re-polled
// after the frontend sees a transaction confirm, so the UI reflects the
// new balance/credits without a full page reload.
walletRouter.get('/:address', async (req, res) => {
  try {
    const status = await getWalletStatus(req.params.address);
    res.json(status);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 502;
    res.status(statusCode).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/wallet/:address/tokens - which Brokerz Homes this address owns
// right now, with resolved display metadata for each. Powers the "Your
// Brokerz Homes" section on the Mint page.
walletRouter.get('/:address/tokens', async (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) {
    res.status(400).json({ error: 'Invalid address' });
    return;
  }
  try {
    const tokenIds = getTokensOwnedBy(address);
    const tokens = await getTokenMetadataBatch(tokenIds);
    res.json({ tokens });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
