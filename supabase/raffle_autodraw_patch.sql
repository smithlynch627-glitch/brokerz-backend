-- ============================================================================
-- Rafflor — automatic draw support
-- ============================================================================
-- Run once if you already created the raffle tables.
-- ============================================================================

alter table raffles add column if not exists seed_secret text;
alter table raffles add column if not exists auto_draw boolean not null default true;
alter table raffles add column if not exists draw_attempted_at timestamptz;
alter table raffles add column if not exists draw_error text;

-- The public view must never expose the seed. Rebuilt explicitly rather than
-- select *, so a future column cannot leak by accident.
--
-- Dropped first because replacing a view cannot reorder or insert columns,
-- only append them. Views hold no data.
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
  (select coalesce(sum(e.entry_weight),0) from raffle_entries e where e.raffle_id = r.id) as total_weight,
  (select count(*) from raffle_winners w where w.raffle_id = r.id) as winner_count
from raffles r;

-- Recreated because the cascade above removed it. Each patch should leave the
-- database consistent on its own, not depend on a later one to finish the job.
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
