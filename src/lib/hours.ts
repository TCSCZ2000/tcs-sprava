import type { Trip, TripCrew } from './supabase'

// Mezera mezi koncem předchozí cesty a startem další, do které se „Navazuje“ předvyplní samo
export const COMBI_GAP_H = 6

export type AdjKind = 'overlap' | 'auto' | 'confirmed' | 'manual'
export type Seg = {
  trip: Trip
  person: string
  start: string | null
  end: string | null          // příjezd domů z reportu
  endAdj: string | null       // konec pro hodiny (zkrácený/prodloužený na start další cesty)
  hours: number | null        // hodiny pro mzdy
  hoursRaw: number | null     // hodiny z reportu bez úprav
  manual: boolean             // hodiny ručně z reportu
  ov: TripCrew | null         // střídání / náhradník: vlastní od–do, auto, km, dodavatel
  adj: { kind: AdjKind; next: Trip; gapH: number; nextStart: string; nextPlanned: boolean } | null
  next: { trip: Trip; gapH: number; kind: Link['kind']; planned: boolean } | null  // další cesta člověka, i když nenavazuje
}
export type Link = { person: string; prev: Trip; gapH: number; kind: AdjKind | 'rejected' | 'none' }

const GUARDS = ['guard1_id', 'guard2_id', 'guard3_id'] as const
const ms = (v: string) => Date.parse(v.replace(' ', 'T'))
export const round2 = (n: number) => Math.round(n * 100) / 100

// Pro každého člověka seřadí jeho cesty a dopočítá konce podle navazování.
// Další cesta se bere i bez reportu: pak se počítá s jejím plánovaným startem (startOf), jako v Excelu.
// Vrací segmenty (tripId|personId) jen pro cesty s reportem a pro každou cestu vazby na předchozí cesty posádky (byNext).
export function chainHours(trips: Trip[], startOf?: (t: Trip) => string | null, crew: TripCrew[] = []) {
  const segs = new Map<string, Seg>()
  const byNext = new Map<string, Link[]>()
  const perPerson = new Map<string, { t: Trip; ov: TripCrew | null }[]>()
  const ovBy = new Map<string, TripCrew>(); for (const c of crew) ovBy.set(`${c.trip_id}|${c.person_id}`, c)
  const add = (p: string, t: Trip) => { if (!perPerson.has(p)) perPerson.set(p, []); if (!perPerson.get(p)!.some(x => x.t.id === t.id)) perPerson.get(p)!.push({ t, ov: ovBy.get(`${t.id}|${p}`) ?? null }) }
  for (const t of trips) {
    if (t.status === 'Canceled') continue
    for (const g of GUARDS) { const p = t[g]; if (p) add(p, t) }
    for (const c of crew) if (c.trip_id === t.id) add(c.person_id, t)
  }
  for (const [person, list] of perPerson) {
    // od–do člověka: vlastní (střídání) nebo z cesty
    const depOf = (x: { t: Trip; ov: TripCrew | null }) => x.ov?.start_at ?? x.t.dep_home
    const arrOf = (x: { t: Trip; ov: TripCrew | null }) => x.ov?.end_at ?? x.t.arr_home
    const manualOf = (x: { t: Trip; ov: TripCrew | null }) => x.ov?.hours != null ? Number(x.ov.hours) : x.t.hours_manual != null ? Number(x.t.hours_manual) : null
    const items = list.map(x => ({ ...x, dep: depOf(x), arr: arrOf(x), start: depOf(x) ?? startOf?.(x.t) ?? null, planned: !depOf(x) }))
      .filter(x => x.start).sort((a, b) => ms(a.start!) - ms(b.start!))
    for (const x of list.filter(x => !depOf(x) && manualOf(x) != null)) {
      segs.set(`${x.t.id}|${person}`, { trip: x.t, person, start: null, end: arrOf(x), endAdj: null, hours: manualOf(x), hoursRaw: manualOf(x), manual: true, ov: x.ov, adj: null, next: null })
    }
    items.forEach((it, i) => {
      const t = it.t
      if (it.planned) return
      const nx = items[i + 1]
      const seg: Seg = { trip: t, person, start: it.dep, end: it.arr, endAdj: null, hours: null, hoursRaw: null, manual: false, ov: it.ov, adj: null, next: null }
      if (it.arr) seg.hoursRaw = round2((ms(it.arr) - ms(it.dep!)) / 36e5)
      const man = manualOf(it)
      if (man != null) { seg.manual = true; seg.hours = man; seg.hoursRaw = man }
      if (nx && it.arr) {
        const next = nx.t
        const gapH = round2((ms(nx.start!) - ms(it.arr)) / 36e5)
        let kind: Link['kind'] = 'none'
        if (gapH < 0) kind = 'overlap'
        else if (next.combi === true) kind = gapH <= COMBI_GAP_H ? 'confirmed' : 'manual'
        else if (next.combi === false) kind = 'rejected'
        else if (gapH <= COMBI_GAP_H) kind = 'auto'
        if (!byNext.has(next.id)) byNext.set(next.id, [])
        byNext.get(next.id)!.push({ person, prev: t, gapH, kind })
        seg.next = { trip: next, gapH, kind, planned: nx.planned }
        if (kind !== 'none' && kind !== 'rejected') {
          seg.adj = { kind, next, gapH, nextStart: nx.start!, nextPlanned: nx.planned }
          seg.endAdj = nx.start!
          if (!seg.manual) seg.hours = round2((ms(nx.start!) - ms(it.dep!)) / 36e5)
        }
      }
      if (seg.hours == null && !seg.manual && it.arr) seg.hours = seg.hoursRaw
      segs.set(`${t.id}|${person}`, seg)
    })
  }
  return { segs, byNext }
}

export const fmtH = (h: number | null | undefined) => h == null ? '' : h.toLocaleString('cs-CZ', { maximumFractionDigits: 2 })
export const fmtGap = (h: number) => {
  const a = Math.abs(h), hh = Math.floor(a), mm = Math.round((a - hh) * 60)
  return `${h < 0 ? '−' : ''}${hh}:${String(mm).padStart(2, '0')}`
}
