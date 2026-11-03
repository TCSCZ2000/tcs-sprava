-- Varianty trasy: stejný Pup, Dop i základny, jiné parametry (přes Francii / Švýcarsko / Rakousko)
alter table routes add column variant text not null default '';
alter table routes drop constraint routes_pup_dop_bases_key;
alter table routes add constraint routes_pup_dop_bases_variant_key unique (pup_id, dop_id, base_from, base_to, variant);

-- u cesty zvolená varianta (prázdné = základní varianta bez názvu, nebo jediná existující)
alter table trips add column route_id uuid references routes on delete set null;

drop function route_times();
create function route_times()
returns table (id uuid, pup_id uuid, dop_id uuid, ho_pup_h numeric, dop_ho_h numeric, base_from text, base_to text, variant text)
language sql stable security definer set search_path = public as $$
  select r.id, r.pup_id, r.dop_id, r.ho_pup_h, r.dop_ho_h, r.base_from, r.base_to, r.variant
  from routes r where can_read('planning')
$$;
grant execute on function route_times() to authenticated;

create or replace function trips_check_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.route_price_id, new.price_manual, new.route_id) is distinct from (old.route_price_id, old.price_manual, old.route_id)
     and not (can_write('reports') or can_write('routes') or can_write('planning_route')) then
    raise exception 'Nemáte oprávnění měnit cenu a variantu trasy.' using errcode = '42501';
  end if;
  if new.combi is distinct from old.combi and not (can_write('reports') or can_write('hours')) then
    raise exception 'Nemáte oprávnění měnit navazování cest.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function trips_check_price() from public, anon, authenticated;
