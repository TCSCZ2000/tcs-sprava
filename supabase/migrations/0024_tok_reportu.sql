-- Tok reportu: Finished v Planningu = cesta spadne do Reportů; tam se dopíše a uzavře tlačítkem Hotovo (report_done_at);
-- hotová cesta zmizí z Planningu do Historie. Status „Report“ už není potřeba.
alter table trips add column report_done_at timestamptz;
-- cesty s kompletním reportem jsou hotové
update trips set report_done_at = updated_at where status = 'Finished' and report_no is not null and dep_home is not null and arr_home is not null;
update trips set status = 'Finished' where status = 'Report';
delete from statuses where name = 'Report';

create or replace function trips_check_columns() returns trigger language plpgsql security definer set search_path = public as $$
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
