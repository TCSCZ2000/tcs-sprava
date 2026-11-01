-- TCS Správa · jádro + Planning v1
-- Spustit jednou v Supabase: SQL Editor → New query → vložit celý soubor → Run.

-- ============ UŽIVATELÉ A PRÁVA ============
create type app_role as enum ('admin', 'dispatcher', 'viewer');
create type access_level as enum ('none', 'read', 'write');

create table invites (
  email      text primary key check (email = lower(email)),
  full_name  text not null,
  role       app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

create table profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null unique,
  full_name  text not null,
  role       app_role not null default 'viewer',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Moduly a výchozí úroveň podle role
create table modules (
  key   text primary key,
  name  text not null,
  sort  int not null
);
insert into modules values
  ('planning',    'Planning',              1),
  ('people',      'Lidé – kontakty',       2),
  ('people_docs', 'Lidé – doklady a pasy', 3),
  ('cars',        'Auta',                  4),
  ('places',      'Místa',                 5),
  ('users',       'Správa uživatelů',      9);

create table role_defaults (
  role   app_role not null,
  module text not null references modules,
  level  access_level not null,
  primary key (role, module)
);
insert into role_defaults values
  ('admin','planning','write'),     ('dispatcher','planning','write'),    ('viewer','planning','read'),
  ('admin','people','write'),       ('dispatcher','people','write'),      ('viewer','people','read'),
  ('admin','people_docs','write'),  ('dispatcher','people_docs','read'),  ('viewer','people_docs','none'),
  ('admin','cars','write'),         ('dispatcher','cars','read'),         ('viewer','cars','read'),
  ('admin','places','write'),       ('dispatcher','places','write'),      ('viewer','places','read'),
  ('admin','users','write'),        ('dispatcher','users','none'),        ('viewer','users','none');

-- Výjimky pro konkrétního člověka (přebíjí roli)
create table permissions (
  user_id uuid not null references profiles on delete cascade,
  module  text not null references modules,
  level   access_level not null,
  primary key (user_id, module)
);

-- Efektivní úroveň přihlášeného uživatele v modulu
create or replace function perm(mod text) returns access_level
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case when not p.active then 'none'::access_level
                 else coalesce(x.level, d.level, 'none') end
       from profiles p
       left join permissions x on x.user_id = p.id and x.module = mod
       left join role_defaults d on d.role = p.role and d.module = mod
      where p.id = auth.uid()),
    'none');
$$;
create or replace function can_read(mod text) returns boolean
language sql stable as $$ select perm(mod) in ('read','write') $$;
create or replace function can_write(mod text) returns boolean
language sql stable as $$ select perm(mod) = 'write' $$;

-- Nový účet dostane profil jen tehdy, když je pozvaný
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare i invites;
begin
  select * into i from invites where email = lower(new.email);
  if found then
    insert into profiles (id, email, full_name, role)
    values (new.id, lower(new.email), i.full_name, i.role)
    on conflict (id) do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Pozvánka pro někoho, kdo už účet má → profil vznikne hned
create or replace function invite_attach() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name, role)
  select u.id, lower(u.email), new.full_name, new.role
    from auth.users u where lower(u.email) = new.email
  on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, active = true;
  return new;
end $$;
create trigger on_invite after insert on invites
  for each row execute function invite_attach();

-- ============ ČÍSELNÍKY ============
create table people (
  id           uuid primary key default gen_random_uuid(),
  first_name   text not null,
  last_name    text not null,
  short_name   text generated always as (left(first_name, 1) || '. ' || last_name) stored,
  phone        text,
  birth_date   date,
  nationality  text,
  active       boolean not null default true,
  note         text,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid()
);
create index on people (short_name);

create table person_docs (
  person_id         uuid primary key references people on delete cascade,
  id_number         text,
  id_valid_to       date,
  passport_number   text,
  passport_valid_to date,
  updated_at        timestamptz not null default now(),
  updated_by        uuid default auth.uid()
);

create table cars (
  id              uuid primary key default gen_random_uuid(),
  plate           text not null unique,
  model           text,
  color           text,
  car_no          text,
  loc             text,
  category        text,
  gps             text,
  uta_card        text,
  owner           text,
  insurer         text,
  stk_until       date,
  vignette_until  date,
  tyres           text,
  state           text default 'Aktivní',
  note            text,
  label           text generated always as (
                    plate || coalesce(', ' || model, '') || coalesce(' ' || color, '') || coalesce(', ' || car_no, '')) stored,
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid()
);

create table places (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  travel_time  interval,          -- doba jízdy z TCS
  ferry        boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid()
);

create table statuses (
  name   text primary key,
  color  text not null,
  sort   int not null,
  sent   boolean not null default false  -- výjezd už je odeslaný zákazníkovi
);
insert into statuses values
  ('HEADS-UP',    '#FF0000', 1, false),
  ('Confirmed',   '#92D050', 2, false),
  ('Send',        '#FFFF00', 3, true),
  ('Skupina ✅',  '#2F75B5', 4, true),
  ('Jti',         '#FFC000', 5, false),
  ('On the road', '#E59866', 6, true),
  ('Departed',    '#00B050', 7, true),
  ('Finished',    '#00B0F0', 8, true),
  ('Canceled',    '#7030A0', 9, false);

-- ============ CESTY ============
create table trips (
  id              uuid primary key default gen_random_uuid(),
  trip_date       date not null,
  trip_time       time,
  pup_id          uuid references places,
  dop_id          uuid references places,
  guard1_id       uuid references people,
  guard2_id       uuid references people,
  guard3_id       uuid references people,
  car_id          uuid references cars,
  car_origin      text check (car_origin in ('Praha', 'Příbram', 'Jiné')),
  car_origin_other text,
  ref_tcs         text unique check (ref_tcs ~ '^A[0-9]{5}$'),
  status          text references statuses on update cascade,
  remarks         text,
  crew_change     text,            -- např. „G1: J. Novak → P. Dvorak“; prázdné = bez změny
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid()
);
create index on trips (trip_date);

-- Hlídání změny posádky po odeslání zákazníkovi
create or replace function trips_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  was_sent boolean;
  msg text := '';
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  select s.sent into was_sent from statuses s where s.name = old.status;
  if coalesce(was_sent, false) then
    if new.guard1_id is distinct from old.guard1_id then
      msg := msg || 'G1: ' || coalesce((select short_name from people where id = old.guard1_id), '–')
                 || ' → ' || coalesce((select short_name from people where id = new.guard1_id), '–') || '; ';
    end if;
    if new.guard2_id is distinct from old.guard2_id then
      msg := msg || 'G2: ' || coalesce((select short_name from people where id = old.guard2_id), '–')
                 || ' → ' || coalesce((select short_name from people where id = new.guard2_id), '–') || '; ';
    end if;
    if new.guard3_id is distinct from old.guard3_id then
      msg := msg || 'G3: ' || coalesce((select short_name from people where id = old.guard3_id), '–')
                 || ' → ' || coalesce((select short_name from people where id = new.guard3_id), '–') || '; ';
    end if;
    if new.car_id is distinct from old.car_id then
      msg := msg || 'Auto: ' || coalesce((select plate from cars where id = old.car_id), '–')
                 || ' → ' || coalesce((select plate from cars where id = new.car_id), '–') || '; ';
    end if;
    if msg <> '' and new.crew_change is not distinct from old.crew_change then
      new.crew_change := trim(both ' ' from coalesce(old.crew_change || ' ', '') || msg);
    end if;
  end if;
  return new;
end $$;
create trigger trips_bu before update on trips
  for each row execute function trips_before_update();

-- Kdo naposledy upravil číselníky
create or replace function touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger people_bu before update on people for each row execute function touch();
create trigger docs_bu   before update on person_docs for each row execute function touch();
create trigger cars_bu   before update on cars for each row execute function touch();
create trigger places_bu before update on places for each row execute function touch();

-- ============ PRÁVA V DATABÁZI (RLS) ============
alter table invites       enable row level security;
alter table profiles      enable row level security;
alter table modules       enable row level security;
alter table role_defaults enable row level security;
alter table permissions   enable row level security;
alter table people        enable row level security;
alter table person_docs   enable row level security;
alter table cars          enable row level security;
alter table places        enable row level security;
alter table statuses      enable row level security;
alter table trips         enable row level security;

-- Správa uživatelů
create policy "users r" on invites  for select using (can_read('users'));
create policy "users w" on invites  for all    using (can_write('users')) with check (can_write('users'));
create policy "profil sám" on profiles for select using (id = auth.uid() or can_read('users'));
create policy "profil w"   on profiles for update using (can_write('users')) with check (can_write('users'));
create policy "moduly"   on modules       for select using (auth.uid() is not null);
create policy "role r"   on role_defaults for select using (auth.uid() is not null);
create policy "perm r"   on permissions   for select using (user_id = auth.uid() or can_read('users'));
create policy "perm w"   on permissions   for all    using (can_write('users')) with check (can_write('users'));

-- Číselníky a cesty
create policy "lidé r"   on people      for select using (can_read('people') or can_read('planning'));
create policy "lidé w"   on people      for all    using (can_write('people')) with check (can_write('people'));
create policy "doklady r" on person_docs for select using (can_read('people_docs'));
create policy "doklady w" on person_docs for all    using (can_write('people_docs')) with check (can_write('people_docs'));
create policy "auta r"   on cars        for select using (can_read('cars') or can_read('planning'));
create policy "auta w"   on cars        for all    using (can_write('cars')) with check (can_write('cars'));
create policy "místa r"  on places      for select using (can_read('places') or can_read('planning'));
create policy "místa w"  on places      for all    using (can_write('places')) with check (can_write('places'));
create policy "statusy r" on statuses   for select using (auth.uid() is not null);
create policy "statusy w" on statuses   for all    using (can_write('users')) with check (can_write('users'));
create policy "cesty r"  on trips       for select using (can_read('planning'));
create policy "cesty w"  on trips       for all    using (can_write('planning')) with check (can_write('planning'));

-- Data API: přístup jen pro přihlášené (anon nedostane nic)
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  invites, profiles, permissions, people, person_docs, cars, places, statuses, trips
  to authenticated;
grant select on modules, role_defaults to authenticated;
grant execute on function perm(text), can_read(text), can_write(text) to authenticated;

-- Živé změny pro všechny otevřené obrazovky
alter publication supabase_realtime add table trips, people, cars, places;

-- Funkce práv nejsou pro nepřihlášené
revoke execute on function perm(text), can_read(text), can_write(text) from public, anon;
revoke execute on function handle_new_user(), invite_attach(), trips_before_update() from public, anon, authenticated;
