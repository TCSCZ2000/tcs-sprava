-- Zrušené cesty: buď se smažou, nebo se účtuje storno (ruční cena + číslo reportu + Hotovo), nebo se nechají „bez účtování“ kvůli přehledu.
-- Vyřízená cesta = report_done_at (Finished s hotovým reportem, nebo Canceled rozhodnutá).
alter table trips add column cancel_mode text check (cancel_mode in ('fee', 'none'));
