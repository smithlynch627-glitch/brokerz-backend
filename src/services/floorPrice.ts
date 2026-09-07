import { cached } from '../cache.js';
import { config } from '../config.js';

const TTL_MS = 300_000;

/**
 * Floor price from OpenSea. Requires an API key — without one this returns
 * null and the UI shows a dash rather than inventing a number.
 */
async function fetchFloor(): Promise<number | null> {
  if (!config.openseaApiKey || !config.openseaSlug) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(
      `https://api.opensea.io/api/v2/collections/${config.openseaSlug}/stats`,
      { headers: { 'x-api-key': config.openseaApiKey }, signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { total?: { floor_price?: number } };
    return data.total?.floor_price ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFloorPrice(): Promise<number | null> {
  return cached('opensea-floor', TTL_MS, fetchFloor);
}
