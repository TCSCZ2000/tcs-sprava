import { supabase, type Place, type Route, type RoutePrice, type Trip } from './supabase'

export const LEGS = [
  { key: 'ho_pup', label: 'Odkud→PUP' },
  { key: 'pup_dop', label: 'PUP→DOP' },
  { key: 'dop_ho', label: 'DOP→Kam' },
] as const

const n = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v))
export const totalKm = (r: Route) => n(r.ho_pup_km) + n(r.pup_dop_km) + n(r.dop_ho_km)
export const totalH = (r: Route) => n(r.ho_pup_h) + n(r.pup_dop_h) + n(r.dop_ho_h)
export const totalToll = (r: Route) => n(r.ho_pup_toll) + n(r.pup_dop_toll) + n(r.dop_ho_toll)

export const eur = (v: number) => v.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €'

const fmtH = (h: number) => h.toString().replace('.', ',')

// Cena cesty jako v Přehledu 10_26.
// Ruční cena přebije vše. Pevná cena platí pro X h mezi Pup a Dop; skutečné hodiny navíc
// (request čas cesty → odjezd z Dop) se zaokrouhlí nahoru na čtvrthodiny a připočtou × počet lidí × sazba/h (sazba je na 1 člena posádky).
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
    const crew = [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).length
    if (crew === 0) return { price: base, how: `Pevná cena ${fixed.label} + ${fmtH(extra)} h navíc – chybí posádka, hodiny navíc nejde spočítat` }
    const add = crew * extra * Number(route.rate_h)
    return {
      price: Math.round((base + add) * 100) / 100,
      how: `Pevná cena ${fixed.label} ${eur(base)} + ${crew} × ${fmtH(extra)} h navíc × ${route.rate_h} € = ${eur(add)} (od requestu do odjezdu z Dop ${fmtH(Math.round(fixedH * 100) / 100)} h)`,
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

// Podobné trasy: stejné Pup / Dop, nebo stejné město (KN Frankfurt ~ CHI Frankfurt), stejná základna
export function suggestRoutes(pup: string, dop: string, from: string, to: string, routes: Route[], placeBy: Map<string, Place>, stops: string[] = []): { route: Route; why: string }[] {
  const city = (id: string) => (placeBy.get(id)?.city ?? '').trim().toLowerCase()
  const pc = city(pup), dc = city(dop)
  const out: { route: Route; why: string; score: number }[] = []
  for (const r of routes) {
    if (r.base_from !== from || r.base_to !== to) continue
    // stejné další vykládky (stejné místo nebo stejné město)
    if (r.stops.length !== stops.length || !r.stops.every((s, i) => s === stops[i] || (!!city(s) && city(s) === city(stops[i])))) continue
    const samePup = r.pup_id === pup, sameDop = r.dop_id === dop
    const pupCity = !!pc && city(r.pup_id) === pc, dopCity = !!dc && city(r.dop_id) === dc
    if ((samePup || pupCity) && (sameDop || dopCity) && !(samePup && sameDop)) {
      out.push({ route: r, score: (samePup ? 2 : 1) + (sameDop ? 2 : 1), why: [samePup ? 'stejné Pup' : `Pup v ${placeBy.get(pup)?.city}`, sameDop ? 'stejné Dop' : `Dop v ${placeBy.get(dop)?.city}`].join(', ') })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3)
}

// Založí trasu jako kopii jiné (úseky, sazby, pevné ceny); vrací chybu nebo null
export async function copyRoute(src: Route | undefined, pup: string, dop: string, from: string, to: string, prices: RoutePrice[], variant = '', stops: string[] = []): Promise<{ error: string | null; id?: string }> {
  const vals = src ? Object.fromEntries(Object.entries(src).filter(([k]) => !['id', 'pup_id', 'dop_id', 'copied_from', 'updated_at', 'updated_by', 'note', 'base_from', 'base_to', 'variant', 'stops'].includes(k))) : {}
  const { data, error } = await supabase.from('routes').insert({ ...vals, pup_id: pup, dop_id: dop, base_from: from, base_to: to, variant, stops, copied_from: src?.id ?? null }).select().single()
  if (error) return { error: error.code === '23505' ? (variant ? `Varianta „${variant}“ už u téhle trasy je.` : 'Tahle trasa už existuje. Pro další variantu (třeba „přes Francii“) vyplňte název varianty.') : error.message }
  if (src) {
    const ps = prices.filter(p => p.route_id === src.id).map(p => ({ route_id: (data as Route).id, label: p.label, pup_dop_h: p.pup_dop_h, price: p.price, sort: p.sort }))
    if (ps.length) await supabase.from('route_prices').insert(ps)
  }
  return { error: null, id: (data as Route).id }
}

// Složení trasy z hotových úseků: HO→PUP z jiné trasy ze stejného Pup (nebo města), DOP→HO z jiné trasy na stejný Dop (nebo město).
// PUP→DOP zůstane prázdný k doplnění.
export type LegPick = { route: Route; why: string }
export type MidPick = { km: number; h: number | null; toll: number; parts: string[] }
export function composeRoute(pup: string, dop: string, from: string, to: string, routes: Route[], placeBy: Map<string, Place>, stops: string[] = []): { ho: LegPick | null; dh: LegPick | null; mid: MidPick | null } {
  const city = (id: string) => (placeBy.get(id)?.city ?? '').trim().toLowerCase()
  const name = (id: string) => placeBy.get(id)?.name ?? '?'
  const pick = (key: 'pup_id' | 'dop_id', id: string, h: 'ho_pup_h' | 'dop_ho_h', km: 'ho_pup_km' | 'dop_ho_km'): LegPick | null => {
    const cand = routes.filter(r => (key === 'pup_id' ? r.base_from === from : r.base_to === to) && (r[h] != null || r[km] != null))
    const exact = cand.filter(r => r[key] === id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    if (exact[0]) return { route: exact[0], why: `${name(exact[0].pup_id)} → ${name(exact[0].dop_id)} (stejné místo)` }
    const c = city(id)
    const same = c ? cand.filter(r => city(r[key]) === c).sort((a, b) => b.updated_at.localeCompare(a.updated_at)) : []
    if (same[0]) return { route: same[0], why: `${name(same[0].pup_id)} → ${name(same[0].dop_id)} (stejné město ${placeBy.get(id)?.city})` }
    return null
  }
  const last = stops.length ? stops[stops.length - 1] : dop
  // PUP→DOP u více vykládek: součet úseků PUP→DOP z tras mezi po sobě jdoucími místy (Pup→Dop1, Dop1→Dop2 …), bez ohledu na základnu
  let mid: MidPick | null = null
  if (stops.length) {
    const chain = [pup, dop, ...stops]
    const acc: MidPick = { km: 0, h: 0, toll: 0, parts: [] }
    let ok = true
    for (let i = 0; i < chain.length - 1 && ok; i++) {
      const leg = routes.filter(r => r.pup_id === chain[i] && r.dop_id === chain[i + 1] && !r.stops.length && (r.pup_dop_km != null || r.pup_dop_h != null))
        .sort((a, b) => (a.variant ? 1 : 0) - (b.variant ? 1 : 0))[0]
      if (!leg) { ok = false; break }
      acc.km += Number(leg.pup_dop_km ?? 0); acc.h = leg.pup_dop_h == null ? acc.h : (acc.h ?? 0) + Number(leg.pup_dop_h); acc.toll += Number(leg.pup_dop_toll ?? 0)
      acc.parts.push(`${name(chain[i])} → ${name(chain[i + 1])}`)
    }
    mid = ok ? acc : null
  }
  return { ho: pick('pup_id', pup, 'ho_pup_h', 'ho_pup_km'), dh: pick('dop_id', last, 'dop_ho_h', 'dop_ho_km'), mid }
}

export async function createComposedRoute(pup: string, dop: string, from: string, to: string, ho: LegPick | null, dh: LegPick | null, stops: string[] = [], mid: MidPick | null = null): Promise<{ error: string | null }> {
  const src = ho?.route ?? dh?.route
  const vals: Partial<Route> = { rate_h: src?.rate_h ?? 10, rate_km: src?.rate_km ?? 0.28, stops }
  if (mid) Object.assign(vals, { pup_dop_km: mid.km, pup_dop_h: mid.h, pup_dop_toll: mid.toll })
  if (ho) Object.assign(vals, { ho_pup_km: ho.route.ho_pup_km, ho_pup_h: ho.route.ho_pup_h, ho_pup_toll: ho.route.ho_pup_toll })
  if (dh) Object.assign(vals, { dop_ho_km: dh.route.dop_ho_km, dop_ho_h: dh.route.dop_ho_h, dop_ho_toll: dh.route.dop_ho_toll })
  const { error } = await supabase.from('routes').insert({ ...vals, pup_id: pup, dop_id: dop, base_from: from, base_to: to, copied_from: src?.id ?? null,
    note: `Složeno z úseků: ${from}→PUP ${ho ? 'z ' + ho.why : 'chybí'}; ${mid ? 'PUP→DOP součet ' + mid.parts.join(' + ') + '; ' : ''}DOP→${to} ${dh ? 'z ' + dh.why : 'chybí'}.${mid ? '' : ' Doplňte PUP→DOP.'}` })
  if (error) return { error: error.code === '23505' ? 'Tahle trasa už existuje.' : error.message }
  return { error: null }
}

export const routeIncomplete = (r: Route) => r.pup_dop_km == null && r.pup_dop_h == null
