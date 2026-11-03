import type { Place, RouteTime, Trip } from './supabase'
import { addHoursIso, intervalToMinutes } from './format'

// Doby jízdy z tras: přesná trasa (Pup, Dop, základna), nebo náhrada z jiné trasy se stejným Pup / Dop a základnou
export type RouteIndex = { by: Map<string, RouteTime>; pupH: Map<string, number>; dopH: Map<string, number> }
export function buildRouteIndex(routeTimes: RouteTime[]): RouteIndex {
  const by = new Map(routeTimes.map(r => [`${r.pup_id}|${r.dop_id}|${r.home_base}`, r]))
  const pick = (key: 'pup_id' | 'dop_id', h: 'ho_pup_h' | 'dop_ho_h') => {
    const cnt = new Map<string, Map<number, number>>()
    for (const r of routeTimes) {
      if (r[h] == null) continue
      const id = `${r.home_base}|${r[key]}`
      const m = cnt.get(id) ?? new Map<number, number>(); cnt.set(id, m)
      m.set(Number(r[h]), (m.get(Number(r[h])) ?? 0) + 1)
    }
    return new Map([...cnt].map(([id, m]) => [id, [...m].sort((a, b) => b[1] - a[1])[0][0]]))
  }
  return { by, pupH: pick('pup_id', 'ho_pup_h'), dopH: pick('dop_id', 'dop_ho_h') }
}

export const requestIso = (t: Trip) => t.trip_time ? `${t.trip_date}T${t.trip_time.slice(0, 5)}:00` : null

// HO→PUP hodiny pro cestu: z trasy, jinak z jiné trasy ze stejného Pup; undefined = nic
export function hoPupHours(t: Trip, idx: RouteIndex): { h: number; from: 'route' | 'pup' } | undefined {
  const rt = idx.by.get(`${t.pup_id}|${t.dop_id}|${t.home_base}`)
  if (rt?.ho_pup_h != null) return { h: Number(rt.ho_pup_h), from: 'route' }
  if (!rt && t.pup_id) { const h = idx.pupH.get(`${t.home_base}|${t.pup_id}`); if (h != null) return { h, from: 'pup' } }
  return undefined
}
export function dopHoHours(t: Trip, idx: RouteIndex): { h: number; from: 'route' | 'dop' } | undefined {
  const rt = idx.by.get(`${t.pup_id}|${t.dop_id}|${t.home_base}`)
  if (rt?.dop_ho_h != null) return { h: Number(rt.dop_ho_h), from: 'route' }
  if (!rt && t.dop_id) { const h = idx.dopH.get(`${t.home_base}|${t.dop_id}`); if (h != null) return { h, from: 'dop' } }
  return undefined
}

// Plánovaný start: ručně > čas − HO→PUP z tras > čas − doba jízdy v Místech
export function plannedStartIso(t: Trip, idx: RouteIndex, placeBy: Map<string, Place>): string | null {
  if (t.start_at) return t.start_at.replace(' ', 'T')
  const req = requestIso(t)
  if (!req) return null
  const hp = hoPupHours(t, idx)
  if (hp) return addHoursIso(req, -hp.h, 5)
  const pup = placeBy.get(t.pup_id ?? '')
  const mins = intervalToMinutes(pup?.travel_time ?? null)
  if (mins == null || pup?.ferry) return null
  return addHoursIso(req, -mins / 60, 1)
}

// Plánovaný návrat domů: ručně > konec Dop + DOP→HO z tras (nahoru na čtvrthodiny)
export function plannedHomeIso(t: Trip, idx: RouteIndex): string | null {
  if (t.home_at) return t.home_at.replace(' ', 'T')
  if (!t.dep_dop) return null
  const dh = dopHoHours(t, idx)
  return dh ? addHoursIso(t.dep_dop, dh.h) : null
}
