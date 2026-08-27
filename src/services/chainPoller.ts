import { publicClient } from '../chain.js';
import { config } from '../config.js';
import { BRKZ_SALE_ABI, BROKERZ_HOMES_ABI } from '../abis.js';

type LogHandler = (logs: {
  purchases: unknown[];
  activations: unknown[];
  mints: unknown[];
  transfers: unknown[];
}) => void;

const CHUNK_SIZE = 40_000n;

const purchaseEvent = BRKZ_SALE_ABI.find((e) => e.type === 'event' && e.name === 'TokensPurchased')!;
const activatedEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Activated')!;
const mintedEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Minted')!;
const transferEvent = BROKERZ_HOMES_ABI.find((e) => e.type === 'event' && e.name === 'Transfer')!;

let cursor = 0n;
let started = false;
let running = false;
let lastError: string | null = null;
const handlers: LogHandler[] = [];

export function onChainLogs(handler: LogHandler): void {
  handlers.push(handler);
}

export function pollerState() {
  return { lastScannedBlock: cursor.toString(), stale: lastError !== null, lastError };
}

/**
 * One poller for the whole backend.
 *
 * The holder index and the activity feed both need the same block range, so
 * they previously each fetched the head block and ran their own getLogs.
 * Sharing a single pass cuts that traffic roughly in half and guarantees the
 * two never disagree about which blocks they have seen.
 */
async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const head = await publicClient.getBlockNumber();
    if (cursor === 0n) cursor = config.deployBlock > 0n ? config.deployBlock - 1n : head - 1n;
    if (head <= cursor) {
      lastError = null;
      return;
    }

    const behind = head - cursor;
    if (behind > CHUNK_SIZE) {
      console.log(`[poller] catching up ${behind.toString()} blocks from ${cursor.toString()} to ${head.toString()}`);
    }

    let from = cursor + 1n;
    let scanned = 0n;
    while (from <= head) {
      const to = from + CHUNK_SIZE - 1n > head ? head : from + CHUNK_SIZE - 1n;

      const [purchases, activations, mints, transfers] = await Promise.all([
        publicClient.getLogs({ address: config.brkzSaleAddress, event: purchaseEvent, fromBlock: from, toBlock: to }),
        publicClient.getLogs({ address: config.brokerzHomesAddress, event: activatedEvent, fromBlock: from, toBlock: to }),
        publicClient.getLogs({ address: config.brokerzHomesAddress, event: mintedEvent, fromBlock: from, toBlock: to }),
        publicClient.getLogs({ address: config.brokerzHomesAddress, event: transferEvent, fromBlock: from, toBlock: to }),
      ]);

      for (const handler of handlers) {
        handler({ purchases, activations, mints, transfers });
      }

      cursor = to;
      from = to + 1n;
      scanned += CHUNK_SIZE;

      if (behind > CHUNK_SIZE && scanned % (CHUNK_SIZE * 10n) === 0n) {
        console.log(`[poller] ${(head - cursor).toString()} blocks remaining`);
      }
    }

    if (behind > CHUNK_SIZE) {
      console.log(`[poller] caught up at block ${cursor.toString()}`);
    }
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[poller] ${lastError} (will retry from block ${cursor.toString()})`);
    // Cursor is left untouched so the next pass re-scans the same range.
    // Nothing is skipped by a transient failure.
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
