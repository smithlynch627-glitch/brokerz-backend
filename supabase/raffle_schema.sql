-- ============================================================================
-- Brokerz Rafflor — schema
-- ============================================================================
-- Run in the Supabase SQL Editor. Safe to re-run.
--
-- Split of responsibility:
--   on-chain  — payments, entry weights, the draw, winner addresses
--   here      — presentation and identity: banners, tasks, socials, the
--               burner wallet a winner wants their spot sent to
--
-- Money and randomness stay on-chain so they are verifiable. Everything a
-- marketing page needs lives here so editing it costs nothing.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- raffles — one row per giveaway. chain_raffle_id links to the contract.
-- ----------------------------------------------------------------------------
create table if not exists raffles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                    -- shareable link segment
  chain_raffle_id bigint unique,                -- id emitted by createRaffle

  kind text not null check (kind in ('nft_holder','brkz_entry','fixed_gtd')),
  spot_type text not null default 'GTD' check (spot_type in ('GTD','FCFS','ACCESS_CODE')),

  project_name text not null,
  project_description text,
  banner_url text,
  logo_url text,

  project_x text,
  project_discord text,
  project_telegram text,
  socials_required boolean not null default true,

  team_x text,
  team_discord text,
  team_telegram text,

  spots int not null check (spots > 0),
  cost_per_entry numeric(78,0) not null default 0,   -- raw $BRKZ
  max_entries_per_user int not null default 0,        -- 0 = unlimited

  starts_at timestamptz not null,
  ends_at timestamptz not null,

  status text not null default 'draft'
    check (status in ('draft','live','ended','drawn','cancelled')),

  winners_published boolean not null default false,

  -- Draw automation. seed_secret is the preimage of the on-chain commitment;
  -- the backend reveals it when the window closes.
  --
  -- Holding it here is safe because the contract also mixes in a blockhash
  -- from draw time, so knowing the secret early does not determine the result.
  -- Kept behind RLS default-deny like everything else.
  seed_secret text,
  auto_draw boolean not null default true,
  draw_attempted_at timestamptz,
  draw_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint window_valid check (ends_at > starts_at)
);

create index if not exists idx_raffles_status on raffles(status);
create index if not exists idx_raffles_slug on raffles(slug);
create index if not exists idx_raffles_ends on raffles(ends_at);

-- ----------------------------------------------------------------------------
-- raffle_tasks — the follow / retweet / join list. Ordered, extensible.
-- ----------------------------------------------------------------------------
create table if not exists raffle_tasks (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references raffles(id) on delete cascade,
  position int not null default 0,
  task_type text not null check (task_type in
    ('follow_x','like_rt','comment','join_discord','join_telegram','visit_link','custom')),
  label text not null,
  target_url text,
  required boolean not null default true
);

create index if not exists idx_tasks_raffle on raffle_tasks(raffle_id, position);

-- ----------------------------------------------------------------------------
-- entries — identity attached to a wallet's on-chain entry.
--
-- The contract records that an address entered and with what weight. It has no
-- idea who that is. This table carries the X handle, Discord handle and the
-- burner wallet a winner wants the spot delivered to.
--
-- burner_wallet is deliberately separate from wallet_address: people enter with
-- the wallet holding their NFTs but rarely want that address published.
-- ----------------------------------------------------------------------------
create table if not exists raffle_entries (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references raffles(id) on delete cascade,

  wallet_address text not null,      -- entered with; verified on-chain
  burner_wallet text not null,       -- where the spot goes; shown publicly
  x_username text not null,
  discord_username text not null,

  entry_weight int not null default 0,   -- mirrored from chain for display
  tx_hash text,

  created_at timestamptz not null default now(),

  unique (raffle_id, wallet_address)
);

create index if not exists idx_entries_raffle on raffle_entries(raffle_id);
create index if not exists idx_entries_wallet on raffle_entries(lower(wallet_address));

-- ----------------------------------------------------------------------------
-- raffle_winners — mirrors the on-chain draw, joined to identity.
-- ----------------------------------------------------------------------------
create table if not exists raffle_winners (
  id uuid primary key default gen_random_uuid(),
  raffle_id uuid not null references raffles(id) on delete cascade,
  wallet_address text not null,
  position int not null,
  tx_hash text,
  created_at timestamptz not null default now(),
  unique (raffle_id, wallet_address)
);

create index if not exists idx_winners_raffle on raffle_winners(raffle_id, position);

-- ----------------------------------------------------------------------------
-- admin_wallets — who may reach the admin panel.
-- ----------------------------------------------------------------------------
create table if not exists admin_wallets (
  wallet text primary key,
  label text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- RLS: default-deny everywhere. Only the backend's service_role key touches
-- these tables, exactly as with access_codes.
-- ----------------------------------------------------------------------------
alter table raffles enable row level security;
alter table raffle_tasks enable row level security;
alter table raffle_entries enable row level security;
alter table raffle_winners enable row level security;
alter table admin_wallets enable row level security;

-- ----------------------------------------------------------------------------
-- Public view of a raffle, safe to serve without auth.
-- Deliberately excludes entrant identities.
-- ----------------------------------------------------------------------------
-- Dropped first so a re-run against an altered view cannot fail on column
-- ordering — CREATE OR REPLACE can only append columns, never reorder them.
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
  (select count(*) from raffle_entries e where e.raffle_id = r.id) as entrant_count,
  (select coalesce(sum(e.entry_weight),0) from raffle_entries e where e.raffle_id = r.id) as total_weight
from raffles r;

-- Winners, with only the burner wallet and social handles exposed —
-- never the wallet someone actually entered with.
create view raffle_winners_public as
select
  w.raffle_id,
  r.slug,
  w.position,
  coalesce(e.burner_wallet, w.wallet_address) as burner_wallet,
  e.x_username,
  e.discord_username,
  w.created_at
from raffle_winners w
join raffles r on r.id = w.raffle_id
left join raffle_entries e
  on e.raffle_id = w.raffle_id
 and lower(e.wallet_address) = lower(w.wallet_address)
where r.winners_published;

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
create or replace function is_admin(p_wallet text)
returns boolean language sql stable as $$
  select exists(select 1 from admin_wallets where lower(wallet) = lower(p_wallet));
$$;

create or replace function touch_raffle()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_touch_raffle on raffles;
create trigger trg_touch_raffle before update on raffles
for each row execute function touch_raffle();

-- ----------------------------------------------------------------------------
-- Add yourself as an admin:
--   insert into admin_wallets (wallet, label)
--   values (lower('0x2c210e1299b93961253604037DBd162c3C986826'), 'owner');
-- ----------------------------------------------------------------------------
