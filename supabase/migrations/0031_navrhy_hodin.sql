-- Domluvené hodiny ke schválení: kdo má právo „Hodiny – návrhy“, zadá hodiny navíc (vyzvednutí auta, auto do servisu…) jako navržené,
-- správce hodin je schválí nebo zamítne; do součtů jdou až schválené. Navrhující vidí jen své návrhy.
insert into modules values ('hours_propose', 'Hodiny – návrhy', 19) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','hours_propose','write'), ('dispatcher','hours_propose','write'), ('viewer','hours_propose','none'), ('custom','hours_propose','none')
on conflict do nothing;

alter table hours_extra drop constraint if exists hours_extra_kind_check;
alter table hours_extra add constraint hours_extra_kind_check check (kind in ('mimo', 'pevne', 'vyzvednuti', 'servis', 'cekani'));
alter table hours_extra
  add column status      text not null default 'schvaleno' check (status in ('navrzeno', 'schvaleno', 'zamitnuto')),
  add column trip_id     uuid references trips on delete set null,
  add column approved_by uuid,
  add column approved_at timestamptz,
  add column decision_note text;   -- důvod zamítnutí / poznámka schvalovatele

-- Kdo nemá právo Hodiny (zápis), může jen navrhovat: záznam je vždy „navrženo“ a nejde mu měnit schválení
create or replace function hours_extra_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if not can_write('hours') then
    if tg_op = 'INSERT' then new.status := 'navrzeno'; new.approved_by := null; new.approved_at := null; new.decision_note := null;
    else
      if old.status <> 'navrzeno' then raise exception 'Schválený návrh už nejde měnit.' using errcode = '42501'; end if;
      new.status := 'navrzeno'; new.approved_by := null; new.approved_at := null; new.decision_note := old.decision_note;
    end if;
  elsif new.status in ('schvaleno', 'zamitnuto') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.approved_by := auth.uid(); new.approved_at := now();
  end if;
  return new;
end $$;
create trigger hours_extra_biu before insert or update on hours_extra for each row execute function hours_extra_guard();

drop policy if exists "hodiny r" on hours_extra;
drop policy if exists "hodiny w" on hours_extra;
create policy "hodiny r" on hours_extra for select using (can_read('hours') or (can_write('hours_propose') and created_by = auth.uid()));
create policy "hodiny w" on hours_extra for all
  using (can_write('hours') or (can_write('hours_propose') and created_by = auth.uid() and status = 'navrzeno'))
  with check (can_write('hours') or (can_write('hours_propose') and created_by = auth.uid()));
