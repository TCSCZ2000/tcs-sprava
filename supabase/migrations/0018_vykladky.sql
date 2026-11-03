-- Více vykládek: Dop 2 … Dop N u cesty, s časy a km po úsecích; trasa může mít stejnou sestavu vykládek (pevná cena)
create table trip_stops (
  id        uuid primary key default gen_random_uuid(),
  trip_id   uuid not null references trips on delete cascade,
  seq       int  not null check (seq >= 2),          -- 2 = Dop 2, 3 = Dop 3 …
  place_id  uuid not null references places,
  arr       timestamp,                                -- příjezd na tuhle vykládku
  dep       timestamp,                                -- odjezd z ní
  km        int,                                      -- km z předchozí vykládky
  note      text,
  unique (trip_id, seq)
);
create index on trip_stops (trip_id);

alter table trip_stops enable row level security;
create policy "vykládky r" on trip_stops for select using (can_read('planning'));
create policy "vykládky w" on trip_stops for all
  using (can_write('planning_route') or can_write('reports'))
  with check (can_write('planning_route') or can_write('reports'));
grant select, insert, update, delete on trip_stops to authenticated;
alter publication supabase_realtime add table trip_stops;

-- trasa pro víc vykládek: Dop = první vykládka (jako u cesty), stops = Dop 2 … Dop N v pořadí; úsek DOP→Kam je z poslední vykládky
alter table routes add column stops uuid[] not null default '{}';
alter table routes drop constraint routes_pup_dop_bases_variant_key;
alter table routes add constraint routes_key unique (pup_id, dop_id, base_from, base_to, variant, stops);

drop function route_times();
create function route_times()
returns table (id uuid, pup_id uuid, dop_id uuid, ho_pup_h numeric, dop_ho_h numeric, base_from text, base_to text, variant text, stops uuid[])
language sql stable security definer set search_path = public as $$
  select r.id, r.pup_id, r.dop_id, r.ho_pup_h, r.dop_ho_h, r.base_from, r.base_to, r.variant, r.stops
  from routes r where can_read('planning')
$$;
grant execute on function route_times() to authenticated;
