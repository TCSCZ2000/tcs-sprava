-- Výchozí sazby zákazníka: použijí se, když cesta nemá trasu v ceníku (hodiny × sazba × posádka + km × sazba/km + mýto)
alter table customers add column rate_h numeric, add column rate_km numeric, add column currency text not null default 'EUR' check (currency in ('EUR', 'CZK'));
update customers set rate_h = 10, rate_km = 0.28 where name in ('TCS NL', 'TCS DE');
update customers set currency = 'CZK' where name in ('JTi CZ', 'JTi SK');
