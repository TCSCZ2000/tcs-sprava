import { useEffect, useMemo, useState } from 'react'
import { supabase, type Route, type RoutePrice, type Trip } from '../lib/supabase'
import { eur, tripPrice } from '../lib/routes'
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
  useEffect(() => {
    if (!seePrice) return
    Promise.all([supabase.from('routes').select('*'), supabase.from('route_prices').select('*').order('sort')])
      .then(([r, p]) => { setRoutes((r.data as Route[]) ?? []); setRprices((p.data as RoutePrice[]) ?? []) })
  }, [seePrice])
  const routeBy = useMemo(() => new Map(routes.map(r => [`${r.pup_id}|${r.dop_id}|${r.home_base}`, r])), [routes])
  const [trips, setTrips] = useState<Trip[]>([])
  const [showDone, setShowDone] = useState(false)
  const [doneMonth, setDoneMonth] = useState(todayIso().slice(0, 7))
  const [chainTrips, setChainTrips] = useState<Trip[]>([])
  const [hiddenCust, setHiddenCust] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
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
    })
  }, [showDone, doneMonth, toast])

  // Cesty s odjezdem za posledních 90 dní kvůli navazování (předchozí cesta posádky může být i hotová nebo ještě v plánu)
  useEffect(() => {
    supabase.from('trips').select('*').not('dep_home', 'is', null).gte('trip_date', todayIso(-90))
      .then(({ data }) => setChainTrips((data as Trip[]) ?? []))
  }, [trips])
  const { byNext } = useMemo(() => chainHours(chainTrips), [chainTrips])

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

  async function nextNumber(t: Trip) {
    const { data } = await supabase.from('trips').select('report_no').not('report_no', 'is', null).order('report_no', { ascending: false }).limit(1)
    const last = (data as { report_no: number }[] | null)?.[0]?.report_no
    if (!last) return toast('Zatím není žádné číslo reportu. Napište první ručně, další už aplikace dopočítá.', 'err')
    save(t, { report_no: last + 1 })
  }

  function excel() {
    const head: Cell[] = ['Datum', 'Čas', 'Zákazník', '#Report', 'Ref.', 'Pup', 'Dop', 'Posádka', 'Auto', ...TIMES.map(x => x.label), 'Km Pup', 'Km Dop', 'Km celkem', 'Mýto €', 'Celkem h', 'Eskorta h', 'Hodiny ručně', 'Navazuje', 'Cena podle', 'Cena € bez DPH', 'Poznámka', 'Status']
    const body: Cell[][] = []
    for (const [, rows] of groups) for (const t of rows) {
      const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, t.arr_dop)
      const route = routeBy.get(`${t.pup_id}|${t.dop_id}|${t.home_base}`)
      const pr = seePrice ? tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, t.trip_time && t.dep_dop ? Number((hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, t.dep_dop) ?? '0').replace(',', '.')) : null) : null
      const links = byNext.get(t.id) ?? []
      body.push([t.trip_date.split('-').reverse().join('.'), t.trip_time?.slice(0, 5), t.customer, t.report_no, t.ref_tcs,
        placeBy.get(t.pup_id ?? '')?.name, placeBy.get(t.dop_id ?? '')?.name,
        [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => personBy.get(id!)?.short_name).join(', '),
        carBy.get(t.car_id ?? '')?.plate ?? carBy.get(t.car_id ?? '')?.car_no,
        ...TIMES.map(x => fmtDT(t[x.key])), t.km_pup, t.km_dop, t.km_total, t.toll, total, escort, t.hours_manual,
        t.combi === true ? 'ano' : t.combi === false ? 'ne' : links.some(l => l.kind === 'auto' || l.kind === 'overlap') ? 'navrženo' : '',
        pr?.how, pr?.price, t.report_note, t.status])
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
        <label className="check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />Ukázat i hotové za</label>
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
                const total = hours(t.dep_home, t.arr_home), escort = hours(t.dep_pup, t.arr_dop)
                const ready = !!t.report_no && !!t.dep_home && !!t.arr_home
                const ed = canEdit && !done
                return (
                  <tr key={t.id} className={'trip' + (done ? ' done' : '')} style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                    <td className="ro nowrap">{dm(t.trip_date)} {t.trip_time?.slice(0, 5)}</td>
                    <td className={'ro' + (t.customer ? '' : ' missingtxt')}>{t.customer ?? 'chybí'}</td>
                    <td className="repno">
                      <Text disabled={!ed} value={t.report_no?.toString() ?? ''} mono time placeholder="číslo"
                        onSave={v => { const n = v.trim(); if (n && !/^\d+$/.test(n)) return toast('Číslo reportu jsou jen číslice.', 'err'); save(t, { report_no: n ? Number(n) : null }) }} />
                      {ed && !t.report_no && <button className="link small" onClick={() => nextNumber(t)}>další</button>}
                    </td>
                    <td><Text disabled={!ed} value={t.ref_tcs ?? ''} mono time placeholder="A·····"
                      onSave={v => save(t, { ref_tcs: v.trim().toUpperCase() || null })} /></td>
                    <td className="ro">{placeBy.get(t.pup_id ?? '')?.name ?? '?'} → {placeBy.get(t.dop_id ?? '')?.name ?? '?'}</td>
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
                      const route = routeBy.get(`${t.pup_id}|${t.dop_id}|${t.home_base}`)
                      const opts = route ? rprices.filter(p => p.route_id === route.id) : []
                      const rq = t.trip_time ? hours(`${t.trip_date}T${t.trip_time.slice(0, 5)}:00`, t.dep_dop) : null
                      const reqH = rq ? Number(rq.replace(',', '.')) : null
                      const pr = tripPrice(t, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH)
                      const auto = tripPrice({ ...t, price_manual: null }, route, rprices, total ? Number(total.replace(',', '.')) : null, reqH)
                      return <>
                        <td>
                          {t.price_manual != null
                            ? <span className="ro manualprice">ručně {ed && <button className="link small" onClick={() => save(t, { price_manual: null })} title="Zrušit ruční cenu a počítat znovu">zrušit</button>}</span>
                            : route
                            ? <select disabled={!ed} value={t.route_price_id ?? ''} onChange={e => save(t, { route_price_id: e.target.value || null })}>
                                <option value="">sazby ({route.rate_h} €/h, {route.rate_km} €/km)</option>
                                {opts.map(p => <option key={p.id} value={p.id}>pevná {p.label}: {eur(Number(p.price))}</option>)}
                              </select>
                            : <span className="ro missingtxt" title={`V Trasách a cenách tahle trasa není${t.home_base === 'NL' ? ' (varianta NL–NL)' : ''}`}>chybí trasa{t.home_base === 'NL' ? ' NL' : ''}</span>}
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
