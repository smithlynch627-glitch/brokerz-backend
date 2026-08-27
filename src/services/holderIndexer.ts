import { onChainLogs, pollerState } from './chainPoller.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const tokenOwner = new Map<string, string>();

/**
 * Unique-holder count for an ERC-721 has to be derived from Transfer history;
 * there is no contract function for it. Held in memory, which is fine at a
 * 2,222 ceiling.
 */
onChainLogs(({ transfers }) => {
  for (const log of transfers as Array<{ args?: { tokenId?: bigint; to?: string } }>) {
    const tokenId = log.args?.tokenId;
    const to = log.args?.to;
    if (tokenId === undefined || !to) continue;

    if (to.toLowerCase() === ZERO_ADDRESS) {
      tokenOwner.delete(tokenId.toString());
    } else {
      tokenOwner.set(tokenId.toString(), to.toLowerCase());
    }
  }
});

export function getHolderStats() {
  const state = pollerState();
  return {
    holderCount: new Set(tokenOwner.values()).size,
    indexedTokenCount: tokenOwner.size,
    lastScannedBlock: state.lastScannedBlock,
    stale: state.stale,
    lastError: state.lastError,
  };
}

export function getTokensOwnedBy(address: string): number[] {
  const target = address.toLowerCase();
  const owned: number[] = [];
  for (const [tokenId, owner] of tokenOwner.entries()) {
    if (owner === target) owned.push(Number(tokenId));
  }
  return owned.sort((a, b) => a - b);
}
