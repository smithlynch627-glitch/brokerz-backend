import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { isAddress, verifyMessage } from 'viem';
import { supabase } from '../supabase.js';
import { config } from '../config.js';
import { getWinners, participantCount } from '../services/raffleChain.js';
import { drawWinners } from '../services/offchainDraw.js';
import { privateKeyToAccount } from 'viem/accounts';
import { redeemRateLimit } from '../middleware/rateLimit.js';

export const raffleAdminRouter = Router();

/**
 * Admin auth by wallet signature.
 *
 * No password to leak and no extra credential to manage: the admin proves
 * control of a wallet listed in admin_wallets by signing a one-time nonce.
 * Nonces are single-use so a captured signature cannot be replayed.
 */
const nonces = new Map<string, { nonce: string; expires: number }>();
const sessions = new Map<string, { wallet: string; expires: number }>();
const SESSION_MS = 8 * 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires < now) nonces.delete(k);
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
}
setInterval(sweep, 10 * 60 * 1000);

async function isAdminWallet(wallet: string): Promise<boolean> {
  const { data } = await supabase.rpc('is_admin', { p_wallet: wallet.toLowerCase() });
  return Boolean(data);
}

function requireAdmin(req: import('express').Request, res: import('express').Response): string | null {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const s = token ? sessions.get(createHash('sha256').update(token).digest('hex')) : undefined;
  if (!s || s.expires < Date.now()) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return s.wallet;
}

/**
 * GET /api/raffle-admin/check/:address
 * Whether a wallet may see the admin tab. Public because the answer leaks
 * nothing — an attacker already knows their own address is not an admin, and
 * hiding this would mean shipping the admin list to every visitor instead.
 */
raffleAdminRouter.get('/check/:address', async (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) { res.json({ isAdmin: false }); return; }
  try {
    res.json({ isAdmin: await isAdminWallet(address) });
  } catch {
    res.json({ isAdmin: false });
  }
});

// POST /api/raffle-admin/nonce  { wallet }
raffleAdminRouter.post('/nonce', redeemRateLimit, async (req, res) => {
  const { wallet } = req.body ?? {};
  if (typeof wallet !== 'string' || !isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }
  if (!(await isAdminWallet(wallet))) { res.status(403).json({ error: 'Not an admin wallet' }); return; }

  const nonce = randomBytes(16).toString('hex');
  nonces.set(wallet.toLowerCase(), { nonce, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ message: `Sign in to Brokerz Rafflor admin.\n\nNonce: ${nonce}` });
});

// POST /api/raffle-admin/login  { wallet, signature }
raffleAdminRouter.post('/login', redeemRateLimit, async (req, res) => {
  const { wallet, signature } = req.body ?? {};
  if (typeof wallet !== 'string' || !isAddress(wallet) || typeof signature !== 'string') {
    res.status(400).json({ error: 'Invalid request' }); return;
  }

  const entry = nonces.get(wallet.toLowerCase());
  if (!entry || entry.expires < Date.now()) { res.status(400).json({ error: 'Nonce expired — try again' }); return; }

  const message = `Sign in to Brokerz Rafflor admin.\n\nNonce: ${entry.nonce}`;
  let ok = false;
  try {
    ok = await verifyMessage({ address: wallet as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch { ok = false; }

  if (!ok) { res.status(401).json({ error: 'Signature did not verify' }); return; }
  nonces.delete(wallet.toLowerCase());          // single use
  if (!(await isAdminWallet(wallet))) { res.status(403).json({ error: 'Not an admin wallet' }); return; }

  const token = randomBytes(32).toString('hex');
  sessions.set(createHash('sha256').update(token).digest('hex'), {
    wallet: wallet.toLowerCase(), expires: Date.now() + SESSION_MS,
  });
  res.json({ token });
});

/**
 * GET /api/raffle-admin/me
 * Whether the caller's token is still valid.
 *
 * Sessions live in memory, so any backend restart invalidates them — which
 * happens constantly under tsx watch. The token survives in localStorage
 * regardless, so without this check the panel shows a working-looking form
 * whose every request 401s.
 */
raffleAdminRouter.get('/me', (req, res) => {
  const wallet = requireAdmin(req, res);
  if (!wallet) return;
  res.json({ wallet });
});

/**
 * GET /api/raffle-admin/operator
 * The public address derived from OPERATOR_PRIVATE_KEY.
 *
 * Returns an address, never the key. The owner has to call setOperator with
 * this value or the backend cannot draw — and without it there is no way to
 * find the address short of importing the key into a wallet by hand.
 */
raffleAdminRouter.get('/operator', (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (!config.operatorPrivateKey) {
    res.json({ configured: false, address: null });
    return;
  }
  try {
    const account = privateKeyToAccount(config.operatorPrivateKey as `0x${string}`);
    res.json({ configured: true, address: account.address });
  } catch {
    res.json({ configured: true, address: null, error: 'OPERATOR_PRIVATE_KEY is not a valid key' });
  }
});

// GET /api/raffle-admin/raffles — everything, drafts included
raffleAdminRouter.get('/raffles', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Explicit column list rather than select('*') — seed_secret must never
  // leave the server, and a wildcard would ship it to the admin browser and
  // any future column with it.
  // Read through raffle_public: it already computes entrant_count and
  // total_weight, and excludes seed_secret by construction. Selecting from the
  // base table returned rows with no counts, which is why the admin table
  // showed an empty Entrants column.
  const { data, error } = await supabase
    .from('raffle_public').select('*').order('ends_at', { ascending: false });
  if (error) { res.status(502).json({ error: 'Could not load raffles' }); return; }
  res.json({ raffles: data ?? [] });
});

/**
 * POST /api/raffle-admin/raffles/:id/close  { action }
 *
 * Database-level lifecycle for raffles with no on-chain presence. A gasless
 * holder raffle has no contract entry, so the on-chain end and cancel calls
 * have nothing to act on — without this the admin buttons simply refuse.
 */
raffleAdminRouter.post('/raffles/:id/close', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { action } = req.body ?? {};

  const { data: raffle } = await supabase
    .from('raffles').select('id, gasless, chain_raffle_id, status').eq('id', req.params.id).maybeSingle();
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  if (action === 'end') {
    // Backdating the end time is what makes the auto-draw pick it up on its
    // next pass, rather than waiting for the original timer.
    const { error } = await supabase.from('raffles')
      .update({ ends_at: new Date().toISOString(), status: 'ended' })
      .eq('id', raffle.id);
    if (error) { res.status(502).json({ error: error.message }); return; }
    res.json({ ok: true, message: 'Entries closed. It will draw on the next pass.' });
    return;
  }

  if (action === 'cancel') {
    const { error } = await supabase.from('raffles')
      .update({ status: 'cancelled', auto_draw: false }).eq('id', raffle.id);
    if (error) { res.status(502).json({ error: error.message }); return; }
    res.json({ ok: true, message: 'Cancelled. It will not draw.' });
    return;
  }

  res.status(400).json({ error: 'Unknown action' });
});

/**
 * DELETE /api/raffle-admin/raffles/:id
 *
 * Removes the raffle and, by cascade, its tasks, entries and winners.
 *
 * Refused once winners are published: at that point people have been told they
 * won, and deleting the record leaves them with no way to point at it. Cancel
 * or archive instead.
 */
raffleAdminRouter.delete('/raffles/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { data: raffle } = await supabase
    .from('raffles').select('id, winners_published, chain_raffle_id, project_name')
    .eq('id', req.params.id).maybeSingle();
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  if (raffle.winners_published) {
    res.status(400).json({
      error: 'Winners are already published — deleting would erase the record people were shown. Archive it instead.',
    });
    return;
  }

  const { count } = await supabase
    .from('raffle_entries').select('id', { count: 'exact', head: true }).eq('raffle_id', raffle.id);

  const { error } = await supabase.from('raffles').delete().eq('id', raffle.id);
  if (error) { res.status(502).json({ error: error.message }); return; }

  res.json({
    ok: true,
    message: `Deleted "${raffle.project_name}" and ${count ?? 0} ${count === 1 ? 'entry' : 'entries'}.`,
    onChainRemains: raffle.chain_raffle_id !== null,
  });
});

/**
 * POST /api/raffle-admin/raffles/:id/draw-now
 *
 * Runs the draw immediately, ignoring the timer.
 *
 * The scheduler only picks up raffles whose end time has passed, so a raffle
 * that needs deciding early — or one whose scheduled attempt failed — has no
 * other way to be resolved from the panel.
 */
raffleAdminRouter.post('/raffles/:id/draw-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { data: r } = await supabase
    .from('raffles')
    .select('id, slug, kind, spots, gasless, seed_secret, chain_raffle_id, status')
    .eq('id', req.params.id).maybeSingle();

  if (!r) { res.status(404).json({ error: 'Raffle not found' }); return; }
  if (r.status === 'cancelled') { res.status(400).json({ error: 'This raffle is cancelled' }); return; }

  // Fixed-GTD spots were claimed as they were bought — nothing to draw
  if (r.kind === 'fixed_gtd') {
    await supabase.from('raffles')
      .update({ status: 'drawn', winners_published: true }).eq('id', r.id);
    res.json({ ok: true, message: 'Spots were claimed directly. Winners published.' });
    return;
  }

  if (!r.gasless) {
    res.status(400).json({
      error: 'This raffle draws on-chain. Call draw() on the contract, then press Refresh winners.',
    });
    return;
  }

  if (!r.seed_secret) {
    res.status(400).json({ error: 'No draw seed stored for this raffle — it cannot be drawn.' });
    return;
  }

  const { data: entrants } = await supabase
    .from('raffle_entries').select('wallet_address, entry_weight').eq('raffle_id', r.id);

  if (!entrants?.length) {
    res.status(400).json({ error: 'Nobody entered this raffle.' });
    return;
  }

  try {
    const picked = drawWinners(
      r.seed_secret,
      entrants.map((e) => ({ wallet: e.wallet_address, weight: e.entry_weight })),
      r.spots
    );

    if (picked.length) {
      await supabase.from('raffle_winners').upsert(
        picked.map((w, i) => ({ raffle_id: r.id, wallet_address: w, position: i })),
        { onConflict: 'raffle_id,wallet_address' }
      );
    }

    await supabase.from('raffles').update({
      status: 'drawn',
      winners_published: true,
      ends_at: new Date().toISOString(),
      seed_published_at: new Date().toISOString(),
      draw_attempted_at: new Date().toISOString(),
      draw_error: null,
    }).eq('id', r.id);

    res.json({ ok: true, message: `Drew ${picked.length} of ${r.spots} and published them.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('raffles').update({ draw_error: message.slice(0, 300) }).eq('id', r.id);
    res.status(502).json({ error: message });
  }
});

// POST /api/raffle-admin/raffles — create, with its task list
raffleAdminRouter.post('/raffles', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body ?? {};

  if (!b.slug || !b.project_name || !b.kind || !b.spots || !b.starts_at || !b.ends_at) {
    res.status(400).json({ error: 'slug, project_name, kind, spots, starts_at and ends_at are required' });
    return;
  }

  const { data, error } = await supabase.from('raffles').insert({
    slug: String(b.slug).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    chain_raffle_id: b.chain_raffle_id ?? null,
    kind: b.kind,
    spot_type: b.spot_type ?? 'GTD',
    project_name: b.project_name,
    project_description: b.project_description ?? null,
    banner_url: b.banner_url ?? null,
    logo_url: b.logo_url ?? null,
    project_x: b.project_x ?? null,
    project_discord: b.project_discord ?? null,
    project_telegram: b.project_telegram ?? null,
    socials_required: b.socials_required ?? true,
    team_x: b.team_x ?? null,
    team_discord: b.team_discord ?? null,
    team_telegram: b.team_telegram ?? null,
    spots: Number(b.spots),
    cost_per_entry: String(b.cost_per_entry ?? '0'),
    max_entries_per_user: Number(b.max_entries_per_user ?? 0),
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    status: b.status ?? 'draft',
    seed_secret: b.seed_secret ?? null,
    seed_commitment: b.seed_commitment ?? null,
    chain_key: b.chain_key ?? null,
    gasless: b.gasless ?? false,
    auto_draw: b.auto_draw ?? true,
  }).select().single();

  if (error) { res.status(400).json({ error: error.message }); return; }

  if (Array.isArray(b.tasks) && b.tasks.length) {
    await supabase.from('raffle_tasks').insert(
      b.tasks.map((t: Record<string, unknown>, i: number) => ({
        raffle_id: data.id,
        position: i,
        task_type: t.task_type ?? 'custom',
        label: t.label ?? 'Task',
        target_url: t.target_url ?? null,
        required: t.required ?? true,
      }))
    );
  }

  res.json({ raffle: data });
});

// PATCH /api/raffle-admin/raffles/:id
raffleAdminRouter.patch('/raffles/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const allowed = ['status','chain_raffle_id','seed_secret','seed_commitment','chain_key','gasless','auto_draw','hidden','banner_url','logo_url','project_description',
    'project_x','project_discord','project_telegram','team_x','team_discord','team_telegram',
    'spots','cost_per_entry','max_entries_per_user','starts_at','ends_at','winners_published','spot_type'];

  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in (req.body ?? {})) patch[k] = req.body[k];
  if (!Object.keys(patch).length) { res.status(400).json({ error: 'Nothing to update' }); return; }

  const { data, error } = await supabase.from('raffles').update(patch).eq('id', req.params.id).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json({ raffle: data });
});

// GET /api/raffle-admin/raffles/:id/entries — full list with identities
raffleAdminRouter.get('/raffles/:id/entries', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { data, error } = await supabase
    .from('raffle_entries')
    .select('wallet_address, delivery_address, delivery_chain, burner_wallet, x_username, ' +
            'discord_username, entry_weight, tx_hash, created_at')
    .eq('raffle_id', req.params.id)
    .order('entry_weight', { ascending: false });
  if (error) { res.status(502).json({ error: 'Could not load entries' }); return; }
  res.json({ entries: data ?? [] });
});

/**
 * POST /api/raffle-admin/raffles/:id/sync-winners
 * Pulls the drawn winners from the contract and joins them to identity.
 * The chain is the source of truth; this only mirrors it for display.
 */
raffleAdminRouter.post('/raffles/:id/sync-winners', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { data: raffle } = await supabase
    .from('raffles').select('id, chain_raffle_id, gasless').eq('id', req.params.id).maybeSingle();
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  // Gasless raffles have no on-chain entries — the draw already wrote winners
  // here, so return what is stored rather than reading an empty contract.
  if (raffle.gasless || !raffle.chain_raffle_id) {
    const { data: stored } = await supabase
      .from('raffle_winners').select('*').eq('raffle_id', raffle.id).order('position');
    res.json({ count: stored?.length ?? 0, winners: stored ?? [] });
    return;
  }

  let addresses: string[];
  try {
    addresses = await getWinners(Number(raffle.chain_raffle_id));
  } catch {
    res.status(502).json({ error: 'Could not read winners from chain' }); return;
  }

  if (addresses.length) {
    await supabase.from('raffle_winners').upsert(
      addresses.map((a, i) => ({ raffle_id: raffle.id, wallet_address: a.toLowerCase(), position: i })),
      { onConflict: 'raffle_id,wallet_address' }
    );
    await supabase.from('raffles').update({ status: 'drawn' }).eq('id', raffle.id);
  }

  const { data: joined } = await supabase
    .from('raffle_winners').select('*').eq('raffle_id', raffle.id).order('position');
  res.json({ count: addresses.length, winners: joined ?? [] });
});

/**
 * GET /api/raffle-admin/raffles/:id/winners
 * Winners with identity attached, for any raffle type.
 */
raffleAdminRouter.get('/raffles/:id/winners', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { data: winners } = await supabase
    .from('raffle_winners').select('wallet_address, position').eq('raffle_id', req.params.id).order('position');

  if (!winners?.length) { res.json({ winners: [] }); return; }

  const { data: entries } = await supabase
    .from('raffle_entries')
    .select('wallet_address, delivery_address, burner_wallet, x_username, discord_username, entry_weight')
    .eq('raffle_id', req.params.id);

  const byWallet = new Map((entries ?? []).map((e) => [e.wallet_address.toLowerCase(), e]));

  res.json({
    winners: winners.map((w) => {
      const e = byWallet.get(w.wallet_address.toLowerCase());
      return {
        position: w.position + 1,
        entry_wallet: w.wallet_address,
        payout_address: e?.delivery_address ?? e?.burner_wallet ?? '',
        x_username: e?.x_username ?? '',
        discord_username: e?.discord_username ?? '',
        entries: e?.entry_weight ?? 0,
      };
    }),
  });
});

// GET /api/raffle-admin/raffles/:id/chain — live on-chain counts
raffleAdminRouter.get('/raffles/:id/chain', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { data: raffle } = await supabase
    .from('raffles').select('chain_raffle_id').eq('id', req.params.id).maybeSingle();
  if (!raffle?.chain_raffle_id) { res.json({ linked: false }); return; }
  try {
    const [participants, winners] = await Promise.all([
      participantCount(Number(raffle.chain_raffle_id)),
      getWinners(Number(raffle.chain_raffle_id)),
    ]);
    res.json({ linked: true, participants, winners: winners.length });
  } catch {
    res.status(502).json({ error: 'Chain read failed' });
  }
});
