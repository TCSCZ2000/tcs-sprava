import type { Car } from './supabase'

// Servis auta: stejná pravidla jako hodinová kontrola TCS servis (list Intervaly)
export interface ServiceGroup { name: string; small_km: number; big_every: number | null; timing_km: number | null; service_at: string; notify: boolean; sort: number }
export interface WorkKind { name: string; sort: number; counts_as_service: boolean; big: boolean }
export interface CarService {
  id: string; car_id: string; done_on: string; km: number | null; kind: string; shop: string | null
  price_net: number | null; price_gross: number | null; currency: string; doc_no: string | null; source: string | null; note: string | null
}
export interface CarKm { id: string; car_id: string; at: string; km: number; source: string | null; crew: string | null; link: string | null; note: string | null }

export type Stage = 'overdue' | 'k1000' | 'k3000' | 'k6000' | 'ok'
export const STAGE_LABEL: Record<Stage, string> = { overdue: 'Po termínu', k1000: 'Do 1 000 km', k3000: 'Do 3 000 km', k6000: 'Do 6 000 km', ok: 'OK' }

export interface ServiceStatus {
  group: ServiceGroup | null
  kmMax: number | null; kmAt: string | null
  lastService: CarService | null          // poslední malý/velký (nejvyšší km)
  nextKm: number | null; left: number | null; stage: Stage | null
  nextKind: 'malý' | 'velký' | 'nutno ověřit' | null
  lastBig: CarService | null
  lastTiming: CarService | null; timingNextKm: number | null; timingLeft: number | null; timingStage: Stage | 'none' | null
  brakesFront: CarService | null; brakesRear: CarService | null; tyresFront: CarService | null; tyresRear: CarService | null
  costYear: Record<string, number>; costTotal: number
}

const stageOf = (left: number): Stage => left < 0 ? 'overdue' : left <= 1000 ? 'k1000' : left <= 3000 ? 'k3000' : left <= 6000 ? 'k6000' : 'ok'

export function serviceStatus(c: Car, records: CarService[], kms: CarKm[], groups: ServiceGroup[], kinds: WorkKind[]): ServiceStatus {
  const group = groups.find(g => g.name === c.service_group) ?? null
  const svcKinds = new Set(kinds.filter(k => k.counts_as_service).map(k => k.name))
  const bigKinds = new Set(kinds.filter(k => k.big).map(k => k.name))
  const byKm = (a: CarService, b: CarService) => (b.km ?? -1) - (a.km ?? -1) || b.done_on.localeCompare(a.done_on)
  const rec = records.filter(r => r.car_id === c.id)
  const withKm = rec.filter(r => r.km != null)

  // nejvyšší stav km (log + ručně zapsané)
  let kmMax: number | null = c.km_current ?? null, kmAt: string | null = c.km_updated ?? null
  for (const k of kms) if (k.car_id === c.id && (kmMax == null || k.km >= kmMax)) { kmMax = k.km; kmAt = k.at }

  const services = withKm.filter(r => svcKinds.has(r.kind)).sort(byKm)
  const lastService = services[0] ?? null
  const lastBig = withKm.filter(r => bigKinds.has(r.kind)).sort(byKm)[0] ?? null

  let nextKm: number | null = null
  if (lastService?.km != null && group) {
    const step = group.small_km
    nextKm = group.name === 'Renault Kangoo' ? Math.round(lastService.km / step) * step + step : lastService.km + step
  }
  const left = nextKm != null && kmMax != null ? nextKm - kmMax : null
  const stage = left == null ? null : stageOf(left)

  // malý, nebo velký: počet malých od posledního velkého
  let nextKind: ServiceStatus['nextKind'] = null
  if (group && lastService) {
    if (!group.big_every) nextKind = 'malý'
    else if (!lastBig) nextKind = group.name === 'Renault Kangoo' && nextKm != null ? (nextKm % (group.small_km * group.big_every) === 0 ? 'velký' : 'malý') : 'nutno ověřit'
    else {
      const smallSince = services.filter(r => !bigKinds.has(r.kind) && (r.km ?? 0) > (lastBig.km ?? 0)).length
      nextKind = smallSince >= group.big_every - 1 ? 'velký' : 'malý'
    }
  }

  // rozvody
  const lastTiming = withKm.filter(r => r.kind === 'Rozvody').sort(byKm)[0] ?? null
  let timingNextKm: number | null = null, timingStage: ServiceStatus['timingStage'] = null
  if (group?.timing_km) {
    timingNextKm = lastTiming?.km != null ? lastTiming.km + group.timing_km : (kmMax != null && kmMax < group.timing_km ? group.timing_km : null)
    timingStage = timingNextKm == null ? 'none' : kmMax == null ? null : stageOf(timingNextKm - kmMax)
  } else if (group) timingStage = 'none'
  const timingLeft = timingNextKm != null && kmMax != null ? timingNextKm - kmMax : null

  const lastOf = (...names: string[]) => rec.filter(r => names.includes(r.kind)).sort((a, b) => b.done_on.localeCompare(a.done_on))[0] ?? null
  const costYear: Record<string, number> = {}; let costTotal = 0
  for (const r of rec) { const v = Number(r.price_net ?? 0); if (!v) continue; const y = r.done_on.slice(0, 4); costYear[y] = (costYear[y] ?? 0) + v; costTotal += v }

  return {
    group, kmMax, kmAt, lastService, nextKm, left, stage, nextKind, lastBig,
    lastTiming, timingNextKm, timingLeft, timingStage,
    brakesFront: lastOf('Brzdy přední', 'Brzdy (nerozlišeno)'), brakesRear: lastOf('Brzdy zadní', 'Brzdy (nerozlišeno)'),
    tyresFront: lastOf('Přezutí přední', 'Přezutí komplet'), tyresRear: lastOf('Přezutí zadní', 'Přezutí komplet'),
    costYear, costTotal,
  }
}

export const fmtKm = (n: number | null | undefined) => n == null ? '' : n.toLocaleString('cs-CZ') + ' km'
export const fmtCzk = (n: number) => n.toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + ' Kč'
export const dmyOf = (iso: string | null | undefined) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${d}. ${m}. ${y}` }
