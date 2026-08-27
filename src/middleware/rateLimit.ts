import rateLimit from 'express-rate-limit';

// Generous but real - normal polling (stats every few seconds, one wallet
// lookup on connect) sits comfortably under this. A script hammering the
// API gets throttled with a standard 429 response instead of being able to
// drive unlimited RPC calls through this server.
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 120, // per IP, per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests - slow down and try again shortly.' },
});

// SSE connections are long-lived, not repeated requests - rate-limit how
// often a single IP can OPEN a new stream connection, separately from the
// general API limit above (a reconnect loop shouldn't burn through the
// same budget as normal polling would).
export const streamRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream connection attempts - slow down and try again shortly.' },
});

// Much stricter than the general API limit, and specifically scoped to
// code-redemption attempts - this is the main defense against someone
// scripting through guesses at a valid access code. 31^12 possible codes
// makes brute-forcing infeasible on its own, but rate limiting is cheap
//, meaningful defense-in-depth on top of that, not a substitute for it.
export const redeemRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts - wait a while before trying again.' },
});
