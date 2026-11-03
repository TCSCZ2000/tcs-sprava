-- Hodiny pro lidi: navazování cest (combi), hodiny mimo report, modul Hodiny

-- Navazuje na předchozí cestu posádky: null = podle automatiky (mezera do 6 h), true = potvrzeno/ručně, false = odmítnuto
alter table trips add column if not exists combi boolean;

-- Hodiny mimo reporty (přesuny aut apod.) a pevné hodiny za jinou práci
create table hours_extra (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references people on delete cascade,
  work_date  date not null,
  kind       text not null check (kind in ('mimo', 'pevne')),
  hours      numeric(6,2) not null,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index on hours_extra (work_date);

insert into modules values ('hours', 'Hodiny', 18) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','hours','write'), ('dispatcher','hours','none'), ('viewer','hours','none'), ('custom','hours','none')
on conflict do nothing;

alter table hours_extra enable row level security;
create policy "hodiny r" on hours_extra for select using (can_read('hours'));
create policy "hodiny w" on hours_extra for all using (can_write('hours')) with check (can_write('hours'));
grant select, insert, update, delete on hours_extra to authenticated;
alter publication supabase_realtime add table hours_extra;

-- combi smí měnit ten, kdo dopisuje reporty nebo spravuje hodiny
create or replace function trips_check_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.route_price_id, new.price_manual) is distinct from (old.route_price_id, old.price_manual)
     and not (can_write('reports') or can_write('routes')) then
    raise exception 'Nemáte oprávnění měnit cenu cesty.' using errcode = '42501';
  end if;
  if new.combi is distinct from old.combi and not (can_write('reports') or can_write('hours')) then
    raise exception 'Nemáte oprávnění měnit navazování cest.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function trips_check_price() from public, anon, authenticated;
