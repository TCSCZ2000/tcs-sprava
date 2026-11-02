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

// Cena cesty jako v Přehledu 10_26: hodiny každého z posádky × sazba/h + km × sazba/km + mýto, nebo pevná cena
export function tripPrice(t: Trip, route: Route | undefined, prices: RoutePrice[], hoursTotal: number | null) {
  const fixed = t.route_price_id ? prices.find(p => p.id === t.route_price_id) : undefined
  if (fixed) return { price: Number(fixed.price), how: `Pevná cena ${fixed.label}` }
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
