import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} - copy .env.example to .env and fill it in`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got: ${value}`);
  return n;
}

export const config = {
  rpcUrl: required('RPC_URL'),
  chainId: optionalNumber('CHAIN_ID', 4663),
  explorerUrl: process.env.EXPLORER_URL ?? 'https://robinhoodchain.blockscout.com',

  // Optional extra endpoints. The client rotates to these when the primary
  // starts failing, which is what makes a shared public RPC survivable.
  fallbackRpcUrls: (process.env.FALLBACK_RPC_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Multicall3 at the canonical cross-chain address. Set to empty to disable
  // if this chain has no deployment.
  multicallAddress: (process.env.MULTICALL3_ADDRESS ?? '0xcA11bde05977b3631167028862bE2a173976CA11').trim() as `0x${string}` | '',

  brkzAddress: required('BRKZ_ADDRESS') as `0x${string}`,
  brkzSaleAddress: required('BRKZ_SALE_ADDRESS') as `0x${string}`,
  brokerzHomesAddress: required('BROKERZ_HOMES_ADDRESS') as `0x${string}`,

  deployBlock: BigInt(optionalNumber('DEPLOY_BLOCK', 0)),

  allowedOrigins: required('ALLOWED_ORIGINS').split(',').map((s) => s.trim()),

  port: optionalNumber('PORT', 3001),

  // Cache lifetimes. Longer values mean fewer RPC calls; these are tuned so
  // background load stays flat regardless of how many people are on the site.
  statsRefreshMs: optionalNumber('STATS_REFRESH_MS', 20_000),
  walletCacheMs: optionalNumber('WALLET_CACHE_MS', 300_000),
  pollIntervalMs: optionalNumber('POLL_INTERVAL_MS', 20_000),

  // Presale access codes. SUPABASE_SERVICE_ROLE_KEY bypasses every RLS
  // policy on your entire Supabase project - treat it with the same care
  // as a private key. It must NEVER be sent to the frontend, ever, under
  // any circumstance - it only belongs here, server-side.
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // Wallets that always have access regardless of phase or codes - this is
  // how you test the live site while the public still sees the countdown.
  // Comma-separated. Additive with the tester_wallets Supabase table.
  testerWallets: (process.env.TESTER_WALLETS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // LOCAL DEV ONLY. Overrides the computed phase for EVERY visitor, so
  // setting this on the live Railway deployment would open (or close) the
  // site for everyone, not just you - use TESTER_WALLETS for that instead.
  // Valid values: coming_soon | code_required | public
  forcePhase: (process.env.FORCE_PHASE ?? '').trim() || null,
};
