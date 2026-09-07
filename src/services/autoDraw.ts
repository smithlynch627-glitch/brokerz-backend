import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { supabase } from '../supabase.js';
import { config } from '../config.js';
import { robinhoodChain } from '../chain.js';
import { RAFFLE_ABI } from '../abis/raffle.js';
import { getWinners } from './raffleChain.js';
import { drawWinners } from './offchainDraw.js';

const CHECK_INTERVAL_MS = 60_000;
const BATCH = 25;

let started = false;
let running = false;

function operatorClient() {
  if (!config.operatorPrivateKey || !config.raffleAddress) return null;
  return createWalletClient({
    account: privateKeyToAccount(config.operatorPrivateKey as `0x${string}`),
    chain: robinhoodChain,
    transport: http(config.rpcUrl, { retryCount: 3, retryDelay: 600 }),
  });
}

/**
 * Draws finished raffles and mirrors winners into the database.
 *
 * Runs on a timer rather than on an event, because "the window closed" is not
 * something the chain emits — it is simply time passing. The operator key can
 * only call draw(); it cannot move funds, cancel a raffle or alter a seed
 * commitment, so a compromise here cannot change who wins, only when the draw
 * happens.
 */
async function tick(): Promise<void> {
  if (running || !config.raffleAddress) return;
  running = true;

  try {
    const nowIso = new Date().toISOString();

    // Raffles past their end time that still need drawing
    const { data: due } = await supabase
      .from('raffles')
      .select('id, slug, chain_raffle_id, kind, spots, seed_secret, auto_draw, status, gasless')
      .lte('ends_at', nowIso)
      .in('status', ['live', 'ended'])
      .eq('auto_draw', true);

    if (!due?.length) return;

    const wallet = operatorClient();

    for (const r of due) {
      if (r.chain_raffle_id === null) continue;

      // Gasless holder raffles have no on-chain entries, so the draw runs
      // here against the recorded entrants using the committed seed.
      if (r.gasless) {
        try {
          const { data: entrants } = await supabase
            .from('raffle_entries').select('wallet_address, entry_weight').eq('raffle_id', r.id);

          if (!entrants?.length || !r.seed_secret) {
            await supabase.from('raffles').update({
              status: 'ended', draw_attempted_at: new Date().toISOString(),
              draw_error: entrants?.length ? 'no seed stored' : 'no entrants',
            }).eq('id', r.id);
            continue;
          }

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

          // The seed is published alongside the winners so anyone can re-run
          // the draw and confirm the same result.
          await supabase.from('raffles').update({
            status: 'drawn',
            winners_published: true,
            seed_published_at: new Date().toISOString(),
            draw_attempted_at: new Date().toISOString(),
            draw_error: null,
          }).eq('id', r.id);

          console.log(`[autodraw] ${r.slug}: ${picked.length} winners (off-chain)`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[autodraw] ${r.slug}: ${message}`);
          await supabase.from('raffles').update({
            status: 'ended', draw_attempted_at: new Date().toISOString(),
            draw_error: message.slice(0, 300),
          }).eq('id', r.id);
        }
        continue;
      }

      const needsDraw = r.kind !== 'fixed_gtd';

      try {
        if (needsDraw && wallet && r.seed_secret) {
          const onChain = await getWinners(Number(r.chain_raffle_id));
          if (onChain.length < r.spots) {
            const hash = await wallet.writeContract({
              address: config.raffleAddress as `0x${string}`,
              abi: RAFFLE_ABI,
              functionName: 'draw',
              // The secret itself, not its hash. The contract hashes it and
              // compares against the stored commitment.
              args: [BigInt(r.chain_raffle_id), r.seed_secret as `0x${string}`, BATCH],
              chain: robinhoodChain,
            });
            console.log(`[autodraw] ${r.slug}: draw submitted ${hash}`);
            await new Promise((res) => setTimeout(res, 4000));
          }
        }

        // Mirror whatever the chain says, drawn just now or previously
        const winners = await getWinners(Number(r.chain_raffle_id));
        if (winners.length) {
          await supabase.from('raffle_winners').upsert(
            winners.map((a, i) => ({
              raffle_id: r.id,
              wallet_address: a.toLowerCase(),
              position: i,
            })),
            { onConflict: 'raffle_id,wallet_address' }
          );
        }

        const complete = !needsDraw || winners.length >= r.spots || winners.length > 0;
        await supabase.from('raffles').update({
          status: complete ? 'drawn' : 'ended',
          winners_published: complete,
          draw_attempted_at: new Date().toISOString(),
          draw_error: null,
        }).eq('id', r.id);

        if (complete) console.log(`[autodraw] ${r.slug}: ${winners.length} winners published`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[autodraw] ${r.slug}: ${message}`);
        await supabase.from('raffles').update({
          status: 'ended',
          draw_attempted_at: new Date().toISOString(),
          draw_error: message.slice(0, 300),
        }).eq('id', r.id);
      }
    }
  } catch (err) {
    console.error('[autodraw]', err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}

export function startAutoDraw(): void {
  if (started || !config.raffleAddress) return;
  started = true;

  if (!config.operatorPrivateKey) {
    console.log('[autodraw] no OPERATOR_PRIVATE_KEY — winners will mirror but draws must be run manually');
  } else {
    console.log('[autodraw] active');
  }

  setInterval(() => void tick(), CHECK_INTERVAL_MS);
  void tick();
}
