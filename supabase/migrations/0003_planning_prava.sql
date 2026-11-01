-- Jemnější práva v Planningu
-- planning          = vidí Planning (read) / smí psát poznámky a potvrzovat změny posádky (write)
-- planning_create   = přidávat a mazat cesty
-- planning_status   = měnit status a referenční číslo
-- planning_crew     = měnit posádku, auto a odkud auto
-- planning_route    = měnit datum, čas, Pup a Dop

update modules set name = 'Planning – vidí, poznámky' where key = 'planning';
insert into modules values
  ('planning_create', 'Planning – přidávat a mazat cesty', 11),
  ('planning_status', 'Planning – status a reference',     12),
  ('planning_crew',   'Planning – posádka a auto',         13),
  ('planning_route',  'Planning – datum, čas a trasa',     14);
update modules set sort = 10 where key = 'planning';

insert into role_defaults values
  ('admin','planning_create','write'),      ('dispatcher','planning_create','write'),      ('viewer','planning_create','none'),
  ('admin','planning_status','write'),      ('dispatcher','planning_status','write'),      ('viewer','planning_status','none'),
  ('admin','planning_crew','write'),        ('dispatcher','planning_crew','write'),        ('viewer','planning_crew','none'),
  ('admin','planning_route','write'),       ('dispatcher','planning_route','write'),       ('viewer','planning_route','none');

-- Řádky: kdo vidí Planning, smí do řádku sáhnout; co přesně změní, hlídá trigger níž
drop policy "cesty w" on trips;
create policy "cesty insert" on trips for insert with check (can_write('planning_create'));
create policy "cesty delete" on trips for delete using (can_write('planning_create'));
create policy "cesty update" on trips for update using (can_read('planning')) with check (can_read('planning'));

create or replace function trips_check_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- správa přímo v databázi
  if (new.status, new.ref_tcs) is distinct from (old.status, old.ref_tcs)
     and not can_write('planning_status') then
    raise exception 'Nemáte oprávnění měnit status a referenci.' using errcode = '42501';
  end if;
  if (new.guard1_id, new.guard2_id, new.guard3_id, new.car_id, new.car_origin, new.car_origin_other)
     is distinct from (old.guard1_id, old.guard2_id, old.guard3_id, old.car_id, old.car_origin, old.car_origin_other)
     and not can_write('planning_crew') then
    raise exception 'Nemáte oprávnění měnit posádku a auto.' using errcode = '42501';
  end if;
  if (new.trip_date, new.trip_time, new.pup_id, new.dop_id) is distinct from (old.trip_date, old.trip_time, old.pup_id, old.dop_id)
     and not can_write('planning_route') then
    raise exception 'Nemáte oprávnění měnit datum, čas a trasu.' using errcode = '42501';
  end if;
  if (new.remarks, new.crew_change) is distinct from (old.remarks, old.crew_change)
     and not can_write('planning') then
    -- automatický zápis změny posádky (trips_bu) se počítá k právu na posádku
    if new.remarks is distinct from old.remarks or not can_write('planning_crew') then
      raise exception 'Nemáte oprávnění měnit poznámky.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function trips_check_columns() from public, anon, authenticated;

-- Běží po trips_bu (abecedně „trips_bu“ < „trips_check“), takže vidí i automatický zápis změny posádky
create trigger trips_check before update on trips
  for each row execute function trips_check_columns();
