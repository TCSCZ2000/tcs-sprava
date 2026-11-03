-- Detail auta: pořízení, servisní historie, log stavů km, soubory, tankovací karty s PINy, servisní skupiny
create extension if not exists pgcrypto;

alter table cars
  add column if not exists purchase_date  date,
  add column if not exists purchase_price numeric(12,2),
  add column if not exists purchase_km    int,
  add column if not exists vin            text,
  add column if not exists year           int,
  add column if not exists service_group  text,     -- skupina vozu pro intervaly (VW diesel, Fabia benzín, Renault Kangoo…)
  add column if not exists service_at     text;     -- TCS / dealer

-- Servisní skupiny (pravidla intervalů; jako list Intervaly v TCS servis)
create table car_service_groups (
  name       text primary key,
  small_km   int not null default 20000,     -- malý servis každých X km
  big_every  int,                            -- velký servis každý N. servis
  timing_km  int,                            -- rozvody každých X km (null = nehlídá se)
  service_at text not null default 'TCS',
  notify     boolean not null default true,
  sort       int not null default 10
);
insert into car_service_groups values
  ('VW diesel', 20000, 3, 210000, 'TCS', true, 1),
  ('Fabia benzín', 20000, 3, null, 'TCS', true, 2),
  ('Renault Kangoo', 30000, 2, 150000, 'dealer', true, 3),
  ('Renault Clio', 20000, 3, 160000, 'TCS', true, 4),
  ('Peugeot 301', 20000, 3, 170000, 'TCS', true, 5),
  ('Před prodejem', 30000, null, null, 'TCS', false, 6);

-- Druhy práce
create table car_work_kinds (name text primary key, sort int not null default 10, counts_as_service boolean not null default false, big boolean not null default false);
insert into car_work_kinds values
  ('Malý servis', 1, true, false), ('Velký servis', 2, true, true), ('Rozvody', 3, false, false),
  ('Brzdy přední', 4, false, false), ('Brzdy zadní', 5, false, false), ('Brzdy (nerozlišeno)', 6, false, false),
  ('Přezutí přední', 7, false, false), ('Přezutí zadní', 8, false, false), ('Přezutí komplet', 9, false, false),
  ('STK', 10, false, false), ('Baterie', 11, false, false), ('Karoserie', 12, false, false), ('Oprava', 13, false, false), ('Jiné', 14, false, false);

-- Servisní historie: každá provedená práce jeden řádek
create table car_service (
  id          uuid primary key default gen_random_uuid(),
  car_id      uuid not null references cars on delete cascade,
  done_on     date not null,
  km          int,
  kind        text not null references car_work_kinds on update cascade,
  shop        text,
  price_net   numeric(12,2),
  price_gross numeric(12,2),
  currency    text not null default 'CZK',
  doc_no      text,
  source      text,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index on car_service (car_id, done_on);

-- Log stavů km (z fotek tachometru, ručně, z GPS)
create table car_km (
  id       uuid primary key default gen_random_uuid(),
  car_id   uuid not null references cars on delete cascade,
  at       timestamp not null,
  km       int not null,
  source   text,
  crew     text,
  link     text,
  note     text,
  created_by uuid default auth.uid()
);
create index on car_km (car_id, at);

-- Soubory k autu (zelená karta, TP, faktury, fotky) – v Supabase Storage, bucket car-files
create table car_files (
  id          uuid primary key default gen_random_uuid(),
  car_id      uuid not null references cars on delete cascade,
  kind        text not null default 'jiné',   -- zelená karta, TP, faktura, foto, jiné
  name        text not null,
  path        text not null unique,           -- cesta v bucketu car-files
  size        int,
  valid_to    date,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid default auth.uid()
);

-- Tankovací karty (UTA, DKV) s PINem zašifrovaným hlavním klíčem (viz níže)
create table car_cards (
  id        uuid primary key default gen_random_uuid(),
  car_id    uuid not null references cars on delete cascade,
  provider  text not null,                   -- UTA / DKV
  number    text,
  valid_to  date,
  pin_enc   bytea,                           -- pgp_sym_encrypt(pin, hlavní klíč)
  note      text,
  unique (car_id, provider)
);

-- Práva: nový modul Auta – PINy
insert into modules values ('cars_pins', 'Auta – PINy', 19) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','cars_pins','write'), ('dispatcher','cars_pins','none'), ('viewer','cars_pins','none'), ('custom','cars_pins','none')
on conflict do nothing;

alter table car_service_groups enable row level security;
alter table car_work_kinds     enable row level security;
alter table car_service        enable row level security;
alter table car_km             enable row level security;
alter table car_files          enable row level security;
alter table car_cards          enable row level security;
create policy "skupiny r" on car_service_groups for select using (auth.uid() is not null);
create policy "skupiny w" on car_service_groups for all using (can_write('cars')) with check (can_write('cars'));
create policy "druhy r"   on car_work_kinds for select using (auth.uid() is not null);
create policy "servis r"  on car_service for select using (can_read('cars'));
create policy "servis w"  on car_service for all using (can_write('cars')) with check (can_write('cars'));
create policy "km r"      on car_km for select using (can_read('cars'));
create policy "km w"      on car_km for all using (can_write('cars')) with check (can_write('cars'));
create policy "soubory r" on car_files for select using (can_read('cars'));
create policy "soubory w" on car_files for all using (can_write('cars')) with check (can_write('cars'));
create policy "karty r"   on car_cards for select using (can_read('cars'));
create policy "karty w"   on car_cards for all using (can_write('cars')) with check (can_write('cars'));
grant select on car_service_groups, car_work_kinds to authenticated;
grant insert, update, delete on car_service_groups to authenticated;
grant select, insert, update, delete on car_service, car_km, car_files, car_cards to authenticated;
-- PIN se nikdy nečte přímo: sloupec pin_enc není pro authenticated čitelný ani zapisovatelný
revoke select (pin_enc), insert (pin_enc), update (pin_enc) on car_cards from authenticated;
alter publication supabase_realtime add table car_service, car_km, car_files, car_cards;

-- ===== PINy: hlavní klíč zabalený heslem každého oprávněného uživatele =====
create table pin_keys (
  user_id    uuid primary key references profiles on delete cascade,
  wrapped    bytea not null,          -- pgp_sym_encrypt(hlavní klíč, heslo uživatele)
  granted_by uuid,
  created_at timestamptz not null default now()
);
create table pin_log (
  id      bigserial primary key,
  user_id uuid not null,
  card_id uuid,
  action  text not null,              -- reveal / set / setup / grant / revoke / change
  at      timestamptz not null default now()
);
alter table pin_keys enable row level security;
alter table pin_log  enable row level security;
create policy "pin_keys r" on pin_keys for select using (can_read('users') or user_id = auth.uid());
create policy "pin_log r"  on pin_log  for select using (can_read('cars_pins'));
grant select on pin_keys, pin_log to authenticated;

-- rozbalí hlavní klíč heslem volajícího; chyba, když nemá klíč nebo je heslo špatně
create or replace function pins_master(p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare w bytea; m text;
begin
  if not can_read('cars_pins') then raise exception 'Nemáte oprávnění k PINům.' using errcode = '42501'; end if;
  select wrapped into w from pin_keys where user_id = auth.uid();
  if w is null then raise exception 'Nemáte nastavené heslo k PINům. Požádejte správce.' using errcode = '42501'; end if;
  begin
    m := pgp_sym_decrypt(w, p_password);
  exception when others then
    raise exception 'Špatné heslo k PINům.' using errcode = '28P01';
  end;
  return m;
end $$;
revoke execute on function pins_master(text) from public, anon, authenticated;

-- první nastavení: správce si zvolí heslo, vznikne hlavní klíč
create or replace function pins_setup(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m text;
begin
  if not can_write('users') then raise exception 'Jen správce.' using errcode = '42501'; end if;
  if exists (select 1 from pin_keys) then raise exception 'PINy už jsou nastavené.' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Heslo k PINům musí mít aspoň 6 znaků.'; end if;
  m := encode(gen_random_bytes(32), 'hex');
  insert into pin_keys (user_id, wrapped, granted_by) values (auth.uid(), pgp_sym_encrypt(m, p_password), auth.uid());
  insert into pin_log (user_id, action) values (auth.uid(), 'setup');
end $$;

-- správce dá přístup dalšímu uživateli a nastaví mu počáteční heslo (uživatel si ho pak změní)
create or replace function pins_grant(p_my_password text, p_user uuid, p_their_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m text;
begin
  if not can_write('users') then raise exception 'Jen správce.' using errcode = '42501'; end if;
  if length(coalesce(p_their_password, '')) < 6 then raise exception 'Heslo k PINům musí mít aspoň 6 znaků.'; end if;
  m := pins_master(p_my_password);
  insert into pin_keys (user_id, wrapped, granted_by) values (p_user, pgp_sym_encrypt(m, p_their_password), auth.uid())
  on conflict (user_id) do update set wrapped = excluded.wrapped, granted_by = excluded.granted_by, created_at = now();
  insert into pin_log (user_id, action) values (p_user, 'grant');
end $$;

create or replace function pins_revoke(p_user uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not can_write('users') then raise exception 'Jen správce.' using errcode = '42501'; end if;
  if p_user = auth.uid() and (select count(*) from pin_keys) = 1 then raise exception 'Nelze zrušit poslední přístup k PINům.'; end if;
  delete from pin_keys where user_id = p_user;
  insert into pin_log (user_id, action) values (p_user, 'revoke');
end $$;

create or replace function pins_change_password(p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m text;
begin
  if length(coalesce(p_new, '')) < 6 then raise exception 'Heslo k PINům musí mít aspoň 6 znaků.'; end if;
  m := pins_master(p_old);
  update pin_keys set wrapped = pgp_sym_encrypt(m, p_new) where user_id = auth.uid();
  insert into pin_log (user_id, action) values (auth.uid(), 'change');
end $$;

create or replace function pins_set(p_card uuid, p_pin text, p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare m text;
begin
  if not can_write('cars') then raise exception 'Nemáte oprávnění upravovat auta.' using errcode = '42501'; end if;
  m := pins_master(p_password);
  update car_cards set pin_enc = case when coalesce(p_pin, '') = '' then null else pgp_sym_encrypt(p_pin, m) end where id = p_card;
  insert into pin_log (user_id, card_id, action) values (auth.uid(), p_card, 'set');
end $$;

create or replace function pins_reveal(p_card uuid, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare m text; e bytea; pin text;
begin
  m := pins_master(p_password);
  select pin_enc into e from car_cards where id = p_card;
  if e is null then return null; end if;
  pin := pgp_sym_decrypt(e, m);
  insert into pin_log (user_id, card_id, action) values (auth.uid(), p_card, 'reveal');
  return pin;
end $$;

-- stav: kdo má přístup k PINům a jestli je nastaveno
create or replace function pins_status() returns table (configured boolean, has_key boolean)
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from pin_keys), exists (select 1 from pin_keys where user_id = auth.uid())
$$;
grant execute on function pins_setup(text), pins_grant(text, uuid, text), pins_revoke(uuid), pins_change_password(text, text), pins_set(uuid, text, text), pins_reveal(uuid, text), pins_status() to authenticated;

-- Storage: bucket car-files (privátní), čtení podle práva Auta, zápis podle práva Auta
insert into storage.buckets (id, name, public, file_size_limit) values ('car-files', 'car-files', false, 26214400) on conflict (id) do nothing;
create policy "car-files r" on storage.objects for select using (bucket_id = 'car-files' and can_read('cars'));
create policy "car-files w" on storage.objects for insert with check (bucket_id = 'car-files' and can_write('cars'));
create policy "car-files u" on storage.objects for update using (bucket_id = 'car-files' and can_write('cars'));
create policy "car-files d" on storage.objects for delete using (bucket_id = 'car-files' and can_write('cars'));
