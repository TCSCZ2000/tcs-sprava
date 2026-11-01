-- Role: Správce (vše), Náhled (jen čtení, vybrané části), Individuální (vše nastavitelné)

-- Podklad pro zákazníka jako samostatná část
insert into modules values ('podklad', 'Podklad pro zákazníka', 15) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','podklad','write'), ('dispatcher','podklad','read'), ('viewer','podklad','read'), ('custom','podklad','none')
on conflict do nothing;

-- Individuální: výchozí je všechno zakázané, práva jsou jen ve výjimkách
insert into role_defaults (role, module, level)
select 'custom', key, 'none' from modules
on conflict do nothing;

-- Dosavadní dispečery převést na Individuální se stejnými právy
insert into permissions (user_id, module, level)
select p.id, d.module, d.level from profiles p join role_defaults d on d.role = 'dispatcher'
where p.role = 'dispatcher'
on conflict (user_id, module) do nothing;
update profiles set role = 'custom' where role = 'dispatcher';
update invites set role = 'custom' where role = 'dispatcher';

-- Práva určená už v pozvánce
alter table invites add column if not exists perms jsonb not null default '{}'::jsonb;

-- Efektivní úroveň: Správce vždy vše, Náhled nejvýš čte
create or replace function perm(mod text) returns access_level
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case
              when not p.active then 'none'::access_level
              when p.role = 'admin' then 'write'::access_level
              when p.role = 'viewer' and coalesce(x.level, d.level) = 'write' then 'read'::access_level
              else coalesce(x.level, d.level, 'none')
            end
       from profiles p
       left join permissions x on x.user_id = p.id and x.module = mod
       left join role_defaults d on d.role = p.role and d.module = mod
      where p.id = auth.uid()),
    'none');
$$;

create or replace function apply_invite_perms(uid uuid, p jsonb) returns void
language sql security definer set search_path = public as $$
  delete from permissions where user_id = uid;
  insert into permissions (user_id, module, level)
  select uid, e.key, e.value::access_level
    from jsonb_each_text(p) e
   where e.key in (select key from modules) and e.value in ('none', 'read', 'write');
$$;
revoke execute on function apply_invite_perms(uuid, jsonb) from public, anon, authenticated;

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare i invites;
begin
  select * into i from invites where email = lower(new.email);
  if found then
    insert into profiles (id, email, full_name, role)
    values (new.id, lower(new.email), i.full_name, i.role)
    on conflict (id) do nothing;
    perform apply_invite_perms(new.id, i.perms);
  end if;
  return new;
end $$;

create or replace function invite_attach() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select u.id into uid from auth.users u where lower(u.email) = new.email;
  if uid is not null then
    insert into profiles (id, email, full_name, role)
    values (uid, new.email, new.full_name, new.role)
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, active = true;
    perform apply_invite_perms(uid, new.perms);
  end if;
  return new;
end $$;
-- jen při založení pozvánky; pozdější úpravy práv se dělají u uživatele
drop trigger if exists on_invite on invites;
create trigger on_invite after insert on invites
  for each row execute function invite_attach();

-- Podklad smí číst cesty i bez Planningu
drop policy "cesty r" on trips;
create policy "cesty r" on trips for select using (can_read('planning') or can_read('podklad'));
drop policy "lidé r" on people;
create policy "lidé r" on people for select using (can_read('people') or can_read('planning') or can_read('podklad'));
drop policy "auta r" on cars;
create policy "auta r" on cars for select using (can_read('cars') or can_read('planning') or can_read('podklad'));
drop policy "místa r" on places;
create policy "místa r" on places for select using (can_read('places') or can_read('planning') or can_read('podklad'));
