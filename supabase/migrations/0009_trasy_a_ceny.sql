-- Trasy a ceny: úseky, sazby, víc pevných cen na trasu, města pro návrhy kopií

alter table places add column if not exists city text;
-- první odhad města: poslední slovo názvu (KN Frankfurt → Frankfurt); dá se opravit v Místech
update places set city = regexp_replace(name, '^.*\s', '') where city is null and name ~ '\s';

create table routes (
  id            uuid primary key default gen_random_uuid(),
  pup_id        uuid not null references places,
  dop_id        uuid not null references places,
  ho_pup_km     numeric(8,1), ho_pup_h  numeric(6,2), ho_pup_toll  numeric(10,2),
  pup_dop_km    numeric(8,1), pup_dop_h numeric(6,2), pup_dop_toll numeric(10,2),
  dop_ho_km     numeric(8,1), dop_ho_h  numeric(6,2), dop_ho_toll  numeric(10,2),
  rate_h        numeric(8,2) not null default 10,
  rate_km       numeric(8,3) not null default 0.28,
  note          text,
  copied_from   uuid references routes on delete set null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid(),
  unique (pup_id, dop_id)
);

create table route_prices (
  id         uuid primary key default gen_random_uuid(),
  route_id   uuid not null references routes on delete cascade,
  label      text not null,                -- např. „10 h“, „20 h“
  pup_dop_h  numeric(6,2),                 -- počet hodin mezi Pup a Dop, ze kterých je cena spočítaná
  price      numeric(10,2) not null,
  sort       int not null default 1
);

-- u cesty: zvolená pevná cena (prázdné = podle sazeb)
alter table trips add column if not exists route_price_id uuid references route_prices on delete set null;

create trigger routes_bu before update on routes for each row execute function touch();

-- práva
insert into modules values ('routes', 'Trasy a ceny', 17) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','routes','write'), ('dispatcher','routes','none'), ('viewer','routes','none'), ('custom','routes','none')
on conflict do nothing;

alter table routes enable row level security;
alter table route_prices enable row level security;
create policy "trasy r" on routes for select using (can_read('routes'));
create policy "trasy w" on routes for all using (can_write('routes')) with check (can_write('routes'));
create policy "ceny r" on route_prices for select using (can_read('routes'));
create policy "ceny w" on route_prices for all using (can_write('routes')) with check (can_write('routes'));
grant select, insert, update, delete on routes, route_prices to authenticated;
alter publication supabase_realtime add table routes, route_prices;

-- výběr ceny u cesty smí ten, kdo dopisuje reporty nebo spravuje ceny
create or replace function trips_check_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.route_price_id is distinct from old.route_price_id
     and not (can_write('reports') or can_write('routes')) then
    raise exception 'Nemáte oprávnění měnit cenu cesty.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function trips_check_price() from public, anon, authenticated;
create trigger trips_check_price before update on trips for each row execute function trips_check_price();
