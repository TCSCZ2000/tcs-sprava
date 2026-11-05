-- JTi přepravy a řady čísel reportů
-- 1) Číslo reportu dává TCS CZ, v řadách: TCS (NL + DE společně), JTi AGS, JTi CZ, JTi SK. Unikátní je (řada, číslo).
-- 2) A-reference (A12345) je od TCS NL/DE; JTi ji nemá, má jen referenci zákazníka (volný text), u opakujících se tras výchozí z trasy.
-- 3) Ceník: každá trasa patří zákazníkovi (filtr), cena a sazby mají měnu (EUR/CZK). U přeprav je v pevné ceně X h zdarma na nakládku
--    (od objednaného času do naložení) a Y h na vykládku (od příjezdu na vykládku do vyložení); přesah po započatých čtvrthodinách × sazba.

alter table customers add column report_series text;
update customers set name = 'JTi AGS' where name = 'JTi';
update customers set report_series = case when name in ('TCS NL', 'TCS DE') then 'TCS' when name = 'JTi AGS' then 'JTI-AGS' when name = 'JTi CZ' then 'JTI-CZ' when name = 'JTi SK' then 'JTI-SK' else upper(replace(name, ' ', '-')) end;
alter table customers alter column report_series set not null;

alter table trips add column report_series text;
alter table trips add column customer_ref text;
update trips t set report_series = c.report_series from customers c where c.name = t.customer;
create or replace function trips_set_series() returns trigger language plpgsql as $$
begin
  new.report_series := (select report_series from customers where name = new.customer);
  return new;
end $$;
create trigger trips_set_series before insert or update of customer on trips for each row execute function trips_set_series();
drop index if exists trips_report_no;
create unique index trips_report_no on trips (report_series, report_no) where report_no is not null;
-- KH → JTi Trier dostala omylem číslo z řady TCS
update trips set report_no = null where report_no = 13602 and customer = 'JTi AGS';

alter table routes add column customer text references customers on update cascade on delete set null;
alter table routes add column currency text not null default 'EUR' check (currency in ('EUR', 'CZK'));
alter table routes add column customer_ref text;   -- výchozí reference zákazníka (opakující se)
alter table route_prices add column currency text not null default 'EUR' check (currency in ('EUR', 'CZK'));
alter table route_prices add column free_load_h numeric(5,2);    -- přeprava: hodin zdarma na nakládku
alter table route_prices add column free_unload_h numeric(5,2);  -- přeprava: hodin zdarma na vykládku
-- dnešní ceník je TCS NL, až na trasy, po kterých jezdí jiný zákazník
update routes r set customer = 'TCS NL';
update routes r set customer = x.customer from (
  select distinct on (t.route_id) t.route_id, t.customer from trips t where t.route_id is not null and t.customer is not null order by t.route_id, t.trip_date desc
) x where x.route_id = r.id;
update routes r set customer = x.customer, currency = case when x.customer like 'JTi%' then 'CZK' else r.currency end from (
  select distinct on (r2.id) r2.id, t.customer from routes r2 join trips t on t.pup_id = r2.pup_id and t.dop_id = r2.dop_id and t.customer like 'JTi%' order by r2.id, t.trip_date desc
) x where x.id = r.id and r.customer = 'TCS NL';
update route_prices p set currency = r.currency from routes r where r.id = p.route_id;

-- oprávnění po sloupcích: reference zákazníka jako A-reference
create or replace function trips_check_columns() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status is distinct from old.status then
    if not (can_write('planning_status')
            or (can_write('reports') and old.status in ('Report', 'Finished') and new.status in ('Report', 'Finished', 'Departed'))) then
      raise exception 'Nemáte oprávnění měnit status.' using errcode = '42501';
    end if;
  end if;
  if (new.ref_tcs, new.customer_ref) is distinct from (old.ref_tcs, old.customer_ref)
     and not (can_write('planning_status') or can_write('reports')) then
    raise exception 'Nemáte oprávnění měnit referenci.' using errcode = '42501';
  end if;
  if (new.guard1_id, new.guard2_id, new.guard3_id, new.car_id, new.car_origin, new.car_origin_other)
     is distinct from (old.guard1_id, old.guard2_id, old.guard3_id, old.car_id, old.car_origin, old.car_origin_other)
     and not can_write('planning_crew') then
    raise exception 'Nemáte oprávnění měnit posádku a auto.' using errcode = '42501';
  end if;
  if (new.guard1_supplier, new.guard2_supplier, new.guard3_supplier, new.car_supplier, new.supplier_km, new.supplier_toll)
     is distinct from (old.guard1_supplier, old.guard2_supplier, old.guard3_supplier, old.car_supplier, old.supplier_km, old.supplier_toll)
     and not (can_write('reports') or can_write('planning_crew')) then
    raise exception 'Nemáte oprávnění měnit dodavatele, jeho km a mýto.' using errcode = '42501';
  end if;
  if (new.trip_date, new.trip_time, new.pup_id, new.dop_id, new.customer, new.base_from, new.base_to, new.takeover, new.kind)
     is distinct from (old.trip_date, old.trip_time, old.pup_id, old.dop_id, old.customer, old.base_from, old.base_to, old.takeover, old.kind)
     and not can_write('planning_route') then
    raise exception 'Nemáte oprávnění měnit datum, čas, trasu a zákazníka.' using errcode = '42501';
  end if;
  if (new.dep_dop, new.start_at, new.home_at) is distinct from (old.dep_dop, old.start_at, old.home_at)
     and not (can_write('planning_route') or can_write('reports')) then
    raise exception 'Nemáte oprávnění měnit konec na Dop, start a návrat.' using errcode = '42501';
  end if;
  if (new.remarks, new.crew_change) is distinct from (old.remarks, old.crew_change)
     and not can_write('planning') then
    if new.remarks is distinct from old.remarks or not can_write('planning_crew') then
      raise exception 'Nemáte oprávnění měnit poznámky.' using errcode = '42501';
    end if;
  end if;
  if (new.report_no, new.dep_home, new.arr_pup, new.dep_pup, new.arr_dop, new.arr_home,
      new.km_pup, new.km_dop, new.km_total, new.toll, new.hours_manual, new.report_note, new.report_done_at)
     is distinct from
     (old.report_no, old.dep_home, old.arr_pup, old.dep_pup, old.arr_dop, old.arr_home,
      old.km_pup, old.km_dop, old.km_total, old.toll, old.hours_manual, old.report_note, old.report_done_at)
     and not can_write('reports') then
    raise exception 'Nemáte oprávnění upravovat report.' using errcode = '42501';
  end if;
  return new;
end $$;

-- stejná trasa může mít ceník pro víc zákazníků
alter table routes drop constraint routes_key;
create unique index routes_key on routes (pup_id, dop_id, base_from, base_to, variant, stops, coalesce(customer, ''));
