create or replace function check_code(p_code text)
returns text
language plpgsql
as $$
declare
  v_id uuid;
  v_used_at timestamptz;
  v_match_count int;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return 'invalid';
  end if;

  -- Presence is tested with the primary key rather than a boolean flag.
  -- SELECT INTO sets its targets to NULL when nothing matches, so a flag
  -- initialised to false becomes NULL, and `if not v_flag` is then NULL,
  -- which an IF treats as false. That skipped the "invalid" branch and fell
  -- through to returning 'valid' for every unknown code. An id is NOT NULL
  -- whenever a row matched, so `v_id is null` has no such ambiguity.
  select id, used_at into v_id, v_used_at
  from access_codes
  where lower(code) = lower(trim(p_code))
  limit 1;

  if v_id is null then
    select count(*) into v_match_count
    from access_codes
    where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code));

    if v_match_count = 1 then
      select id, used_at into v_id, v_used_at
      from access_codes
      where normalize_ambiguous(code) = normalize_ambiguous(trim(p_code))
      limit 1;
    end if;
  end if;

  if v_id is null then
    return 'invalid';
  end if;

  if v_used_at is not null then
    return 'used';
  end if;

  return 'valid';
end;
$$;
