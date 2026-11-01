# TCS Správa

Správcovská platforma TCS. Modul 1: Planning (cesty, posádky, auta, Start, podklad pro zákazníka) nad společným jádrem (uživatelé a práva, lidé, auta, místa).

## Části
- `supabase/migrations/` – databáze, práva (RLS). Spouští se v Supabase → SQL Editor.
- `src/` – webová aplikace (React + Vite), hostovaná na Cloudflare Pages.
- `data/` – import z Excelu s osobními údaji. **Není v Gitu.**

## Cloudflare Pages
- Build command: `npm run build`
- Output directory: `dist`
- Proměnné prostředí: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

## Supabase
- Authentication → URL Configuration → Site URL = adresa aplikace (např. https://tcs-sprava.pages.dev)
- Nový uživatel se dostane dovnitř jen s pozvánkou (tabulka `invites`, obrazovka Uživatelé).
