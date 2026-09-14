import { Router } from 'express';
import { isAddress } from 'viem';
import { supabase } from '../supabase.js';
import { config } from '../config.js';
import { verifyEntry, weightForHoldings, getTiers } from '../services/raffleChain.js';
import { redeemRateLimit } from '../middleware/rateLimit.js';
import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';

export const raffleRouter = Router();

function unavailable(res: import('express').Response) {
  res.status(503).json({ error: 'Rafflor is not configured yet.' });
}

// GET /api/raffles — everything live or finished, newest first
raffleRouter.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('raffle_public')
    .select('*')
    .in('status', ['live', 'ended', 'drawn'])
    .eq('hidden', false)
    .order('ends_at', { ascending: false });

  if (error) { res.status(502).json({ error: 'Could not load raffles' }); return; }
  res.json({ raffles: data ?? [] });
});

// GET /api/raffles/tiers — the holder ladder, straight from the contract
raffleRouter.get('/tiers', async (_req, res) => {
  if (!config.raffleAddress) { res.json({ tiers: [] }); return; }
  try {
    res.json({ tiers: await getTiers() });
  } catch {
    res.status(502).json({ error: 'Could not read tiers' });
  }
});

// GET /api/raffles/:slug — one raffle plus its task list
raffleRouter.get('/:slug', async (req, res) => {
  const { data: raffle, error } = await supabase
    .from('raffle_public').select('*').eq('slug', req.params.slug).maybeSingle();

  if (error) { res.status(502).json({ error: 'Could not load raffle' }); return; }
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  const { data: tasks } = await supabase
    .from('raffle_tasks').select('*').eq('raffle_id', raffle.id).order('position');

  res.json({ raffle, tasks: tasks ?? [] });
});

// GET /api/raffles/:slug/winners — burner wallets and handles only
raffleRouter.get('/:slug/winners', async (req, res) => {
  const { data, error } = await supabase
    .from('raffle_winners_public').select('*').eq('slug', req.params.slug).order('position');
  if (error) { res.status(502).json({ error: 'Could not load winners' }); return; }
  res.json({ winners: data ?? [] });
});

// GET /api/raffles/eligibility/:address — entry weight from NFT holdings
raffleRouter.get('/eligibility/:address', async (req, res) => {
  if (!config.raffleAddress) return unavailable(res);
  const { address } = req.params;
  if (!isAddress(address)) { res.status(400).json({ error: 'Invalid address' }); return; }
  try {
    res.json({ weight: await weightForHoldings(address) });
  } catch {
    res.status(502).json({ error: 'Could not read holdings' });
  }
});

/**
 * POST /api/raffles/:slug/entry
 * Records identity for an entry that already exists on-chain.
 *
 * The on-chain check is the whole point: without it anyone could post an entry
 * and appear among the winners without holding an NFT or paying anything.
 */
raffleRouter.post('/:slug/entry', redeemRateLimit, async (req, res) => {
  if (!config.raffleAddress) return unavailable(res);

  const { wallet, burnerWallet, xUsername, discordUsername, txHash } = req.body ?? {};

  if (typeof wallet !== 'string' || !isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }
  if (typeof burnerWallet !== 'string' || burnerWallet.trim().length < 20) { res.status(400).json({ error: 'Enter a valid receiving wallet address' }); return; }
  if (typeof xUsername !== 'string' || xUsername.trim().length < 2) { res.status(400).json({ error: 'Enter your X username' }); return; }
  if (typeof discordUsername !== 'string' || discordUsername.trim().length < 2) { res.status(400).json({ error: 'Enter your Discord username' }); return; }

  const { data: raffle } = await supabase
    .from('raffles').select('id, chain_raffle_id, status, chain_key').eq('slug', req.params.slug).maybeSingle();

  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }
  if (raffle.status !== 'live') { res.status(400).json({ error: 'This raffle is not open' }); return; }
  if (raffle.chain_raffle_id === null) { res.status(400).json({ error: 'Raffle is not linked on-chain yet' }); return; }

  // Validated against the prize chain's own format. isAddress alone assumes
  // EVM, so a Solana or Sui prize chain would reject every valid address.
  if (raffle.chain_key) {
    const { data: chain } = await supabase
      .from('chains').select('address_regex, label').eq('key', raffle.chain_key).maybeSingle();
    if (chain?.address_regex && !new RegExp(chain.address_regex).test(burnerWallet.trim())) {
      res.status(400).json({ error: `That does not look like a valid ${chain.label} address` });
      return;
    }
  }

  let check;
  try {
    check = await verifyEntry(Number(raffle.chain_raffle_id), wallet);
  } catch {
    res.status(502).json({ error: 'Could not verify your entry on-chain' }); return;
  }
  if (!check.entered) {
    res.status(400).json({ error: 'No on-chain entry found for this wallet. Complete the transaction first.' });
    return;
  }

  const { error } = await supabase.from('raffle_entries').upsert({
    raffle_id: raffle.id,
    wallet_address: wallet.toLowerCase(),
    burner_wallet: burnerWallet.trim(),
    delivery_chain: raffle.chain_key,
    delivery_address: burnerWallet.trim(),
    x_username: xUsername.trim().replace(/^@/, ''),
    discord_username: discordUsername.trim(),
    entry_weight: check.weight,
    tx_hash: typeof txHash === 'string' ? txHash : null,
  }, { onConflict: 'raffle_id,wallet_address' });

  if (error) { res.status(502).json({ error: 'Could not save your entry' }); return; }
  res.json({ ok: true, weight: check.weight });
});

/**
 * POST /api/raffles/:slug/nonce  { wallet }
 * Challenge for a gasless entry.
 */
raffleRouter.post('/:slug/nonce', redeemRateLimit, async (req, res) => {
  const { wallet } = req.body ?? {};
  if (typeof wallet !== 'string' || !isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }

  const { data: raffle } = await supabase
    .from('raffles').select('id, status, gasless').eq('slug', req.params.slug).maybeSingle();
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  const nonce = randomBytes(16).toString('hex');
  await supabase.from('entry_nonces').insert({ nonce, wallet: wallet.toLowerCase(), raffle_id: raffle.id });

  res.json({
    nonce,
    message: `Brokerz Rafflor\n\nEnter: ${req.params.slug}\n\nThis is a signature, not a transaction. It costs nothing.\n\nNonce: ${nonce}`,
  });
});

/**
 * POST /api/raffles/:slug/enter-free
 * Gasless entry for holder raffles.
 *
 * Holdings are read from the chain here rather than taken on trust, and the
 * signature proves the wallet belongs to whoever is asking. The entry is
 * recorded off-chain because writing to a contract would cost gas, which is
 * the whole thing this flow exists to avoid.
 */
raffleRouter.post('/:slug/enter-free', redeemRateLimit, async (req, res) => {
  const { wallet, signature, nonce, deliveryAddress, xUsername, discordUsername } = req.body ?? {};

  if (typeof wallet !== 'string' || !isAddress(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }
  if (typeof signature !== 'string' || typeof nonce !== 'string') { res.status(400).json({ error: 'Signature required' }); return; }

  const { data: raffle } = await supabase
    .from('raffles').select('id, status, kind, gasless, chain_key, ends_at')
    .eq('slug', req.params.slug).maybeSingle();

  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }
  if (raffle.kind !== 'nft_holder' || !raffle.gasless) { res.status(400).json({ error: 'This raffle needs an on-chain entry' }); return; }
  if (raffle.status !== 'live') { res.status(400).json({ error: 'This raffle is not open' }); return; }
  if (new Date(raffle.ends_at).getTime() <= Date.now()) { res.status(400).json({ error: 'Entries have closed' }); return; }

  // single-use challenge, bound to this wallet and this raffle
  const { data: nrow } = await supabase
    .from('entry_nonces').select('nonce, wallet, raffle_id, used').eq('nonce', nonce).maybeSingle();
  if (!nrow || nrow.used || nrow.raffle_id !== raffle.id ||
      nrow.wallet.toLowerCase() !== wallet.toLowerCase()) {
    res.status(400).json({ error: 'Challenge expired — reload and try again' }); return;
  }

  const message = `Brokerz Rafflor\n\nEnter: ${req.params.slug}\n\nThis is a signature, not a transaction. It costs nothing.\n\nNonce: ${nonce}`;
  let valid = false;
  try {
    valid = await verifyMessage({ address: wallet as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch { valid = false; }
  if (!valid) { res.status(401).json({ error: 'Signature did not verify' }); return; }

  await supabase.from('entry_nonces').update({ used: true }).eq('nonce', nonce);

  // Weight comes from live holdings, never from the request body
  let weight = 0;
  try {
    weight = await weightForHoldings(wallet);
  } catch {
    res.status(502).json({ error: 'Could not read your holdings — try again shortly' }); return;
  }
  if (weight === 0) { res.status(400).json({ error: 'You need at least one Brokerz Home to enter' }); return; }

  if (typeof deliveryAddress !== 'string' || deliveryAddress.trim().length < 20) {
    res.status(400).json({ error: 'A wallet address is needed for the prize chain' }); return;
  }

  const { error } = await supabase.from('raffle_entries').upsert({
    raffle_id: raffle.id,
    wallet_address: wallet.toLowerCase(),
    delivery_chain: raffle.chain_key,
    delivery_address: deliveryAddress.trim(),
    burner_wallet: deliveryAddress.trim(),
    x_username: typeof xUsername === 'string' ? xUsername.trim().replace(/^@/, '') : '',
    discord_username: typeof discordUsername === 'string' ? discordUsername.trim() : '',
    entry_weight: weight,
  }, { onConflict: 'raffle_id,wallet_address' });

  if (error) { res.status(502).json({ error: 'Could not save your entry' }); return; }
  res.json({ ok: true, weight });
});

// GET /api/raffles/:slug/me/:address — has this wallet already entered?
raffleRouter.get('/:slug/me/:address', async (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) { res.status(400).json({ error: 'Invalid address' }); return; }

  const { data: raffle } = await supabase
    .from('raffles').select('id, chain_raffle_id').eq('slug', req.params.slug).maybeSingle();
  if (!raffle) { res.status(404).json({ error: 'Raffle not found' }); return; }

  const { data: entry } = await supabase
    .from('raffle_entries').select('entry_weight, x_username, burner_wallet')
    .eq('raffle_id', raffle.id).eq('wallet_address', address.toLowerCase()).maybeSingle();

  res.json({ entered: Boolean(entry), entry: entry ?? null });
});
