import { cached } from '../cache.js';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const PRICE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

async function fetchEthUsdPrice(): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(COINGECKO_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { ethereum?: { usd?: number } };
    return data.ethereum?.usd ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getEthUsdPrice(): Promise<number | null> {
  return cached('eth-usd-price', PRICE_TTL_MS, fetchEthUsdPrice);
}
