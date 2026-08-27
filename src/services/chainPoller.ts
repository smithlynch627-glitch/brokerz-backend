import { publicClient } from '../chain.js';
import { config } from '../config.js';
import { BRKZ_SALE_ABI, BROKERZ_HOMES_ABI } from '../abis.js';

type LogHandler = (logs: {
  purchases: unknown[];
  activations: unknown[];
  mints: unknown[];
  transfers: unknown[];
}) => void;

const CHUNK_SIZE = 5_000n;

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

    let from = cursor + 1n;
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
    }

    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
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
