-- Základny: odkud posádka vyjíždí a kam se vrací (CZ, NL, Somaglia…). Nahrazuje zatržítko NL–NL.
create table bases (
  code text primary key,
  name text not null,
  sort int not null default 10,
  created_at timestamptz not null default now()
);
insert into bases values ('CZ', 'Česko (Praha / Příbram)', 1), ('NL', 'Nizozemsko', 2);

alter table bases enable row level security;
create policy "základny r" on bases for select using (auth.uid() is not null);
create policy "základny w" on bases for all using (can_write('places')) with check (can_write('places'));
grant select, insert, update, delete on bases to authenticated;
alter publication supabase_realtime add table bases;

-- CZ nejde smazat
create or replace function bases_guard() returns trigger language plpgsql as $$
begin
  if old.code = 'CZ' then raise exception 'Základnu CZ nelze smazat ani přejmenovat.' using errcode = '42501'; end if;
  return old;
end $$;
create trigger bases_bd before delete on bases for each row execute function bases_guard();

-- cesty
alter table trips
  add column base_from text not null default 'CZ' references bases on update cascade,
  add column base_to   text not null default 'CZ' references bases on update cascade;
update trips set base_from = home_base, base_to = home_base where home_base <> 'CZ';
alter table trips drop column home_base;

-- trasy
alter table routes
  add column base_from text not null default 'CZ' references bases on update cascade,
  add column base_to   text not null default 'CZ' references bases on update cascade;
update routes set base_from = home_base, base_to = home_base where home_base <> 'CZ';
alter table routes drop constraint routes_pup_dop_base_key;
alter table routes drop constraint routes_home_base_check;
alter table routes drop column home_base;
alter table routes add constraint routes_pup_dop_bases_key unique (pup_id, dop_id, base_from, base_to);

drop function route_times();
create function route_times()
returns table (pup_id uuid, dop_id uuid, ho_pup_h numeric, dop_ho_h numeric, base_from text, base_to text)
language sql stable security definer set search_path = public as $$
  select r.pup_id, r.dop_id, r.ho_pup_h, r.dop_ho_h, r.base_from, r.base_to
  from routes r where can_read('planning')
$$;
grant execute on function route_times() to authenticated;

create or replace function trips_check_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status is distinct from old.status then
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
  if (new.trip_date, new.trip_time, new.pup_id, new.dop_id, new.customer, new.base_from, new.base_to, new.takeover)
     is distinct from (old.trip_date, old.trip_time, old.pup_id, old.dop_id, old.customer, old.base_from, old.base_to, old.takeover)
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
      new.km_pup, new.km_dop, new.km_total, new.toll, new.hours_manual, new.report_note)
     is distinct from
     (old.report_no, old.dep_home, old.arr_pup, old.dep_pup, old.arr_dop, old.arr_home,
      old.km_pup, old.km_dop, old.km_total, old.toll, old.hours_manual, old.report_note)
     and not can_write('reports') then
    raise exception 'Nemáte oprávnění upravovat report.' using errcode = '42501';
  end if;
  return new;
end $$;
