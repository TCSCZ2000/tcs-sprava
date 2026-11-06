-- Střídání posádky během cesty + příplatek k ceně.
-- trip_crew: u konkrétního člověka na cestě vlastní od–do (nebo hodiny), auto a km, dodavatel; i člověk, který v Planningu u cesty není (náhradník).
-- Hodiny lidí se počítají z těchto údajů, cena pro zákazníka se nemění.
create table trip_crew (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips on delete cascade,
  person_id  uuid not null references people on delete cascade,
  start_at   timestamp,                 -- odjezd z domova toho člověka; prázdné = jako cesta
  end_at     timestamp,                 -- příjezd domů toho člověka; prázdné = jako cesta
  hours      numeric(6,2),              -- hodiny ručně (přebijí od–do)
  car_id     uuid references cars on delete set null,
  km         int,
  supplier   text references suppliers (name) on update cascade on delete set null,
  note       text,                      -- třeba „vystřídán v Liège, přijel autem 4SR7052“
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (trip_id, person_id)
);
create index on trip_crew (trip_id);
create trigger trip_crew_bu before update on trip_crew for each row execute function touch();
alter table trip_crew enable row level security;
create policy "stridani r" on trip_crew for select using (can_read('planning') or can_read('reports') or can_read('hours'));
create policy "stridani w" on trip_crew for all using (can_write('planning_crew') or can_write('reports')) with check (can_write('planning_crew') or can_write('reports'));
grant select, insert, update, delete on trip_crew to authenticated;
alter publication supabase_realtime add table trip_crew;

-- Příplatek k ceně (třeba 100 € za cestu CZ posádky z NL jako kompenzace); přičítá se k ceně ze sazeb i k pevné ceně, ne k ruční částce
alter table trips add column extra_fee numeric(10,2), add column extra_note text;

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
      new.km_pup, new.km_dop, new.km_total, new.toll, new.hours_manual, new.report_note, new.report_done_at, new.extra_fee, new.extra_note)
     is distinct from
     (old.report_no, old.dep_home, old.arr_pup, old.dep_pup, old.arr_dop, old.arr_home,
      old.km_pup, old.km_dop, old.km_total, old.toll, old.hours_manual, old.report_note, old.report_done_at, old.extra_fee, old.extra_note)
     and not can_write('reports') then
    raise exception 'Nemáte oprávnění upravovat report.' using errcode = '42501';
  end if;
  return new;
end $$;
