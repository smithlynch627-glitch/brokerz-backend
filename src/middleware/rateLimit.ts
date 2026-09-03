import rateLimit from 'express-rate-limit';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

const API_LIMIT = num('RATE_LIMIT_API', 2000);
const STREAM_LIMIT = num('RATE_LIMIT_STREAM', 200);
const REDEEM_LIMIT = num('RATE_LIMIT_REDEEM', 30);

/**
 * Counted per IP, but mobile carriers put thousands of users behind a single
 * address via CGNAT — so a limit tuned for one person throttles a whole
 * network. The default is set high enough that shared IPs are not punished,
 * while still capping a script hammering the API.
 *
 * Set RATE_LIMIT_API=0 to disable entirely.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: API_LIMIT,
  skip: () => API_LIMIT === 0,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down and try again shortly.' },
});

export const streamRateLimit = rateLimit({
  windowMs: 60_000,
  limit: STREAM_LIMIT,
  skip: () => STREAM_LIMIT === 0,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream connection attempts — try again shortly.' },
});

/**
 * Guards code redemption and checking.
 *
 * Keep this one. Codes are now reusable, so a single valid code found by
 * guessing grants permanent access to everyone it is shared with — which
 * makes brute-forcing far more valuable than when codes were single-use.
 * This is the only thing standing between an attacker and enumerating the
 * code space.
 */
export const redeemRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: REDEEM_LIMIT,
  skip: () => REDEEM_LIMIT === 0,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — wait a few minutes and try again.' },
});
