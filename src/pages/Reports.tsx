import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, type Route, type RoutePrice, type RouteTime, type Trip } from '../lib/supabase'
import { buildRouteIndex, plannedStartIso } from '../lib/planned'
import { baseLabel, groupRoutes, jobEnd, loadStops, pickRoute, stopsOf, tripRouteKey, variantLabel, type StopsMap, type TripStop } from '../lib/supabase'
import { composeRoute, copyRoute, createComposedRoute, eur, routeIncomplete, suggestRoutes, tripPrice, type LegPick, type MidPick } from '../lib/routes'
import { explain, useApp } from '../lib/data'
import { fmtDT, parseDT, todayIso } from '../lib/format'
import { chainHours, fmtGap, type Link } from '../lib/hours'
import { exportXlsx, printPdf, type Cell } from '../lib/export'
import { Text } from './Plan'

const REPORT = 'Report'
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
  async function adoptRoute(t: Trip, src: Route) {
    const { error } = await copyRoute(src, t.pup_id!, t.dop_id!, t.base_from, t.base_to, rprices, '', stopsOf(t, stops).map(s => s.place_id))
    if (error) return toast(error, 'err')
    toast(`Trasa ${placeBy.get(t.pup_id!)?.name} → ${placeBy.get(t.dop_id!)?.name} založena jako kopie. Zkontrolujte ji v Trasách a cenách.`)
    loadRoutes()
  }
  async function composeFor(t: Trip, ho: LegPick | null, dh: LegPick | null, mid: MidPick | null) {
    const { error } = await createComposedRoute(t.pup_id!, t.dop_id!, t.base_from, t.base_to, ho, dh, stopsOf(t, stops).map(s => s.place_id), mid)
    if (error) return toast(error, 'err')
    toast(mid ? 'Trasa založena z úseků včetně PUP→DOP. Zkontrolujte ji v Trasách a cenách.' : `Trasa založena z úseků. Doplňte PUP→DOP v Trasách a cenách (km, hodiny, mýto).`)
    loadRoutes()
  }
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

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const ridx = useMemo(() => buildRouteIndex(routeTimes, placeBy), [routeTimes, placeBy])
  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const statusBy = useMemo(() => new Map(statuses.map(s => [s.name, s])), [statuses])

  useEffect(() => {
    let q = supabase.from('trips').select('*').order('trip_date').order('trip_time', { nullsFirst: true })
    const [y, mo] = doneMonth.split('-').map(Number)
    const next = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`
    q = showDone ? q.or(`status.eq.${REPORT},and(status.eq.${DONE},trip_date.gte.${doneMonth}-01,trip_date.lt.${next})`) : q.eq('status', REPORT)
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

  useEffect(() => {
    const ch = supabase.channel('reports')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips' }, payload => {
        setTrips(cur => {
          if (payload.eventType === 'DELETE') return cur.filter(t => t.id !== (payload.old as Trip).id)
          const row = payload.new as Trip
          const keep = row.status === REPORT || (showDone && row.status === DONE)
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
    supabase.from('trip_stops').update({ [key]: r }).eq('id', s.id).then(({ error }) => error ? toast(explain(error), 'err') : reloadStops([s.trip_id]))
  }

  async function nextNumber(t: Trip) {
    const { data } = await supabase.from('trips').select('report_no').not('report_no', 'is', null).order('report_no', { ascending: false }).limit(1)
    const last = (data as { report_no: number }[] | null)?.[0]?.report_no
    if (!last) return toast('Zatím není žádné číslo reportu. Napište první ručně, další už aplikace dopočítá.', 'err')
    save(t, { report_no: last + 1 })
  }

  function excel() {
    const head: Cell[] = ['Datum', 'Čas', 'Zákazník', '#Report', 'Ref.', 'Pup', 'Dop', 'Další Dop', 'Výjezd z', 'Návrat do', 'Take-over', 'Posádka', 'Auto', ...TIMES.map(x => x.label), 'Km Pup', 'Km Dop', 'Km celkem', 'Mýto €', 'Celkem h', 'Eskorta h', 'Hodiny ručně', 'Navazuje', 'Varianta trasy', 'Cena podle', 'Cena € bez DPH', 'Poznámka', 'Status']
    const body: Cell[][] = []
    for (const [, rows] of groups) for (const t of rows) {
      const end = jobEnd(t, stops)
      const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, end)
      const route = pickRoute(t, routeBy.get(tripRouteKey(t, stopsOf(t, stops))))
      const pr = seePrice ? tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, t.trip_time && end ? Number((hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, end) ?? '0').replace(',', '.')) : null) : null
      const links = byNext.get(t.id) ?? []
      body.push([t.trip_date.split('-').reverse().join('.'), t.trip_time?.slice(0, 5), t.customer, t.report_no, t.ref_tcs,
        placeBy.get(t.pup_id ?? '')?.name, placeBy.get(t.dop_id ?? '')?.name, stopsOf(t, stops).map(s => `${placeBy.get(s.place_id)?.name} (${fmtDT(s.arr)} – ${fmtDT(s.dep)}, ${s.km ?? '?'} km)`).join('; '), t.base_from, t.base_to, t.takeover ? 'ano' : '',
        [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => personBy.get(id!)?.short_name).join(', '),
        carBy.get(t.car_id ?? '')?.plate ?? carBy.get(t.car_id ?? '')?.car_no,
        ...TIMES.map(x => fmtDT(t[x.key])), t.km_pup, t.km_dop, t.km_total, t.toll, total, escort, t.hours_manual,
        t.combi === true ? 'ano' : t.combi === false ? 'ne' : links.some(l => l.kind === 'auto' || l.kind === 'overlap') ? 'navrženo' : '',
        route ? variantLabel(route.variant) : '', pr?.how, pr?.price, t.report_note, t.status])
    }
    exportXlsx(`reporty_${showDone ? doneMonth : todayIso()}`, [{ name: 'Reporty', rows: [head, ...body] }])
  }

  const groups = useMemo(() => {
    const order = [...customers.map(c => c.name), NO_CUSTOMER]
    const m = new Map<string, Trip[]>(order.map(c => [c, []]))
    for (const t of trips) if (!hiddenCust.has(t.customer ?? NO_CUSTOMER)) m.get(t.customer ?? NO_CUSTOMER)?.push(t)
    return [...m.entries()].filter(([, r]) => r.length)
  }, [trips, customers, hiddenCust])

  const waiting = trips.filter(t => t.status === REPORT).length
  const COLS = seePrice ? 26 : 24

  return (
    <section className="plan reports size-s">
      <div className="toolbar">
        <h1>Reporty</h1>
        <span className="count">{waiting} k dopsání</span>
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
        <button className="ghostbtn" onClick={printPdf}>Tisk / PDF</button>
      </div>
      <p className="intro">Sem přijde každá cesta, které v Planningu dáte status Report. Časy pište jako 3:30 (den se doplní sám) nebo 2.11. 3:30. Hotový report uzavřete tlačítkem Hotovo, cesta dostane status Finished.</p>

      <div className="tablewrap">
        <table className="grid report">
          <thead>
            <tr>
              <th>Datum</th><th>Zákazník</th><th>#Report</th><th>Ref.</th><th>Trasa</th><th>Posádka</th><th>Auto</th>
              {TIMES.map(x => <th key={x.key}>{x.label}</th>)}
              <th>Km Pup</th><th>Km Dop</th><th>Km celkem</th><th>Mýto €</th>
              <th title="Příjezd domov − odjezd domov">Celkem h</th><th title="Příjezd Dop − odjezd Pup">Eskorta h</th><th>Hodiny ručně</th><th title="Navazuje na předchozí cestu posádky: konec předchozí cesty se pro hodiny lidí posune na start téhle. Překryv vždy, mezera do 6 h se navrhne sama.">Navazuje</th>{seePrice && <><th>Cena podle</th><th title="Klikněte a napište částku, pokud je cena domluvená jinak">Cena € bez DPH</th></>}<th>Poznámka</th><th />
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
                const done = t.status === DONE
                const tstops = stopsOf(t, stops)
                const end = jobEnd(t, stops)
                const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, end)
                const ready = !!t.report_no && !!t.dep_home && !!t.arr_home
                const ed = canEdit && !done
                return (
                  <Fragment key={t.id}>
                  <tr className={'trip' + (done ? ' done' : '')} style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                    <td className="ro nowrap">{dm(t.trip_date)} {t.trip_time?.slice(0, 5)}</td>
                    <td className={'ro' + (t.customer ? '' : ' missingtxt')}>{t.customer ?? 'chybí'}</td>
                    <td className="repno">
                      <Text disabled={!ed} value={t.report_no?.toString() ?? ''} mono time placeholder="číslo"
                        onSave={v => { const n = v.trim(); if (n && !/^\d+$/.test(n)) return toast('Číslo reportu jsou jen číslice.', 'err'); save(t, { report_no: n ? Number(n) : null }) }} />
                      {ed && !t.report_no && <button className="link small" onClick={() => nextNumber(t)}>další</button>}
                    </td>
                    <td><Text disabled={!ed} value={t.ref_tcs ?? ''} mono time placeholder="A·····"
                      onSave={v => save(t, { ref_tcs: v.trim().toUpperCase() || null })} /></td>
                    <td className="ro">{placeBy.get(t.pup_id ?? '')?.name ?? '?'} → {placeBy.get(t.dop_id ?? '')?.name ?? '?'}{tstops.map(s => ` → ${placeBy.get(s.place_id)?.name ?? '?'}`).join('')}{baseLabel(t.base_from, t.base_to) && <span className="nltag">{baseLabel(t.base_from, t.base_to)}</span>}{t.takeover && <span className="totag" title="Take-over: cestu přebíráme od cizí posádky">Take-over</span>}</td>
                    <td className="ro">{[t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => personBy.get(id!)?.short_name).join(', ')}</td>
                    <td className="ro nowrap">{carBy.get(t.car_id ?? '')?.plate ?? carBy.get(t.car_id ?? '')?.car_no ?? ''}</td>
                    {TIMES.map((x, i) => (
                      <td key={x.key} className="timecell">
                        <Text disabled={!ed} value={fmtDT(t[x.key])} time placeholder="hh:mm"
                          onSave={v => {
                            const base = i === 0 ? `${t.trip_date}T00:00:00` : prevFilled(t, i)
                            const r = parseDT(v, base, i > 0)
                            if (r === undefined) return toast('Čas zapište jako 3:30 nebo 2.11. 3:30.', 'err')
                            save(t, { [x.key]: r } as Partial<Trip>)
                          }} />
                      </td>
                    ))}
                    {(['km_pup', 'km_dop', 'km_total'] as const).map(k => (
                      <td key={k}><Text disabled={!ed} value={t[k]?.toString() ?? ''} time mono
                        onSave={v => { const n = num(v); if (n === undefined) return toast('Km pište jako celé číslo.', 'err'); save(t, { [k]: n === null ? null : Math.round(n) } as Partial<Trip>) }} /></td>
                    ))}
                    <td><Text disabled={!ed} value={t.toll?.toString().replace('.', ',') ?? ''} time mono
                      onSave={v => { const n = num(v); if (n === undefined) return toast('Mýto pište jako číslo, třeba 25,50.', 'err'); save(t, { toll: n }) }} /></td>
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
                      const pr = tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH)
                      const auto = tripPrice({ ...t, price_manual: null }, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH)
                      return <>
                        <td>
                          {variants.length > 1 && (
                            <select className="variantsel" disabled={!ed} value={route?.id ?? ''} title="Varianta trasy (přes Francii, přes Švýcarsko…). Platí pro cenu i pro Start a Home v Planningu."
                              onChange={e => save(t, { route_id: e.target.value || null })}>
                              {variants.map(v => <option key={v.id} value={v.id}>{variantLabel(v.variant)}</option>)}
                            </select>
                          )}
                          {t.price_manual != null
                            ? <span className="ro manualprice">ručně {ed && <button className="link small" onClick={() => save(t, { price_manual: null })} title="Zrušit ruční cenu a počítat znovu">zrušit</button>}</span>
                            : route
                            ? <select disabled={!ed} value={t.route_price_id ?? ''} onChange={e => save(t, { route_price_id: e.target.value || null })}>
                                <option value="">sazby ({route.rate_h} €/h, {route.rate_km} €/km){routeIncomplete(route) ? ' – chybí PUP→DOP!' : ''}</option>
                                {opts.map(p => <option key={p.id} value={p.id}>pevná {p.label}: {eur(Number(p.price))}</option>)}
                              </select>
                            : (() => {
                                const sug = t.pup_id && t.dop_id ? suggestRoutes(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : []
                                const comp = t.pup_id && t.dop_id && !sug.length ? composeRoute(t.pup_id, t.dop_id, t.base_from, t.base_to, routes, placeBy, tstops.map(s => s.place_id)) : null
                                return <span className="ro missingtxt" title={`V Trasách a cenách tahle trasa není${baseLabel(t.base_from, t.base_to) ? ` (varianta ${baseLabel(t.base_from, t.base_to)})` : ''}`}>
                                  chybí trasa{baseLabel(t.base_from, t.base_to) ? ` ${baseLabel(t.base_from, t.base_to)}` : ''}
                                  {sug.length > 0 && canRoutes && (
                                    <> <button className="link small" title={`Založí trasu jako kopii ${placeBy.get(sug[0].route.pup_id)?.name} → ${placeBy.get(sug[0].route.dop_id)?.name} (${sug[0].why}) včetně sazeb a pevných cen. Příště už se nebude ptát.`}
                                      onClick={() => adoptRoute(t, sug[0].route)}>použít {placeBy.get(sug[0].route.pup_id)?.name} → {placeBy.get(sug[0].route.dop_id)?.name}</button></>
                                  )}
                                  {comp && (comp.ho || comp.dh) && canRoutes && (
                                    <> <button className="link small" title={`Založí trasu s hotovými úseky: ${t.base_from}→PUP ${comp.ho ? 'z ' + comp.ho.why : 'chybí'}; ${comp.mid ? 'PUP→DOP součet ' + comp.mid.parts.join(' + ') + '; ' : ''}DOP→${t.base_to} ${comp.dh ? 'z ' + comp.dh.why : 'chybí'}.${comp.mid ? '' : ' Úsek PUP→DOP pak doplníte v Trasách a cenách.'}`}
                                      onClick={() => composeFor(t, comp.ho, comp.dh, comp.mid)}>založit z úseků{comp.mid ? ' (i PUP→DOP)' : comp.ho && comp.dh ? '' : comp.ho ? ' (jen Výjezd→PUP)' : ' (jen DOP→Návrat)'}</button></>
                                  )}
                                </span>
                              })()}
                        </td>
                        <td className="num" title={pr?.how}>
                          <Text disabled={!ed} value={pr ? eur(pr.price) : ''} time mono placeholder={ed ? 'zadat' : ''}
                            onSave={v => {
                              const n = num(v.replace('€', ''))
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
                          <button className="primary small" disabled={!ready} title={ready ? 'Uzavřít report' : 'Chybí číslo reportu, odjezd nebo příjezd domů'}
                            onClick={() => save(t, { status: DONE })}>Hotovo</button>{' '}
                          <button className="link small" onClick={() => save(t, { status: 'Departed' })} title="Vrátit cestu do Planningu se statusem Departed">Do Planningu</button>
                        </>
                      )}
                      {canEdit && done && <button className="link small" onClick={() => save(t, { status: REPORT })}>Znovu otevřít</button>}
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
