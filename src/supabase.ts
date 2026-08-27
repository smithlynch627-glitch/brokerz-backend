import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// Service role key deliberately bypasses RLS - this client has full access
// to the database, which is exactly why it must only ever exist here, in
// backend code that never ships to a browser. The frontend never talks to
// Supabase directly at all; every access-code operation goes through the
// routes in routes/access.ts, same "backend mediates everything sensitive"
// pattern as the rest of this app.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false }, // this is a server process, not a browser - no session to persist
});
