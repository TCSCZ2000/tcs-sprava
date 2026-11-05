import { supabase, tripKind, type Place, type Route, type RoutePrice, type Trip } from './supabase'

export const LEGS = [
  { key: 'ho_pup', label: 'Výjezd→PUP' },
  { key: 'pup_dop', label: 'PUP→DOP' },
  { key: 'dop_ho', label: 'DOP→Návrat' },
] as const

const n = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v))
export const totalKm = (r: Route) => n(r.ho_pup_km) + n(r.pup_dop_km) + n(r.dop_ho_km)
export const totalH = (r: Route) => n(r.ho_pup_h) + n(r.pup_dop_h) + n(r.dop_ho_h)
export const totalToll = (r: Route) => n(r.ho_pup_toll) + n(r.pup_dop_toll) + n(r.dop_ho_toll)

export const eur = (v: number) => v.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €'
export const money = (v: number, cur: 'EUR' | 'CZK' | null | undefined) => v.toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + (cur === 'CZK' ? ' Kč' : ' €')
const q4 = (h: number) => Math.max(0, Math.ceil(h * 4 - 1e-9) / 4)   // započaté čtvrthodiny
const hrsBetween = (a: string | null | undefined, b: string | null | undefined) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 36e5 : null)

const fmtH = (h: number) => h.toString().replace('.', ',')

// Cena cesty jako v Přehledu 10_26.
// Ruční cena přebije vše. Pevná cena platí pro X h mezi Pup a Dop; skutečné hodiny navíc
// (request čas cesty → odjezd z Dop) se zaokrouhlí nahoru na čtvrthodiny a připočtou × počet lidí × sazba/h (sazba je na 1 člena posádky).
// Jinak: hodiny každého z posádky × sazba/h + km × sazba/km + mýto.
// Rozklad ceny jako v Přehledu / přílohách faktury: HRS price (hodiny), Car price (km × sazba), Toll. U pevné ceny je car = km × sazba/km, toll = mýto, hrs = zbytek.
export type Priced = { price: number; how: string; currency: 'EUR' | 'CZK'; hrs: number; car: number; toll: number }
const r2 = (v: number) => Math.round(v * 100) / 100
export function breakdown(t: Trip, route: Route | undefined, price: number, how: string, currency: 'EUR' | 'CZK'): Priced {
  const transport = tripKind(t) === 'transport'
  const km = t.km_total ?? (route ? totalKm(route) : 0)
  const car = route ? r2(km * Number(route.rate_km)) : 0
  const toll = transport ? 0 : r2(Number(t.toll ?? (route ? totalToll(route) : 0)))
  return { price, how, currency, car: Math.min(car, price), toll: Math.min(toll, Math.max(0, price - car)), hrs: r2(Math.max(0, price - Math.min(car, price) - Math.min(toll, Math.max(0, price - car)))) }
}
// Když trasa v ceníku chybí, počítá se ze sazeb zákazníka (fallback) a z km a mýta v reportu
export type RateFallback = { rate_h: number; rate_km: number; currency: 'EUR' | 'CZK'; label: string }
export function tripPrice(t: Trip, route: Route | undefined, prices: RoutePrice[], hoursTotal: number | null, fixedH: number | null, fallback?: RateFallback | null): Priced | null {
  const r = tripPriceRaw(t, route, prices, hoursTotal, fixedH, fallback)
  if (!r) return null
  const rt = route ?? (fallback ? ({ rate_km: fallback.rate_km, ho_pup_km: 0, pup_dop_km: 0, dop_ho_km: 0, ho_pup_toll: 0, pup_dop_toll: 0, dop_ho_toll: 0 } as unknown as Route) : undefined)
  return breakdown(t, rt, r.price, r.how, r.currency)
}
function tripPriceRaw(t: Trip, route: Route | undefined, prices: RoutePrice[], hoursTotal: number | null, fixedH: number | null, fallback?: RateFallback | null): { price: number; how: string; currency: 'EUR' | 'CZK' } | null {
  const fixed = t.route_price_id ? prices.find(p => p.id === t.route_price_id) : undefined
  const cur = fixed?.currency ?? route?.currency ?? fallback?.currency ?? 'EUR'
  if (t.price_manual != null) return { price: Number(t.price_manual), how: 'Ruční cena (domluva se zákazníkem)', currency: cur }
  const m = (v: number) => money(v, cur)
  if (fixed && tripKind(t) === 'transport') {
    // Přeprava: pevná cena, v ní X h zdarma na nakládku (objednaný čas → naloženo) a Y h na vykládku (příjezd na vykládku → vyloženo)
    const base = Number(fixed.price)
    const req = t.trip_time ? `${t.trip_date}T${t.trip_time.slice(0, 5)}:00` : null
    const load = hrsBetween(req, t.dep_pup), unload = hrsBetween(t.arr_dop, t.dep_dop)
    const fl = fixed.free_load_h == null ? null : Number(fixed.free_load_h), fu = fixed.free_unload_h == null ? null : Number(fixed.free_unload_h)
    if (fl == null && fu == null) return { price: base, how: `Pevná cena ${fixed.label} (bez hodin zdarma, nic navíc se nepočítá)`, currency: cur }
    const parts: string[] = []; let extra = 0
    if (fl != null) { if (load == null) parts.push('nakládka: chybí objednaný čas nebo Naloženo'); else { const e = q4(load - fl); extra += e; parts.push(`nakládka ${fmtH(Math.round(load * 100) / 100)} h, zdarma ${fmtH(fl)} h → ${e ? fmtH(e) + ' h navíc' : 'ok'}`) } }
    if (fu != null) { if (unload == null) parts.push('vykládka: chybí Příjezd na vykládku nebo Vyloženo'); else { const e = q4(unload - fu); extra += e; parts.push(`vykládka ${fmtH(Math.round(unload * 100) / 100)} h, zdarma ${fmtH(fu)} h → ${e ? fmtH(e) + ' h navíc' : 'ok'}`) } }
    const crew = Math.max(1, [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).length)
    const rate = route ? Number(route.rate_h) : 0
    const add = extra * rate * crew
    return { price: Math.round((base + add) * 100) / 100, currency: cur,
      how: `Pevná cena ${fixed.label} ${m(base)}${add ? ` + ${crew > 1 ? crew + ' × ' : ''}${fmtH(extra)} h navíc × ${rate} = ${m(add)}` : ''}; ${parts.join('; ')}` }
  }
  if (fixed) {
    const base = Number(fixed.price)
    if (fixed.pup_dop_h == null || !route) return { price: base, how: `Pevná cena ${fixed.label}`, currency: cur }
    if (fixedH == null) return { price: base, how: `Pevná cena ${fixed.label} (hodiny navíc se dopočtou, až bude vyplněný odjezd z Dop)`, currency: cur }
    const extra = q4(fixedH - Number(fixed.pup_dop_h))
    if (extra === 0) return { price: base, how: `Pevná cena ${fixed.label}, od requestu do odjezdu z Dop ${fmtH(Math.round(fixedH * 100) / 100)} h – nic navíc`, currency: cur }
    const crew = [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).length
    if (crew === 0) return { price: base, how: `Pevná cena ${fixed.label} + ${fmtH(extra)} h navíc – chybí posádka, hodiny navíc nejde spočítat`, currency: cur }
    const add = crew * extra * Number(route.rate_h)
    return {
      price: Math.round((base + add) * 100) / 100, currency: cur,
      how: `Pevná cena ${fixed.label} ${m(base)} + ${crew} × ${fmtH(extra)} h navíc × ${route.rate_h} = ${m(add)} (od requestu do odjezdu z Dop ${fmtH(Math.round(fixedH * 100) / 100)} h)`,
    }
  }
  if (!route && !fallback) return null
  const crew = [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).length
  const hours = t.hours_manual ?? hoursTotal
  if (hours == null || crew === 0) return null
  const rateH = route ? Number(route.rate_h) : fallback!.rate_h, rateKm = route ? Number(route.rate_km) : fallback!.rate_km
  const km = t.km_total ?? (route ? totalKm(route) : 0)
  const transport = tripKind(t) === 'transport'
  const toll = transport ? 0 : Number(t.toll ?? (route ? totalToll(route) : 0))
  const hrs = crew * hours * rateH, car = km * rateKm
  return {
    price: Math.round((hrs + car + toll) * 100) / 100, currency: cur,
    how: `${crew} × ${hours} h × ${rateH} + ${km} km × ${rateKm}${transport ? '' : ` + mýto ${toll}`}${route ? '' : ` (${fallback!.label}, trasa v ceníku není)`}`,
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
export async function copyRoute(src: Route | undefined, pup: string, dop: string, from: string, to: string, prices: RoutePrice[], variant = '', stops: string[] = [], customer: string | null = src?.customer ?? null): Promise<{ error: string | null; id?: string }> {
  const vals = src ? Object.fromEntries(Object.entries(src).filter(([k]) => !['id', 'pup_id', 'dop_id', 'copied_from', 'updated_at', 'updated_by', 'note', 'base_from', 'base_to', 'variant', 'stops', 'customer'].includes(k))) : {}
  const { data, error } = await supabase.from('routes').insert({ ...vals, pup_id: pup, dop_id: dop, base_from: from, base_to: to, variant, stops, customer, copied_from: src?.id ?? null }).select().single()
  if (error) return { error: error.code === '23505' ? (variant ? `Varianta „${variant}“ už u téhle trasy je.` : 'Tahle trasa už existuje. Pro další variantu (třeba „přes Francii“) vyplňte název varianty.') : error.message }
  if (src) {
    const ps = prices.filter(p => p.route_id === src.id).map(p => ({ route_id: (data as Route).id, label: p.label, pup_dop_h: p.pup_dop_h, price: p.price, sort: p.sort, currency: p.currency, free_load_h: p.free_load_h, free_unload_h: p.free_unload_h }))
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

export async function createComposedRoute(pup: string, dop: string, from: string, to: string, ho: LegPick | null, dh: LegPick | null, stops: string[] = [], mid: MidPick | null = null, customer: string | null = null): Promise<{ error: string | null }> {
  const src = ho?.route ?? dh?.route
  const vals: Partial<Route> = { rate_h: src?.rate_h ?? 10, rate_km: src?.rate_km ?? 0.28, stops, customer: customer ?? src?.customer ?? null, currency: src?.currency ?? 'EUR' }
  if (mid) Object.assign(vals, { pup_dop_km: mid.km, pup_dop_h: mid.h, pup_dop_toll: mid.toll })
  if (ho) Object.assign(vals, { ho_pup_km: ho.route.ho_pup_km, ho_pup_h: ho.route.ho_pup_h, ho_pup_toll: ho.route.ho_pup_toll })
  if (dh) Object.assign(vals, { dop_ho_km: dh.route.dop_ho_km, dop_ho_h: dh.route.dop_ho_h, dop_ho_toll: dh.route.dop_ho_toll })
  const { error } = await supabase.from('routes').insert({ ...vals, pup_id: pup, dop_id: dop, base_from: from, base_to: to, copied_from: src?.id ?? null,
    note: `Složeno z úseků: ${from}→PUP ${ho ? 'z ' + ho.why : 'chybí'}; ${mid ? 'PUP→DOP součet ' + mid.parts.join(' + ') + '; ' : ''}DOP→${to} ${dh ? 'z ' + dh.why : 'chybí'}.${mid ? '' : ' Doplňte PUP→DOP.'}` })
  if (error) return { error: error.code === '23505' ? 'Tahle trasa už existuje.' : error.message }
  return { error: null }
}

export const routeIncomplete = (r: Route) => r.pup_dop_km == null && r.pup_dop_h == null
