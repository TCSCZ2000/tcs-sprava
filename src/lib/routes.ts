import type { Route, RoutePrice, Trip } from './supabase'

export const LEGS = [
  { key: 'ho_pup', label: 'HO→PUP' },
  { key: 'pup_dop', label: 'PUP→DOP' },
  { key: 'dop_ho', label: 'DOP→HO' },
] as const

const n = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v))
export const totalKm = (r: Route) => n(r.ho_pup_km) + n(r.pup_dop_km) + n(r.dop_ho_km)
export const totalH = (r: Route) => n(r.ho_pup_h) + n(r.pup_dop_h) + n(r.dop_ho_h)
export const totalToll = (r: Route) => n(r.ho_pup_toll) + n(r.pup_dop_toll) + n(r.dop_ho_toll)

export const eur = (v: number) => v.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €'

const fmtH = (h: number) => h.toString().replace('.', ',')

// Cena cesty jako v Přehledu 10_26.
// Ruční cena přebije vše. Pevná cena platí pro X h mezi Pup a Dop; skutečné hodiny navíc
// (request čas cesty → odjezd z Dop) se zaokrouhlí nahoru na čtvrthodiny a připočtou × sazba/h.
// Jinak: hodiny každého z posádky × sazba/h + km × sazba/km + mýto.
export function tripPrice(t: Trip, route: Route | undefined, prices: RoutePrice[], hoursTotal: number | null, fixedH: number | null) {
  if (t.price_manual != null) return { price: Number(t.price_manual), how: 'Ruční cena (domluva se zákazníkem)' }
  const fixed = t.route_price_id ? prices.find(p => p.id === t.route_price_id) : undefined
  if (fixed) {
    const base = Number(fixed.price)
    if (fixed.pup_dop_h == null || !route) return { price: base, how: `Pevná cena ${fixed.label}` }
    if (fixedH == null) return { price: base, how: `Pevná cena ${fixed.label} (hodiny navíc se dopočtou, až bude vyplněný odjezd z Dop)` }
    const extra = Math.max(0, Math.ceil((fixedH - Number(fixed.pup_dop_h)) * 4 - 1e-9) / 4)
    if (extra === 0) return { price: base, how: `Pevná cena ${fixed.label}, od requestu do odjezdu z Dop ${fmtH(Math.round(fixedH * 100) / 100)} h – nic navíc` }
    const add = extra * Number(route.rate_h)
    return {
      price: Math.round((base + add) * 100) / 100,
      how: `Pevná cena ${fixed.label} ${eur(base)} + ${fmtH(extra)} h navíc × ${route.rate_h} € = ${eur(add)} (od requestu do odjezdu z Dop ${fmtH(Math.round(fixedH * 100) / 100)} h)`,
    }
  }
  if (!route) return null
  const crew = [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).length
  const hours = t.hours_manual ?? hoursTotal
  if (hours == null || crew === 0) return null
  const km = t.km_total ?? totalKm(route)
  const toll = t.toll ?? totalToll(route)
  const hrs = crew * hours * Number(route.rate_h), car = km * Number(route.rate_km)
  return {
    price: Math.round((hrs + car + toll) * 100) / 100,
    how: `${crew} × ${hours} h × ${route.rate_h} € + ${km} km × ${route.rate_km} € + mýto ${toll} €`,
  }
}
