-- Lidé: detail s doklady, automatické zkratky bez dvojek, rozlišení stejných jmen, úklid duplicit
-- Nahrazuje person_docs (jeden řádek na člověka s OP a pasem) tabulkou person_documents (jeden řádek na doklad, se souborem ve Storage).

-- ---------- zkratky ----------
-- short_name byl generovaný sloupec (1. písmeno jména + příjmení) → M. Rada pro oba Rady.
-- Nově: obyčejný sloupec, který přepočítává funkce people_short_names(): u stejného příjmení se vezme
-- tolik písmen jména, kolik je potřeba (Mat. Rada / Mir. Rada); u stejného jména i příjmení se přidá rozlišení (tag), nebo pořadové číslo.
-- Zkratku jde přepnout na ruční (short_name_auto = false).
alter table people drop column short_name;
alter table people add column short_name text not null default '';
alter table people add column short_name_auto boolean not null default true;
alter table people add column tag text not null default '';          -- rozlišení pro stejná jména (město, ročník…)
alter table people add column email text;
create index on people (short_name);

create or replace function people_short_names() returns void language plpgsql security definer set search_path = public as $$
declare g record; k int; cnt int;
begin
  for g in select lower(last_name) ln, count(*) c, count(distinct lower(first_name)) dn, max(length(first_name)) ml from people group by lower(last_name) loop
    k := 1;
    if g.c > 1 then
      -- tolik písmen jména, aby se různá jména lišila (stejná jména dostanou rozlišení v závorce)
      loop
        select count(distinct lower(left(first_name, k))) into cnt from people where lower(last_name) = g.ln;
        exit when cnt = g.dn or k >= g.ml;
        k := k + 1;
      end loop;
      if k > 1 then k := least(greatest(k, 3), g.ml); end if;   -- Mat. Rada / Mir. Rada, ne Ma. / Mi.
    end if;
    update people p set short_name = y.s from (
      select id, left(first_name, k) || '. ' || last_name || case when dup > 1 and (rn > 1 or tag <> '') then ' (' || coalesce(nullif(tag, ''), rn::text) || ')' else '' end s
      from (select id, first_name, last_name, tag,
                   count(*) over (partition by lower(left(first_name, k))) dup,
                   row_number() over (partition by lower(left(first_name, k)) order by (phone is null), id) rn
            from people where lower(last_name) = g.ln) x
    ) y where p.id = y.id and p.short_name_auto and p.short_name is distinct from y.s;
  end loop;
end $$;

create or replace function people_short_names_trg() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() < 2 then perform people_short_names(); end if;
  return null;
end $$;
create trigger people_short_names_aiud after insert or update of first_name, last_name, tag, short_name_auto or delete on people
  for each statement execute function people_short_names_trg();

-- ---------- úklid duplicit ----------
-- Michal Kováčik dvakrát (druhý záznam prázdný, bez cest)
delete from people where id = 'a9263a57-a99e-43d6-a2e3-2c91d6763d51'
  and not exists (select 1 from trips where guard1_id = 'a9263a57-a99e-43d6-a2e3-2c91d6763d51' or guard2_id = 'a9263a57-a99e-43d6-a2e3-2c91d6763d51' or guard3_id = 'a9263a57-a99e-43d6-a2e3-2c91d6763d51');
-- „Rada2“ a „Machacek2“ byly obezličky v Excelu
update people set last_name = 'Rada' where last_name = 'Rada2';
update people set last_name = 'Machacek', tag = '2' where last_name = 'Machacek2';
select people_short_names();

-- ---------- doklady ----------
create table person_doc_kinds (key text primary key, label text not null, sort int not null default 10, expires boolean not null default true, numbered boolean not null default true);
insert into person_doc_kinds values
  ('op', 'Občanský průkaz', 1, true, true), ('pas', 'Cestovní pas', 2, true, true), ('rp', 'Řidičský průkaz', 3, true, true),
  ('strazny', 'Osvědčení strážného', 4, true, true), ('zbrojni', 'Zbrojní průkaz', 5, true, true), ('dpp', 'Smlouva / DPP', 6, false, false),
  ('foto', 'Fotografie', 7, false, false), ('jine', 'Jiný doklad', 8, true, true), ('nezarazeno', 'Nezařazeno', 99, false, false);

create table person_documents (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references people on delete cascade,
  kind        text not null default 'nezarazeno' references person_doc_kinds,
  name        text,                 -- název u „jiný doklad“, jinak volitelný popis
  number      text,
  valid_to    date,
  path        text unique,          -- soubor v bucketu people-files (může chybět, když je jen číslo)
  file_name   text,
  mime        text,
  size        int,
  source      text,                 -- 'drive' = přenesené z Google Drive, null = nahrané v aplikaci
  source_ref  text,                 -- id souboru na Drive
  status      text check (status in ('navrzeno', 'potvrzeno')),   -- navrzeno = typ/číslo/platnost navrhl Claude, čeká na potvrzení
  note        text,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index on person_documents (person_id);
create trigger person_documents_bu before update on person_documents for each row execute function touch();

-- převod starých OP a pasů (jen čísla, bez souboru)
insert into person_documents (person_id, kind, number, valid_to, status)
  select person_id, 'op', id_number, id_valid_to, 'potvrzeno' from person_docs where id_number is not null or id_valid_to is not null;
insert into person_documents (person_id, kind, number, valid_to, status)
  select person_id, 'pas', passport_number, passport_valid_to, 'potvrzeno' from person_docs where passport_number is not null or passport_valid_to is not null;
drop table person_docs;

alter table person_doc_kinds enable row level security;
alter table person_documents enable row level security;
create policy "druhy dokladu r" on person_doc_kinds for select using (auth.uid() is not null);
create policy "doklady r" on person_documents for select using (can_read('people_docs'));
create policy "doklady w" on person_documents for all using (can_write('people_docs')) with check (can_write('people_docs'));

insert into storage.buckets (id, name, public, file_size_limit) values ('people-files', 'people-files', false, 26214400) on conflict (id) do nothing;
create policy "people-files r" on storage.objects for select using (bucket_id = 'people-files' and can_read('people_docs'));
create policy "people-files w" on storage.objects for insert with check (bucket_id = 'people-files' and can_write('people_docs'));
create policy "people-files u" on storage.objects for update using (bucket_id = 'people-files' and can_write('people_docs'));
create policy "people-files d" on storage.objects for delete using (bucket_id = 'people-files' and can_write('people_docs'));

-- ---------- přenos z Google Drive ----------
-- Mapa složek „Doklady/<Příjmení Jméno>“ na lidi; plní se z analýzy, aplikace ji použije při importu ze složky.
-- person_id null = člověk v databázi není, import ho založí (neaktivního) podle first_name/last_name.
create table drive_folders (
  folder_name text primary key,
  person_id   uuid references people on delete set null,
  first_name  text,
  last_name   text,
  imported_at timestamptz
);
alter table drive_folders enable row level security;
create policy "drive_folders r" on drive_folders for select using (can_read('people_docs'));
create policy "drive_folders w" on drive_folders for all using (can_write('people_docs')) with check (can_write('people_docs'));

alter publication supabase_realtime add table person_documents;

-- práva pro přihlášené (RLS je výše)
grant select, insert, update, delete on person_documents, drive_folders to authenticated;
grant select on person_doc_kinds to authenticated;
