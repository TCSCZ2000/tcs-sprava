import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, reportDone, supplierOf, supplierLabel, NO_SUPPLIER, EXTRA_KINDS, type HoursExtra, type RouteTime, type Trip } from '../lib/supabase'
import { ExtraHoursDialog } from './ExtraHoursDialog'
import { SupplierExportDialog } from './SupplierExport'
import { usePref } from './Plan'
import { buildRouteIndex, plannedStartIso } from '../lib/planned'
import { explain, useApp } from '../lib/data'
import { fmtDT, todayIso } from '../lib/format'
import { chainHours, fmtGap, fmtH, round2, type Seg } from '../lib/hours'
import { exportXlsx, printPdf, type Cell } from '../lib/export'

const KINDS = EXTRA_KINDS
const kindLabel = (k: string) => KINDS.find(x => x.key === k)?.label ?? k

const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' }) }
const shiftMonth = (m: string, d: number) => { const [y, mo] = m.split('-').map(Number); const x = new Date(y, mo - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}` }
const monthStart = (m: string) => `${m}-01`

type Row = { key: string; person: string; supplier: string; segs: Seg[]; extra: HoursExtra[]; raw: number; real: number; mimo: number; pevne: number; total: number; pending: number }

export default function Hours() {
  const { level, people, places, suppliers, crew, toast } = useApp()
  const canEdit = level('hours') === 'write'
  const [month, setMonth] = useState(todayIso().slice(0, 7))
  const [trips, setTrips] = useState<Trip[]>([])
  const [extra, setExtra] = useState<HoursExtra[]>([])
  const [routeTimes, setRouteTimes] = useState<RouteTime[]>([])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [form, setForm] = useState(false)
  const [view, setView] = usePref<'list' | 'wide'>('hours.view', 'list')
  const [decide, setDecide] = useState<HoursExtra | null>(null)
  const [supExport, setSupExport] = useState(false)

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const ridx = useMemo(() => buildRouteIndex(routeTimes, placeBy), [routeTimes, placeBy])
  useEffect(() => { supabase.rpc('route_times').then(({ data }) => setRouteTimes((data as RouteTime[]) ?? [])) }, [])
  const from = monthStart(month), to = monthStart(shiftMonth(month, 1))

  const load = () => {
    // Cesty měsíc před a po, aby navazování fungovalo i přes přelom měsíce
    Promise.all([
      supabase.from('trips').select('*').gte('trip_date', monthStart(shiftMonth(month, -1))).lt('trip_date', monthStart(shiftMonth(month, 2))).neq('status', 'Canceled'),
      supabase.from('hours_extra').select('*').or(`and(work_date.gte.${from},work_date.lt.${to}),status.eq.navrzeno`).order('work_date'),
    ]).then(([t, e]) => {
      if (t.error) toast(explain(t.error), 'err')
      if (e.error) toast(explain(e.error), 'err')
      setTrips((t.data as Trip[]) ?? []); setExtra((e.data as HoursExtra[]) ?? []); setLoaded(true)
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [month])

  const { segs } = useMemo(() => chainHours(trips, t => plannedStartIso(t, ridx, placeBy), crew), [trips, ridx, placeBy, crew])
  const inMonth = (t: Trip) => t.trip_date >= from && t.trip_date < to
  const counted = (t: Trip) => t.status === 'Finished' && reportDone(t)
  const proposals = useMemo(() => extra.filter(e => e.status === 'navrzeno'), [extra])
  const pendingTrips = useMemo(() => trips.filter(t => inMonth(t) && !counted(t) && t.status !== 'Canceled'), [trips, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    // řádek = člověk × dodavatel (člověk dodaný na jedné cestě jiným dodavatelem je v seznamu toho dodavatele)
    const m = new Map<string, Row>()
    const row = (p: string, sup: string) => { const k = p + '|' + sup; if (!m.has(k)) m.set(k, { key: k, person: p, supplier: sup, segs: [], extra: [], raw: 0, real: 0, mimo: 0, pevne: 0, total: 0, pending: 0 }); return m.get(k)! }
    const defSup = (p: string) => personBy.get(p)?.supplier ?? NO_SUPPLIER
    for (const s of segs.values()) {
      if (!inMonth(s.trip)) continue
      const sup = s.ov?.supplier ?? supplierOf(s.trip, s.person, personBy)
      if (!counted(s.trip)) { if (s.trip.status !== 'Canceled') row(s.person, sup).pending++; continue }
      const r = row(s.person, sup); r.segs.push(s); r.raw += s.hoursRaw ?? 0; r.real += s.hours ?? 0
    }
    for (const e of extra) { if (e.status !== 'schvaleno') continue; const r = row(e.person_id, defSup(e.person_id)); r.extra.push(e); if (e.kind === 'pevne') r.pevne += Number(e.hours); else r.mimo += Number(e.hours) }
    for (const r of m.values()) { r.raw = round2(r.raw); r.real = round2(r.real); r.total = round2(r.real + r.mimo + r.pevne); r.segs.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')) }
    const supSort = (n: string) => n === NO_SUPPLIER ? 99 : suppliers.find(x => x.name === n)?.sort ?? 50
    return [...m.values()].filter(r => r.segs.length || r.extra.length).sort((a, b) => supSort(a.supplier) - supSort(b.supplier) || a.supplier.localeCompare(b.supplier) || (personBy.get(a.person)?.short_name ?? '').localeCompare(personBy.get(b.person)?.short_name ?? '', 'cs'))
  }, [segs, extra, personBy, suppliers, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  // auta od dodavatelů: cesty v měsíci s hotovým reportem, kde auto dodal dodavatel (platí se km × sazba + mýto)
  // + km náhradníka / střídání (auto člověka, který dojel na místo střídání) – platí se jeho dodavateli
  type SupCar = { key: string; supplier: string; t: Trip; km: number | null; toll: number | null; who: string }
  const supCars = useMemo<SupCar[]>(() => {
    const out: SupCar[] = trips.filter(t => inMonth(t) && counted(t) && t.car_supplier).map(t => ({ key: t.id, supplier: t.car_supplier!, t, km: t.supplier_km, toll: t.supplier_toll, who: '' }))
    for (const c of crew) {
      const t = trips.find(x => x.id === c.trip_id)
      if (!t || !inMonth(t) || !counted(t) || !c.km) continue
      out.push({ key: c.id, supplier: c.supplier ?? supplierOf(t, c.person_id, personBy), t, km: c.km, toll: null, who: personBy.get(c.person_id)?.short_name ?? '?' })
    }
    return out.sort((a, b) => a.t.trip_date.localeCompare(b.t.trip_date))
  }, [trips, crew, from, to, personBy]) // eslint-disable-line react-hooks/exhaustive-deps
  const supCarAmount = (c: SupCar) => { const rate = suppliers.find(x => x.name === c.supplier)?.rate_km; return rate != null && c.km != null ? round2(Number(c.km) * Number(rate) + Number(c.toll ?? 0)) : null }
  const multiSup = new Set(rows.map(r => r.supplier)).size > 1 || supCars.length > 0

  const sum = (k: 'raw' | 'real' | 'mimo' | 'pevne' | 'total', sup?: string) => round2(rows.filter(r => !sup || r.supplier === sup).reduce((a, r) => a + r[k], 0))
  const name = (id: string) => personBy.get(id)?.short_name ?? '?'

  async function removeExtra(e: HoursExtra) {
    if (!window.confirm(`Smazat ${fmtH(Number(e.hours))} h (${e.note ?? kindLabel(e.kind)})?`)) return
    const { error } = await supabase.from('hours_extra').delete().eq('id', e.id)
    if (error) return toast(explain(error), 'err')
    load()
  }
  async function decideExtra(e: HoursExtra, status: 'schvaleno' | 'zamitnuto', note?: string) {
    const { error } = await supabase.from('hours_extra').update({ status, decision_note: note?.trim() || null }).eq('id', e.id)
    if (error) return toast(explain(error), 'err')
    setDecide(null); load()
  }
  async function setCombi(t: Trip, v: boolean | null) {
    const { error } = await supabase.from('trips').update({ combi: v }).eq('id', t.id)
    if (error) return toast(explain(error), 'err')
    load()
  }

  function toggle(p: string) { setOpen(cur => { const n = new Set(cur); n.has(p) ? n.delete(p) : n.add(p); return n }) }

  function excel() {
    const summary: Cell[][] = [['Dodavatel', 'Jméno', 'Hodiny z reportů', 'Skutečné', 'Úspora', 'Mimo report', 'Pevné hodiny', 'Celkem']]
    for (const r of rows) summary.push([supplierLabel(r.supplier), name(r.person), r.raw, r.real, round2(r.raw - r.real), r.mimo, r.pevne, r.total])
    for (const sup of [...new Set(rows.map(r => r.supplier))]) summary.push([supplierLabel(sup), 'CELKEM ' + supplierLabel(sup), sum('raw', sup), sum('real', sup), round2(sum('raw', sup) - sum('real', sup)), sum('mimo', sup), sum('pevne', sup), sum('total', sup)])
    summary.push(['', 'CELKEM', sum('raw'), sum('real'), round2(sum('raw') - sum('real')), sum('mimo'), sum('pevne'), sum('total')])
    const detail: Cell[][] = [['Dodavatel', 'Jméno', '#Report', 'Ref.', 'Od', 'Do (report)', 'Do (pro hodiny)', 'Hodiny', 'Poznámka']]
    for (const r of rows) {
      for (const s of r.segs) detail.push([supplierLabel(r.supplier), name(r.person), s.trip.report_no, s.trip.ref_tcs, fmtDT(s.start), fmtDT(s.end), fmtDT(s.endAdj ?? s.end), s.hours, [s.ov ? (s.ov.note || 'střídání') : '', adjNote(s)].filter(Boolean).join(' · ')])
      for (const e of r.extra) detail.push([supplierLabel(r.supplier), name(r.person), '', kindLabel(e.kind), e.work_date, '', '', Number(e.hours), e.note])
    }
    const cars: Cell[][] = [['Dodavatel', 'Datum', '#Report', 'Ref.', 'Trasa', 'Km', 'Kč/km', 'Mýto', 'Celkem Kč']]
    for (const c of supCars) cars.push([supplierLabel(c.supplier), c.t.trip_date.split('-').reverse().join('.'), c.t.report_no, c.t.ref_tcs, `${placeBy.get(c.t.pup_id ?? '')?.name ?? '?'} → ${placeBy.get(c.t.dop_id ?? '')?.name ?? '?'}${c.who ? ` (${c.who})` : ''}`, c.km, suppliers.find(x => x.name === c.supplier)?.rate_km ?? '', c.toll, supCarAmount(c)])
    exportXlsx(`hodiny_${month}`, [{ name: 'Lidé', rows: summary, widths: [12, 18, 14, 12, 10, 12, 12, 10] }, { name: 'Detail', rows: detail, widths: [12, 18, 9, 9, 16, 16, 16, 8, 40] }, ...(supCars.length ? [{ name: 'Auta dodavatelů', rows: cars, widths: [14, 10, 9, 9, 36, 8, 8, 8, 10] }] : [])])
  }

  return (
    <section className="list hours size-s">
      <div className="toolbar">
        <h1>Hodiny</h1>
        <div className="seg" role="group" aria-label="Měsíc">
          <button onClick={() => setMonth(shiftMonth(month, -1))} title="Předchozí měsíc">‹</button>
          <button className="on" style={{ minWidth: '9rem' }}>{monthLabel(month)}</button>
          <button onClick={() => setMonth(shiftMonth(month, 1))} title="Další měsíc">›</button>
        </div>
        <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className="search" style={{ minWidth: 'auto', flex: '0 0 auto' }} />
        <span className="count">{rows.length} lidí · {fmtH(sum('total'))} h</span>
        <div className="seg" role="group" aria-label="Pohled">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="Lidé pod sebou, detail rozklikem">Pod sebou</button>
          <button className={view === 'wide' ? 'on' : ''} onClick={() => setView('wide')} title="Člověk a vedle něj cesty za sebou (jako v Excelu)">Vedle sebe</button>
        </div>
        <span className="grow" />
        <button className="ghostbtn" onClick={excel}>Excel</button>
        <button className="ghostbtn" onClick={() => setSupExport(true)} title="Hodiny a cesty lidí dodavatele bez cen a úspor">Podklad pro dodavatele</button>
        <button className="ghostbtn" onClick={printPdf}>Tisk / PDF</button>
        {canEdit && <button className="primary" onClick={() => setForm(true)}>Přidat hodiny navíc</button>}
      </div>
      <p className="intro">Hodiny za cesty s datem v tomhle měsíci a hotovým reportem. Když člověk pokračuje rovnou na další cestu, konec předchozí se pro hodiny posune na start té další (překryv vždy, mezera do 6 h automaticky jako „navrženo“, delší jen po potvrzení v Reportech). Časy v reportu ani cena zákazníkovi se tím nemění.</p>

      {pendingTrips.length > 0 && (
        <p className="warn">{pendingTrips.length} {pendingTrips.length === 1 ? 'cesta v tomhle měsíci ještě nemá' : pendingTrips.length < 5 ? 'cesty v tomhle měsíci ještě nemají' : 'cest v tomhle měsíci ještě nemá'} hotový report, hodiny z nich tu nejsou: {pendingTrips.slice(0, 8).map(t => `${t.ref_tcs ?? t.status} ${t.trip_date.slice(8, 10)}. ${Number(t.trip_date.slice(5, 7))}.`).join(', ')}{pendingTrips.length > 8 ? '…' : ''}</p>
      )}

      {form && <ExtraHoursDialog onClose={() => setForm(false)} onSaved={load} />}
      {supExport && <SupplierExportDialog month={month} rows={rows} trips={trips.filter(t => inMonth(t) && counted(t))} onClose={() => setSupExport(false)} />}
      {proposals.length > 0 && (
        <div className="proposals">
          <strong>Návrhy hodin navíc ke schválení ({proposals.length})</strong>
          <table className="grid plain sub2">
            <thead><tr><th>Datum</th><th>Člověk</th><th>Druh</th><th className="num">Hodiny</th><th>Poznámka</th><th>Navrhl</th><th /></tr></thead>
            <tbody>
              {proposals.map(e => (
                <tr key={e.id} className="proposed">
                  <td>{e.work_date.split('-').reverse().join('. ')}</td><td><strong>{name(e.person_id)}</strong></td><td>{kindLabel(e.kind)}</td><td className="num"><strong>{fmtH(Number(e.hours))}</strong></td>
                  <td>{e.note}{e.trip_id && <span className="quiet small"> · k cestě</span>}</td><td className="quiet small">{fmtDT(e.created_at.slice(0, 16))}</td>
                  <td className="nowrap">{canEdit && <>
                    <button className="link small" onClick={() => decideExtra(e, 'schvaleno')}>schválit</button>{' '}
                    {decide?.id === e.id
                      ? <span className="inlinerow"><input className="cell" placeholder="důvod (nepovinné)" id={'dn' + e.id} /><button className="link small" onClick={() => decideExtra(e, 'zamitnuto', (document.getElementById('dn' + e.id) as HTMLInputElement)?.value)}>zamítnout</button><button className="link small" onClick={() => setDecide(null)}>zpět</button></span>
                      : <button className="link small" onClick={() => setDecide(e)}>zamítnout</button>}
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'list' && <div className="tablewrap">
        <table className="grid plain hoursgrid">
          <thead>
            <tr>
              <th>Jméno</th><th className="num" title="Součet příjezd domů − odjezd domov z reportů">Z reportů</th>
              <th className="num" title="Po posunutí konců navazujících cest">Skutečné</th><th className="num">Úspora</th>
              <th className="num" title={KINDS[0].hint}>Mimo report</th><th className="num" title={KINDS[1].hint}>Pevné</th><th className="num">Celkem</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.key}>
                {multiSup && (i === 0 || rows[i - 1].supplier !== r.supplier) && (
                  <tr className="supsection"><td colSpan={8}><strong>{supplierLabel(r.supplier)}</strong><span className="quiet small"> · {rows.filter(x => x.supplier === r.supplier).length} lidí · {fmtH(sum('total', r.supplier))} h</span></td></tr>
                )}
                <tr className={open.has(r.key) ? 'open' : ''}>
                  <td><button className="link" onClick={() => toggle(r.key)}>{open.has(r.key) ? '▾' : '▸'} {name(r.person)}</button>
                    {r.pending > 0 && <span className="quiet small" title="Cesty tohoto člověka v měsíci bez hotového reportu"> +{r.pending} bez reportu</span>}</td>
                  <td className="num">{fmtH(r.raw)}</td><td className="num"><strong>{fmtH(r.real)}</strong></td>
                  <td className={'num' + (r.raw - r.real > 0 ? ' saving' : '')}>{r.raw - r.real !== 0 ? fmtH(round2(r.raw - r.real)) : ''}</td>
                  <td className="num">{r.mimo ? fmtH(r.mimo) : ''}</td><td className="num">{r.pevne ? fmtH(r.pevne) : ''}</td>
                  <td className="num"><strong>{fmtH(r.total)}</strong></td><td />
                </tr>
                {open.has(r.key) && (
                  <tr className="detail"><td colSpan={8}>
                    <table className="sub">
                      <thead><tr><th>#Report</th><th>Ref.</th><th>Od</th><th>Do (report)</th><th>Do (pro hodiny)</th><th className="num">Hodiny</th><th>Navazování</th></tr></thead>
                      <tbody>
                        {r.segs.map(s => (
                          <tr key={s.trip.id}>
                            <td>{s.trip.report_no}</td><td>{s.trip.ref_tcs}</td><td>{fmtDT(s.start)}</td>
                            <td className={s.endAdj ? 'strike' : ''}>{fmtDT(s.end)}</td>
                            <td className={s.adj ? 'adj-' + s.adj.kind : ''}>{s.endAdj ? fmtDT(s.endAdj) : ''}</td>
                            <td className="num">{fmtH(s.hours)}{s.manual && <span className="quiet small" title="Hodiny ručně"> ručně</span>}</td>
                            <td className="quiet">
                              {s.ov && <span className="suptag crewtag" title="Střídání / náhradník – vlastní od–do">{s.ov.note || 'střídání'}</span>}{s.ov && ' '}
                              {adjNote(s)}
                              {s.adj?.kind === 'auto' && canEdit && <> <button className="link small" onClick={() => setCombi(s.adj!.next, true)}>Potvrdit</button> <button className="link small" onClick={() => setCombi(s.adj!.next, false)}>Nenavazuje</button></>}
                              {!s.adj && s.next && s.next.kind === 'none' && <>další cesta za {fmtGap(s.next.gapH)}{s.next.planned ? ' (podle plánovaného startu)' : ''}{canEdit && <> <button className="link small" onClick={() => setCombi(s.next!.trip, true)}>navazuje</button></>}</>}
                              {!s.adj && s.next && s.next.kind === 'rejected' && <>nenavazuje (odmítnuto){canEdit && <> <button className="link small" onClick={() => setCombi(s.next!.trip, null)}>zrušit</button></>}</>}
                            </td>
                          </tr>
                        ))}
                        {r.extra.map(e => (
                          <tr key={e.id} className="extra">
                            <td /><td>{kindLabel(e.kind)}</td><td>{e.work_date.split('-').reverse().join('. ')}</td><td /><td />
                            <td className="num">{fmtH(Number(e.hours))}</td>
                            <td className="quiet">{e.note}{canEdit && <> <button className="link small" onClick={() => removeExtra(e)}>smazat</button></>}</td>
                          </tr>
                        ))}
                        {r.segs.length === 0 && r.extra.length === 0 && <tr><td colSpan={7} className="quiet">Žádné hotové reporty v tomhle měsíci.</td></tr>}
                      </tbody>
                    </table>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr>
              <td><strong>Celkem</strong></td><td className="num">{fmtH(sum('raw'))}</td><td className="num"><strong>{fmtH(sum('real'))}</strong></td>
              <td className="num saving">{fmtH(round2(sum('raw') - sum('real')))}</td><td className="num">{fmtH(sum('mimo'))}</td><td className="num">{fmtH(sum('pevne'))}</td>
              <td className="num"><strong>{fmtH(sum('total'))}</strong></td><td />
            </tr></tfoot>
          )}
        </table>
        {loaded && rows.length === 0 && <p className="empty">V tomhle měsíci zatím nejsou žádné hotové reporty ani hodiny mimo report.</p>}
      </div>}
      {view === 'wide' && (
        <div className="tablewrap">
          <table className="grid plain hoursgrid wide">
            <thead><tr><th>Jméno</th><th className="num">Celkem</th><th>Cesty a hodiny v pořadí →</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const items = [
                  ...r.segs.map(s => ({ at: s.start ?? s.end ?? '', seg: s, ex: null as HoursExtra | null })),
                  ...r.extra.map(e => ({ at: e.work_date + 'T00:00:00', seg: null as Seg | null, ex: e })),
                ].sort((a, b) => a.at.localeCompare(b.at))
                return (
                  <Fragment key={r.key}>
                    {multiSup && (i === 0 || rows[i - 1].supplier !== r.supplier) && (
                      <tr className="supsection"><td colSpan={3}><strong>{supplierLabel(r.supplier)}</strong><span className="quiet small"> · {rows.filter(x => x.supplier === r.supplier).length} lidí · {fmtH(sum('total', r.supplier))} h</span></td></tr>
                    )}
                    <tr>
                      <td className="nowrap"><strong>{name(r.person)}</strong>{r.pending > 0 && <span className="quiet small" title="Cesty bez hotového reportu"> +{r.pending}</span>}</td>
                      <td className="num"><strong>{fmtH(r.total)}</strong>{r.raw - r.real > 0 && <div className="quiet small">z reportů {fmtH(r.raw)}</div>}</td>
                      <td className="blocks">
                        {items.map(it => it.seg ? (
                          <span key={it.seg.trip.id} className={'hblock' + (it.seg.adj ? ' adj-' + it.seg.adj.kind : '')} title={adjNote(it.seg)}>
                            <span className="hb-head">#{it.seg.trip.report_no ?? '–'} {it.seg.trip.ref_tcs ?? ''} <span className="quiet">{placeBy.get(it.seg.trip.pup_id ?? '')?.name ?? '?'} → {placeBy.get(it.seg.trip.dop_id ?? '')?.name ?? '?'}</span></span>
                            <span className="hb-time">{fmtDT(it.seg.start)} – {it.seg.endAdj ? <><s>{fmtDT(it.seg.end)}</s> {fmtDT(it.seg.endAdj)}</> : fmtDT(it.seg.end)}</span>
                            <span className="hb-h"><strong>{fmtH(it.seg.hours)} h</strong>{it.seg.manual && <span className="quiet small"> ručně</span>}{it.seg.ov && <span className="suptag crewtag">{it.seg.ov.note || 'střídání'}</span>}</span>
                            {it.seg.adj && <span className="hb-link">⟶ navazuje {it.seg.adj.gapH < 0 ? `(překryv ${fmtGap(it.seg.adj.gapH)})` : `(mezera ${fmtGap(it.seg.adj.gapH)})`}{it.seg.adj.kind === 'auto' && canEdit && <> <button className="link small" onClick={() => setCombi(it.seg!.adj!.next, true)}>potvrdit</button> <button className="link small" onClick={() => setCombi(it.seg!.adj!.next, false)}>ne</button></>}</span>}
                            {!it.seg.adj && it.seg.next && it.seg.next.kind === 'none' && <span className="hb-link quiet">další za {fmtGap(it.seg.next.gapH)}{canEdit && <> <button className="link small" onClick={() => setCombi(it.seg!.next!.trip, true)}>navazuje</button></>}</span>}
                          </span>
                        ) : (
                          <span key={it.ex!.id} className="hblock extra" title={it.ex!.note ?? ''}>
                            <span className="hb-head">{kindLabel(it.ex!.kind)}</span>
                            <span className="hb-time">{it.ex!.work_date.split('-').reverse().join('. ')}</span>
                            <span className="hb-h"><strong>{fmtH(Number(it.ex!.hours))} h</strong>{it.ex!.note && <span className="quiet small"> {it.ex!.note}</span>}</span>
                          </span>
                        ))}
                        {items.length === 0 && <span className="quiet small">bez hotových reportů</span>}
                      </td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
            {rows.length > 0 && <tfoot><tr><td><strong>Celkem</strong></td><td className="num"><strong>{fmtH(sum('total'))}</strong></td><td className="quiet small">z reportů {fmtH(sum('raw'))} · skutečné {fmtH(sum('real'))} · navíc {fmtH(round2(sum('mimo') + sum('pevne')))}</td></tr></tfoot>}
          </table>
        </div>
      )}
      {supCars.length > 0 && (
        <div className="tablewrap">
          <h2 className="subhead">Auta od dodavatelů</h2>
          <table className="grid plain sub2">
            <thead><tr><th>Dodavatel</th><th>Datum</th><th>#Report</th><th>Ref.</th><th>Trasa</th><th className="num">Km</th><th className="num">Kč/km</th><th className="num">Mýto</th><th className="num">Celkem Kč</th></tr></thead>
            <tbody>
              {supCars.map(c => (
                <tr key={c.key}>
                  <td><strong>{supplierLabel(c.supplier)}</strong></td><td>{c.t.trip_date.split('-').reverse().join('. ')}</td><td>{c.t.report_no}</td><td>{c.t.ref_tcs}</td>
                  <td>{placeBy.get(c.t.pup_id ?? '')?.name ?? '?'} → {placeBy.get(c.t.dop_id ?? '')?.name ?? '?'}{c.who && <span className="suptag crewtag" title="Km náhradníka / střídání">{c.who}</span>}</td>
                  <td className="num">{c.km ?? ''}</td><td className="num">{suppliers.find(x => x.name === c.supplier)?.rate_km ?? <span className="quiet small">chybí sazba</span>}</td>
                  <td className="num">{c.toll ?? ''}</td><td className="num"><strong>{supCarAmount(c)?.toLocaleString('cs-CZ') ?? ''}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function adjNote(s: Seg): string {
  if (!s.adj) return ''
  const n = s.adj.next.ref_tcs ?? (s.adj.next.report_no ? `#${s.adj.next.report_no}` : 'další cesta')
  const gap = (s.adj.gapH < 0 ? `překryv ${fmtGap(s.adj.gapH)}` : `mezera ${fmtGap(s.adj.gapH)}`) + (s.adj.nextPlanned ? ', podle plánovaného startu' : '')
  const how = { overlap: 'zkráceno', auto: 'navrženo', confirmed: 'potvrzeno', manual: 'ručně' }[s.adj.kind]
  return `${how}: navazuje ${n} (${gap})`
}
