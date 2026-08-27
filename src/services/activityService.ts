import { EventEmitter } from 'node:events';
import { formatEther } from 'viem';
import { onChainLogs } from './chainPoller.js';

export type ActivityItem =
  | { type: 'purchase'; wallet: string; brkzAmount: number; ethPaid: number; txHash: string; timestamp: number }
  | { type: 'activate'; wallet: string; activationNumber: number; txHash: string; timestamp: number }
  | { type: 'mint'; wallet: string; tokenId: number; txHash: string; timestamp: number };

const MAX_FEED_LENGTH = 50;
const feed: ActivityItem[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

type RawLog = { args?: Record<string, unknown>; transactionHash: string };

onChainLogs(({ purchases, activations, mints }) => {
  const items: ActivityItem[] = [];
  const now = Date.now();

  for (const log of purchases as RawLog[]) {
    const { buyer, tokenAmount, costWei } = (log.args ?? {}) as { buyer?: string; tokenAmount?: bigint; costWei?: bigint };
    if (!buyer || tokenAmount === undefined || costWei === undefined) continue;
    items.push({
      type: 'purchase',
      wallet: buyer,
      brkzAmount: Number(tokenAmount),
      ethPaid: Number(formatEther(costWei)),
      txHash: log.transactionHash,
      timestamp: now,
    });
  }

  for (const log of activations as RawLog[]) {
    const { wallet, activationNumber } = (log.args ?? {}) as { wallet?: string; activationNumber?: bigint };
    if (!wallet || activationNumber === undefined) continue;
    items.push({
      type: 'activate',
      wallet,
      activationNumber: Number(activationNumber),
      txHash: log.transactionHash,
      timestamp: now,
    });
  }

  for (const log of mints as RawLog[]) {
    const { owner, tokenId } = (log.args ?? {}) as { owner?: string; tokenId?: bigint };
    if (!owner || tokenId === undefined) continue;
    items.push({
      type: 'mint',
      wallet: owner,
      tokenId: Number(tokenId),
      txHash: log.transactionHash,
      timestamp: now,
    });
  }

  for (const item of items) {
    feed.unshift(item);
    emitter.emit('activity', item);
  }
  if (feed.length > MAX_FEED_LENGTH) feed.length = MAX_FEED_LENGTH;
});

export function getRecentActivity(): ActivityItem[] {
  return feed;
}

export function onActivity(listener: (item: ActivityItem) => void): () => void {
  emitter.on('activity', listener);
  return () => emitter.off('activity', listener);
}
