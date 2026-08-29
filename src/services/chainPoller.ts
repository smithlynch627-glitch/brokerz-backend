import { publicClient } from '../chain.js';
import { config } from '../config.js';
import { BRKZ_SALE_ABI, BROKERZ_HOMES_ABI } from '../abis.js';

type LogHandler = (logs: {
  purchases: unknown[];
  activations: unknown[];
  mints: unknown[];
  transfers: unknown[];
}) => void;

// Providers cap getLogs at different block ranges and rarely document it.
// Rather than hardcode a guess, start optimistic and halve on failure until a
// range works, then stay there. A fixed value that happens to exceed the cap
// fails silently forever, which is exactly what an empty activity feed looks like.
const MAX_CHUNK = 10_000n;
const MIN_CHUNK = 500n;

const purchaseEvent = BRKZ_SALE_ABI.find((e) => e.type === 'event' && e.name === 'TokensPurchased')!;
const activatedEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Activated')!;
const mintedEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Minted')!;
const transferEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Transfer')!;

let cursor = 0n;
let chunkSize = MAX_CHUNK;
let started = false;
let running = false;
let lastError: string | null = null;
let totalEventsSeen = 0;
let headBlock = 0n;
const handlers: LogHandler[] = [];

export function onChainLogs(handler: LogHandler): void {
  handlers.push(handler);
}

export function pollerState() {
  return {
    lastScannedBlock: cursor.toString(),
    headBlock: headBlock.toString(),
    blocksBehind: headBlock > cursor ? (headBlock - cursor).toString() : '0',
    chunkSize: chunkSize.toString(),
    deployBlock: config.deployBlock.toString(),
    totalEventsSeen,
    stale: lastError !== null,
    lastError,
  };
}

async function fetchRange(from: bigint, to: bigint) {
  return Promise.all([
    publicClient.getLogs({ address: config.brkzSaleAddress, event: purchaseEvent, fromBlock: from, toBlock: to }),
    publicClient.getLogs({ address: config.brokerzHomesAddress, event: activatedEvent, fromBlock: from, toBlock: to }),
    publicClient.getLogs({ address: config.brokerzHomesAddress, event: mintedEvent, fromBlock: from, toBlock: to }),
    publicClient.getLogs({ address: config.brokerzHomesAddress, event: transferEvent, fromBlock: from, toBlock: to }),
  ]);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const head = await publicClient.getBlockNumber();
    headBlock = head;

    if (cursor === 0n) {
      cursor = config.deployBlock > 0n ? config.deployBlock - 1n : head - 1n;
      console.log(`[poller] starting from block ${cursor.toString()} (head ${head.toString()})`);
    }

    if (head <= cursor) {
      lastError = null;
      return;
    }

    const startedBehind = head - cursor;
    if (startedBehind > chunkSize) {
      console.log(`[poller] ${startedBehind.toString()} blocks behind, catching up`);
    }

    let from = cursor + 1n;

    while (from <= head) {
      const to = from + chunkSize - 1n > head ? head : from + chunkSize - 1n;

      let result;
      try {
        result = await fetchRange(from, to);
      } catch (err) {
        // Shrink and retry rather than aborting the whole pass. A range
        // rejection and a rate limit look similar from here, and both are
        // helped by asking for less.
        if (chunkSize > MIN_CHUNK) {
          chunkSize = chunkSize / 2n;
          console.warn(`[poller] range ${from}-${to} failed, reducing chunk to ${chunkSize.toString()}`);
          continue;
        }
        throw err;
      }

      const [purchases, activations, mints, transfers] = result;
      const count = purchases.length + activations.length + mints.length + transfers.length;
      if (count > 0) {
        totalEventsSeen += count;
        console.log(`[poller] ${count} events in blocks ${from}-${to}`);
      }

      for (const handler of handlers) {
        handler({ purchases, activations, mints, transfers });
      }

      cursor = to;
      from = to + 1n;
    }

    if (startedBehind > chunkSize) {
      console.log(`[poller] caught up at ${cursor.toString()}, ${totalEventsSeen} events total`);
    }
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[poller] ${lastError} — will retry from ${cursor.toString()}`);
  } finally {
    running = false;
  }
}

export function startChainPoller(): void {
  if (started) return;
  started = true;
  void tick();
  setInterval(() => void tick(), config.pollIntervalMs);
}
