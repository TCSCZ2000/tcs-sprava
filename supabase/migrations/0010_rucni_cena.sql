-- Ruční cena cesty (domluva se zákazníkem) – přebije sazby i pevnou cenu
alter table trips add column if not exists price_manual numeric(10,2);

create or replace function trips_check_price() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and (new.route_price_id, new.price_manual) is distinct from (old.route_price_id, old.price_manual)
     and not (can_write('reports') or can_write('routes')) then
    raise exception 'Nemáte oprávnění měnit cenu cesty.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function trips_check_price() from public, anon, authenticated;
