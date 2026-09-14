-- ============================================================================
-- Rafflor — hidden flag
-- ============================================================================
-- Run if you already applied rafflor_v3_patch.sql before this column existed.
--
-- Hiding is separate from status on purpose: status='cancelled' means the
-- raffle will not draw and may owe refunds, which is not what "take this off
-- the public list" should mean.
-- ============================================================================

alter table raffles add column if not exists hidden boolean not null default false;

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
  r.chain_key, r.gasless, r.seed_commitment, r.seed_published_at, r.hidden,
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

-- Anything hidden earlier by setting status='cancelled' can be restored:
--   update raffles set hidden = true, status = 'ended'
--   where status = 'cancelled' and winners_published = false;
