-- ============================================================================
-- Rafflor v3 — gasless holder entries, multi-chain profiles, per-raffle chain
-- ============================================================================
-- Run after raffle_schema.sql and raffle_autodraw_patch.sql. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- chains — a table, not an enum, so new networks can be added by inserting a
-- row instead of shipping a migration and a redeploy.
-- ----------------------------------------------------------------------------
create table if not exists chains (
  key text primary key,
  label text not null,
  family text not null default 'evm' check (family in ('evm','solana','sui','other')),
  address_regex text,
  position int not null default 0,
  active boolean not null default true
);

insert into chains (key, label, family, address_regex, position) values
  ('ethereum',  'Ethereum',       'evm',    '^0x[a-fA-F0-9]{40}$',        10),
  ('robinhood', 'Robinhood Chain','evm',    '^0x[a-fA-F0-9]{40}$',        20),
  ('base',      'Base',           'evm',    '^0x[a-fA-F0-9]{40}$',        30),
  ('arbitrum',  'Arbitrum',       'evm',    '^0x[a-fA-F0-9]{40}$',        40),
  ('optimism',  'Optimism',       'evm',    '^0x[a-fA-F0-9]{40}$',        50),
  ('arc',       'Arc',            'evm',    '^0x[a-fA-F0-9]{40}$',        60),
  ('solana',    'Solana',         'solana', '^[1-9A-HJ-NP-Za-km-z]{32,44}$', 70),
  ('sui',       'Sui',            'sui',    '^0x[a-fA-F0-9]{64}$',        80)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- profiles — one per connected wallet. Socials live here so they are entered
-- once rather than on every raffle.
-- ----------------------------------------------------------------------------
create table if not exists raffle_profiles (
  wallet text primary key,
  x_username text,
  discord_username text,
  telegram_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- profile_wallets — a receiving address per chain. All optional; a raffle only
-- needs the one for its own chain.
-- ----------------------------------------------------------------------------
create table if not exists profile_wallets (
  wallet text not null references raffle_profiles(wallet) on delete cascade,
  chain_key text not null references chains(key),
  address text not null,
  updated_at timestamptz not null default now(),
  primary key (wallet, chain_key)
);

create index if not exists idx_profile_wallets_wallet on profile_wallets(wallet);

-- ----------------------------------------------------------------------------
-- raffles — which chain the whitelist spot is on, and gasless support
-- ----------------------------------------------------------------------------
alter table raffles add column if not exists chain_key text references chains(key);
alter table raffles add column if not exists gasless boolean not null default false;
alter table raffles add column if not exists seed_commitment text;
alter table raffles add column if not exists seed_published_at timestamptz;

-- Holder raffles carry no on-chain entries, so chain_raffle_id may be null.
alter table raffles alter column chain_raffle_id drop not null;

-- ----------------------------------------------------------------------------
-- entries — delivery address for this raffle's chain, captured at entry time
-- so a later profile edit cannot rewrite a recorded entry.
-- ----------------------------------------------------------------------------
alter table raffle_entries add column if not exists delivery_chain text;
alter table raffle_entries add column if not exists delivery_address text;
alter table raffle_entries alter column burner_wallet drop not null;

-- ----------------------------------------------------------------------------
-- entry_nonces — single-use challenges for signature-proved entries.
-- Without these a captured signature could be replayed to enter repeatedly.
-- ----------------------------------------------------------------------------
-- raffle_id is nullable: the same single-use machinery serves profile sign-in,
-- which is not tied to any raffle.
create table if not exists entry_nonces (
  nonce text primary key,
  wallet text not null,
  raffle_id uuid references raffles(id) on delete cascade,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

-- If the table already exists from an earlier run with the NOT NULL constraint
alter table entry_nonces alter column raffle_id drop not null;

create index if not exists idx_nonces_created on entry_nonces(created_at);

alter table chains enable row level security;
alter table raffle_profiles enable row level security;
alter table profile_wallets enable row level security;
alter table entry_nonces enable row level security;

-- ----------------------------------------------------------------------------
-- Views rebuilt to carry the new fields.
--
-- Dropped first rather than CREATE OR REPLACE: replacing a view can only
-- append columns at the end, and these add chain_key and friends in the
-- middle. Views hold no data, so dropping loses nothing.
--
-- Explicit column lists, never select * — seed_secret must not leak into a
-- public view.
-- ----------------------------------------------------------------------------
drop view if exists raffle_winners_public cascade;
drop view if exists raffle_public cascade;

create view raffle_public as
select
  r.id, r.slug, r.chain_raffle_id, r.kind, r.spot_type,
  r.project_name, r.project_description, r.banner_url, r.logo_url,
  r.project_x, r.project_discord, r.project_telegram,
  r.team_x, r.team_discord, r.team_telegram,
  r.spots, r.cost_per_entry, r.max_entries_per_user,
  r.starts_at, r.ends_at, r.status, r.winners_published,
  r.chain_key, r.gasless, r.seed_commitment, r.seed_published_at,
  c.label as chain_label, c.family as chain_family,
  (select count(*) from raffle_entries e where e.raffle_id = r.id) as entrant_count,
  (select coalesce(sum(e.entry_weight),0) from raffle_entries e where e.raffle_id = r.id) as total_weight,
  (select count(*) from raffle_winners w where w.raffle_id = r.id) as winner_count
from raffles r
left join chains c on c.key = r.chain_key;

create view raffle_winners_public as
select
  w.raffle_id, r.slug, w.position,
  coalesce(e.delivery_address, e.burner_wallet, w.wallet_address) as payout_address,
  r.chain_key,
  e.x_username, e.discord_username,
  w.created_at
from raffle_winners w
join raffles r on r.id = w.raffle_id
left join raffle_entries e
  on e.raffle_id = w.raffle_id
 and lower(e.wallet_address) = lower(w.wallet_address)
where r.winners_published;

create or replace function touch_profile()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_touch_profile on raffle_profiles;
create trigger trg_touch_profile before update on raffle_profiles
for each row execute function touch_profile();
