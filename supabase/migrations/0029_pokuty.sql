-- Pokuty: dávky (převzaté obálky / datovka), jednotlivé pokuty s párováním na auto, cestu a posádku, stav vyřízení a potvrzení.
-- Čtení dokumentů dělá serverová funkce fines-parse (Claude), výsledek je „navrženo“, člověk potvrdí.
insert into modules values ('fines', 'Pokuty', 22) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','fines','write'), ('dispatcher','fines','read'), ('viewer','fines','none'), ('custom','fines','none')
on conflict do nothing;

create table fine_batches (
  id          uuid primary key default gen_random_uuid(),
  received_on date not null default current_date,      -- kdy Štěpán převzal
  channel     text not null default 'posta' check (channel in ('posta', 'datovka', 'jine')),
  handed_to   text default 'SEMS',                       -- komu předáno
  handed_on   date,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

create table fines (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid references fine_batches on delete set null,
  status        text not null default 'nova' check (status in ('nova', 'predano', 'zaplaceno', 'ridic_nahlasen', 'odvolani', 'uzavreno', 'neni_pokuta')),
  country       text,                 -- DE, FR, BE, NL, AT, CH, IT, ES, PL, CZ…
  authority     text,
  case_no       text,
  offense_at    timestamptz,
  place         text,
  plate         text,
  car_id        uuid references cars on delete set null,
  trip_id       uuid references trips on delete set null,
  person_id     uuid references people on delete set null,   -- kdo řídil / koho SEMS nahlásil
  offense       text,                 -- druh: rychlost +23 km/h, mýto, parkování…
  amount        numeric,
  currency      text default 'EUR',
  due_pay       date,                 -- lhůta zaplacení
  due_driver    date,                 -- lhůta nahlášení řidiče
  payment_iban  text,
  payment_ref   text,
  phase         text check (phase in ('doprovod', 'presun', 'mimo')),   -- během doprovodu / při přesunu / mimo cestu (podle reportu)
  liability     text check (liability in ('TCS', 'SEMS')),              -- k tíži
  paid_on       date,
  paid_amount   numeric,
  paid_ok       boolean,              -- potvrzení sedí (částka, reference, včas)
  driver_reported_on date,
  reported_ok   boolean,
  parse_status  text check (parse_status in ('navrzeno', 'potvrzeno')),
  parsed        jsonb,                -- surový výstup čtení
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid default auth.uid()
);
create index on fines (batch_id);
create index on fines (car_id);
create index on fines (status);
create trigger fines_bu before update on fines for each row execute function touch();

create table fine_files (
  id          uuid primary key default gen_random_uuid(),
  fine_id     uuid references fines on delete cascade,
  batch_id    uuid references fine_batches on delete cascade,
  kind        text not null default 'pokuta' check (kind in ('sken', 'pokuta', 'platba', 'nahlaseni', 'jine')),  -- sken = celý soubor z dávky před rozdělením
  path        text not null unique,
  file_name   text,
  mime        text,
  size        int,
  pages       text,                   -- rozsah stránek v původním skenu, třeba 3-4
  parsed      jsonb,
  parse_note  text,                   -- výsledek kontroly potvrzení (sedí / nesedí částka…)
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid default auth.uid()
);
create index on fine_files (fine_id);
create index on fine_files (batch_id);

alter table fine_batches enable row level security;
alter table fines enable row level security;
alter table fine_files enable row level security;
create policy "davky r" on fine_batches for select using (can_read('fines'));
create policy "davky w" on fine_batches for all using (can_write('fines')) with check (can_write('fines'));
create policy "pokuty r" on fines for select using (can_read('fines'));
create policy "pokuty w" on fines for all using (can_write('fines')) with check (can_write('fines'));
create policy "pokuty soubory r" on fine_files for select using (can_read('fines'));
create policy "pokuty soubory w" on fine_files for all using (can_write('fines')) with check (can_write('fines'));
grant select, insert, update, delete on fine_batches, fines, fine_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit) values ('fines', 'fines', false, 52428800) on conflict (id) do nothing;
create policy "fines r" on storage.objects for select using (bucket_id = 'fines' and can_read('fines'));
create policy "fines w" on storage.objects for insert with check (bucket_id = 'fines' and can_write('fines'));
create policy "fines u" on storage.objects for update using (bucket_id = 'fines' and can_write('fines'));
create policy "fines d" on storage.objects for delete using (bucket_id = 'fines' and can_write('fines'));

alter publication supabase_realtime add table fines, fine_files, fine_batches;

-- Párování: cesty auta kolem času přestupku (±2 dny), s fází podle reportu
create or replace function fine_candidates(p_car uuid, p_at timestamptz) returns table (
  trip_id uuid, trip_date date, report_no int, customer text, pup text, dop text, guard1 text, guard2 text,
  dep_home timestamp, arr_pup timestamp, dep_dop timestamp, arr_home timestamp, phase text
) language sql stable security definer set search_path = public as $$
  select t.id, t.trip_date, t.report_no, t.customer, pp.name, dd.name, g1.short_name, g2.short_name,
         t.dep_home, t.arr_pup, t.dep_dop, t.arr_home,
         case when t.dep_home is not null and t.arr_home is not null and p_at between t.dep_home::timestamptz and t.arr_home::timestamptz then
                case when t.arr_pup is not null and t.dep_dop is not null and p_at between t.arr_pup::timestamptz and t.dep_dop::timestamptz then 'doprovod' else 'presun' end
              else null end
  from trips t
  left join places pp on pp.id = t.pup_id left join places dd on dd.id = t.dop_id
  left join people g1 on g1.id = t.guard1_id left join people g2 on g2.id = t.guard2_id
  where can_read('fines') and t.car_id = p_car and t.status <> 'Canceled'
    and t.trip_date between (p_at - interval '3 days')::date and (p_at + interval '1 day')::date
  order by abs(extract(epoch from (coalesce(t.dep_home, t.trip_date::timestamp)::timestamptz - p_at)))
$$;
