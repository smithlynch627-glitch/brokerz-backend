import express from 'express';
import { config } from './config.js';
import { applySecurityMiddleware } from './middleware/security.js';
import { apiRateLimit } from './middleware/rateLimit.js';
import { statsRouter } from './routes/stats.js';
import { walletRouter } from './routes/wallet.js';
import { activityRouter } from './routes/activity.js';
import { accessRouter } from './routes/access.js';
import { metadataRouter } from './routes/metadata.js';
import { startChainPoller } from './services/chainPoller.js';
import './services/holderIndexer.js';
import './services/activityService.js';

const app = express();

// SECURITY: Railway (like most PaaS hosts) sits your app behind a reverse
// proxy. Without this, Express sees every request as coming from that
// proxy's internal IP, not the real visitor - which breaks express-rate-
// limit's whole premise of tracking abuse per-IP: every visitor would
// look identical, so the limit either does nothing (can't tell one abusive
// caller from everyone else) or wrongly punishes all your real users
// together as if they were one caller. "1" trusts exactly one hop of
// proxying, matching Railway's actual setup - not an open-ended trust of
// any forwarded-for header, which would let a client spoof its own IP and
// defeat rate limiting in the other direction.
app.set('trust proxy', 1);

applySecurityMiddleware(app);
// Rate limiting is scoped to /api only. Metadata is static public JSON with
// no abuse value, and marketplace crawlers fetch all 2,222 files in a burst
// from a handful of IPs — throttling them makes OpenSea cache failures as
// permanently broken tokens.
app.use('/api', apiRateLimit);
// Small limit deliberately - every request body in this API is a wallet
// address and/or a 14-character code, nothing here should ever need more
// than a few hundred bytes. Rejects oversized payloads before they're even
// parsed.
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', chainId: config.chainId }));

app.use('/api/stats', statsRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/activity', activityRouter);
app.use('/api/access', accessRouter);

// NFT metadata. Deliberately not under /api — the URL ends up baked into the
// contract, so it should read cleanly and never change.
app.use('/metadata', metadataRouter);

// 404 for anything else - this server only ever serves the routes above,
// nothing else should exist to be discovered by scanning.
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(config.port, () => {
  console.log(`Brokerz backend listening on :${config.port}`);
  console.log(`Reading contracts on chain ${config.chainId} via ${config.rpcUrl}`);
  console.log(`Allowed frontend origins: ${config.allowedOrigins.join(', ')}`);

  startChainPoller();
});
