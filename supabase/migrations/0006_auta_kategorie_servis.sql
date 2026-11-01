-- Kategorie aut, GPS platforma, km a servis

create table car_categories (
  name    text primary key,
  kind    text not null check (kind in ('own', 'rental', 'driver')),
  sort    int not null,
  visible boolean not null default true   -- ukazovat v Planningu a v nabídkách
);
insert into car_categories values
  ('TCS', 'own', 1, true),
  ('Sixt', 'rental', 2, true),
  ('S-Car', 'rental', 3, true),
  ('Osobní auto řidiče', 'driver', 4, true);
alter table car_categories enable row level security;
create policy "kategorie r" on car_categories for select using (auth.uid() is not null);
create policy "kategorie w" on car_categories for all using (can_write('cars')) with check (can_write('cars'));
grant select, insert, update, delete on car_categories to authenticated;

alter table cars
  add column car_category text references car_categories on update cascade,
  add column gps_platform text check (gps_platform in ('GpsGate', 'RexGPS')),
  add column service_last_km int,
  add column km_current int,
  add column service_next_km int,
  add column km_updated date;

update cars set car_category = 'TCS' where owner = 'TCS' or owner is null;
update cars set gps_platform = case
  when gps ilike '%teltonika%' then 'GpsGate'
  when gps ilike '%rex%' or gps ilike 'obd%' then 'RexGPS'
end;
-- u prodaných aut sloupec GPS obsahoval poznámky k prodeji
update cars set note = concat_ws('; ', note, gps), gps = null, gps_platform = null
 where state = 'Prodáno' and gps is not null and gps not ilike '%teltonika%';

update cars c set service_last_km = v.l::int, km_current = v.c::int, service_next_km = v.n::int, km_updated = date '2026-11-01'
  from (values ('4SR7052',412600,429156,432600),
  ('6ST4055',299400,316176,319400),
  ('6SU1973',393000,421251,423000),
  ('6SU1987',389000,419589,419000),
  ('6SZ9183',249400,263872,269400),
  ('6SZ9406',170800,175609,190800),
  ('6SZ9449',209000,229180,239000),
  ('7AL2841',256400,263230,276400),
  ('7SC1824',120000,127457,150000),
  ('7SC2064',120000,126835,150000),
  ('7SD0515',250200,270666,270200),
  ('7SJ0487',290000,292193,310000),
  ('7SJ0708',385500,414930,415500),
  ('7SJ0814',60000,77896,90000),
  ('7SJ0834',30000,61817,90000),
  ('8AB6722',202000,112024,222000),
  ('8AE1539',410000,417157,430000),
  ('8AJ7057',394500,402968,414500),
  ('8AJ7894',361470,376476,381470),
  ('8AL1239',288600,269708,308600),
  ('8AP4702',416100,426328,436100),
  ('9AB2610',223600,238346,243600),
  ('9AF3319',137500,164048,157500),
  ('9AF9395',104700,113186,124700),
  ('9AH3949',147100,155652,167100),
  ('9AI4340',106800,120816,126800),
  ('9AJ7524',256500,271310,276500),
  ('9AK2378',308000,311403,328000),
  ('9AM8188',134500,140542,154500),
  ('9AN2956',155208,157181,175208),
  ('9AN6350',235538,236595,255538),
  ('9AN6641',210000,220345,230000),
  ('9AN8153',141600,153699,161600),
  ('9AN8156',150400,168854,170400),
  ('9AN8235',194100,212460,214100),
  ('9AN8813',107100,121851,127100),
  ('9AR1810',120800,133983,140800),
  ('9AS0343',153500,162276,173500),
  ('9AT1837',115900,115993,135900),
  ('9AU7657',121900,141107,141900),
  ('9AX9766',131900,143113,151900),
  ('5SY9411',null,null,null),
  ('7SE2166',null,null,null),
  ('PRODANÁ AUTA – K DOŘEŠENÍ',null,null,null),
  ('5SX8994',610000,618369,640000),
  ('8AD1979',194400,194969,214400),
  ('8AJ9206',450148,479275,480148),
  ('9AP5620',169500,178172,189500)) as v(plate, l, c, n)
 where c.plate = v.plate;
