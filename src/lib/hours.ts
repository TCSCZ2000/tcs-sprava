import type { Trip } from './supabase'

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
  adj: { kind: AdjKind; next: Trip; gapH: number } | null
}
export type Link = { person: string; prev: Trip; gapH: number; kind: AdjKind | 'rejected' | 'none' }

const GUARDS = ['guard1_id', 'guard2_id', 'guard3_id'] as const
const ms = (v: string) => Date.parse(v.replace(' ', 'T'))
export const round2 = (n: number) => Math.round(n * 100) / 100

// Pro každého člověka seřadí jeho cesty a dopočítá konce podle navazování.
// Vrací segmenty (tripId|personId) a pro každou cestu seznam vazeb na předchozí cesty posádky (byNext).
export function chainHours(trips: Trip[]) {
  const segs = new Map<string, Seg>()
  const byNext = new Map<string, Link[]>()
  const perPerson = new Map<string, Trip[]>()
  for (const t of trips) {
    for (const g of GUARDS) { const p = t[g]; if (p) { if (!perPerson.has(p)) perPerson.set(p, []); perPerson.get(p)!.push(t) } }
  }
  for (const [person, list] of perPerson) {
    const withStart = list.filter(t => t.dep_home).sort((a, b) => ms(a.dep_home!) - ms(b.dep_home!))
    for (const t of list.filter(t => !t.dep_home)) {
      segs.set(`${t.id}|${person}`, { trip: t, person, start: null, end: t.arr_home, endAdj: null, hours: t.hours_manual ?? null, hoursRaw: t.hours_manual ?? null, manual: t.hours_manual != null, adj: null })
    }
    withStart.forEach((t, i) => {
      const next = withStart[i + 1]
      const seg: Seg = { trip: t, person, start: t.dep_home, end: t.arr_home, endAdj: null, hours: null, hoursRaw: null, manual: false, adj: null }
      if (t.arr_home) seg.hoursRaw = round2((ms(t.arr_home) - ms(t.dep_home!)) / 36e5)
      if (t.hours_manual != null) { seg.manual = true; seg.hours = Number(t.hours_manual); seg.hoursRaw = Number(t.hours_manual) }
      if (next && t.arr_home) {
        const gapH = round2((ms(next.dep_home!) - ms(t.arr_home)) / 36e5)
        let kind: Link['kind'] = 'none'
        if (gapH < 0) kind = 'overlap'
        else if (next.combi === true) kind = gapH <= COMBI_GAP_H ? 'confirmed' : 'manual'
        else if (next.combi === false) kind = 'rejected'
        else if (gapH <= COMBI_GAP_H) kind = 'auto'
        if (!byNext.has(next.id)) byNext.set(next.id, [])
        byNext.get(next.id)!.push({ person, prev: t, gapH, kind })
        if (kind !== 'none' && kind !== 'rejected') {
          seg.adj = { kind, next, gapH }
          seg.endAdj = next.dep_home
          if (!seg.manual) seg.hours = round2((ms(next.dep_home!) - ms(t.dep_home!)) / 36e5)
        }
      }
      if (seg.hours == null && !seg.manual && t.arr_home) seg.hours = seg.hoursRaw
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
