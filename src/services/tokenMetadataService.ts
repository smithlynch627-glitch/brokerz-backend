import { brokerzHomesContract } from '../chain.js';
import { cached } from '../cache.js';

export interface TokenMetadata {
  tokenId: number;
  name: string;
  image: string;
  description?: string;
}

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const METADATA_TTL_MS = 60_000; // pre-reveal this never changes; post-reveal it's still effectively static per token
const FETCH_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_FETCHES = 8;

function resolveUri(uri: string): string {
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice('ipfs://'.length);
  return uri;
}

/**
 * SECURITY: tokenURI() is currently only settable by the contract owner
 * (reveal() / setHiddenMetadataURI(), both onlyOwner), so this isn't
 * exploitable by an outside attacker today. Hardened anyway, on the same
 * principle as the contract audit's checks-effects-interactions fix: don't
 * rely on "the caller happens to be trustworthy right now" when the fix
 * costs nothing. Without this, a malicious or compromised admin - or any
 * future change that makes tokenURI less trusted - could point it at an
 * internal address (a cloud metadata endpoint, an internal service on
 * localhost, etc.) and use this backend as an unwitting relay to probe
 * its own network. Blocks non-http(s) protocols and obvious
 * private/loopback/link-local hosts, and caps how long a single fetch can
 * hang.
 */
function isSafeToFetch(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
  if (/^127\./.test(host)) return false; // loopback
  if (/^10\./.test(host)) return false; // private
  if (/^192\.168\./.test(host)) return false; // private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // private
  if (/^169\.254\./.test(host)) return false; // link-local, incl. cloud metadata endpoints

  return true;
}

async function safeFetchJson(url: string): Promise<unknown | null> {
  if (!isSafeToFetch(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function decodeMetadataJson(uri: string): Promise<{ name?: string; image?: string; description?: string } | null> {
  try {
    if (uri.startsWith('data:application/json;base64,')) {
      const b64 = uri.slice('data:application/json;base64,'.length);
      const json = Buffer.from(b64, 'base64').toString('utf-8');
      return JSON.parse(json);
    }
    if (uri.startsWith('data:application/json,')) {
      const raw = uri.slice('data:application/json,'.length);
      return JSON.parse(decodeURIComponent(raw));
    }
    // IPFS or plain HTTP(S) - actually fetch it, through the guarded path above.
    const result = await safeFetchJson(resolveUri(uri));
    return result as { name?: string; image?: string; description?: string } | null;
  } catch {
    return null; // malformed metadata shouldn't take down the whole request - caller falls back to a placeholder
  }
}

async function fetchOne(tokenId: number): Promise<TokenMetadata> {
  const uri = await brokerzHomesContract.read.tokenURI([BigInt(tokenId)]);
  const meta = await decodeMetadataJson(uri);
  return {
    tokenId,
    name: meta?.name ?? `Brokerz Home #${tokenId}`,
    image: meta?.image ? resolveUri(meta.image) : '',
    description: meta?.description,
  };
}

export async function getTokenMetadata(tokenId: number): Promise<TokenMetadata> {
  return cached(`tokenmeta:${tokenId}`, METADATA_TTL_MS, () => fetchOne(tokenId));
}

/**
 * SECURITY: a wallet is capped at 3 MINTED tokens, but nothing stops it
 * receiving many more via ordinary transfers - a wallet that ends up
 * holding a large share of the 2,222 could otherwise trigger hundreds of
 * concurrent contract reads (and possibly external metadata fetches) in
 * one request. Processes in small batches instead of firing everything
 * at once, so one wallet's lookup can't spike RPC usage or exhaust this
 * server's own resources.
 */
export async function getTokenMetadataBatch(tokenIds: number[]): Promise<TokenMetadata[]> {
  const results: TokenMetadata[] = [];
  for (let i = 0; i < tokenIds.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = tokenIds.slice(i, i + MAX_CONCURRENT_FETCHES);
    const batchResults = await Promise.all(batch.map(getTokenMetadata));
    results.push(...batchResults);
  }
  return results;
}
