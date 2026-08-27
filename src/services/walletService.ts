import { formatUnits, isAddress } from 'viem';
import { brkzContract, brkzSaleContract, brokerzHomesContract } from '../chain.js';
import { cached, cacheInvalidate } from '../cache.js';
import { config } from '../config.js';
import { onChainLogs } from './chainPoller.js';

export interface WalletResponse {
  address: string;
  brkzBalance: string;
  brkzBalanceFormatted: number;
  totalPurchased: number;
  purchaseCapRemaining: number;
  activationsEarned: number;
  activationsClaimable: number;
  activationsAvailable: number;
  mintedByWallet: number;
  maxPerWallet: number;
}

const key = (address: string) => `wallet:${address.toLowerCase()}`;

/**
 * A wallet's figures only change when that wallet transacts. The chain poller
 * already sees every relevant event, so rather than expiring every wallet on a
 * timer, only the wallets that actually did something get dropped.
 *
 * This is what keeps RPC usage flat as traffic grows: an idle visitor
 * refreshing the page costs nothing upstream no matter how often they poll.
 */
onChainLogs(({ purchases, activations, mints, transfers }) => {
  const touched = new Set<string>();

  for (const log of purchases as Array<{ args?: { buyer?: string } }>) {
    if (log.args?.buyer) touched.add(log.args.buyer.toLowerCase());
  }
  for (const log of activations as Array<{ args?: { wallet?: string } }>) {
    if (log.args?.wallet) touched.add(log.args.wallet.toLowerCase());
  }
  for (const log of mints as Array<{ args?: { owner?: string } }>) {
    if (log.args?.owner) touched.add(log.args.owner.toLowerCase());
  }
  for (const log of transfers as Array<{ args?: { from?: string; to?: string } }>) {
    if (log.args?.from) touched.add(log.args.from.toLowerCase());
    if (log.args?.to) touched.add(log.args.to.toLowerCase());
  }

  for (const address of touched) cacheInvalidate(key(address));
});

async function computeWallet(address: `0x${string}`): Promise<WalletResponse> {
  const [brkzBalance, totalPurchased, maxPurchase, mintedByWallet, maxPerWallet, earned, claimable, available] =
    await Promise.all([
      brkzContract.read.balanceOf([address]),
      brkzSaleContract.read.totalPurchased([address]),
      brkzSaleContract.read.maxPurchasePerWallet(),
      brokerzHomesContract.read.mintedByWallet([address]),
      brokerzHomesContract.read.MAX_PER_WALLET(),
      brokerzHomesContract.read.activationsEarned([address]),
      brokerzHomesContract.read.activationsClaimable([address]),
      brokerzHomesContract.read.activationsAvailable([address]),
    ]);

  const purchasedNum = Number(totalPurchased);

  return {
    address,
    brkzBalance: brkzBalance.toString(),
    brkzBalanceFormatted: Number(formatUnits(brkzBalance, 18)),
    totalPurchased: purchasedNum,
    purchaseCapRemaining: Number(maxPurchase) - purchasedNum,
    activationsEarned: Number(earned),
    activationsClaimable: Number(claimable),
    activationsAvailable: Number(available),
    mintedByWallet: Number(mintedByWallet),
    maxPerWallet: Number(maxPerWallet),
  };
}

export async function getWalletStatus(address: string): Promise<WalletResponse> {
  if (!isAddress(address)) {
    throw Object.assign(new Error('Invalid address'), { statusCode: 400 });
  }
  return cached(key(address), config.walletCacheMs, () => computeWallet(address as `0x${string}`));
}
