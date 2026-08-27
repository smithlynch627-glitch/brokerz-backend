import { createPublicClient, http, fallback, defineChain, getContract } from 'viem';
import { config } from './config.js';
import { BRKZ_ABI, BRKZ_SALE_ABI, BROKERZ_HOMES_ABI } from './abis.js';

export const robinhoodChain = defineChain({
  id: config.chainId,
  name: config.chainId === 4663 ? 'Robinhood Chain' : 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: config.explorerUrl } },
  testnet: config.chainId !== 4663,
  contracts: config.multicallAddress
    ? { multicall3: { address: config.multicallAddress } }
    : undefined,
});

const endpoints = [config.rpcUrl, ...config.fallbackRpcUrls];

/**
 * Transport tuned for a shared, rate-limited public endpoint.
 *
 * batch      - collapses many eth_call requests into a single JSON-RPC batch
 *              over one HTTP POST. Works on any standard node; no on-chain
 *              helper contract required.
 * retryCount - backs off and retries rather than surfacing a 429 to callers.
 * fallback   - rotates to the next endpoint when one starts failing.
 */
const transports = endpoints.map((url) =>
  http(url, {
    batch: { batchSize: 40, wait: 20 },
    retryCount: 3,
    retryDelay: 400,
    timeout: 15_000,
  })
);

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: transports.length > 1 ? fallback(transports, { rank: false }) : transports[0],
  // Groups independent contract reads into one multicall when a Multicall3
  // deployment is configured. Falls back to plain batched calls otherwise.
  batch: config.multicallAddress ? { multicall: { batchSize: 2048, wait: 20 } } : undefined,
});

export const brkzContract = getContract({ address: config.brkzAddress, abi: BRKZ_ABI, client: publicClient });
export const brkzSaleContract = getContract({ address: config.brkzSaleAddress, abi: BRKZ_SALE_ABI, client: publicClient });
export const brokerzHomesContract = getContract({ address: config.brokerzHomesAddress, abi: BROKERZ_HOMES_ABI, client: publicClient });
