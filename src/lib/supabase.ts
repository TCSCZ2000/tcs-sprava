import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const configured = Boolean(url && key)
export const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export type Level = 'none' | 'read' | 'write'
export type Role = 'admin' | 'viewer' | 'custom' | 'dispatcher'

export interface Profile { id: string; email: string; full_name: string; role: Role; active: boolean }
export interface Person {
  id: string; first_name: string; last_name: string; short_name: string; short_name_auto: boolean; tag: string; phone: string | null
  email: string | null; birth_date: string | null; nationality: string | null; active: boolean; note: string | null
  supplier: string | null   // výchozí dodavatel (SEMS); null = TCS
}
// Dodavatel posádek: SEMS = jen lidé (hodiny); jiní mohou dát i auto (km × sazba + mýto)
export interface Supplier {
  name: string; provides_car: boolean; rate_h: number | null; rate_km: number | null; note: string | null; sort: number; active: boolean
  ico: string | null; dic: string | null; address: string | null; email: string | null; phone: string | null; web: string | null; payment_terms: string | null
}
export interface SupplierContact { id: string; supplier: string; name: string; role: string | null; phone: string | null; email: string | null; note: string | null; sort: number }
export const NO_SUPPLIER = ''   // člověk bez dodavatele (vlastní)
export const supplierLabel = (s: string | null | undefined) => s || 'bez dodavatele'
// Doklad člověka: jeden řádek na doklad (OP, pas, ŘP, …), soubor v bucketu people-files; status 'navrzeno' = typ/číslo/platnost navrhl Claude
export interface PersonDoc {
  id: string; person_id: string; kind: string; name: string | null; number: string | null; valid_to: string | null
  path: string | null; file_name: string | null; mime: string | null; size: number | null; source: string | null; source_ref: string | null
  status: 'navrzeno' | 'potvrzeno' | null; note: string | null; uploaded_at: string
}
export interface DocKind { key: string; label: string; sort: number; expires: boolean; numbered: boolean }
// Souhrn OP a pasu pro Planning a Podklad (nejdelší platnost z potvrzených, jinak jakýkoli)
export interface PersonDocs {
  person_id: string; id_number: string | null; id_valid_to: string | null
  passport_number: string | null; passport_valid_to: string | null
}
export function summarizeDocs(docs: PersonDoc[]): Map<string, PersonDocs> {
  const m = new Map<string, PersonDocs>()
  const better = (a: PersonDoc | undefined, b: PersonDoc) => !a || ((b.status === 'potvrzeno' ? 1 : 0) - (a.status === 'potvrzeno' ? 1 : 0) || (b.valid_to ?? '').localeCompare(a.valid_to ?? '')) > 0
  const best = new Map<string, PersonDoc>()
  for (const d of docs) if (d.kind === 'op' || d.kind === 'pas') { const k = d.person_id + d.kind; if (better(best.get(k), d)) best.set(k, d) }
  for (const d of best.values()) {
    const cur = m.get(d.person_id) ?? { person_id: d.person_id, id_number: null, id_valid_to: null, passport_number: null, passport_valid_to: null }
    if (d.kind === 'op') { cur.id_number = d.number; cur.id_valid_to = d.valid_to } else { cur.passport_number = d.number; cur.passport_valid_to = d.valid_to }
    m.set(d.person_id, cur)
  }
  return m
}
export interface Car {
  id: string; plate: string | null; model: string | null; color: string | null; car_no: string | null
  loc: string | null; category: string | null; gps: string | null; uta_card: string | null; owner: string | null
  insurer: string | null; stk_until: string | null; vignette_until: string | null; tyres: string | null
  state: string | null; note: string | null; label: string
  car_category: string | null; gps_platform: 'GpsGate' | 'RexGPS' | null
  service_last_km: number | null; km_current: number | null; service_next_km: number | null; km_updated: string | null
  purchase_date: string | null; purchase_price: number | null; purchase_km: number | null; vin: string | null; year: number | null
  service_group: string | null; service_at: string | null
}
export interface CarCategory { name: string; kind: 'own' | 'rental' | 'driver'; sort: number; visible: boolean }
export interface Place { id: string; name: string; travel_time: string | null; ferry: boolean; city: string | null }
export interface Status { name: string; color: string; sort: number; sent: boolean }
export interface Trip {
  id: string; trip_date: string; trip_time: string | null; pup_id: string | null; dop_id: string | null
  guard1_id: string | null; guard2_id: string | null; guard3_id: string | null; car_id: string | null
  car_origin: string | null; car_origin_other: string | null; ref_tcs: string | null; status: string | null
  remarks: string | null; crew_change: string | null; updated_at: string; updated_by: string | null
  customer: string | null; report_no: number | null
  dep_home: string | null; arr_pup: string | null; dep_pup: string | null; arr_dop: string | null; dep_dop: string | null; arr_home: string | null
  km_pup: number | null; km_dop: number | null; km_total: number | null; toll: number | null; hours_manual: number | null; report_note: string | null
  route_price_id: string | null
  price_manual: number | null
  start_at: string | null
  home_at: string | null
  route_id: string | null
  base_from: string
  base_to: string
  combi: boolean | null
  takeover: boolean
  kind: 'escort' | 'transport' | null
  guard1_supplier: string | null; guard2_supplier: string | null; guard3_supplier: string | null   // null = podle člověka
  car_supplier: string | null; supplier_km: number | null; supplier_toll: number | null             // auto od dodavatele
  report_done_at: string | null   // report uzavřený tlačítkem Hotovo
  report_series: string | null    // řada čísel reportů (podle zákazníka: TCS, JTI-AGS, JTI-CZ, JTI-SK)
  customer_ref: string | null     // reference zákazníka (JTi…), u opakujících se tras výchozí z trasy
}
// Tok: Finished v Planningu → cesta je v Reportech k dopsání → Hotovo (report_done_at) → z Planningu do Historie.
export const reportDone = (t: Pick<Trip, 'status' | 'report_done_at'>) => t.status === 'Finished' && t.report_done_at != null
export const REPORT_DONE_OR = 'status.neq.Finished,status.is.null,report_done_at.is.null'   // filtr „není vyřízená“ pro PostgREST

// Dodavatel člena posádky na dané cestě: přepsaný u cesty, jinak výchozí u člověka, jinak bez dodavatele
export function supplierOf(t: Pick<Trip, 'guard1_id' | 'guard2_id' | 'guard3_id' | 'guard1_supplier' | 'guard2_supplier' | 'guard3_supplier'>, personId: string, personBy: Map<string, Person>): string {
  const slot = t.guard1_id === personId ? t.guard1_supplier : t.guard2_id === personId ? t.guard2_supplier : t.guard3_id === personId ? t.guard3_supplier : null
  return slot ?? personBy.get(personId)?.supplier ?? NO_SUPPLIER
}
export interface Customer { name: string; sort: number; active: boolean; report_series: string }
// Zákazník, který nám dává A-referenci a číslo reportu z řady TCS (TCS NL, TCS DE); ostatní (JTi…) mají jen referenci zákazníka
export const isTcsCustomer = (customer: string | null | undefined, customers: Customer[]) => customers.find(c => c.name === customer)?.report_series === 'TCS'
export interface Route {
  id: string; pup_id: string; dop_id: string
  ho_pup_km: number | null; ho_pup_h: number | null; ho_pup_toll: number | null
  pup_dop_km: number | null; pup_dop_h: number | null; pup_dop_toll: number | null
  dop_ho_km: number | null; dop_ho_h: number | null; dop_ho_toll: number | null
  rate_h: number; rate_km: number; note: string | null; copied_from: string | null; base_from: string; base_to: string; variant: string; stops: string[]; updated_at: string
  customer: string | null; currency: 'EUR' | 'CZK'; customer_ref: string | null
}
export interface RoutePrice { id: string; route_id: string; label: string; pup_dop_h: number | null; price: number; sort: number; currency: 'EUR' | 'CZK'; free_load_h: number | null; free_unload_h: number | null }

export type RouteTime = { id: string; pup_id: string; dop_id: string; ho_pup_h: number | null; dop_ho_h: number | null; base_from: string; base_to: string; variant: string; stops: string[] }
export interface TripStop { id: string; trip_id: string; seq: number; place_id: string; arr: string | null; dep: string | null; km: number | null; note: string | null }
export type StopsMap = Map<string, TripStop[]>
// Varianty trasy pro cestu (stejný Pup, Dop, základny) a výběr té, která platí: zvolená, jinak základní (bez názvu), jinak první
export const routeKeyOf = (pup: string | null, dop: string | null, from: string, to: string, stops: string[] = []) => `${pup}|${dop}|${from}|${to}|${stops.join(',')}`
export const tripRouteKey = (t: Pick<Trip, 'pup_id' | 'dop_id' | 'base_from' | 'base_to'>, stops: TripStop[] = []) => routeKeyOf(t.pup_id, t.dop_id, t.base_from, t.base_to, stops.map(s => s.place_id))
export function groupRoutes<R extends { pup_id: string; dop_id: string; base_from: string; base_to: string; variant: string; stops: string[] }>(list: R[]) {
  const m = new Map<string, R[]>()
  for (const r of list) { const k = routeKeyOf(r.pup_id, r.dop_id, r.base_from, r.base_to, r.stops); if (!m.has(k)) m.set(k, []); m.get(k)!.push(r) }
  for (const v of m.values()) v.sort((a, b) => a.variant.localeCompare(b.variant, 'cs'))
  return m
}
export function pickRoute<R extends { id: string; variant: string; customer?: string | null }>(t: Pick<Trip, 'route_id' | 'customer'>, variants: R[] | undefined): R | undefined {
  if (!variants?.length) return undefined
  const chosen = t.route_id && variants.find(r => r.id === t.route_id)
  if (chosen) return chosen
  // stejná trasa může mít ceník pro víc zákazníků: přednost má trasa zákazníka cesty
  const mine = variants.filter(r => !r.customer || r.customer === t.customer)
  const pool = mine.length ? mine : variants
  return pool.find(r => r.variant === '') || pool[0]
}
export const variantLabel = (v: string) => v || 'základní'
// Druh cesty: doprovod (standard) nebo přeprava dodávkou; když není zadán, JTi* = přeprava, ostatní doprovod
export const tripKind = (t: Pick<Trip, 'kind' | 'customer'>) => t.kind ?? ((t.customer ?? '').toUpperCase().startsWith('JTI') ? 'transport' : 'escort')
export const KIND_LABEL = { escort: 'Doprovod', transport: 'Přeprava dodávkou' } as const
export interface Base { code: string; name: string; sort: number }
export const baseLabel = (from: string, to: string) => from === 'CZ' && to === 'CZ' ? '' : `${from} → ${to}`
export interface HoursExtra { id: string; person_id: string; work_date: string; kind: 'mimo' | 'pevne'; hours: number; note: string | null }

// Vykládky cesty: Dop (první) + další v trip_stops; konec práce = odjezd z poslední vykládky
export const stopsOf = (t: Pick<Trip, 'id'>, stops: StopsMap) => stops.get(t.id) ?? []
export const lastDropId = (t: Pick<Trip, 'id' | 'dop_id'>, stops: StopsMap) => { const s = stopsOf(t, stops); return s.length ? s[s.length - 1].place_id : t.dop_id }
export const jobEnd = (t: Pick<Trip, 'id' | 'dep_dop'>, stops: StopsMap) => { const s = stopsOf(t, stops); return s.length ? (s[s.length - 1].dep ?? null) : t.dep_dop }
export async function loadStops(tripIds: string[]): Promise<StopsMap> {
  const m: StopsMap = new Map()
  for (let i = 0; i < tripIds.length; i += 200) {
    const { data } = await supabase.from('trip_stops').select('*').in('trip_id', tripIds.slice(i, i + 200)).order('seq')
    for (const s of (data as TripStop[]) ?? []) { if (!m.has(s.trip_id)) m.set(s.trip_id, []); m.get(s.trip_id)!.push(s) }
  }
  return m
}
