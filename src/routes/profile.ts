import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { isAddress, verifyMessage } from 'viem';
import { supabase } from '../supabase.js';
import { redeemRateLimit } from '../middleware/rateLimit.js';

export const profileRouter = Router();

/**
 * Profiles are proved by signature, not by a session.
 *
 * Signing is free and instant, which is the whole point — asking someone to
 * pay gas to save a Discord handle would be absurd. Every write re-verifies
 * the signature, so there is no token to steal or expire.
 */
async function provesOwnership(wallet: string, signature: string, nonce: string): Promise<boolean> {
  const { data } = await supabase
    .from('entry_nonces').select('nonce, wallet, used')
    .eq('nonce', nonce).maybeSingle();

  if (!data || data.used) return false;
  if (data.wallet.toLowerCase() !== wallet.toLowerCase()) return false;

  const message = `Brokerz Rafflor\n\nProve this wallet is yours.\n\nNonce: ${nonce}`;
  try {
    const ok = await verifyMessage({
      address: wallet as `0x${string}`, message, signature: signature as `0x${string}`,
    });
    if (ok) await supabase.from('entry_nonces').update({ used: true }).eq('nonce', nonce);
    return ok;
  } catch {
    return false;
  }
}

// GET /api/profile/chains — the chain list, driven by the database so new
// networks appear without a redeploy
profileRouter.get('/chains', async (_req, res) => {
  const { data } = await supabase
    .from('chains').select('key, label, family, address_regex, position')
    .eq('active', true).order('position');
  res.json({ chains: data ?? [] });
});

// POST /api/profile/nonce  { wallet }
profileRouter.post('/nonce', redeemRateLimit, async (req, res) => {
  const { wallet } = req.body ?? {};
  if (typeof wallet !== 'string' || !isAddress(wallet)) {
    res.status(400).json({ error: 'Invalid wallet' }); return;
  }

  const nonce = randomBytes(16).toString('hex');
  // raffle_id is nullable in practice for profile nonces; a sentinel row keeps
  // the same single-use machinery for both flows.
  const { error } = await supabase.from('entry_nonces').insert({
    nonce, wallet: wallet.toLowerCase(), raffle_id: null,
  });
  if (error) { res.status(502).json({ error: 'Could not start sign-in' }); return; }

  res.json({ nonce, message: `Brokerz Rafflor\n\nProve this wallet is yours.\n\nNonce: ${nonce}` });
});

// GET /api/profile/:wallet — public read; addresses are shown to winners anyway
profileRouter.get('/:wallet', async (req, res) => {
  const wallet = req.params.wallet.toLowerCase();
  if (!isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }

  const [{ data: profile }, { data: wallets }] = await Promise.all([
    supabase.from('raffle_profiles').select('*').eq('wallet', wallet).maybeSingle(),
    supabase.from('profile_wallets').select('chain_key, address').eq('wallet', wallet),
  ]);

  res.json({
    profile: profile ?? null,
    wallets: Object.fromEntries((wallets ?? []).map((w) => [w.chain_key, w.address])),
  });
});

// POST /api/profile — save socials and per-chain addresses
profileRouter.post('/', redeemRateLimit, async (req, res) => {
  const { wallet, signature, nonce, xUsername, discordUsername, telegramUsername, wallets } = req.body ?? {};

  if (typeof wallet !== 'string' || !isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }
  if (typeof signature !== 'string' || typeof nonce !== 'string') { res.status(400).json({ error: 'Signature required' }); return; }
  if (!(await provesOwnership(wallet, signature, nonce))) { res.status(401).json({ error: 'Signature did not verify' }); return; }

  const key = wallet.toLowerCase();

  const { error: pErr } = await supabase.from('raffle_profiles').upsert({
    wallet: key,
    x_username: typeof xUsername === 'string' ? xUsername.trim().replace(/^@/, '') : null,
    discord_username: typeof discordUsername === 'string' ? discordUsername.trim() : null,
    telegram_username: typeof telegramUsername === 'string' ? telegramUsername.trim().replace(/^@/, '') : null,
  }, { onConflict: 'wallet' });
  if (pErr) { res.status(502).json({ error: 'Could not save profile' }); return; }

  if (wallets && typeof wallets === 'object') {
    const { data: chains } = await supabase.from('chains').select('key, address_regex').eq('active', true);
    const rules = new Map((chains ?? []).map((c) => [c.key, c.address_regex as string | null]));

    const rows: Array<{ wallet: string; chain_key: string; address: string }> = [];
    const rejected: string[] = [];

    for (const [chainKey, addr] of Object.entries(wallets as Record<string, string>)) {
      if (!rules.has(chainKey)) continue;
      const value = String(addr ?? '').trim();
      if (!value) continue;

      // Validated per chain — a Solana address in the Ethereum slot would mean
      // a winner's prize sent somewhere unusable.
      const pattern = rules.get(chainKey);
      if (pattern && !new RegExp(pattern).test(value)) { rejected.push(chainKey); continue; }

      rows.push({ wallet: key, chain_key: chainKey, address: value });
    }

    if (rejected.length) {
      res.status(400).json({ error: `Address format looks wrong for: ${rejected.join(', ')}` });
      return;
    }
    if (rows.length) await supabase.from('profile_wallets').upsert(rows, { onConflict: 'wallet,chain_key' });
  }

  res.json({ ok: true });
});
