-- ============================================================================
-- Rafflor — correct wrongly flagged gasless raffles
-- ============================================================================
-- The admin form held gasless as the string 'yes', which was sent for every
-- raffle kind. 'yes' and 'no' are both truthy, so paid raffles were stored
-- gasless=true and routed to the off-chain draw, which they have no business
-- using — their winners live on the contract.
--
-- Only holder raffles can be gasless. Anything with an on-chain id is not.
-- ============================================================================

update raffles
set gasless = false
where gasless = true
  and (kind <> 'nft_holder' or chain_raffle_id is not null);

-- What this touched
select kind,
       count(*) filter (where gasless)     as now_gasless,
       count(*) filter (where not gasless) as now_on_chain
from raffles
group by kind
order by kind;
