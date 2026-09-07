import { keccak256, toHex } from 'viem';

export interface Entrant { wallet: string; weight: number }

/**
 * Weighted random draw, run off-chain for gasless raffles.
 *
 * Deterministic on purpose. Given the published seed and the published
 * entrant list, anyone can re-run this and get the same winners — which is
 * what keeps a gasless draw checkable without paying gas per entry.
 *
 * A wallet can win at most one spot: winners are removed from the pool as
 * they are picked, so extra entries raise the odds and never the number of
 * spots won.
 */
export function drawWinners(seed: string, entrants: Entrant[], spots: number): string[] {
  // Sorted so the input order cannot change the outcome — the database could
  // return rows in any order, and an unstable input would make the result
  // impossible for anyone else to reproduce.
  const pool = entrants
    .filter((e) => e.weight > 0)
    .map((e) => ({ wallet: e.wallet.toLowerCase(), weight: e.weight }))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  const winners: string[] = [];
  let remaining = pool.reduce((n, e) => n + e.weight, 0);
  const taken = new Set<string>();

  for (let round = 0; round < spots && remaining > 0; round++) {
    // Fresh randomness per round, derived from the seed and the round number
    const hash = keccak256(toHex(`${seed}:${round}`));
    const rand = BigInt(hash) % BigInt(remaining);

    let cumulative = 0n;
    let picked: string | null = null;

    for (const e of pool) {
      if (taken.has(e.wallet)) continue;
      cumulative += BigInt(e.weight);
      if (rand < cumulative) { picked = e.wallet; break; }
    }
    if (!picked) break;

    winners.push(picked);
    taken.add(picked);
    remaining -= pool.find((e) => e.wallet === picked)!.weight;
  }

  return winners;
}

/**
 * The value published before entries close.
 *
 * Hashes the seed as 32 raw bytes, matching what the admin panel stores. The
 * earlier version ran toHex over the 0x-prefixed string first, hashing 66 text
 * characters instead — so a verifier following the published method would
 * never reproduce the stored commitment.
 */
export function commitmentFor(seed: string): string {
  return keccak256(seed as `0x${string}`);
}
