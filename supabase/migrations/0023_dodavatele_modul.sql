-- Dodavatelé jako samostatný modul: firemní údaje, kontaktní osoby, vlastní oprávnění. TCS není dodavatel.
alter table suppliers add column ico text, add column dic text, add column address text, add column email text, add column phone text, add column web text,
  add column payment_terms text, add column updated_at timestamptz not null default now(), add column updated_by uuid default auth.uid();
create trigger suppliers_bu before update on suppliers for each row execute function touch();

create table supplier_contacts (
  id          uuid primary key default gen_random_uuid(),
  supplier    text not null references suppliers on delete cascade,
  name        text not null,
  role        text,
  phone       text,
  email       text,
  note        text,
  sort        int not null default 10
);
create index on supplier_contacts (supplier);

-- TCS pryč: lidé bez dodavatele mají null
update people set supplier = null where supplier = 'TCS';
update trips set guard1_supplier = null where guard1_supplier = 'TCS';
update trips set guard2_supplier = null where guard2_supplier = 'TCS';
update trips set guard3_supplier = null where guard3_supplier = 'TCS';
update trips set car_supplier = null where car_supplier = 'TCS';
delete from suppliers where name = 'TCS';

insert into modules values ('suppliers', 'Dodavatelé', 21) on conflict (key) do nothing;
insert into role_defaults values
  ('admin','suppliers','write'), ('dispatcher','suppliers','read'), ('viewer','suppliers','none'), ('custom','suppliers','none')
on conflict do nothing;

drop policy "dodavatele w" on suppliers;
create policy "dodavatele w" on suppliers for all using (can_write('suppliers')) with check (can_write('suppliers'));
alter table supplier_contacts enable row level security;
create policy "kontakty r" on supplier_contacts for select using (can_read('suppliers'));
create policy "kontakty w" on supplier_contacts for all using (can_write('suppliers')) with check (can_write('suppliers'));
grant select, insert, update, delete on supplier_contacts to authenticated;
