import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase, supplierOf, SUPPLIER_OWN, type HoursExtra, type RouteTime, type Trip } from '../lib/supabase'
import { buildRouteIndex, plannedStartIso } from '../lib/planned'
import { explain, useApp } from '../lib/data'
import { fmtDT, todayIso } from '../lib/format'
import { chainHours, fmtGap, fmtH, round2, type Seg } from '../lib/hours'
import { exportXlsx, printPdf, type Cell } from '../lib/export'

const KINDS: { key: HoursExtra['kind']; label: string; hint: string }[] = [
  { key: 'mimo', label: 'Mimo report', hint: 'Placené hodiny bez reportu, třeba přesun auta' },
  { key: 'pevne', label: 'Pevné hodiny', hint: 'Pevně dané hodiny za jinou práci' },
]

const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' }) }
const shiftMonth = (m: string, d: number) => { const [y, mo] = m.split('-').map(Number); const x = new Date(y, mo - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}` }
const monthStart = (m: string) => `${m}-01`

type Row = { key: string; person: string; supplier: string; segs: Seg[]; extra: HoursExtra[]; raw: number; real: number; mimo: number; pevne: number; total: number; pending: number }

export default function Hours() {
  const { level, people, places, suppliers, toast } = useApp()
  const canEdit = level('hours') === 'write'
  const [month, setMonth] = useState(todayIso().slice(0, 7))
  const [trips, setTrips] = useState<Trip[]>([])
  const [extra, setExtra] = useState<HoursExtra[]>([])
  const [routeTimes, setRouteTimes] = useState<RouteTime[]>([])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [form, setForm] = useState<{ person: string; date: string; kind: HoursExtra['kind']; hours: string; note: string } | null>(null)

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const ridx = useMemo(() => buildRouteIndex(routeTimes, placeBy), [routeTimes, placeBy])
  useEffect(() => { supabase.rpc('route_times').then(({ data }) => setRouteTimes((data as RouteTime[]) ?? [])) }, [])
  const from = monthStart(month), to = monthStart(shiftMonth(month, 1))

  const load = () => {
    // Cesty měsíc před a po, aby navazování fungovalo i přes přelom měsíce
    Promise.all([
      supabase.from('trips').select('*').gte('trip_date', monthStart(shiftMonth(month, -1))).lt('trip_date', monthStart(shiftMonth(month, 2))).neq('status', 'Canceled'),
      supabase.from('hours_extra').select('*').gte('work_date', from).lt('work_date', to).order('work_date'),
    ]).then(([t, e]) => {
      if (t.error) toast(explain(t.error), 'err')
      if (e.error) toast(explain(e.error), 'err')
      setTrips((t.data as Trip[]) ?? []); setExtra((e.data as HoursExtra[]) ?? []); setLoaded(true)
    })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [month])

  const { segs } = useMemo(() => chainHours(trips, t => plannedStartIso(t, ridx, placeBy)), [trips, ridx, placeBy])
  const inMonth = (t: Trip) => t.trip_date >= from && t.trip_date < to
  const counted = (t: Trip) => t.status === 'Finished' && t.report_no != null
  const pendingTrips = useMemo(() => trips.filter(t => inMonth(t) && !counted(t) && t.status !== 'Canceled'), [trips, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    // řádek = člověk × dodavatel (člověk dodaný na jedné cestě jiným dodavatelem je v seznamu toho dodavatele)
    const m = new Map<string, Row>()
    const row = (p: string, sup: string) => { const k = p + '|' + sup; if (!m.has(k)) m.set(k, { key: k, person: p, supplier: sup, segs: [], extra: [], raw: 0, real: 0, mimo: 0, pevne: 0, total: 0, pending: 0 }); return m.get(k)! }
    const defSup = (p: string) => personBy.get(p)?.supplier ?? SUPPLIER_OWN
    for (const s of segs.values()) {
      if (!inMonth(s.trip)) continue
      const sup = supplierOf(s.trip, s.person, personBy)
      if (!counted(s.trip)) { if (s.trip.status !== 'Canceled') row(s.person, sup).pending++; continue }
      const r = row(s.person, sup); r.segs.push(s); r.raw += s.hoursRaw ?? 0; r.real += s.hours ?? 0
    }
    for (const e of extra) { const r = row(e.person_id, defSup(e.person_id)); r.extra.push(e); if (e.kind === 'mimo') r.mimo += Number(e.hours); else r.pevne += Number(e.hours) }
    for (const r of m.values()) { r.raw = round2(r.raw); r.real = round2(r.real); r.total = round2(r.real + r.mimo + r.pevne); r.segs.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')) }
    const supSort = (n: string) => suppliers.find(x => x.name === n)?.sort ?? 50
    return [...m.values()].filter(r => r.segs.length || r.extra.length).sort((a, b) => supSort(a.supplier) - supSort(b.supplier) || a.supplier.localeCompare(b.supplier) || (personBy.get(a.person)?.short_name ?? '').localeCompare(personBy.get(b.person)?.short_name ?? '', 'cs'))
  }, [segs, extra, personBy, suppliers, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  // auta od dodavatelů: cesty v měsíci s hotovým reportem, kde auto dodal dodavatel (platí se km × sazba + mýto)
  const supCars = useMemo(() => trips.filter(t => inMonth(t) && counted(t) && t.car_supplier).sort((a, b) => a.trip_date.localeCompare(b.trip_date)), [trips, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const supCarAmount = (t: Trip) => { const rate = suppliers.find(x => x.name === t.car_supplier)?.rate_km; return rate != null && t.supplier_km != null ? round2(Number(t.supplier_km) * Number(rate) + Number(t.supplier_toll ?? 0)) : null }
  const multiSup = new Set(rows.map(r => r.supplier)).size > 1 || supCars.length > 0

  const sum = (k: 'raw' | 'real' | 'mimo' | 'pevne' | 'total', sup?: string) => round2(rows.filter(r => !sup || r.supplier === sup).reduce((a, r) => a + r[k], 0))
  const name = (id: string) => personBy.get(id)?.short_name ?? '?'

  async function addExtra() {
    if (!form) return
    const h = Number(form.hours.replace(',', '.'))
    if (!form.person || !form.date || !Number.isFinite(h) || h <= 0) return toast('Vyplňte člověka, datum a hodiny.', 'err')
    const { error } = await supabase.from('hours_extra').insert({ person_id: form.person, work_date: form.date, kind: form.kind, hours: h, note: form.note.trim() || null })
    if (error) return toast(explain(error), 'err')
    setForm(null); load()
  }
  async function removeExtra(e: HoursExtra) {
    if (!window.confirm(`Smazat ${fmtH(Number(e.hours))} h (${e.note ?? KINDS.find(k => k.key === e.kind)?.label})?`)) return
    const { error } = await supabase.from('hours_extra').delete().eq('id', e.id)
    if (error) return toast(explain(error), 'err')
    load()
  }
  async function setCombi(t: Trip, v: boolean | null) {
    const { error } = await supabase.from('trips').update({ combi: v }).eq('id', t.id)
    if (error) return toast(explain(error), 'err')
    load()
  }

  function toggle(p: string) { setOpen(cur => { const n = new Set(cur); n.has(p) ? n.delete(p) : n.add(p); return n }) }

  function excel() {
    const summary: Cell[][] = [['Dodavatel', 'Jméno', 'Hodiny z reportů', 'Skutečné', 'Úspora', 'Mimo report', 'Pevné hodiny', 'Celkem']]
    for (const r of rows) summary.push([r.supplier, name(r.person), r.raw, r.real, round2(r.raw - r.real), r.mimo, r.pevne, r.total])
    for (const sup of [...new Set(rows.map(r => r.supplier))]) summary.push([sup, 'CELKEM ' + sup, sum('raw', sup), sum('real', sup), round2(sum('raw', sup) - sum('real', sup)), sum('mimo', sup), sum('pevne', sup), sum('total', sup)])
    summary.push(['', 'CELKEM', sum('raw'), sum('real'), round2(sum('raw') - sum('real')), sum('mimo'), sum('pevne'), sum('total')])
    const detail: Cell[][] = [['Dodavatel', 'Jméno', '#Report', 'Ref.', 'Od', 'Do (report)', 'Do (pro hodiny)', 'Hodiny', 'Poznámka']]
    for (const r of rows) {
      for (const s of r.segs) detail.push([r.supplier, name(r.person), s.trip.report_no, s.trip.ref_tcs, fmtDT(s.start), fmtDT(s.end), fmtDT(s.endAdj ?? s.end), s.hours, adjNote(s)])
      for (const e of r.extra) detail.push([r.supplier, name(r.person), '', KINDS.find(k => k.key === e.kind)?.label, e.work_date, '', '', Number(e.hours), e.note])
    }
    const cars: Cell[][] = [['Dodavatel', 'Datum', '#Report', 'Ref.', 'Trasa', 'Km', 'Kč/km', 'Mýto', 'Celkem Kč']]
    for (const t of supCars) cars.push([t.car_supplier, t.trip_date.split('-').reverse().join('.'), t.report_no, t.ref_tcs, `${placeBy.get(t.pup_id ?? '')?.name ?? '?'} → ${placeBy.get(t.dop_id ?? '')?.name ?? '?'}`, t.supplier_km, suppliers.find(x => x.name === t.car_supplier)?.rate_km ?? '', t.supplier_toll, supCarAmount(t)])
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
        <span className="grow" />
        <button className="ghostbtn" onClick={excel}>Excel</button>
        <button className="ghostbtn" onClick={printPdf}>Tisk / PDF</button>
        {canEdit && <button className="primary" onClick={() => setForm({ person: '', date: todayIso(), kind: 'mimo', hours: '', note: '' })}>Přidat hodiny mimo report</button>}
      </div>
      <p className="intro">Hodiny za cesty s datem v tomhle měsíci a hotovým reportem. Když člověk pokračuje rovnou na další cestu, konec předchozí se pro hodiny posune na start té další (překryv vždy, mezera do 6 h automaticky jako „navrženo“, delší jen po potvrzení v Reportech). Časy v reportu ani cena zákazníkovi se tím nemění.</p>

      {pendingTrips.length > 0 && (
        <p className="warn">{pendingTrips.length} {pendingTrips.length === 1 ? 'cesta v tomhle měsíci ještě nemá' : pendingTrips.length < 5 ? 'cesty v tomhle měsíci ještě nemají' : 'cest v tomhle měsíci ještě nemá'} hotový report, hodiny z nich tu nejsou: {pendingTrips.slice(0, 8).map(t => `${t.ref_tcs ?? t.status} ${t.trip_date.slice(8, 10)}. ${Number(t.trip_date.slice(5, 7))}.`).join(', ')}{pendingTrips.length > 8 ? '…' : ''}</p>
      )}

      {form && (
        <div className="newroute">
          <strong>Hodiny mimo report:</strong>
          <select value={form.person} onChange={e => setForm({ ...form, person: e.target.value })}>
            <option value="">— člověk —</option>
            {people.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.short_name}</option>)}
          </select>
          <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
          <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as HoursExtra['kind'] })}>
            {KINDS.map(k => <option key={k.key} value={k.key} title={k.hint}>{k.label}</option>)}
          </select>
          <input className="search" style={{ minWidth: '5rem', flex: '0 0 5rem' }} placeholder="hodiny" value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} />
          <input className="search" placeholder="poznámka, třeba přesun auta Praha → Příbram" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
          <button className="primary" onClick={addExtra}>Uložit</button>
          <button className="link" onClick={() => setForm(null)}>Zrušit</button>
        </div>
      )}

      <div className="tablewrap">
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
                  <tr className="supsection"><td colSpan={8}><strong>{r.supplier}</strong><span className="quiet small"> · {rows.filter(x => x.supplier === r.supplier).length} lidí · {fmtH(sum('total', r.supplier))} h</span></td></tr>
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
                            <td className="num">{fmtH(s.hours)}{s.manual && <span className="quiet small" title="Hodiny ručně z reportu"> ručně</span>}</td>
                            <td className="quiet">
                              {adjNote(s)}
                              {s.adj?.kind === 'auto' && canEdit && <> <button className="link small" onClick={() => setCombi(s.adj!.next, true)}>Potvrdit</button> <button className="link small" onClick={() => setCombi(s.adj!.next, false)}>Nenavazuje</button></>}
                              {!s.adj && s.next && s.next.kind === 'none' && <>další cesta za {fmtGap(s.next.gapH)}{s.next.planned ? ' (podle plánovaného startu)' : ''}{canEdit && <> <button className="link small" onClick={() => setCombi(s.next!.trip, true)}>navazuje</button></>}</>}
                              {!s.adj && s.next && s.next.kind === 'rejected' && <>nenavazuje (odmítnuto){canEdit && <> <button className="link small" onClick={() => setCombi(s.next!.trip, null)}>zrušit</button></>}</>}
                            </td>
                          </tr>
                        ))}
                        {r.extra.map(e => (
                          <tr key={e.id} className="extra">
                            <td /><td>{KINDS.find(k => k.key === e.kind)?.label}</td><td>{e.work_date.split('-').reverse().join('. ')}</td><td /><td />
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
      </div>
      {supCars.length > 0 && (
        <div className="tablewrap">
          <h2 className="subhead">Auta od dodavatelů</h2>
          <table className="grid plain sub2">
            <thead><tr><th>Dodavatel</th><th>Datum</th><th>#Report</th><th>Ref.</th><th>Trasa</th><th className="num">Km</th><th className="num">Kč/km</th><th className="num">Mýto</th><th className="num">Celkem Kč</th></tr></thead>
            <tbody>
              {supCars.map(t => (
                <tr key={t.id}>
                  <td><strong>{t.car_supplier}</strong></td><td>{t.trip_date.split('-').reverse().join('. ')}</td><td>{t.report_no}</td><td>{t.ref_tcs}</td>
                  <td>{placeBy.get(t.pup_id ?? '')?.name ?? '?'} → {placeBy.get(t.dop_id ?? '')?.name ?? '?'}</td>
                  <td className="num">{t.supplier_km ?? ''}</td><td className="num">{suppliers.find(x => x.name === t.car_supplier)?.rate_km ?? <span className="quiet small">chybí sazba</span>}</td>
                  <td className="num">{t.supplier_toll ?? ''}</td><td className="num"><strong>{supCarAmount(t)?.toLocaleString('cs-CZ') ?? ''}</strong></td>
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
