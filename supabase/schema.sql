-- ============================================================================
-- Brokerz access control - Supabase schema  (v2: wallet-free, session-based)
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor, then run codes_import.sql to
-- load your own 10,000 codes. Safe to re-run this file.
--
-- WHAT CHANGED FROM v1:
--   * No auto-generated codes. Your codes are imported from your own CSV.
--   * No wallet needed to enter a code. Access is granted to a BROWSER
--     SESSION, not to an address - so a visitor can read the whole site
--     and only connect a wallet later, when they actually want to buy.
--   * Invite/referral system removed entirely.
-- ============================================================================

create extension if not exists pgcrypto;

-- Old objects from v1 - dropped so a re-run leaves a clean state.
drop function if exists generate_invite_codes(text);
drop function if exists generate_readable_code();
drop function if exists try_auto_redeem_by_address(text);
drop function if exists redeem_access_code(text, text);
drop function if exists has_access(text);

-- ----------------------------------------------------------------------------
-- access_codes
-- `code` holds whatever string you load in: a 6-char code, a full EVM
-- address, anything. Matching is exact + case-insensitive, so the format
-- genuinely doesn't matter - add more any time with a plain INSERT.
-- ----------------------------------------------------------------------------
create table if not exists access_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_access_codes_code_lower on access_codes (lower(code));
create index if not exists idx_access_codes_used_at on access_codes (used_at);

alter table access_codes enable row level security;
-- No policies: default-deny for anon/authenticated. Only the backend's
-- service_role key can read or write this table.

-- ----------------------------------------------------------------------------
-- access_sessions
-- One row per successfully redeemed code. The client keeps the raw token;
-- only its SHA-256 hash is stored here, so the table alone can't be used to
-- mint working sessions.
-- ----------------------------------------------------------------------------
create table if not exists access_sessions (
  token_hash text primary key,
  code_id uuid references access_codes(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table access_sessions enable row level security;

-- ----------------------------------------------------------------------------
-- launch_config - the two timers. Edit this row in the Table Editor to
-- change the schedule; no redeploy needed.
--   now < code_gate_starts_at                     -> coming_soon  (no code field shown)
--   code_gate_starts_at <= now < public_opens_at  -> code_required (whitelist)
--   now >= public_opens_at                        -> public        (open to all)
-- ----------------------------------------------------------------------------
create table if not exists launch_config (
  id int primary key default 1,
  code_gate_starts_at timestamptz not null default (now() + interval '24 hours'),
  public_opens_at timestamptz not null default (now() + interval '25 hours'),
  constraint single_row check (id = 1)
);

insert into launch_config (id) values (1) on conflict (id) do nothing;
alter table launch_config enable row level security;

-- ----------------------------------------------------------------------------
-- bypass_tokens - lets YOU into the site during any phase without a code.
-- Add a long random string here, then visit  ?bypass=THAT_STRING  once.
-- ----------------------------------------------------------------------------
create table if not exists bypass_tokens (
  token text primary key,
  label text,
  created_at timestamptz not null default now()
);

alter table bypass_tokens enable row level security;

-- ----------------------------------------------------------------------------
-- redeem_code: validates a code and opens a session. Returns the session's
-- token_hash on success, NULL on failure.
--
-- Typo tolerance: tries an exact case-insensitive match first. Only if that
-- finds nothing does it try again treating O/0 and I/L/1 as interchangeable
-- - and that fallback is accepted ONLY when it resolves to exactly one
-- unused code. Verified against your current 10,000: zero codes collide
-- under that normalisation, so this can't hand out the wrong code. The
-- uniqueness check keeps it safe even if a future code you add would.
-- ----------------------------------------------------------------------------
create or replace function normalize_ambiguous(p text)
returns text
language sql
immutable
as $$
  select translate(upper(p), 'OIL', '011');
$$;

create or replace function redeem_code(p_code text, p_token_hash text)
returns boolean
language plpgsql
as $$
declare
  v_code_id uuid;
  v_match_count int;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return false;
  end if;

  -- 1. exact, case-insensitive
  select id into v_code_id
  from access_codes
  where lower(code) = lower(trim(p_code)) and used_at is null
  limit 1;

  -- 2. typo-tolerant fallback, only if unambiguous
  if v_code_id is null then
    select count(*) into v_match_count
    from access_codes
    where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code)) and used_at is null;

    if v_match_count = 1 then
      select id into v_code_id
      from access_codes
      where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code)) and used_at is null
      limit 1;
    end if;
  end if;

  if v_code_id is null then
    return false;
  end if;

  -- Claim it. The `used_at is null` guard makes this atomic under
  -- concurrency: two simultaneous redeems of the same code, only one wins.
  update access_codes set used_at = now() where id = v_code_id and used_at is null;
  if not found then
    return false;
  end if;

  insert into access_sessions (token_hash, code_id) values (p_token_hash, v_code_id);
  return true;
end;
$$;

-- ----------------------------------------------------------------------------
-- check_code: tells someone whether their code will work, without consuming
-- it. Lets people confirm a code is genuine before the window opens, so nobody
-- discovers a bad code at the moment it matters.
-- Returns 'valid' | 'used' | 'invalid'.
-- ----------------------------------------------------------------------------
create or replace function check_code(p_code text)
returns text
language plpgsql
as $$
declare
  v_used_at timestamptz;
  v_found boolean := false;
  v_match_count int;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return 'invalid';
  end if;

  select used_at, true into v_used_at, v_found
  from access_codes
  where lower(code) = lower(trim(p_code))
  limit 1;

  if not v_found then
    select count(*) into v_match_count
    from access_codes
    where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code));

    if v_match_count = 1 then
      select used_at, true into v_used_at, v_found
      from access_codes
      where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code))
      limit 1;
    end if;
  end if;

  if not v_found then
    return 'invalid';
  end if;
  if v_used_at is not null then
    return 'used';
  end if;
  return 'valid';
end;
$$;

-- ----------------------------------------------------------------------------
-- session_is_valid: called on every page load to re-check a stored session.
-- ----------------------------------------------------------------------------
create or replace function session_is_valid(p_token_hash text)
returns boolean
language plpgsql
as $$
declare
  v_exists boolean;
begin
  select exists(select 1 from access_sessions where token_hash = p_token_hash) into v_exists;
  if v_exists then
    update access_sessions set last_seen_at = now() where token_hash = p_token_hash;
  end if;
  return v_exists;
end;
$$;

-- ----------------------------------------------------------------------------
-- Handy admin queries
-- ----------------------------------------------------------------------------
-- How many codes are left?
--   select count(*) filter (where used_at is null) as unused,
--          count(*) filter (where used_at is not null) as used,
--          count(*) as total
--   from access_codes;
--
-- Add more codes later:
--   insert into access_codes (code) values ('AB12CD'), ('0xYourFriendsWallet...');
--
-- Give yourself a bypass link:
--   insert into bypass_tokens (token, label) values ('pick-a-long-random-string', 'admin');
--   then visit  https://yoursite.netlify.app/?bypass=pick-a-long-random-string
--
-- Free a code that was used by mistake:
--   update access_codes set used_at = null where code = 'AB12CD';
--   delete from access_sessions where code_id = (select id from access_codes where code = 'AB12CD');
