-- Půjčená auta: čísla podle půjčovny (Sixt1, S-Car2 …), stavy Objednáno / Půjčeno / Vráceno, auto může být zatím bez SPZ

alter table cars add column if not exists created_at timestamptz not null default now();
alter table cars alter column plate drop not null;

-- Popisek auta i bez SPZ: „Sixt1“, s SPZ „1ABT698, Skoda Octavia Grey, Sixt1“
alter table cars drop column label;
alter table cars add column label text generated always as (
  coalesce(plate, car_no, '?')
  || coalesce(', ' || nullif(trim(coalesce(model, '') || ' ' || coalesce(color, '')), ''), '')
  || case when plate is not null and car_no is not null then ', ' || car_no else '' end
) stored;

create or replace function renumber_cars() returns void
language plpgsql security definer set search_path = public as $$
declare r record; n int;
begin
  -- naše auta: TCS, pak Manažerská, podle SPZ
  with own as (
    select c.id, row_number() over (order by k.sort, c.plate) as n
      from cars c join car_categories k on k.name = c.car_category
     where k.kind = 'own' and coalesce(c.state, 'Aktivní') in ('Aktivní', 'V opravě', 'K prodeji')
  )
  update cars c set car_no = '#' || lpad(own.n::text, 2, '0')
    from own where own.id = c.id and c.car_no is distinct from '#' || lpad(own.n::text, 2, '0');
  update cars c set car_no = null
    from car_categories k
   where k.name = c.car_category and k.kind = 'own'
     and coalesce(c.state, 'Aktivní') not in ('Aktivní', 'V opravě', 'K prodeji') and c.car_no is not null;

  -- půjčená: vrácené auto si číslo nechá jako popis, ale číslo se uvolní pro další objednávku

  -- půjčená bez platného čísla dostanou nejnižší volné číslo své půjčovny
  for r in
    select c.id, c.car_category as cat
      from cars c join car_categories k on k.name = c.car_category
     where k.kind = 'rental' and coalesce(c.state, 'Objednáno') in ('Objednáno', 'Půjčeno')
       and (c.car_no is null or left(c.car_no, length(c.car_category)) <> c.car_category
            or substr(c.car_no, length(c.car_category) + 1) !~ '^[0-9]+$'
            or exists (select 1 from cars d where d.id <> c.id and d.car_no = c.car_no and d.car_category = c.car_category
                         and coalesce(d.state, 'Objednáno') in ('Objednáno', 'Půjčeno') and d.created_at < c.created_at))
     order by c.created_at
  loop
    select min(g) into n from generate_series(1, 999) g
     where not exists (
       select 1 from cars x
        where x.car_category = r.cat and x.id <> r.id and coalesce(x.state, 'Objednáno') in ('Objednáno', 'Půjčeno')
          and x.car_no = r.cat || g);
    update cars set car_no = r.cat || n where id = r.id;
  end loop;
end $$;
revoke execute on function renumber_cars() from public, anon, authenticated;

-- nové auto z půjčovny je ve výchozím stavu Objednáno
create or replace function cars_default_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.state is null or new.state = 'Aktivní' then
    if exists (select 1 from car_categories where name = new.car_category and kind = 'rental') then
      new.state := 'Objednáno';
    end if;
  end if;
  return new;
end $$;
revoke execute on function cars_default_state() from public, anon, authenticated;
drop trigger if exists cars_state_default on cars;
create trigger cars_state_default before insert on cars for each row execute function cars_default_state();

select renumber_cars();
