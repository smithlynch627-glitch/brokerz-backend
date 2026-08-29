import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../supabase.js';
import { redeemRateLimit } from '../middleware/rateLimit.js';
import { getLaunchStatus } from '../services/launchConfigService.js';

export const accessRouter = Router();

// Deliberately permissive: a code can be 6 chars, a full EVM address, or
// anything else you load into Supabase. This only rejects obviously-bogus
// input; the real check is an exact match against the database.
const CODE_SHAPE = /^[A-Za-z0-9-]{4,64}$/;
const TOKEN_SHAPE = /^[a-f0-9]{64}$/;

/**
 * Sessions are identified by a 256-bit random token held by the browser.
 * Only its SHA-256 hash is stored server-side, so the database alone can't
 * be used to mint working sessions.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// GET /api/access/launch-status - public, no auth. Drives the countdown UI.
accessRouter.get('/launch-status', async (_req, res) => {
  try {
    res.json(await getLaunchStatus());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to read launch status' });
  }
});

/**
 * GET /api/access/verify?token=...&bypass=...
 * The single authority on "may this visitor see the site". No wallet
 * involved anywhere - access belongs to a browser session, not an address.
 */
accessRouter.get('/verify', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const bypass = typeof req.query.bypass === 'string' ? req.query.bypass : '';

  try {
    const launch = await getLaunchStatus();

    // Once public, nobody needs anything.
    if (launch.phase === 'public') {
      res.json({ hasAccess: true, phase: launch.phase, reason: 'public' });
      return;
    }

    // Admin bypass link (?bypass=...). Checked against Supabase so tokens
    // can be added/revoked without a redeploy.
    if (bypass) {
      const { data } = await supabase.from('bypass_tokens').select('token').eq('token', bypass).maybeSingle();
      if (data) {
        res.json({ hasAccess: true, phase: launch.phase, reason: 'bypass' });
        return;
      }
    }

    if (token && TOKEN_SHAPE.test(token)) {
      const { data } = await supabase.rpc('session_is_valid', { p_token_hash: hashToken(token) });
      if (data) {
        res.json({ hasAccess: true, phase: launch.phase, reason: 'session' });
        return;
      }
    }

    res.json({ hasAccess: false, phase: launch.phase, reason: 'none' });
  } catch {
    res.status(502).json({ error: 'Failed to verify access' });
  }
});

/**
 * POST /api/access/check  body: { code }
 * Verifies a code without consuming it, so people can confirm theirs is real
 * before the window opens. Rate-limited as hard as redeem: this is a code
 * oracle, and left open it would let someone enumerate valid codes.
 */
accessRouter.post('/check', redeemRateLimit, async (req, res) => {
  const { code } = req.body ?? {};

  if (typeof code !== 'string' || !CODE_SHAPE.test(code.trim())) {
    res.json({ status: 'invalid' });
    return;
  }

  try {
    const { data, error } = await supabase.rpc('check_code', { p_code: code.trim() });
    if (error) {
      res.status(502).json({ error: 'Could not check that code right now.' });
      return;
    }
    res.json({ status: data as 'valid' | 'used' | 'invalid' });
  } catch {
    res.status(502).json({ error: 'Could not check that code right now.' });
  }
});

/**
 * POST /api/access/redeem  body: { code }
 * Returns a session token on success. Heavily rate-limited: this is the
 * endpoint a script would hammer to guess codes.
 */
accessRouter.post('/redeem', redeemRateLimit, async (req, res) => {
  const { code } = req.body ?? {};

  if (typeof code !== 'string' || !CODE_SHAPE.test(code.trim())) {
    res.status(400).json({ error: 'That code format looks wrong - check it and try again.' });
    return;
  }

  try {
    const launch = await getLaunchStatus();

    // Enforced server-side, so calling this endpoint directly before the
    // whitelist window opens achieves nothing.
    if (launch.phase === 'coming_soon') {
      res.status(403).json({ error: "Access codes aren't active yet - check the countdown." });
      return;
    }

    const token = randomBytes(32).toString('hex');
    const { data, error } = await supabase.rpc('redeem_code', {
      p_code: code.trim(),
      p_token_hash: hashToken(token),
    });

    if (error) {
      res.status(502).json({ error: 'Something went wrong redeeming that code.' });
      return;
    }
    if (!data) {
      res.status(400).json({ error: 'That code is invalid or has already been used.' });
      return;
    }

    res.json({ hasAccess: true, token });
  } catch {
    res.status(502).json({ error: 'Something went wrong redeeming that code.' });
  }
});
