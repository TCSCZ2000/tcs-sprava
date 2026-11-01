import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, type Car, type Level, type Person, type PersonDocs, type Place, type Profile, type Status, type Customer } from './supabase'

export const MODULES = ['planning', 'planning_create', 'planning_status', 'planning_crew', 'planning_route', 'podklad', 'reports', 'people', 'people_docs', 'cars', 'places', 'users'] as const
export type ModuleKey = (typeof MODULES)[number]

interface Ctx {
  session: Session | null
  profile: Profile | null
  loading: boolean
  level: (m: ModuleKey) => Level
  people: Person[]
  docs: Map<string, PersonDocs>
  cars: Car[]
  places: Place[]
  statuses: Status[]
  customers: Customer[]
  reloadLists: () => Promise<void>
  toast: (msg: string, kind?: 'ok' | 'err') => void
  toastMsg: { msg: string; kind: 'ok' | 'err' } | null
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx)
export const useApp = () => useContext(AppCtx)

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [loading, setLoading] = useState(true)
  const [people, setPeople] = useState<Person[]>([])
  const [docs, setDocs] = useState<Map<string, PersonDocs>>(new Map())
  const [cars, setCars] = useState<Car[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [statuses, setStatuses] = useState<Status[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [toastMsg, setToast] = useState<Ctx['toastMsg']>(null)

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind })
    window.setTimeout(() => setToast(null), kind === 'err' ? 6000 : 2500)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const reloadLists = useCallback(async () => {
    const [p, d, c, pl, st, cu] = await Promise.all([
      supabase.from('people').select('*').order('last_name'),
      supabase.from('person_docs').select('*'),
      supabase.from('cars').select('*').order('car_no'),
      supabase.from('places').select('*').order('name'),
      supabase.from('statuses').select('*').order('sort'),
      supabase.from('customers').select('*').order('sort'),
    ])
    setPeople((p.data as Person[]) ?? [])
    setDocs(new Map(((d.data as PersonDocs[]) ?? []).map(x => [x.person_id, x])))
    setCars((c.data as Car[]) ?? [])
    setPlaces((pl.data as Place[]) ?? [])
    setStatuses((st.data as Status[]) ?? [])
    setCustomers((cu.data as Customer[]) ?? [])
  }, [])

  useEffect(() => {
    if (!session) { setProfile(null); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const uid = session.user.id
      const [pr, rd, pm] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
        supabase.from('role_defaults').select('*'),
        supabase.from('permissions').select('*').eq('user_id', uid),
      ])
      if (cancelled) return
      const prof = pr.data as Profile | null
      setProfile(prof)
      const lv: Record<string, Level> = {}
      if (prof && prof.active) {
        for (const r of (rd.data ?? []) as { role: string; module: string; level: Level }[])
          if (r.role === prof.role) lv[r.module] = r.level
        for (const r of (pm.data ?? []) as { module: string; level: Level }[]) lv[r.module] = r.level
        // stejně jako perm() v databázi: Správce vše, Náhled nejvýš čte
        for (const m of MODULES) {
          if (prof.role === 'admin') lv[m] = 'write'
          else if (prof.role === 'viewer' && lv[m] === 'write') lv[m] = 'read'
        }
      }
      setLevels(lv)
      if (prof && prof.active) await reloadLists()
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [session, reloadLists])

  // Živé změny číselníků
  useEffect(() => {
    if (!profile) return
    const ch = supabase.channel('ciselniky')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'people' }, () => reloadLists())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cars' }, () => reloadLists())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'places' }, () => reloadLists())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [profile, reloadLists])

  const level = useCallback((m: ModuleKey): Level => levels[m] ?? 'none', [levels])

  const value = useMemo(() => ({
    session, profile, loading, level, people, docs, cars, places, statuses, customers, reloadLists, toast, toastMsg,
  }), [session, profile, loading, level, people, docs, cars, places, statuses, customers, reloadLists, toast, toastMsg])

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

// Chybové hlášky z databáze do lidské řeči
export function explain(err: { message?: string; code?: string } | null): string {
  if (!err) return ''
  const m = err.message ?? ''
  if (m.startsWith('Nemáte oprávnění')) return m
  if (m.includes('trips_ref_tcs_check')) return 'Ref. TCS musí mít tvar A12345.'
  if (m.includes('trips_ref_tcs_key')) return 'Tohle Ref. TCS už má jiná cesta.'
  if (m.includes('row-level security') || err.code === '42501') return 'Na tuhle změnu nemáte oprávnění.'
  if (m.includes('duplicate key')) return 'Tahle hodnota už v seznamu je.'
  return m
}
