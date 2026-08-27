import { supabase } from '../supabase.js';
import { cached } from '../cache.js';
import { config } from '../config.js';

export type LaunchPhase = 'coming_soon' | 'code_required' | 'public';

export interface LaunchStatus {
  phase: LaunchPhase;
  serverNowMs: number;
  codeGateStartsAtMs: number;
  publicOpensAtMs: number;
}

const LAUNCH_CONFIG_TTL_MS = 10_000; // short - an admin editing the timestamps in Supabase should take effect quickly, not be stuck behind a long cache

async function fetchLaunchConfig(): Promise<{ codeGateStartsAtMs: number; publicOpensAtMs: number }> {
  const { data, error } = await supabase
    .from('launch_config')
    .select('code_gate_starts_at, public_opens_at')
    .eq('id', 1)
    .single();

  if (error || !data) {
    throw new Error('Failed to read launch_config - has the schema been run and seeded?');
  }

  return {
    codeGateStartsAtMs: new Date(data.code_gate_starts_at).getTime(),
    publicOpensAtMs: new Date(data.public_opens_at).getTime(),
  };
}

/**
 * SECURITY: this is the ONLY place phase is computed, and it always uses
 * this server's own Date.now() - never a value sent by a client, never
 * anything the browser could influence. Every access-related route calls
 * this fresh (through the short cache above) rather than trusting a
 * phase value passed in from the frontend. A client can display whatever
 * countdown it wants; it cannot change what this function returns.
 */
export async function getLaunchStatus(): Promise<LaunchStatus> {
  const { codeGateStartsAtMs, publicOpensAtMs } = await cached('launch-config', LAUNCH_CONFIG_TTL_MS, fetchLaunchConfig);
  const serverNowMs = Date.now();

  // Local-dev override. Deliberately checked here (the single source of
  // phase truth) rather than scattered through routes, so it can't drift
  // out of sync with the real logic.
  if (config.forcePhase === 'coming_soon' || config.forcePhase === 'code_required' || config.forcePhase === 'public') {
    return { phase: config.forcePhase, serverNowMs, codeGateStartsAtMs, publicOpensAtMs };
  }

  let phase: LaunchPhase;
  if (serverNowMs >= publicOpensAtMs) {
    phase = 'public';
  } else if (serverNowMs >= codeGateStartsAtMs) {
    phase = 'code_required';
  } else {
    phase = 'coming_soon';
  }

  return { phase, serverNowMs, codeGateStartsAtMs, publicOpensAtMs };
}
