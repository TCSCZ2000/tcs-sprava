import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const configured = Boolean(url && key)
export const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export type Level = 'none' | 'read' | 'write'
export type Role = 'admin' | 'dispatcher' | 'viewer'

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
  id: string; plate: string; model: string | null; color: string | null; car_no: string | null
  loc: string | null; category: string | null; gps: string | null; uta_card: string | null; owner: string | null
  insurer: string | null; stk_until: string | null; vignette_until: string | null; tyres: string | null
  state: string | null; note: string | null; label: string
}
export interface Place { id: string; name: string; travel_time: string | null; ferry: boolean }
export interface Status { name: string; color: string; sort: number; sent: boolean }
export interface Trip {
  id: string; trip_date: string; trip_time: string | null; pup_id: string | null; dop_id: string | null
  guard1_id: string | null; guard2_id: string | null; guard3_id: string | null; car_id: string | null
  car_origin: string | null; car_origin_other: string | null; ref_tcs: string | null; status: string | null
  remarks: string | null; crew_change: string | null; updated_at: string; updated_by: string | null
}
