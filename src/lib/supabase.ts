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
  id: string; first_name: string; last_name: string; short_name: string; phone: string | null
  birth_date: string | null; nationality: string | null; active: boolean; note: string | null
}
export interface PersonDocs {
  person_id: string; id_number: string | null; id_valid_to: string | null
  passport_number: string | null; passport_valid_to: string | null
}
export interface Car {
  id: string; plate: string | null; model: string | null; color: string | null; car_no: string | null
  loc: string | null; category: string | null; gps: string | null; uta_card: string | null; owner: string | null
  insurer: string | null; stk_until: string | null; vignette_until: string | null; tyres: string | null
  state: string | null; note: string | null; label: string
  car_category: string | null; gps_platform: 'GpsGate' | 'RexGPS' | null
  service_last_km: number | null; km_current: number | null; service_next_km: number | null; km_updated: string | null
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
  home_base: 'CZ' | 'NL'
  combi: boolean | null
  takeover: boolean
}
export interface Customer { name: string; sort: number; active: boolean }
export interface Route {
  id: string; pup_id: string; dop_id: string
  ho_pup_km: number | null; ho_pup_h: number | null; ho_pup_toll: number | null
  pup_dop_km: number | null; pup_dop_h: number | null; pup_dop_toll: number | null
  dop_ho_km: number | null; dop_ho_h: number | null; dop_ho_toll: number | null
  rate_h: number; rate_km: number; note: string | null; copied_from: string | null; home_base: string
}
export interface RoutePrice { id: string; route_id: string; label: string; pup_dop_h: number | null; price: number; sort: number }

export type RouteTime = { pup_id: string; dop_id: string; ho_pup_h: number | null; dop_ho_h: number | null; home_base: string }
export interface HoursExtra { id: string; person_id: string; work_date: string; kind: 'mimo' | 'pevne'; hours: number; note: string | null }
