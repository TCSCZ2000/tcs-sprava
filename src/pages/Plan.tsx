import { useEffect, useMemo, useState } from 'react'
import { supabase, type RouteTime, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { carAlerts, inPlanning } from '../lib/cars'
import { addHoursIso, computeStart, dateLabel, docState, fmtDT, fmtRel, hm, inkOn, parseDT, todayIso } from '../lib/format'

type GuardKey = 'guard1_id' | 'guard2_id' | 'guard3_id'
const GUARDS: GuardKey[] = ['guard1_id', 'guard2_id', 'guard3_id']
const GROUP = 'Skupina ✅'
const REPORT = 'Report'
const NO_CUSTOMER = '—'
const EARLY = ['HEADS-UP', 'Confirmed', 'Send']

export default function Plan() {
  const { level, people, cars, places, statuses: allStatuses, customers, carCategories, docs, toast, reloadLists } = useApp()
  // Report = cesta odjela a čeká na dopsání reportu v záložce Reporty, v Planningu není
  const statuses = useMemo(() => allStatuses.filter(s => s.name !== REPORT), [allStatuses])
  const canNotes = level('planning') === 'write'
  const canCreate = level('planning_create') === 'write'
  const canStatus = level('planning_status') === 'write'
  const canCrew = level('planning_crew') === 'write'
  const canRoute = level('planning_route') === 'write'
  const canAddPlace = level('places') === 'write'
  const [trips, setTrips] = useState<Trip[]>([])
  const [from, setFrom] = useState('')
  const [hist, setHist] = useState(false)
  const [routeTimes, setRouteTimes] = useState<RouteTime[]>([]) // Historie = vyřízené cesty (Finished s hotovým reportem)
  const [to, setTo] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hiddenCust, setHiddenCust] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [carFilter, setCarFilter] = useState<string | null>(null)
  const [fleetOpen, setFleetOpen] = useState(true)
  const [view, setView] = usePref<'days' | 'list' | 'customers'>('plan.view', 'days')
  const [size, setSize] = usePref<'m' | 's' | 'xs'>('plan.size', 'm')

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const personByName = useMemo(() => new Map(people.map(p => [p.short_name.toLowerCase(), p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const placeByName = useMemo(() => new Map(places.map(p => [p.name.toLowerCase(), p])), [places])
  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const carByLabel = useMemo(() => {
    const m = new Map<string, string>()
    // nejdřív všechna auta, pak ta v Planningu (mají přednost při stejném popisu, např. vrácené a nové Sixt1)
    for (const c of [...cars, ...cars.filter(x => inPlanning(x, carCategories))]) {
      m.set(c.label.toLowerCase(), c.id); if (c.plate) m.set(c.plate.toLowerCase(), c.id); if (c.car_no) m.set(c.car_no.toLowerCase(), c.id)
    }
    return m
  }, [cars, carCategories])
  const statusBy = useMemo(() => new Map(statuses.map(s => [s.name, s])), [statuses])
  const routeTimeBy = useMemo(() => new Map(routeTimes.map(r => [`${r.pup_id}|${r.dop_id}|${r.home_base}`, r])), [routeTimes])
  // Náhrada, když celá trasa chybí: HO→PUP z jiné trasy ze stejného Pup, DOP→HO z jiné trasy na stejný Dop
  // (jen trasy se stejnou základnou CZ/NL; při víc hodnotách ta nejčastější)
  const [pupH, dopH] = useMemo(() => {
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
    return [pick('pup_id', 'ho_pup_h'), pick('dop_id', 'dop_ho_h')]
  }, [routeTimes])

  // Doby jízdy z kalkulací tras (HO→PUP, DOP→HO) – přes funkci, aby je viděl i ten, kdo nevidí ceny
  useEffect(() => {
    supabase.rpc('route_times').then(({ data }) => setRouteTimes((data as RouteTime[]) ?? []))
  }, [])

  useEffect(() => {
    // Plán: všechny cesty bez ohledu na datum, dokud nejsou vyřízené (Finished s hotovým reportem).
    // Historie: jen vyřízené. Od/Do omezí obojí.
    let qb = supabase.from('trips').select('*')
    qb = hist ? qb.eq('status', 'Finished').not('report_no', 'is', null) : qb.or('status.neq.Finished,status.is.null,report_no.is.null')
    if (from) qb = qb.gte('trip_date', from)
    if (to) qb = qb.lte('trip_date', to)
    qb.order('trip_date').order('trip_time', { nullsFirst: true })
      .then(({ data, error }) => {
      if (error) toast(explain(error), 'err')
      setTrips((data as Trip[]) ?? [])
      setLoaded(true)
    })
  }, [from, to, hist, toast])

  const resolved = (t: Trip) => t.status === 'Finished' && t.report_no != null

  // Živé změny od ostatních
  useEffect(() => {
    const ch = supabase.channel('trips')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, payload => {
        setTrips(cur => {
          if (payload.eventType === 'DELETE') return cur.filter(t => t.id !== (payload.old as Trip).id)
          const row = payload.new as Trip
          const i = cur.findIndex(t => t.id === row.id)
          if (i === -1) return [...cur, row]
          const next = cur.slice(); next[i] = row; return next
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  async function save(t: Trip, patch: Partial<Trip>) {
    const prev = t
    setTrips(cur => cur.map(x => (x.id === t.id ? { ...x, ...patch } : x)))
    const { data, error } = await supabase.from('trips').update(patch).eq('id', t.id).select().single()
    if (error) {
      toast(explain(error), 'err')
      setTrips(cur => cur.map(x => (x.id === t.id ? prev : x)))
    } else {
      setTrips(cur => cur.map(x => (x.id === t.id ? (data as Trip) : x)))
    }
  }

  async function orderRental(t: Trip, company: string) {
    const { data, error } = await supabase.from('cars').insert({ car_category: company }).select().single()
    if (error) return toast(explain(error), 'err')
    const { data: fresh } = await supabase.from('cars').select('*').eq('id', (data as { id: string }).id).single()
    await reloadLists()
    await save(t, { car_id: (data as { id: string }).id })
    toast(`Objednané auto ${(fresh as { car_no: string | null } | null)?.car_no ?? company} přidáno. SPZ a model doplňte v Autech, až je budete znát.`)
  }

  async function addTrip() {
    const date = from > todayIso() ? from : todayIso(1)
    const { data, error } = await supabase.from('trips').insert({ trip_date: date, status: 'HEADS-UP' }).select().single()
    if (error) return toast(explain(error), 'err')
    setTrips(cur => (cur.some(x => x.id === (data as Trip).id) ? cur : [...cur, data as Trip]))
    toast('Cesta přidána')
  }

  async function removeTrip(t: Trip) {
    if (!window.confirm('Smazat tuhle cestu? Zrušené cesty je lepší nechat se statusem Canceled.')) return
    const { error } = await supabase.from('trips').delete().eq('id', t.id)
    if (error) return toast(explain(error), 'err')
    setTrips(cur => cur.filter(x => x.id !== t.id))
  }

  async function resolvePlace(name: string): Promise<string | null | undefined> {
    const n = name.trim()
    if (!n) return null
    const hit = placeByName.get(n.toLowerCase())
    if (hit) return hit.id
    if (!canAddPlace) { toast(`Místo „${n}“ není v seznamu míst.`, 'err'); return undefined }
    const { data, error } = await supabase.from('places').insert({ name: n }).select().single()
    if (error) { toast(explain(error), 'err'); return undefined }
    await reloadLists()
    toast(`Nové místo „${n}“ přidáno. Doplňte mu dobu jízdy v Místech.`)
    return (data as { id: string }).id
  }

  // Dvojí přiřazení stejného dne
  const clashes = useMemo(() => {
    const seen = new Map<string, number>()
    for (const t of trips) {
      if (t.status === 'Canceled') continue
      for (const k of [...GUARDS, 'car_id' as const]) {
        const v = t[k]; if (!v) continue
        const key = `${t.trip_date}|${v}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
    return seen
  }, [trips])
  const clash = (t: Trip, id: string | null) => !!id && t.status !== 'Canceled' && (clashes.get(`${t.trip_date}|${id}`) ?? 0) > 1

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    return trips
      .filter(t => t.status !== REPORT && resolved(t) === hist)
      .filter(t => (!from || t.trip_date >= from) && (!to || t.trip_date <= to))
      .filter(t => !hidden.has(t.status ?? ''))
      .filter(t => !hiddenCust.has(t.customer ?? NO_CUSTOMER))
      .filter(t => !carFilter || t.car_id === carFilter)
      .filter(t => {
        if (!s) return true
        const hay = [
          placeBy.get(t.pup_id ?? '')?.name, placeBy.get(t.dop_id ?? '')?.name,
          ...GUARDS.map(g => personBy.get(t[g] ?? '')?.short_name),
          carBy.get(t.car_id ?? '')?.label, t.ref_tcs, t.remarks,
        ].join(' ').toLowerCase()
        return hay.includes(s)
      })
      .sort((a, b) => (a.trip_date + (a.trip_time ?? '')).localeCompare(b.trip_date + (b.trip_time ?? '')))
  }, [trips, hidden, hiddenCust, q, placeBy, personBy, carBy, from, to, carFilter, hist])

  const days = useMemo(() => {
    if (view === 'list') return [['all', visible] as [string, Trip[]]]
    if (view === 'customers') {
      const order = [...customers.map(c => c.name), NO_CUSTOMER]
      const m = new Map<string, Trip[]>(order.map(c => [c, []]))
      for (const t of visible) m.get(t.customer ?? NO_CUSTOMER)?.push(t)
      return [...m.entries()].filter(([, r]) => r.length)
    }
    const m = new Map<string, Trip[]>()
    for (const t of visible) { if (!m.has(t.trip_date)) m.set(t.trip_date, []); m.get(t.trip_date)!.push(t) }
    return [...m.entries()]
  }, [visible, view, customers])

  // Jako v Excelu: kolikrát je auto v celém plánu (bez Finished a Canceled)
  const carUse = useMemo(() => {
    const m = new Map<string, Trip[]>()
    for (const t of trips) {
      if (!t.car_id || t.status === 'Finished' || t.status === 'Canceled' || t.status === REPORT) continue
      if (!m.has(t.car_id)) m.set(t.car_id, [])
      m.get(t.car_id)!.push(t)
    }
    return m
  }, [trips])
  const useTitle = (id: string) => (carUse.get(id) ?? [])
    .map(t => `${dateLabel(t.trip_date)} ${hm(t.trip_time)} ${placeBy.get(t.pup_id ?? '')?.name ?? ''} → ${placeBy.get(t.dop_id ?? '')?.name ?? ''}`).join('\n')
  const fleet = cars.filter(c => inPlanning(c, carCategories))

  function toggleStatus(name: string) {
    setHidden(cur => { const n = new Set(cur); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  return (
    <section className={'plan size-' + size + ' view-' + view}>
      <div className="toolbar">
        <label className="field">Od<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="field">Do<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <div className="seg" role="group" aria-label="Plán nebo historie">
          <button className={hist ? '' : 'on'} aria-pressed={!hist} onClick={() => setHist(false)} title="Všechny cesty, které ještě nemají hotový report">Plán</button>
          <button className={hist ? 'on' : ''} aria-pressed={hist} onClick={() => setHist(true)} title="Vyřízené cesty: Finished s hotovým reportem">Historie</button>
        </div>
        <input className="search" placeholder="Hledat místo, jméno, SPZ, Ref…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="statusfilter">
          {statuses.map(s => (
            <button key={s.name} className={'chip' + (hidden.has(s.name) ? ' off' : '')}
              style={{ ['--c' as string]: s.color }} onClick={() => toggleStatus(s.name)} title={hidden.has(s.name) ? 'Zobrazit' : 'Skrýt'}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="statusfilter custfilter">
          {[...customers.map(c => c.name), NO_CUSTOMER].map(c => (
            <button key={c} className={'chip cust' + (hiddenCust.has(c) ? ' off' : '')}
              onClick={() => setHiddenCust(cur => { const n = new Set(cur); n.has(c) ? n.delete(c) : n.add(c); return n })}
              title={hiddenCust.has(c) ? 'Zobrazit' : 'Skrýt'}>{c === NO_CUSTOMER ? 'bez zákazníka' : c}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Zobrazení">
          <button className={view === 'days' ? 'on' : ''} aria-pressed={view === 'days'} onClick={() => setView('days')}>Po dnech</button>
          <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>Seznam</button>
          <button className={view === 'customers' ? 'on' : ''} aria-pressed={view === 'customers'} onClick={() => setView('customers')}>Po zákaznících</button>
        </div>
        <div className="seg" role="group" aria-label="Velikost písma">
          <button className={'fs-m' + (size === 'm' ? ' on' : '')} aria-pressed={size === 'm'} onClick={() => setSize('m')} title="Normální písmo">A</button>
          <button className={'fs-s' + (size === 's' ? ' on' : '')} aria-pressed={size === 's'} onClick={() => setSize('s')} title="Menší písmo">A</button>
          <button className={'fs-xs' + (size === 'xs' ? ' on' : '')} aria-pressed={size === 'xs'} onClick={() => setSize('xs')} title="Nejmenší písmo">A</button>
        </div>
        {canCreate && !hist && <button className="primary" onClick={addTrip}>Nová cesta</button>}
      </div>

      <datalist id="dl-status">{allStatuses.map(x => <option key={x.name} value={x.name} />)}</datalist>
      <datalist id="dl-people">{people.filter(p => p.active).map(p => <option key={p.id} value={p.short_name} />)}</datalist>
      <datalist id="dl-places">{places.map(p => <option key={p.id} value={p.name} />)}</datalist>
      <datalist id="dl-cars">{fleet.map(c => <option key={c.id} value={c.label} />)}</datalist>

      {fleet.length > 0 && (
        <div className="fleet" aria-label="Auta v plánu">
          <button className="fleetlabel link" onClick={() => setFleetOpen(o => !o)}>
            Auta v plánu: {fleet.filter(c => carUse.has(c.id)).length} jede, {fleet.filter(c => !carUse.has(c.id)).length} volných
          </button>
          {fleetOpen && fleet.map(c => {
            const n = carUse.get(c.id)?.length ?? 0
            const al = carAlerts(c)
            return (
              <button key={c.id} className={'car' + (n ? ' used' : '') + (carFilter === c.id ? ' on' : '') + (c.state === 'V opravě' ? ' repair' : '') + (al.some(a => a.level === 'due') ? ' warn-due' : al.length ? ' warn-soon' : '')}
                title={`${c.label}${c.gps_platform ? ' · ' + c.gps_platform : ''}${c.state === 'V opravě' ? ' · v opravě' : ''}${al.length ? '\n⚠ ' + al.map(a => a.text).join(', ') : ''}${n ? '\n' + useTitle(c.id) : '\nvolné'}`}
                onClick={() => setCarFilter(f => (f === c.id ? null : c.id))}>
                {c.car_no ?? c.plate}{!c.plate && <span className="times">?</span>}{n > 1 && <span className="times">{n}×</span>}
              </button>
            )
          })}
          {carFilter && <button className="link" onClick={() => setCarFilter(null)}>Zobrazit všechna auta</button>}
        </div>
      )}

      <div className="tablewrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="w-status">Status</th><th className="w-cust">Zákazník</th><th className="w-date">Datum</th><th className="w-time">Čas</th><th>Pup</th><th>Dop</th>
              <th>Guard 1</th><th>Guard 2</th><th>Guard 3</th><th>Auto</th><th>Odkud</th>
              <th className="w-ref">Ref. TCS</th><th className="w-nl" title="NL–NL: posádka vyjíždí z NL a vrací se do NL">NL</th><th className="w-dt" title="Čas − HO→PUP z trasy (nebo doba jízdy v Místech). Kliknutím přepíšete ručně.">Start</th><th className="w-dt" title="Kdy posádka skončila na Dop (= Odjezd Dop v reportu). Pište 9:45 nebo 3.11. 9:45.">Konec Dop</th><th className="w-dt" title="Konec Dop + DOP→HO z trasy, nahoru na čtvrthodiny. Kliknutím přepíšete ručně.">Home</th><th>Poznámka</th><th>Změna</th>
              {canCreate && <th className="w-x" aria-label="Akce" />}
            </tr>
          </thead>
          {days.map(([date, rows]) => (
            <tbody key={date}>
              {view === 'customers' && <tr className="dayrow">
                <td colSpan={canCreate ? 19 : 18}>
                  <span className="daylabel">{date === NO_CUSTOMER ? 'Bez zákazníka' : date}</span>
                  <span className="daycount">{rows.length} {rows.length === 1 ? 'cesta' : rows.length < 5 ? 'cesty' : 'cest'}</span>
                </td>
              </tr>}
              {view === 'days' && <tr className="dayrow">
                <td colSpan={canCreate ? 19 : 18}>
                  <span className="daylabel">{dateLabel(date)}</span>
                  <span className="daycount">{rows.length} {rows.length === 1 ? 'cesta' : rows.length < 5 ? 'cesty' : 'cest'}</span>
                </td>
              </tr>}
              {rows.map((t, i) => {
                const st = statusBy.get(t.status ?? '')
                const pup = placeBy.get(t.pup_id ?? '')
                const car = carBy.get(t.car_id ?? '')
                const rt = routeTimeBy.get(`${t.pup_id}|${t.dop_id}|${t.home_base}`)
                const nl = t.home_base === 'NL'
                const reqIso = t.trip_time ? `${t.trip_date}T${t.trip_time.slice(0, 5)}:00` : null
                // Start: ručně > z trasy (HO→PUP) > doba jízdy v Místech
                const hoPup = rt?.ho_pup_h != null ? Number(rt.ho_pup_h) : !rt && t.pup_id ? pupH.get(`${t.home_base}|${t.pup_id}`) : undefined
                const hoPupFrom = (rt?.ho_pup_h != null ? 'z trasy' : 'z jiné trasy ze stejného Pup') + (nl ? ' (NL–NL)' : '')
                const startAuto = hoPup != null && reqIso ? fmtRel(addHoursIso(reqIso, -hoPup, 5), t.trip_date)
                  : computeStart(t.trip_date, t.trip_time, pup?.travel_time ?? null, pup?.ferry ?? false)
                const start = t.start_at ? fmtRel(t.start_at, t.trip_date) : startAuto
                const startHow = t.start_at ? 'Zadáno ručně' : hoPup != null ? `HO→PUP ${hoPup} h ${hoPupFrom}` : pup?.travel_time ? 'Z doby jízdy v Místech (žádná trasa z tohoto Pup nemá HO→PUP)' : 'Chybí trasa i doba jízdy'
                // Home: ručně > konec Dop + DOP→HO z trasy (nebo z jiné trasy na stejný Dop)
                const dopHo = rt?.dop_ho_h != null ? Number(rt.dop_ho_h) : !rt && t.dop_id ? dopH.get(`${t.home_base}|${t.dop_id}`) : undefined
                const dopHoFrom = (rt?.dop_ho_h != null ? 'z trasy' : 'z jiné trasy na stejný Dop') + (nl ? ' (NL–NL)' : '')
                const homeAuto = t.dep_dop && dopHo != null ? fmtRel(addHoursIso(t.dep_dop, dopHo), t.trip_date) : ''
                const home = t.home_at ? fmtRel(t.home_at, t.trip_date) : homeAuto
                const homeHow = t.home_at ? 'Zadáno ručně' : homeAuto ? `Konec Dop + DOP→HO ${dopHo} h ${dopHoFrom}` : !t.dep_dop ? 'Vyplňte Konec Dop' : 'Žádná trasa na tento Dop nemá DOP→HO'
                const saveDT = (key: 'start_at' | 'dep_dop' | 'home_at', v: string, base: string) => {
                  const r = parseDT(v, base, key !== 'start_at')
                  if (r === undefined) return toast('Čas zapište jako 9:45 nebo 3.11. 9:45.', 'err')
                  save(t, { [key]: r } as Partial<Trip>)
                }
                return (
                  <tr key={t.id} className={'trip' + (view !== 'days' && i > 0 && rows[i - 1].trip_date !== t.trip_date ? ' newday' : '')}
                    style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                    <td className="statuscell">
                      <StatusInput disabled={!canStatus} color={st?.color}
                        value={statusLabel(t.status, t.ref_tcs)} title={t.ref_tcs ? `${t.ref_tcs} · ${t.status ?? 'bez statusu'}` : t.status ?? undefined}
                        onSave={v => {
                          const n = v.trim()
                          if (!n) return
                          // Nové referenční číslo posune cestu na Skupinu jen z ranějších stavů; jinak status drží
                          if (/^a\d{5}$/i.test(n)) return save(t, {
                            ref_tcs: n.toUpperCase(),
                            status: !t.status || EARLY.includes(t.status) ? GROUP : t.status,
                          })
                          const hit = allStatuses.find(x => x.name.toLowerCase() === n.toLowerCase())
                          if (!hit) return toast(`Napište status ze seznamu nebo referenční číslo ve tvaru A12345.`, 'err')
                          save(t, { status: hit.name })
                          if (hit.name === REPORT) toast('Cesta přešla do záložky Reporty k dopsání reportu.')
                        }} />
                    </td>
                    <td className={'custcell' + (t.customer ? '' : ' missing')}>
                      <select disabled={!canRoute} value={t.customer ?? ''} onChange={e => save(t, { customer: e.target.value || null })}
                        aria-label="Zákazník">
                        <option value="">—</option>
                        {customers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    </td>
                    <td className="datecell"><Text disabled={!canRoute} value={shortDay(t.trip_date)} time
                      onSave={v => { const d = parseDay(v, t.trip_date); if (!d) return toast('Datum zapište jako 3.11. nebo 3.11.2026.', 'err'); save(t, { trip_date: d }) }} /></td>
                    <td><Text disabled={!canRoute} value={hm(t.trip_time)} placeholder="hh:mm" time
                      onSave={v => { const n = normTime(v); if (n === undefined) return toast('Čas zapište jako 8:30 nebo 0830.', 'err'); save(t, { trip_time: n }) }} /></td>
                    <td><Text disabled={!canRoute} list="dl-places" value={pup?.name ?? ''} wide
                      onSave={async v => { const id = await resolvePlace(v); if (id !== undefined) save(t, { pup_id: id }) }} /></td>
                    <td><Text disabled={!canRoute} list="dl-places" value={placeBy.get(t.dop_id ?? '')?.name ?? ''} wide
                      onSave={async v => { const id = await resolvePlace(v); if (id !== undefined) save(t, { dop_id: id }) }} /></td>
                    {GUARDS.map(g => {
                      const p = personBy.get(t[g] ?? '')
                      const d = p ? docState(docs.get(p.id)?.passport_valid_to ?? null) : null
                      const flagged = t.crew_change?.includes(`G${g[5]}:`)
                      return (
                        <td key={g} className={(clash(t, t[g]) ? 'clash ' : '') + (flagged ? 'changed ' : '')}
                          title={clash(t, t[g]) ? 'Tenhle člověk má ten den ještě jinou cestu' : d === 'expired' ? 'Pas po platnosti' : d === 'soon' ? 'Pas končí do 90 dní' : undefined}>
                          <Text disabled={!canCrew} list="dl-people" value={p?.short_name ?? ''} person
                            onSave={v => {
                              const n = v.trim()
                              if (!n) return save(t, { [g]: null } as Partial<Trip>)
                              const hit = personByName.get(n.toLowerCase())
                              if (!hit) return toast(`„${n}“ není v seznamu lidí. Přidejte ho nejdřív v Lidech.`, 'err')
                              save(t, { [g]: hit.id } as Partial<Trip>)
                            }} />
                          {d && <span className={'doc ' + d} aria-hidden>●</span>}
                        </td>
                      )
                    })}
                    <td className={(clash(t, t.car_id) ? 'clash ' : '') + (t.crew_change?.includes('Auto:') ? 'changed ' : '')
                      + (t.car_id && carUse.get(t.car_id)?.length === 1 ? 'once ' : '') + (car && !car.plate ? 'placeholder' : '')}
                      title={clash(t, t.car_id) ? 'Auto má ten den ještě jinou cestu'
                        : car && !car.plate ? `${car.car_no}: objednané auto, zatím bez SPZ a detailů`
                        : t.car_id ? `V plánu ${carUse.get(t.car_id)?.length ?? 0}×:\n${useTitle(t.car_id)}` : undefined}>
                      <Text disabled={!canCrew} list="dl-cars" value={car?.label ?? ''} carcell
                        onSave={v => {
                          const n = v.trim()
                          if (!n) return save(t, { car_id: null })
                          const id = carByLabel.get(n.toLowerCase()) ?? carByLabel.get(n.split(',')[0].trim().toLowerCase())
                          if (id) return save(t, { car_id: id })
                          // jen název půjčovny („Sixt“) → objednat nové auto s dalším číslem
                          const rental = carCategories.find(k => k.kind === 'rental' && k.name.toLowerCase() === n.toLowerCase())
                          if (rental) return orderRental(t, rental.name)
                          toast(`Auto „${n}“ není v seznamu aut. Pro nové auto z půjčovny napište jen název půjčovny, např. Sixt.`, 'err')
                        }} />
                      {t.car_id && (carUse.get(t.car_id)?.length ?? 0) > 1 && <span className="times cell-times">{carUse.get(t.car_id)!.length}×</span>}
                    </td>
                    <td className="origin">
                      <select disabled={!canCrew} value={t.car_origin ?? ''}
                        onChange={e => save(t, { car_origin: e.target.value || null, car_origin_other: e.target.value === 'Jiné' ? t.car_origin_other : null })}>
                        <option value="">–</option><option>Praha</option><option>Příbram</option><option>Jiné</option>
                      </select>
                      {t.car_origin === 'Jiné' && (
                        <Text disabled={!canCrew} value={t.car_origin_other ?? ''} placeholder="kde" onSave={v => save(t, { car_origin_other: v || null })} />
                      )}
                    </td>
                    <td><Text disabled={!canStatus} value={t.ref_tcs ?? ''} placeholder="A·····" mono
                      onSave={v => save(t, { ref_tcs: v.trim().toUpperCase() || null })} /></td>
                    <td className="nlcell">
                      <input type="checkbox" checked={nl} disabled={!canRoute} title="NL–NL: posádka vyjíždí z NL a vrací se do NL. Start a Home se pak berou z NL variant tras."
                        onChange={e => save(t, { home_base: e.target.checked ? 'NL' : 'CZ' })} />
                    </td>
                    <td className={'start' + (start === 'ferry' ? ' ferry' : '') + (t.start_at ? ' manual' : '') + (nl ? ' abroad' : '')} title={startHow}>
                      <Text disabled={!canRoute} value={start} time mono placeholder="–"
                        onSave={v => v.trim() ? saveDT('start_at', v, reqIso ?? `${t.trip_date}T00:00:00`) : save(t, { start_at: null })} />
                    </td>
                    <td className="start" title={t.dep_dop ? fmtDT(t.dep_dop) : undefined}>
                      <Text disabled={!canRoute} value={fmtRel(t.dep_dop, t.trip_date)} time mono placeholder="–"
                        onSave={v => v.trim() ? saveDT('dep_dop', v, reqIso ?? `${t.trip_date}T00:00:00`) : save(t, { dep_dop: null })} />
                    </td>
                    <td className={'start' + (t.home_at ? ' manual' : '')} title={homeHow}>
                      <Text disabled={!canRoute} value={home} time mono placeholder="–"
                        onSave={v => v.trim() ? saveDT('home_at', v, t.dep_dop ?? reqIso ?? `${t.trip_date}T00:00:00`) : save(t, { home_at: null })} />
                    </td>
                    <td><Text disabled={!canNotes} value={t.remarks ?? ''} wide onSave={v => save(t, { remarks: v || null })} /></td>
                    <td className="change">
                      {t.crew_change && (
                        <span className="changenote" title="Posádka se změnila po odeslání zákazníkovi">
                          {t.crew_change}
                          {(canNotes || canCrew) && <button className="link" onClick={() => save(t, { crew_change: null })}>Sděleno zákazníkovi</button>}
                        </span>
                      )}
                    </td>
                    {canCreate && <td className="w-x"><button className="ghost" title="Smazat cestu" aria-label="Smazat cestu" onClick={() => removeTrip(t)}>×</button></td>}
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
        {loaded && days.length === 0 && (
          <p className="empty">{hist ? 'V historii zatím nic není. Cesta se sem přesune, až jí v Reportech dáte Hotovo.' : <>Žádné cesty{hidden.size || hiddenCust.size || from || to ? ' s vybraným filtrem' : ''}.{canCreate && ' Přidejte první tlačítkem Nová cesta.'}</>}</p>
        )}
      </div>

    </section>
  )
}

function Text(props: {
  value: string; onSave: (v: string) => void; disabled?: boolean; list?: string; type?: string
  placeholder?: string; wide?: boolean; mono?: boolean; time?: boolean; person?: boolean; carcell?: boolean
}) {
  const [v, setV] = useState(props.value)
  useEffect(() => setV(props.value), [props.value])
  return (
    <input
      className={'cell' + (props.wide ? ' wide' : '') + (props.mono ? ' mono' : '') + (props.time ? ' time' : '') + (props.person ? ' person' : '') + (props.carcell ? ' carcell' : '')}
      value={v} type={props.type ?? 'text'} list={props.list} placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={e => setV(e.target.value)}
      onBlur={() => { if (v !== props.value) props.onSave(v) }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setV(props.value); (e.target as HTMLInputElement).blur() }
      }}
    />
  )
}

// Status: vyber ze seznamu, nebo napiš referenční číslo A12345 → Skupina
// Po kliknutí se políčko vyprázdní, aby nabídka ukázala všechny statusy; bez zápisu se vrátí původní hodnota
// Reference + zkratka stavu: A12345 (Skupina), A12345-Dep, A12345-Fin …
const SHORT: Record<string, string> = {
  'HEADS-UP': 'HU', Confirmed: 'Conf', Send: 'Send', 'On the road': 'Road', Departed: 'Dep', Report: 'Rep', Finished: 'Fin', Canceled: 'Canc',
}
function statusLabel(status: string | null, ref: string | null) {
  if (!ref) return status ?? ''
  if (!status || status === GROUP) return ref
  return `${ref}-${SHORT[status] ?? status}`
}

function StatusInput(props: { value: string; color?: string; disabled?: boolean; title?: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(props.value)
  const [editing, setEditing] = useState(false)
  useEffect(() => setV(props.value), [props.value])
  return (
    <input className="statusinput" list="dl-status" value={v} disabled={props.disabled} title={props.title}
      placeholder={editing ? props.value || 'status / A12345' : 'status / A12345'}
      style={{ background: props.color, color: props.color ? inkOn(props.color) : undefined }}
      onFocus={() => { setEditing(true); setV('') }}
      onChange={e => setV(e.target.value)}
      onBlur={() => { setEditing(false); if (v.trim() && v !== props.value) props.onSave(v); else setV(props.value) }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setV(props.value); (e.target as HTMLInputElement).blur() }
      }} />
  )
}

// Zapamatovaná volba na tomhle počítači (když prohlížeč nedovolí, platí jen do zavření)
function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T) || initial } catch { return initial }
  })
  const set = (x: T) => { setV(x); try { localStorage.setItem(key, x) } catch { /* bez paměti */ } }
  return [v, set]
}

// "2026-11-03" → "3. 11."
function shortDay(iso: string) {
  const [, m, d] = iso.split('-').map(Number)
  return `${d}. ${m}.`
}

// "3.11.", "3. 11.", "3.11.2026" → "2026-11-03"; rok se vezme z původního data
function parseDay(v: string, prev: string): string | null {
  const m = v.trim().match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(\d{4})?$/)
  if (!m) return null
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3] ?? prev.slice(0, 4))
  const dt = new Date(y, mo - 1, d)
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// "830", "8:30", "8.30" → "08:30"; prázdné → null; nesmysl → undefined
export function normTime(v: string): string | null | undefined {
  const s = v.trim()
  if (!s) return null
  const m = s.match(/^(\d{1,2})[:.,]?(\d{2})$/) ?? s.match(/^(\d{1,2})$/)
  if (!m) return undefined
  const h = Number(m[1]), min = Number(m[2] ?? 0)
  if (h > 23 || min > 59) return undefined
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

export { Text }
