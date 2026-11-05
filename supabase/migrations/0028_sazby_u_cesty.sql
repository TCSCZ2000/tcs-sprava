-- Sazby upravené pro konkrétní cestu (třeba nižší u zrušené); null = podle trasy / zákazníka
alter table trips add column rate_h numeric, add column rate_km numeric;
create or replace function trips_check_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.route_price_id, new.price_manual, new.route_id, new.rate_h, new.rate_km) is distinct from (old.route_price_id, old.price_manual, old.route_id, old.rate_h, old.rate_km)
     and not (can_write('reports') or can_write('routes') or can_write('planning_route')) then
    raise exception 'Nemáte oprávnění měnit cenu a variantu trasy.' using errcode = '42501';
  end if;
  if new.combi is distinct from old.combi and not (can_write('reports') or can_write('hours')) then
    raise exception 'Nemáte oprávnění měnit navazování cest.' using errcode = '42501';
  end if;
  return new;
end $$;
