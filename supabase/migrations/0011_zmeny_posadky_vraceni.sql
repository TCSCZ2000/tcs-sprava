-- Změny posádky u odeslané cesty: vrácení původní hodnoty změnu zruší, druhá změna stejné pozice
-- přepíše tu první (vždy „původní → aktuální“), místo hromadění G1: A → B; G1: B → A.
create or replace function trips_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  was_sent boolean;
  slots   text[] := array['G1', 'G2', 'G3', 'Auto'];
  oldv    text[];
  newv    text[];
  parts   text[];
  entries text[] := '{}';
  e text; orig text; existing text;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  select s.sent into was_sent from statuses s where s.name = old.status;
  if coalesce(was_sent, false) and new.crew_change is not distinct from old.crew_change then
    oldv := array[
      coalesce((select short_name from people where id = old.guard1_id), '–'),
      coalesce((select short_name from people where id = old.guard2_id), '–'),
      coalesce((select short_name from people where id = old.guard3_id), '–'),
      coalesce((select coalesce(plate, car_no) from cars where id = old.car_id), '–')];
    newv := array[
      coalesce((select short_name from people where id = new.guard1_id), '–'),
      coalesce((select short_name from people where id = new.guard2_id), '–'),
      coalesce((select short_name from people where id = new.guard3_id), '–'),
      coalesce((select coalesce(plate, car_no) from cars where id = new.car_id), '–')];
    parts := regexp_split_to_array(coalesce(old.crew_change, ''), ';\s*');
    for i in 1..4 loop
      existing := null; orig := null;
      foreach e in array parts loop
        if e ~ ('^' || slots[i] || ': ') then
          existing := e;
          orig := substring(e from '^[^:]+: (.*) → ');
        end if;
      end loop;
      if newv[i] is distinct from oldv[i] then
        if orig is null then orig := oldv[i]; end if;
        if newv[i] <> orig then
          entries := entries || (slots[i] || ': ' || orig || ' → ' || newv[i]);
        end if;  -- vrácení na původní hodnotu = žádná změna
      elsif existing is not null then
        entries := entries || existing;
      end if;
    end loop;
    new.crew_change := nullif(array_to_string(entries, '; '), '');
  end if;
  return new;
end $$;
