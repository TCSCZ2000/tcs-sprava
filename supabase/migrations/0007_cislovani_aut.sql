-- Automatické číslování našich aut: podle pořadí kategorie (TCS, pak Manažerská) a SPZ
-- Číslo mají auta Aktivní, V opravě a K prodeji; prodaná a vrácená číslo ztratí.
-- Půjčená a osobní auta řidičů se nečíslují (číslo zůstává, jak ho kdo napíše).

update car_categories set sort = sort + 1 where sort >= 2;
insert into car_categories values ('Manažerská', 'own', 2, true) on conflict (name) do nothing;
update cars set car_category = 'Manažerská' where plate in ('5SY9411', '7SE2166');

create or replace function renumber_cars() returns void
language sql security definer set search_path = public as $$
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
$$;
revoke execute on function renumber_cars() from public, anon, authenticated;

create or replace function cars_renumber_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform renumber_cars(); return null; end $$;
revoke execute on function cars_renumber_trigger() from public, anon, authenticated;

create trigger cars_renumber after insert or delete or update of plate, state, car_category on cars
  for each statement execute function cars_renumber_trigger();
create trigger categories_renumber after insert or delete or update of sort, kind on car_categories
  for each statement execute function cars_renumber_trigger();

select renumber_cars();
