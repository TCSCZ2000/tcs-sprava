import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supplierLabel, NO_SUPPLIER, type HoursExtra, type Person, type Place, type Trip, type Car } from '../lib/supabase'
import { useApp } from '../lib/data'
import { exportXlsx, type Cell } from '../lib/export'
import { round2, type Seg } from '../lib/hours'
import { usePref } from './Plan'

// Podklad pro dodavatele: jen hodiny a cesty jeho lidí, žádné ceny, sazby ani úspory (podle vzoru Podklad_dodavatel_MM_26.xlsx).
// Listy: 1 Hodiny (jméno, příjmení, hodiny + poznámka), 2 Hodiny po cestách (do šířky), 3 Hodiny po jednotlivých cestách (dlouhý), 4 Přehled cest.
export type SupRow = { person: string; supplier: string; segs: Seg[]; extra: HoursExtra[]; real: number; mimo: number; pevne: number; total: number }

const dmyhm = (v: string | null | undefined) => { if (!v) return ''; const [d, t] = v.replace(' ', 'T').split('T'); const [y, m, da] = d.split('-'); return `${da}.${m}.${y} ${(t ?? '').slice(0, 5)}` }
const dmy = (v: string | null | undefined) => { if (!v) return ''; const [y, m, d] = v.slice(0, 10).split('-'); return `${d}.${m}.${y}` }
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function buildSupplierWorkbook(sup: string, month: string, rows: SupRow[], trips: Trip[], people: Map<string, Person>, places: Map<string, Place>, cars: Map<string, Car>, note: string) {
  const [y, mo] = month.split('-')
  const label = `${mo}-${y}`
  const mine = rows.filter(r => r.supplier === sup && r.total > 0).slice()
    .sort((a, b) => fold(people.get(a.person)?.last_name ?? '').localeCompare(fold(people.get(b.person)?.last_name ?? '')) || fold(people.get(a.person)?.first_name ?? '').localeCompare(fold(people.get(b.person)?.first_name ?? '')))
  const ref = (t: Trip) => t.ref_tcs ?? (t.report_no ? `#${t.report_no}` : '')
  const route = (t: Trip) => `${places.get(t.pup_id ?? '')?.name ?? '?'} → ${places.get(t.dop_id ?? '')?.name ?? '?'}`
  const car = (t: Trip) => cars.get(t.car_id ?? '')?.plate ?? cars.get(t.car_id ?? '')?.car_no ?? ''
  const blocks = (r: SupRow) => r.segs.slice().sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '')).map(s => ({ ref: ref(s.trip), od: s.start, do: s.endAdj ?? s.end, h: s.hours ?? 0, trip: s.trip }))
  const total = round2(mine.reduce((a, r) => a + r.total, 0))

  const s1: Cell[][] = [['Jméno', 'Příjmení', 'Hodiny']]
  for (const r of mine) { const p = people.get(r.person); s1.push([p?.first_name ?? '', p?.last_name ?? '', r.total]) }
  s1.push(['', 'CELKEM', total], [])
  for (const line of note.split('\n').map(x => x.trim()).filter(Boolean)) s1.push([line])

  const maxb = Math.max(0, ...mine.map(r => r.segs.length))
  const h2: Cell[] = ['Jméno', 'Příjmení', 'Hodiny celkem', 'HRS mimo report', 'Extra']
  for (let i = 1; i <= maxb; i++) h2.push(`Reference ${i}`, 'Od', 'Do', 'Hod')
  const s2: Cell[][] = [h2]
  for (const r of mine) {
    const p = people.get(r.person)
    const row: Cell[] = [p?.first_name ?? '', p?.last_name ?? '', r.total, r.mimo || null, r.pevne || null]
    for (const b of blocks(r)) row.push(b.ref, dmyhm(b.od), dmyhm(b.do), b.h)
    s2.push(row)
  }
  s2.push(['', 'CELKEM', total])

  const long: Cell[][] = []
  for (const r of mine) {
    const p = people.get(r.person)
    for (const b of blocks(r)) long.push([p?.last_name ?? '', p?.first_name ?? '', p?.short_name ?? '', dmy(b.trip.trip_date), b.ref, route(b.trip), car(b.trip), dmyhm(b.od), dmyhm(b.do), b.h])
    for (const e of r.extra) long.push([p?.last_name ?? '', p?.first_name ?? '', p?.short_name ?? '', dmy(e.work_date), e.kind === 'pevne' ? 'Extra' : 'Mimo report', e.note ?? '', '', '', '', Number(e.hours)])
  }
  long.sort((a, b) => fold(String(a[0])).localeCompare(fold(String(b[0]))) || fold(String(a[1])).localeCompare(fold(String(b[1]))) || String(a[7] || a[3]).localeCompare(String(b[7] || b[3])))
  const s3: Cell[][] = [[`Hodiny po jednotlivých cestách – ${label}`], [`${long.length} záznamů · seřazeno podle příjmení a data`], ['Příjmení', 'Jméno', 'Zkratka', 'Datum', 'Reference', 'Trasa', 'Auto', 'Od', 'Do', 'Hodiny'], ...long]

  // Přehled cest: cesty, kde jel někdo z tohoto dodavatele
  const ids = new Set(mine.flatMap(r => r.segs.map(s => s.trip.id)))
  const list = trips.filter(t => ids.has(t.id)).sort((a, b) => a.trip_date.localeCompare(b.trip_date) || (a.report_no ?? 0) - (b.report_no ?? 0))
  const hrs = (t: Trip) => t.dep_home && t.arr_home ? round2((Date.parse(t.arr_home.replace(' ', 'T')) - Date.parse(t.dep_home.replace(' ', 'T'))) / 36e5) : null
  const s4: Cell[][] = [[`Přehled cest – ${label}`], [`${list.length} cest · bez cen`], ['Oddíl', 'Datum', '#Report', 'Reference', 'Trasa', 'Auto', 'Guard I', 'Guard II', 'Guard III', 'Od', 'Do', 'Hodiny'],
    ...list.map(t => [t.customer ?? '', dmy(t.trip_date), t.report_no, t.ref_tcs ?? t.customer_ref ?? '', route(t), car(t), ...[t.guard1_id, t.guard2_id, t.guard3_id].map(g => (g ? people.get(g)?.short_name ?? '' : '')), dmyhm(t.dep_home), dmyhm(t.arr_home), hrs(t)] as Cell[])]

  const w2 = [14, 18, 12, 14, 8]; for (let i = 0; i < maxb; i++) w2.push(11, 16, 16, 7)
  return {
    name: `Podklad_${supplierLabel(sup).replace(/[^\w-]+/g, '_')}_${mo}_${y.slice(2)}.xlsx`,
    sheets: [
      { name: `Hodiny ${label}`, rows: s1, widths: [16, 20, 10] },
      { name: 'Hodiny po cestách', rows: s2, widths: w2 },
      { name: 'Hodiny po jednotlivých cestách', rows: s3, widths: [14, 12, 14, 12, 11, 42, 10, 16, 16, 8] },
      { name: 'Přehled cest', rows: s4, widths: [14, 12, 9, 11, 44, 10, 18, 18, 18, 16, 16, 8] },
    ],
    people: mine.length, total,
  }
}

export function SupplierExportDialog({ month, rows, trips, onClose }: { month: string; rows: SupRow[]; trips: Trip[]; onClose: () => void }) {
  const { people, places, cars, suppliers, toast } = useApp()
  const sups = [...new Set(rows.filter(r => r.total > 0).map(r => r.supplier))].sort((a, b) => (a === NO_SUPPLIER ? 1 : 0) - (b === NO_SUPPLIER ? 1 : 0) || (suppliers.find(s => s.name === a)?.sort ?? 50) - (suppliers.find(s => s.name === b)?.sort ?? 50))
  const [sup, setSup] = useState(sups[0] ?? '')
  const [note, setNote] = usePref<string>(`podklad.note.${sup || 'x'}`, '')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const personBy = new Map(people.map(p => [p.id, p])), placeBy = new Map(places.map(p => [p.id, p])), carBy = new Map(cars.map(c => [c.id, c]))
  const preview = sup ? buildSupplierWorkbook(sup, month, rows, trips, personBy, placeBy, carBy, note) : null
  async function go() {
    if (!preview) return
    await exportXlsx(preview.name, preview.sheets)
    toast(`Podklad pro ${supplierLabel(sup)} stažen.`)
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Podklad pro dodavatele">
        <div className="dialoghead"><h2>Podklad pro dodavatele · {month.split('-').reverse().join('/')}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <p className="quiet small">Jen hodiny a cesty lidí dodavatele – žádné ceny, sazby, úspory ani překryvy. Listy: Hodiny (jméno, příjmení, hodiny + poznámka), Hodiny po cestách (do šířky), Hodiny po jednotlivých cestách, Přehled cest.</p>
        <div className="formgrid">
          <label>Dodavatel<select value={sup} onChange={e => setSup(e.target.value)}>{sups.map(s => <option key={s} value={s}>{supplierLabel(s)}</option>)}</select></label>
          <label className="span3">Poznámka pod tabulku (každý řádek zvlášť)<textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Dezort: 555 hod / Balada: 25.000 …" /></label>
          {preview && <p className="span4 quiet small">{preview.people} lidí · {preview.total.toLocaleString('cs-CZ')} h · {preview.sheets[3].rows.length - 3} cest</p>}
          {sups.length === 0 && <p className="span4 missingtxt">V tomhle měsíci zatím nejsou hotové hodiny.</p>}
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít</button>
          <button className="primary" disabled={!preview || !preview.people} onClick={go}>Stáhnout Excel</button>
        </div>
      </div>
    </div>, document.body)
}
