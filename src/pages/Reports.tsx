import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, reportDone, type Route, type RoutePrice, type RouteTime, type Trip } from '../lib/supabase'
import { buildRouteIndex, plannedHomeIso, plannedStartIso } from '../lib/planned'
import { KIND_LABEL, baseLabel, groupRoutes, isTcsCustomer, tripKind, jobEnd, loadStops, pickRoute, stopsOf, tripRouteKey, variantLabel, type StopsMap, type TripStop } from '../lib/supabase'
import { composeRoute, money, routeIncomplete, suggestRoutes, totalToll, tripPrice, type LegPick, type MidPick, type Priced, type RateFallback } from '../lib/routes'
import { explain, useApp } from '../lib/data'
import { fmtDT, fmtRel, parseDT, todayIso } from '../lib/format'
import { chainHours, fmtGap, type Link } from '../lib/hours'
import { exportXlsx, printPdf, type Cell } from '../lib/export'
import { Text } from './Plan'
import { SupplierDialog, supplierSummary } from './SupplierDialog'
import { RouteSaveDialog } from './RouteSaveDialog'
import { ReportDialog } from './ReportDialog'

const DONE = 'Finished'
const NO_CUSTOMER = '—'

type TimeKey = 'dep_home' | 'arr_pup' | 'dep_pup' | 'arr_dop' | 'dep_dop' | 'arr_home'
const TIMES: { key: TimeKey; label: string }[] = [
  { key: 'dep_home', label: 'Odjezd domov' },
  { key: 'arr_pup', label: 'Příjezd Pup' },
  { key: 'dep_pup', label: 'Odjezd Pup' },
  { key: 'arr_dop', label: 'Příjezd Dop' },
  { key: 'dep_dop', label: 'Odjezd Dop' },
  { key: 'arr_home', label: 'Příjezd domov' },
]

export default function Reports() {
  const { level, people, cars, places, customers, statuses, toast } = useApp()
  const canEdit = level('reports') === 'write'
  const seePrice = level('routes') !== 'none'
  const [routes, setRoutes] = useState<Route[]>([])
  const [rprices, setRprices] = useState<RoutePrice[]>([])
  const loadRoutes = () => Promise.all([supabase.from('routes').select('*'), supabase.from('route_prices').select('*').order('sort')])
    .then(([r, p]) => { setRoutes((r.data as Route[]) ?? []); setRprices((p.data as RoutePrice[]) ?? []) })
  useEffect(() => { if (seePrice) loadRoutes() }, [seePrice])
  const canRoutes = level('routes') === 'write'
  const routeBy = useMemo(() => groupRoutes(routes), [routes])
  const [trips, setTrips] = useState<Trip[]>([])
  const [showDone, setShowDone] = useState(true)
  const [doneMonth, setDoneMonth] = useState(todayIso().slice(0, 7))
  const [chainTrips, setChainTrips] = useState<Trip[]>([])
  const [stops, setStops] = useState<StopsMap>(new Map())
  const reloadStops = (ids: string[]) => loadStops(ids).then(m => setStops(cur => { const n = new Map(cur); for (const id of ids) n.set(id, m.get(id) ?? []); return n }))
  const [routeTimes, setRouteTimes] = useState<RouteTime[]>([])
  useEffect(() => { supabase.rpc('route_times').then(({ data }) => setRouteTimes((data as RouteTime[]) ?? [])) }, [])
  const [hiddenCust, setHiddenCust] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [supFor, setSupFor] = useState<Trip | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [routeFor, setRouteFor] = useState<{ trip: Trip; similar?: { route: Route; why: string }; composed?: { ho: LegPick | null; dh: LegPick | null; mid: MidPick | null } } | null>(null)

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const ridx = useMemo(() => buildRouteIndex(routeTimes, placeBy), [routeTimes, placeBy])
  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const statusBy = useMemo(() => new Map(statuses.map(s => [s.name, s])), [statuses])

  useEffect(() => {
    let q = supabase.from('trips').select('*').order('trip_date').order('trip_time', { nullsFirst: true })
    const [y, mo] = doneMonth.split('-').map(Number)
    const next = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`
    q = q.in('status', [DONE, 'Canceled'])
    q = showDone ? q.or(`report_done_at.is.null,and(trip_date.gte.${doneMonth}-01,trip_date.lt.${next})`) : q.is('report_done_at', null)
    q.then(({ data, error }) => {
      if (error) toast(explain(error), 'err')
      setTrips((data as Trip[]) ?? []); setLoaded(true)
      loadStops(((data as Trip[]) ?? []).map(t => t.id)).then(setStops)
    })
  }, [showDone, doneMonth, toast])

  // Cesty s odjezdem za posledních 90 dní kvůli navazování (předchozí cesta posádky může být i hotová nebo ještě v plánu)
  useEffect(() => {
    supabase.from('trips').select('*').gte('trip_date', todayIso(-90)).neq('status', 'Canceled')
      .then(({ data }) => setChainTrips((data as Trip[]) ?? []))
  }, [trips])
  const { byNext } = useMemo(() => chainHours(chainTrips, t => plannedStartIso(t, ridx, placeBy)), [chainTrips, ridx, placeBy])

  // Návrh z trasy (ceníku) pro prázdná pole reportu: odjezd z domova = objednaný čas − Výjezd→PUP, příjezd domů = odjezd z Dop + DOP→Návrat
  // (nahoru na čtvrthodiny), km jako v Excelu narůstající (Km Pup, Km Dop, Km celkem), mýto = součet mýta úseků.
  function suggestFor(t: Trip): Partial<Trip> {
    const out: Partial<Trip> = {}
    const tstops = stopsOf(t, stops)
    if (!t.dep_home) { const v = plannedStartIso(t, ridx, placeBy, stops); if (v) out.dep_home = v }
    if (!t.arr_home) { const v = plannedHomeIso(t, ridx, stops); if (v) out.arr_home = v }
    const route = pickRoute(t, routeBy.get(tripRouteKey(t, tstops)))
    if (route) {
      const a = Number(route.ho_pup_km ?? 0), b = Number(route.pup_dop_km ?? 0), c = Number(route.dop_ho_km ?? 0)
      if (t.km_pup == null && route.ho_pup_km != null) out.km_pup = a
      if (t.km_dop == null && route.pup_dop_km != null) out.km_dop = a + b
      if (t.km_total == null && route.dop_ho_km != null) out.km_total = a + b + c
      if (t.toll == null && tripKind(t) !== 'transport') out.toll = totalToll(route)
    }
    return out
  }
  // Čerstvá cesta (nic z reportu nevyplněné) dostane návrh rovnou, ať se nemusí koukat do ceníku; vše jde přepsat
  const prefilled = useRef(new Set<string>())
  useEffect(() => {
    if (!canEdit || !routes.length) return
    for (const t of trips) {
      if (reportDone(t) || prefilled.current.has(t.id)) continue
      if (t.dep_home || t.arr_home || t.km_pup != null || t.km_dop != null || t.km_total != null || t.toll != null) continue
      const sug = suggestFor(t)
      delete sug.arr_home   // příjezd domů až podle skutečného odjezdu z Dop
      prefilled.current.add(t.id)
      if (Object.keys(sug).length) save(t, sug)
    }
  }, [trips, routes, ridx, stops]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ch = supabase.channel('reports')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, payload => {
        setTrips(cur => {
          if (payload.eventType === 'DELETE') return cur.filter(t => t.id !== (payload.old as Trip).id)
          const row = payload.new as Trip
          const keep = (row.status === DONE || row.status === 'Canceled') && (!row.report_done_at || showDone)
          const i = cur.findIndex(t => t.id === row.id)
          if (!keep) return i === -1 ? cur : cur.filter(t => t.id !== row.id)
          if (i === -1) return [...cur, row]
          const next = cur.slice(); next[i] = row; return next
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_stops' }, payload => {
        const tid = ((payload.new as TripStop)?.trip_id ?? (payload.old as TripStop)?.trip_id)
        if (tid) reloadStops([tid])
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [showDone])

  async function save(t: Trip, patch: Partial<Trip>) {
    const prev = t
    setTrips(cur => cur.map(x => (x.id === t.id ? { ...x, ...patch } : x)))
    const { data, error } = await supabase.from('trips').update(patch).eq('id', t.id).select().single()
    if (error) {
      toast(explain(error).includes('trips_report_no') ? 'Tohle číslo reportu už má jiná cesta.' : explain(error), 'err')
      setTrips(cur => cur.map(x => (x.id === t.id ? prev : x)))
    } else setTrips(cur => cur.map(x => (x.id === t.id ? (data as Trip) : x)))
  }

  function saveStop(s: TripStop, key: 'arr' | 'dep', v: string, base: string) {
    const r = parseDT(v, base, true)
    if (r === undefined) return toast('Čas zapište jako 3:30 nebo 2.11. 3:30.', 'err')
    supabase.from('trip_stops').update({ [key]: r }).eq('id', s.id).then(({ error }) => {
      if (error) return toast(explain(error), 'err')
      reloadStops([s.trip_id])
      // odjezd z poslední vykládky → navrhnout příjezd domů, když ještě není
      const t = trips.find(x => x.id === s.trip_id); const ts = stopsOf(t ?? { id: s.trip_id }, stops)
      if (key === 'dep' && r && t && !t.arr_home && ts.length && ts[ts.length - 1].id === s.id) {
        const m: StopsMap = new Map(stops); m.set(t.id, ts.map(x => (x.id === s.id ? { ...x, dep: r } : x)))
        const h = plannedHomeIso(t, ridx, m); if (h) save(t, { arr_home: h })
      }
    })
  }

  async function nextNumber(t: Trip) {
    if (!t.report_series) return toast('Nejdřív vyberte zákazníka, čísla reportů mají řady (TCS, JTi AGS, JTi CZ, JTi SK).', 'err')
    const { data } = await supabase.from('trips').select('report_no').eq('report_series', t.report_series).not('report_no', 'is', null).order('report_no', { ascending: false }).limit(1)
    const last = (data as { report_no: number }[] | null)?.[0]?.report_no
    if (!last) return toast(`V řadě ${t.report_series} zatím není žádné číslo reportu. Napište první ručně, další už aplikace dopočítá.`, 'err')
    save(t, { report_no: last + 1 })
  }

  // výchozí sazby zákazníka, když trasa v ceníku chybí
  const fallbackFor = (t: Trip): RateFallback | null => { const c = customers.find(x => x.name === t.customer); return c?.rate_h != null && c.rate_km != null ? { rate_h: Number(c.rate_h), rate_km: Number(c.rate_km), currency: c.currency, label: `sazby zákazníka ${c.name}` } : null }
  // cena cesty pro export a přílohy
  function priceOf(t: Trip) {
    const end = jobEnd(t, stops)
    const total = hours(t.dep_home, t.arr_home)
    const route = pickRoute(t, routeBy.get(tripRouteKey(t, stopsOf(t, stops))))
    return tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, t.trip_time && end ? Number((hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, end) ?? '0').replace(',', '.')) : null, fallbackFor(t))
  }
  // Přílohy k faktuře TCS NL / TCS DE za měsíc: hotové reporty v pořadí čísel, rozdělené po max. 21 000 € (jako listy Priloha v Excelu)
  const ATTACH_MAX = 21000
  const attachments = useMemo(() => {
    if (!showDone || !seePrice) return []
    const out: { customer: string; parts: { rows: { t: Trip; pr: Priced | null }[]; sum: number }[]; missing: number }[] = []
    for (const c of customers.filter(c => c.report_series === 'TCS')) {
      const done = trips.filter(t => t.customer === c.name && reportDone(t) && t.cancel_mode !== 'none' && t.trip_date >= `${doneMonth}-01`).sort((a, b) => (a.report_no ?? 0) - (b.report_no ?? 0))
      if (!done.length) continue
      const parts: { rows: { t: Trip; pr: Priced | null }[]; sum: number }[] = []
      let cur = { rows: [] as { t: Trip; pr: Priced | null }[], sum: 0 }, missing = 0
      for (const t of done) {
        const pr = priceOf(t); if (!pr) missing++
        const v = pr?.price ?? 0
        if (cur.rows.length && cur.sum + v > ATTACH_MAX) { parts.push(cur); cur = { rows: [], sum: 0 } }
        cur.rows.push({ t, pr }); cur.sum = Math.round((cur.sum + v) * 100) / 100
      }
      parts.push(cur)
      out.push({ customer: c.name, parts, missing })
    }
    return out
  }, [trips, customers, showDone, seePrice, doneMonth, rprices, routeBy, stops]) // eslint-disable-line react-hooks/exhaustive-deps

  function excelAttachments() {
    const sheets: { name: string; rows: Cell[][]; widths?: number[] }[] = []
    const overview: Cell[][] = [['Zákazník', 'Příloha', 'Reportů', 'HRS price', 'Car price', 'Toll', 'Celkem €']]
    for (const a of attachments) {
      const code = a.customer.replace('TCS ', '')
      a.parts.forEach((p, i) => {
        const rows: Cell[][] = [['TCS', '', '', '', '', '', '', ''], [], ['Date', '#Report', 'Ref#', 'Route', 'HRS Price', 'Car Price', 'Toll Price', 'Price']]
        let hrs = 0, car = 0, toll = 0
        for (const { t, pr } of p.rows) {
          rows.push([t.trip_date.split('-').reverse().join('.'), t.report_no, t.ref_tcs, `${placeBy.get(t.pup_id ?? '')?.name ?? '?'}-${placeBy.get(t.dop_id ?? '')?.name ?? '?'}${stopsOf(t, stops).map(s => '-' + (placeBy.get(s.place_id)?.name ?? '?')).join('')}${t.takeover ? ' (Take-Over)' : ''}${t.status === 'Canceled' ? ' (canceled)' : ''}`, pr?.hrs ?? '', pr?.car ?? '', pr?.toll ?? '', pr?.price ?? ''])
          hrs += pr?.hrs ?? 0; car += pr?.car ?? 0; toll += pr?.toll ?? 0
        }
        rows.push([], ['', '', '', 'Celkem', Math.round(hrs * 100) / 100, Math.round(car * 100) / 100, Math.round(toll * 100) / 100, p.sum])
        sheets.push({ name: `Priloha ${code} ${i + 1}`, rows, widths: [11, 9, 9, 42, 10, 10, 10, 10] })
        overview.push([a.customer, i + 1, p.rows.length, Math.round(hrs * 100) / 100, Math.round(car * 100) / 100, Math.round(toll * 100) / 100, p.sum])
      })
    }
    exportXlsx(`prilohy_${doneMonth}`, [{ name: 'Přehled', rows: overview, widths: [10, 8, 9, 11, 11, 9, 11] }, ...sheets])
  }

  function excel() {
    const head: Cell[] = ['Datum', 'Čas', 'Zákazník', '#Report', 'Ref.', 'Ref. zákazníka', 'Druh', 'Pup', 'Dop', 'Další Dop', 'Výjezd z', 'Návrat do', 'Take-over', 'Posádka', 'Auto', 'Dodavatel', ...TIMES.map(x => x.label), 'Km Pup', 'Km Dop', 'Km celkem', 'Mýto €', 'Celkem h', 'Eskorta h', 'Hodiny ručně', 'Navazuje', 'Varianta trasy', 'Cena podle', 'HRS price', 'Car price', 'Toll', 'Cena bez DPH', 'Měna', 'Poznámka', 'Status']
    const body: Cell[][] = []
    for (const [, rows] of groups) for (const t of rows) {
      const end = jobEnd(t, stops)
      const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, end)
      const route = pickRoute(t, routeBy.get(tripRouteKey(t, stopsOf(t, stops))))
      const pr = seePrice ? priceOf(t) : null
      const links = byNext.get(t.id) ?? []
      body.push([t.trip_date.split('-').reverse().join('.'), t.trip_time?.slice(0, 5), t.customer, t.report_no, t.ref_tcs, t.customer_ref, KIND_LABEL[tripKind(t)],
        placeBy.get(t.pup_id ?? '')?.name, placeBy.get(t.dop_id ?? '')?.name, stopsOf(t, stops).map(s => `${placeBy.get(s.place_id)?.name} (${fmtDT(s.arr)} – ${fmtDT(s.dep)}, ${s.km ?? '?'} km)`).join('; '), t.base_from, t.base_to, t.takeover ? 'ano' : '',
        [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => personBy.get(id!)?.short_name).join(', '),
        carBy.get(t.car_id ?? '')?.plate ?? carBy.get(t.car_id ?? '')?.car_no, supplierSummary(t, personBy).join('; '),
        ...TIMES.map(x => fmtDT(t[x.key])), t.km_pup, t.km_dop, t.km_total, t.toll, total, escort, t.hours_manual,
        t.combi === true ? 'ano' : t.combi === false ? 'ne' : links.some(l => l.kind === 'auto' || l.kind === 'overlap') ? 'navrženo' : '',
        route ? variantLabel(route.variant) : '', pr?.how, pr?.hrs, pr?.car, pr?.toll, pr?.price, pr?.currency, t.report_note, t.status])
    }
    exportXlsx(`reporty_${showDone ? doneMonth : todayIso()}`, [{ name: 'Reporty', rows: [head, ...body] }])
  }

  const groups = useMemo(() => {
    const order = [...customers.map(c => c.name), NO_CUSTOMER]
    const m = new Map<string, Trip[]>(order.map(c => [c, []]))
    for (const t of trips) if (!hiddenCust.has(t.customer ?? NO_CUSTOMER)) m.get(t.customer ?? NO_CUSTOMER)?.push(t)
    // pořadí: podle čísla reportu; bez čísla podle příjezdu domů, jinak podle data a objednaného času
    const key = (t: Trip) => t.arr_home ?? `${t.trip_date}T${t.trip_time ?? '00:00'}`
    for (const r of m.values()) r.sort((a, b) => (a.report_no != null && b.report_no != null) ? a.report_no - b.report_no : a.report_no != null ? -1 : b.report_no != null ? 1 : key(a).localeCompare(key(b)))
    return [...m.entries()].filter(([, r]) => r.length)
  }, [trips, customers, hiddenCust])

  const waiting = trips.filter(t => t.status === DONE && !t.report_done_at).length
  const canceledOpen = trips.filter(t => t.status === 'Canceled' && !t.report_done_at).length
  const COLS = seePrice ? 27 : 25

  return (
    <section className="plan reports size-s">
      <div className="toolbar">
        <h1>Reporty</h1>
        <span className="count">{waiting} k dopsání{canceledOpen ? ` · ${canceledOpen} zrušených k rozhodnutí` : ''}</span>
        <div className="statusfilter custfilter">
          {[...customers.map(c => c.name), NO_CUSTOMER].map(c => (
            <button key={c} className={'chip cust' + (hiddenCust.has(c) ? ' off' : '')}
              onClick={() => setHiddenCust(cur => { const n = new Set(cur); n.has(c) ? n.delete(c) : n.add(c); return n })}>
              {c === NO_CUSTOMER ? 'bez zákazníka' : c}
            </button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />I hotové za</label>
        <input type="month" value={doneMonth} onChange={e => e.target.value && setDoneMonth(e.target.value)} disabled={!showDone} className="search" style={{ minWidth: 'auto', flex: '0 0 auto' }} />
        <span className="grow" />
        <button className="ghostbtn" onClick={excel}>Excel</button>
        {attachments.length > 0 && <button className="ghostbtn" title="Přílohy k fakturám TCS NL a TCS DE za zvolený měsíc, rozdělené po max. 21 000 €" onClick={excelAttachments}>Přílohy k faktuře</button>}
        <button className="ghostbtn" onClick={printPdf}>Tisk / PDF</button>
      </div>
      {attachments.length > 0 && (
        <p className="quiet small attachinfo">Přílohy k faktuře za {doneMonth}: {attachments.map(a => `${a.customer}: ${a.parts.map((p, i) => `č. ${i + 1} (${p.rows.length} rep., ${money(p.sum, 'EUR')})`).join(', ')}${a.missing ? ` · ${a.missing} bez ceny!` : ''}`).join(' · ')} — rozděleno po max. 21 000 € v pořadí čísel reportů.</p>
      )}
      <p className="intro">Sem spadne každá cesta, které v Planningu dáte status Finished, a také zrušené (Canceled). Časy pište jako 3:30 (den se doplní sám) nebo 2.11. 3:30. Hotový report uzavřete tlačítkem Hotovo; cesta tím zmizí z Planningu do Historie. U zrušené buď zadáte storno (ruční cenu, číslo reportu, Hotovo), nebo dáte „bez účtování“, ať zůstane v Historii pro přehled; co se účtovat nebude a nemá zůstat ani v přehledu, smažte v Planningu.</p>

      <div className="tablewrap">
        <table className="grid report">
          <thead>
            <tr>
              <th className="w-dots" /><th>Datum</th><th>Zákazník</th><th>#Report</th><th>Ref.</th><th>Trasa</th><th>Posádka</th><th>Auto</th>
              {TIMES.map(x => <th key={x.key}>{x.label}</th>)}
              <th>Km Pup</th><th>Km Dop</th><th>Km celkem</th><th>Mýto €</th>
              <th title="Příjezd domov − odjezd domov">Celkem h</th><th title="Příjezd Dop − odjezd Pup">Eskorta h</th><th>Hodiny ručně</th><th title="Navazuje na předchozí cestu posádky: konec předchozí cesty se pro hodiny lidí posune na start téhle. Překryv vždy, mezera do 6 h se navrhne sama.">Navazuje</th>{seePrice && <><th>Cena podle</th><th title="Klikněte a napište částku, pokud je cena domluvená jinak">Cena bez DPH</th></>}<th>Poznámka</th><th />
            </tr>
          </thead>
          {groups.map(([cust, rows]) => (
            <tbody key={cust}>
              <tr className="dayrow"><td colSpan={COLS}>
                <span className="daylabel">{cust === NO_CUSTOMER ? 'Bez zákazníka' : cust}</span>
                <span className="daycount">{rows.length} {rows.length === 1 ? 'cesta' : rows.length < 5 ? 'cesty' : 'cest'}</span>
              </td></tr>
              {rows.map(t => {
                const st = statusBy.get(t.status ?? '')
                const done = reportDone(t)
                const tstops = stopsOf(t, stops)
                const end = jobEnd(t, stops)
                const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, end)
                const canceled = t.status === 'Canceled'
                const routeNow = pickRoute(t, routeBy.get(tripRouteKey(t, tstops)))
                const ready = canceled ? !!t.report_no && (t.price_manual != null || !!t.route_price_id || !!routeNow || !!fallbackFor(t)) : !!t.report_no && !!t.dep_home && !!t.arr_home
                const ed = canEdit && !done
                const transport = tripKind(t) === 'transport'   // přeprava: jen Odjezd, Naloženo, Příjezd na vykládku, Vyloženo, Příjezd, Km celkem
                const tcs = isTcsCustomer(t.customer, customers)
                const TR_LABEL: Partial<Record<TimeKey, string>> = { dep_pup: 'Naloženo', arr_dop: 'Příjezd na vykládku', dep_dop: 'Vyloženo' }
                const sug = ed ? suggestFor(t) : {}
                return (
                  <Fragment key={t.id}>
                  <tr className={'trip' + (done ? ' done' : '') + (canceled ? ' canceledrow' : '')} style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                    <td className="w-dots"><button className="ghost dots" title="Detail reportu: celé časy, trasa z ceníku, cena" aria-label="Detail reportu" onClick={() => setOpenId(t.id)}>⋯</button></td>
                    <td className="ro nowrap">{dm(t.trip_date)} {t.trip_time?.slice(0, 5)}</td>
                    <td className={'ro' + (t.customer ? '' : ' missingtxt')}>{t.customer ?? 'chybí'}{canceled && <span className="totag canceltag" title={t.cancel_mode === 'none' ? 'Zrušeno bez účtování' : t.cancel_mode === 'fee' ? 'Storno poplatek' : 'Zrušená cesta: storno (ruční cena + číslo + Hotovo), nebo bez účtování'}>{t.cancel_mode === 'none' ? 'zrušeno · neúčtuje se' : t.cancel_mode === 'fee' ? 'storno' : 'ZRUŠENO'}</span>}</td>
                    <td className="repno">
                      <Text disabled={!ed} value={t.report_no?.toString() ?? ''} mono time placeholder="číslo"
                        onSave={v => { const n = v.trim(); if (n && !/^\d+$/.test(n)) return toast('Číslo reportu jsou jen číslice.', 'err'); save(t, { report_no: n ? Number(n) : null }) }} />
                      {ed && !t.report_no && <button className="link small" onClick={() => nextNumber(t)}>další</button>}
                    </td>
                    <td>{tcs
                      ? <Text disabled={!ed} value={t.ref_tcs ?? ''} mono time placeholder="A·····" onSave={v => save(t, { ref_tcs: v.trim().toUpperCase() || null })} />
                      : <span className="nowrap"><Text disabled={!ed} value={t.customer_ref ?? ''} mono placeholder={routeNow?.customer_ref ?? 'ref. zákazníka'} onSave={v => save(t, { customer_ref: v.trim() || null })} />
                          {ed && !t.customer_ref && routeNow?.customer_ref && <button className="link small" title="Použít výchozí referenci z trasy" onClick={() => save(t, { customer_ref: routeNow.customer_ref })}>použít</button>}</span>}</td>
                    <td className="ro">{tripKind(t) === 'transport' && <span className="kindicon" title={KIND_LABEL.transport}>🚐 </span>}{placeBy.get(t.pup_id ?? '')?.name ?? '?'} → {placeBy.get(t.dop_id ?? '')?.name ?? '?'}{tstops.map(s => ` → ${placeBy.get(s.place_id)?.name ?? '?'}`).join('')}{baseLabel(t.base_from, t.base_to) && <span className="nltag">{baseLabel(t.base_from, t.base_to)}</span>}{t.takeover && <span className="totag" title="Take-over: cestu přebíráme od cizí posádky">Take-over</span>}</td>
                    <td className="ro">{[t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => personBy.get(id!)?.short_name).join(', ')}
                      {supplierSummary(t, personBy).map(x => <span key={x} className="suptag" title="Odchylka od standardu (SEMS, auto TCS)">{x}</span>)}
                      {canEdit && <button className="link small quiet suplink" title="Dodavatel posádky a auta u téhle cesty (SEMS je standard)" onClick={() => setSupFor(t)}>dodavatel</button>}</td>
                    <td className="ro nowrap">{carBy.get(t.car_id ?? '')?.plate ?? carBy.get(t.car_id ?? '')?.car_no ?? ''}</td>
                    {TIMES.map((x, i) => transport && x.key === 'arr_pup' ? <td key={x.key} className="timecell ro quiet" title="U přepravy se nevyplňuje">—</td> : (
                      <td key={x.key} className="timecell" title={transport ? TR_LABEL[x.key] : undefined}>
                        <Text disabled={!ed} value={fmtRel(t[x.key], t.trip_date)} time placeholder={sug[x.key] ? fmtRel(sug[x.key] as string, t.trip_date) + '?' : transport && TR_LABEL[x.key] ? TR_LABEL[x.key]!.toLowerCase().slice(0, 8) : 'hh:mm'}
                          onSave={v => {
                            const base = i === 0 ? `${t.trip_date}T00:00:00` : prevFilled(t, i)
                            const r = parseDT(v, base, i > 0)
                            if (r === undefined) return toast('Čas zapište jako 3:30 nebo 2.11. 3:30.', 'err')
                            const patch: Partial<Trip> = { [x.key]: r }
                            if (x.key === 'dep_dop' && r && !t.arr_home && !tstops.length) { const h = plannedHomeIso({ ...t, dep_dop: r }, ridx, stops); if (h) patch.arr_home = h }
                            save(t, patch)
                          }} />
                      </td>
                    ))}
                    {(['km_pup', 'km_dop', 'km_total'] as const).map(k => transport && k !== 'km_total' ? <td key={k} className="ro quiet" title="U přepravy jen Km celkem">—</td> : (
                      <td key={k}><Text disabled={!ed} value={t[k]?.toString() ?? ''} time mono placeholder={sug[k] != null ? String(sug[k]) + '?' : ''}
                        onSave={v => { const n = num(v); if (n === undefined) return toast('Km pište jako celé číslo.', 'err'); save(t, { [k]: n === null ? null : Math.round(n) } as Partial<Trip>) }} /></td>
                    ))}
                    {transport ? <td className="ro quiet" title="U přepravy se mýto neúčtuje">—</td> : <td><Text disabled={!ed} value={t.toll?.toString().replace('.', ',') ?? ''} time mono placeholder={sug.toll != null ? String(sug.toll) + '?' : ''}
                      onSave={v => { const n = num(v); if (n === undefined) return toast('Mýto pište jako číslo, třeba 25,50.', 'err'); save(t, { toll: n }) }} /></td>}
                    <td className="ro num">{total ?? ''}</td>
                    <td className="ro num">{escort ?? ''}</td>
                    <td><Text disabled={!ed} value={t.hours_manual?.toString().replace('.', ',') ?? ''} time mono
                      onSave={v => { const n = num(v); if (n === undefined) return toast('Hodiny pište jako číslo, třeba 14,5.', 'err'); save(t, { hours_manual: n }) }} /></td>
                    <td className="combi">{combiCell(t, byNext.get(t.id) ?? [], ed, v => save(t, { combi: v }), personBy)}</td>
                    {seePrice && (() => {
                      const variants = routeBy.get(tripRouteKey(t, tstops)) ?? []
                      const route = pickRoute(t, variants)
                      const opts = route ? rprices.filter(p => p.route_id === route.id) : []
                      const rq = t.trip_time ? hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, end) : null
                      const reqH = rq ? Number(rq.replace(',', '.')) : null
                      const fb = fallbackFor(t)
                      const pr = tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH, fb)
                      const auto = tripPrice({ ...t, price_manual: null }, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH, fb)
                      return <>
                        <td>
                          {variants.length > 1 && (
                            <select className="variantsel" disabled={!ed} value={route?.id ?? ''} title="Varianta trasy (přes Francii, přes Švýcarsko…). Platí pro cenu i pro Start a Home v Planningu."
                              onChange={e => save(t, { route_id: e.target.value || null })}>
                              {variants.map(v => <option key={v.id} value={v.id}>{variantLabel(v.variant)}{v.customer && v.customer !== t.customer ? ` (${v.customer})` : ''}</option>)}
                            </select>
                          )}
                          {t.price_manual != null
                            ? <span className="ro manualprice">ručně {ed && <button className="link small" onClick={() => save(t, { price_manual: null })} title="Zrušit ruční cenu a počítat znovu">zrušit</button>}</span>
                            : route
                            ? <select disabled={!ed} value={t.route_price_id ?? ''} onChange={e => save(t, { route_price_id: e.target.value || null })}>
                                <option value="">sazby ({route.rate_h} {route.currency === 'CZK' ? 'Kč' : '€'}/h, {route.rate_km} {route.currency === 'CZK' ? 'Kč' : '€'}/km){routeIncomplete(route) ? ' – chybí PUP→DOP!' : ''}</option>
                                {opts.map(p => <option key={p.id} value={p.id}>pevná {p.label}: {money(Number(p.price), p.currency)}{transport && (p.free_load_h != null || p.free_unload_h != null) ? ` (zdarma ${p.free_load_h ?? 0} h nakl., ${p.free_unload_h ?? 0} h vykl.)` : ''}</option>)}
                              </select>
                            : (() => {
                                const sug = t.pup_id && t.dop_id ? suggestRoutes(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : []
                                const comp = t.pup_id && t.dop_id && !sug.length ? composeRoute(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : null
                                return <span className="ro missingtxt" title={`V Trasách a cenách tahle trasa není${baseLabel(t.base_from, t.base_to) ? ` (varianta ${baseLabel(t.base_from, t.base_to)})` : ''}`}>
                                  chybí trasa{baseLabel(t.base_from, t.base_to) ? ` ${baseLabel(t.base_from, t.base_to)}` : ''}{fb && <span className="quiet small" title={`Bez trasy se počítá ze sazeb zákazníka ${fb.rate_h}/h a ${fb.rate_km}/km; sazby pro tuhle cestu upravíte v detailu (⋯)`}> · sazby zákazníka</span>}
                                  {canRoutes && t.pup_id && t.dop_id && (
                                    <> <button className="link small" title={sug.length ? `Otevře uložení trasy předvyplněné z reportu a z trasy ${placeBy.get(sug[0].route.pup_id)?.name} → ${placeBy.get(sug[0].route.dop_id)?.name} (${sug[0].why}); před uložením si upravíte km, hodiny, mýto, sazby a variantu.` : comp && (comp.ho || comp.dh) ? `Otevře uložení trasy předvyplněné z reportu a z hotových úseků (${t.base_from}→PUP ${comp.ho ? 'z ' + comp.ho.why : 'chybí'}; DOP→${t.base_to} ${comp.dh ? 'z ' + comp.dh.why : 'chybí'}).` : 'Otevře uložení trasy předvyplněné z reportu (km a časy téhle cesty).'}
                                      onClick={() => setRouteFor({ trip: t, similar: sug[0], composed: comp ?? undefined })}>uložit trasu na příště{sug.length ? ` (podle ${placeBy.get(sug[0].route.pup_id)?.name} → ${placeBy.get(sug[0].route.dop_id)?.name})` : comp && (comp.ho || comp.dh) ? ' (z úseků)' : ''}</button></>
                                  )}
                                </span>
                              })()}
                        </td>
                        <td className="num" title={pr?.how}>
                          <Text disabled={!ed} value={pr ? money(pr.price, pr.currency) : ''} time mono placeholder={ed ? 'zadat' : ''}
                            onSave={v => {
                              const n = num(v.replace(/€|Kč/g, ''))
                              if (n === undefined) return toast('Cenu pište jako číslo, třeba 1250 nebo 1250,50.', 'err')
                              if (n === null) return save(t, { price_manual: null })
                              if (auto && Math.abs(n - auto.price) < 0.005 && t.price_manual == null) return
                              save(t, { price_manual: n })
                            }} />
                        </td>
                      </>
                    })()}
                    <td><Text disabled={!ed} value={t.report_note ?? ''} wide onSave={v => save(t, { report_note: v || null })} /></td>
                    <td className="actions nowrap">
                      {canEdit && !done && (
                        <>
                          {Object.keys(sug).length > 0 && <button className="link small" title={'Doplní prázdná pole podle trasy: ' + Object.entries(sug).map(([k, v]) => `${k} ${typeof v === 'string' && v.includes('T') ? fmtDT(v) : v}`).join(', ')} onClick={() => save(t, sug)}>doplnit z trasy</button>}{' '}
                          <button className="primary small" disabled={!ready} title={ready ? (canceled ? 'Uzavřít storno' : 'Uzavřít report') : canceled ? 'Storno: chybí číslo reportu nebo cena' : 'Chybí číslo reportu, odjezd nebo příjezd domů'}
                            onClick={() => save(t, { report_done_at: new Date().toISOString(), ...(canceled ? { cancel_mode: 'fee' as const } : {}) })}>Hotovo</button>{' '}
                          {canceled && <><button className="link small" title="Zrušená cesta zůstane v Historii pro přehled, nic se neúčtuje" onClick={() => save(t, { report_done_at: new Date().toISOString(), cancel_mode: 'none' })}>bez účtování</button>{' '}</>}
                          <button className="link small" onClick={() => save(t, { status: 'Departed' })} title="Vrátit cestu do Planningu se statusem Departed">Do Planningu</button>
                        </>
                      )}
                      {canEdit && done && <button className="link small" onClick={() => save(t, { report_done_at: null, cancel_mode: null })}>Znovu otevřít</button>}
                      {done && !canEdit && <span className="quiet">hotovo</span>}
                    </td>
                  </tr>
                  {tstops.length > 0 && (
                    <tr className="stopsrow" style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                      <td colSpan={COLS}>
                        <span className="quiet">Další vykládky:</span>
                        {tstops.map(s => (
                          <span key={s.id} className="stop">
                            <strong>Dop {s.seq}</strong> {placeBy.get(s.place_id)?.name ?? '?'}
                            <span className="quiet"> příjezd</span>
                            <Text disabled={!ed} value={fmtDT(s.arr)} time placeholder="hh:mm"
                              onSave={v => saveStop(s, 'arr', v, prevStopTime(t, tstops, s))} />
                            <span className="quiet"> odjezd</span>
                            <Text disabled={!ed} value={fmtDT(s.dep)} time placeholder="hh:mm"
                              onSave={v => saveStop(s, 'dep', v, s.arr ?? prevStopTime(t, tstops, s))} />
                            <span className="quiet"> km z předchozí</span>
                            <Text disabled={!ed} value={s.km?.toString() ?? ''} time mono
                              onSave={v => { const n = num(v); if (n === undefined) return toast('Km pište jako celé číslo.', 'err'); supabase.from('trip_stops').update({ km: n == null ? null : Math.round(n) }).eq('id', s.id).then(({ error }) => error ? toast(explain(error), 'err') : reloadStops([t.id])) }} />
                          </span>
                        ))}
                        <span className="quiet">Příjezd Dop / Odjezd Dop v řádku platí pro Dop 1; Eskorta h a cena počítají s odjezdem z poslední vykládky.</span>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          ))}
        </table>
        {loaded && groups.length === 0 && (
          <p className="empty">Žádný report k dopsání. Cesta se sem dostane, když jí v Planningu dáte status Report.</p>
        )}
      </div>
      {openId && (() => {
        const t = trips.find(x => x.id === openId); if (!t) return null
        const tstops = stopsOf(t, stops); const end = jobEnd(t, stops)
        const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, end)
        const variants = routeBy.get(tripRouteKey(t, tstops)) ?? []; const route = pickRoute(t, variants)
        const rq = t.trip_time ? hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, end) : null; const reqH = rq ? Number(rq.replace(',', '.')) : null
        const tot = total ? Number(total.replace(',', '.')) : null
        const sug = t.pup_id && t.dop_id && !route ? suggestRoutes(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : []
        const comp = !route && t.pup_id && t.dop_id && !sug.length ? composeRoute(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : null
        return <ReportDialog trip={t} stops={tstops} route={route} variants={variants} prices={rprices}
          priced={seePrice ? tripPrice(t, route, rprices, tot, reqH, fallbackFor(t)) : null} auto={seePrice ? tripPrice({ ...t, price_manual: null }, route, rprices, tot, reqH, fallbackFor(t)) : null} fallback={fallbackFor(t)}
          sug={canEdit && !reportDone(t) ? suggestFor(t) : {}} total={total} escort={escort}
          combi={combiCell(t, byNext.get(t.id) ?? [], canEdit && !reportDone(t), v => save(t, { combi: v }), personBy)}
          canEdit={canEdit} seePrice={seePrice} canRoutes={canRoutes} save={patch => save(t, patch)} saveStop={saveStop} nextNumber={() => nextNumber(t)}
          onSaveRoute={() => setRouteFor({ trip: t, similar: sug[0], composed: comp ?? undefined })} onSupplier={() => setSupFor(t)} onClose={() => setOpenId(null)}
          homeFor={x => plannedHomeIso(x, ridx, stops)} />
      })()}
      {routeFor && <RouteSaveDialog trip={trips.find(x => x.id === routeFor.trip.id) ?? routeFor.trip} placeName={id => placeBy.get(id ?? '')?.name ?? '?'} similar={routeFor.similar} composed={routeFor.composed}
        onSaved={id => { setRouteFor(null); loadRoutes(); if (id) save(routeFor.trip, { route_id: id }) }} onClose={() => setRouteFor(null)} />}
      {supFor && <SupplierDialog trip={trips.find(x => x.id === supFor.id) ?? supFor} onSave={p => save(supFor, p)} onClose={() => setSupFor(null)} />}
    </section>
  )
}

// Čas vykládky: den se doplní podle předchozího času (příjezd Dop 1 → odjezd Dop 1 → Dop 2 …)
function prevStopTime(t: Trip, all: TripStop[], s: TripStop): string {
  const i = all.indexOf(s)
  const prev = i > 0 ? all[i - 1] : null
  return (prev?.dep ?? prev?.arr ?? t.dep_dop ?? t.arr_dop ?? `${t.trip_date}T00:00:00`).replace(' ', 'T')
}

function dm(iso: string) { const [, m, d] = iso.split('-').map(Number); return `${d}. ${m}.` }

// Poslední vyplněný čas před tímto polem (od něj se dopočítá den)
function prevFilled(t: Trip, i: number): string {
  for (let k = i - 1; k >= 0; k--) { const v = t[TIMES[k].key]; if (v) return v.replace(' ', 'T') }
  return `${t.trip_date}T00:00:00`
}

function hours(a: string | null, b: string | null): string | null {
  if (!a || !b) return null
  const h = (Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 36e5
  return Number.isFinite(h) ? (Math.round(h * 100) / 100).toString().replace('.', ',') : null
}

function num(v: string): number | null | undefined {
  const s = v.trim().replace(/\s/g, '').replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

// Sloupec Navazuje: stav zatržítka + co to znamená pro lidi na obou cestách
function combiCell(t: Trip, links: Link[], ed: boolean, set: (v: boolean | null) => void, personBy: Map<string, { short_name: string }>) {
  const who = links.map(l => `${personBy.get(l.person)?.short_name ?? '?'} ← ${l.prev.ref_tcs ?? (l.prev.report_no ? '#' + l.prev.report_no : 'předchozí')} (${l.gapH < 0 ? 'překryv ' : 'mezera '}${fmtGap(l.gapH)})`).join('\n')
  const auto = links.some(l => l.kind === 'auto'), overlap = links.some(l => l.kind === 'overlap')
  if (t.combi === true) return <span className="combi-yes" title={who || 'Potvrzeno ručně'}>navazuje{ed && <> <button className="link small" onClick={() => set(null)}>zrušit</button></>}</span>
  if (t.combi === false) return <span className="quiet" title={who}>nenavazuje{ed && <> <button className="link small" onClick={() => set(null)}>zrušit</button></>}</span>
  if (auto) return <span className="combi-auto" title={who}>navrženo{ed && <> <button className="link small" onClick={() => set(true)}>potvrdit</button> <button className="link small" onClick={() => set(false)}>ne</button></>}</span>
  if (overlap) return <span className="combi-auto" title={who + '\nPřekryv se pro hodiny zkrátí vždy.'}>překryv</span>
  if (!links.length) return ed && t.dep_home ? <button className="link small quiet" title="Posádka pokračovala z předchozí cesty (mezera přes 6 h)" onClick={() => set(true)}>navazuje?</button> : null
  return ed ? <button className="link small quiet" title={who} onClick={() => set(true)}>navazuje?</button> : <span className="quiet" title={who}>–</span>
}
