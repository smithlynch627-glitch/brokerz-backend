import { createPublicClient, http } from 'viem';
import { robinhoodChain } from '../chain.js';
import { config } from '../config.js';
import { RAFFLE_ABI } from '../abis/raffle.js';

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.rpcUrl, { batch: true, retryCount: 2 }),
});

const addr = () => config.raffleAddress as `0x${string}`;

/** Entry weight a wallet would receive from its Brokerz Homes holdings. */
export async function weightForHoldings(user: string): Promise<number> {
  if (!config.raffleAddress) return 0;
  const w = await client.readContract({
    address: addr(), abi: RAFFLE_ABI, functionName: 'weightForHoldings', args: [user as `0x${string}`],
  });
  return Number(w);
}

/**
 * Confirms a wallet actually entered on-chain before identity is stored.
 * Without this check anyone could POST an entry and appear in the winners
 * list without ever paying or holding anything.
 */
export async function verifyEntry(chainRaffleId: number, user: string) {
  if (!config.raffleAddress) return { entered: false, weight: 0 };
  const [entered, weight] = await Promise.all([
    client.readContract({ address: addr(), abi: RAFFLE_ABI, functionName: 'hasEntered',
      args: [BigInt(chainRaffleId), user as `0x${string}`] }),
    client.readContract({ address: addr(), abi: RAFFLE_ABI, functionName: 'entryWeight',
      args: [BigInt(chainRaffleId), user as `0x${string}`] }),
  ]);
  return { entered: Boolean(entered), weight: Number(weight) };
}

export async function getWinners(chainRaffleId: number): Promise<string[]> {
  if (!config.raffleAddress) return [];
  const w = await client.readContract({
    address: addr(), abi: RAFFLE_ABI, functionName: 'getWinners', args: [BigInt(chainRaffleId)],
  });
  return [...w] as string[];
}

export async function participantCount(chainRaffleId: number): Promise<number> {
  if (!config.raffleAddress) return 0;
  const n = await client.readContract({
    address: addr(), abi: RAFFLE_ABI, functionName: 'participantCount', args: [BigInt(chainRaffleId)],
  });
  return Number(n);
}

export interface Tier { minNfts: number; entries: number }

/**
 * The holder ladder, read from the contract rather than hardcoded.
 *
 * setTiers can change these at any time; a copy in the frontend would quietly
 * start lying the moment it did. Reading them means the displayed ladder is
 * always what the contract will actually award.
 */
export async function getTiers(): Promise<Tier[]> {
  if (!config.raffleAddress) return [];
  const count = await client.readContract({
    address: addr(), abi: RAFFLE_ABI, functionName: 'tierCount',
  });
  const out: Tier[] = [];
  for (let i = 0n; i < (count as bigint); i++) {
    const t = await client.readContract({
      address: addr(), abi: RAFFLE_ABI, functionName: 'tiers', args: [i],
    }) as readonly [number, number];
    out.push({ minNfts: Number(t[0]), entries: Number(t[1]) });
  }
  return out;
}
