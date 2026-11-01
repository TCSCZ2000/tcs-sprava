-- Zákazníci u cest, status Report a záložka Reporty

create table customers (
  name  text primary key,
  sort  int not null,
  active boolean not null default true
);
insert into customers values ('TCS NL', 1, true), ('TCS DE', 2, true), ('JTi', 3, true), ('JTi CZ', 4, true), ('JTi SK', 5, true);
alter table customers enable row level security;
create policy "zákazníci r" on customers for select using (auth.uid() is not null);
create policy "zákazníci w" on customers for all using (can_write('users')) with check (can_write('users'));
grant select, insert, update, delete on customers to authenticated;

alter table trips add column customer text references customers on update cascade;

-- Status Jti nahrazuje zákazník JTi
update trips set customer = 'JTi', status = 'Confirmed' where status = 'Jti';
delete from statuses where name = 'Jti';

-- Report: cesta odjetá, čeká na dopsání reportu (z Planningu zmizí)
insert into statuses values ('Report', '#595959', 7, true) on conflict (name) do nothing;
update statuses set sort = case name
  when 'HEADS-UP' then 1 when 'Confirmed' then 2 when 'Send' then 3 when 'Skupina ✅' then 4
  when 'On the road' then 5 when 'Departed' then 6 when 'Report' then 7 when 'Finished' then 8 when 'Canceled' then 9 else sort end;

-- Údaje reportu (jako list Reporty v měsíčním sešitu)
alter table trips
  add column report_no   int,
  add column dep_home    timestamp,
  add column arr_pup     timestamp,
  add column dep_pup     timestamp,
  add column arr_dop     timestamp,
  add column dep_dop     timestamp,
  add column arr_home    timestamp,
  add column km_pup      int,
  add column km_dop      int,
  add column km_total    int,
  add column toll        numeric(10,2),
  add column hours_manual numeric(6,2),
  add column report_note text;
create unique index trips_report_no on trips (report_no) where report_no is not null;

-- Práva: záložka Reporty
insert into modules values ('reports', 'Reporty', 16) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','reports','write'), ('dispatcher','reports','read'), ('viewer','reports','none'), ('custom','reports','none')
on conflict do nothing;

drop policy "cesty r" on trips;
create policy "cesty r" on trips for select using (can_read('planning') or can_read('podklad') or can_read('reports'));
drop policy "cesty update" on trips;
create policy "cesty update" on trips for update
  using (can_read('planning') or can_write('reports')) with check (can_read('planning') or can_write('reports'));

create or replace function trips_check_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status is distinct from old.status then
    -- v Reportech jde cestu uzavřít (Finished) nebo vrátit (Report) i bez práva na status v Planningu
    if not (can_write('planning_status')
            or (can_write('reports') and old.status in ('Report', 'Finished') and new.status in ('Report', 'Finished', 'Departed'))) then
      raise exception 'Nemáte oprávnění měnit status.' using errcode = '42501';
    end if;
  end if;
  if new.ref_tcs is distinct from old.ref_tcs
     and not (can_write('planning_status') or can_write('reports')) then
    raise exception 'Nemáte oprávnění měnit referenci.' using errcode = '42501';
  end if;
  if (new.guard1_id, new.guard2_id, new.guard3_id, new.car_id, new.car_origin, new.car_origin_other)
     is distinct from (old.guard1_id, old.guard2_id, old.guard3_id, old.car_id, old.car_origin, old.car_origin_other)
     and not can_write('planning_crew') then
    raise exception 'Nemáte oprávnění měnit posádku a auto.' using errcode = '42501';
  end if;
  if (new.trip_date, new.trip_time, new.pup_id, new.dop_id, new.customer) is distinct from (old.trip_date, old.trip_time, old.pup_id, old.dop_id, old.customer)
     and not can_write('planning_route') then
    raise exception 'Nemáte oprávnění měnit datum, čas, trasu a zákazníka.' using errcode = '42501';
  end if;
  if (new.remarks, new.crew_change) is distinct from (old.remarks, old.crew_change)
     and not can_write('planning') then
    if new.remarks is distinct from old.remarks or not can_write('planning_crew') then
      raise exception 'Nemáte oprávnění měnit poznámky.' using errcode = '42501';
    end if;
  end if;
  if (new.report_no, new.dep_home, new.arr_pup, new.dep_pup, new.arr_dop, new.dep_dop, new.arr_home,
      new.km_pup, new.km_dop, new.km_total, new.toll, new.hours_manual, new.report_note)
     is distinct from
     (old.report_no, old.dep_home, old.arr_pup, old.dep_pup, old.arr_dop, old.dep_dop, old.arr_home,
      old.km_pup, old.km_dop, old.km_total, old.toll, old.hours_manual, old.report_note)
     and not can_write('reports') then
    raise exception 'Nemáte oprávnění upravovat report.' using errcode = '42501';
  end if;
  return new;
end $$;
