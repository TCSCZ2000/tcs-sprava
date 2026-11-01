import { useEffect, useMemo, useState } from 'react'
import { supabase, type Trip } from '../lib/supabase'
import { useApp } from '../lib/data'
import { docState, todayIso } from '../lib/format'

const FIELDS = [
  { key: 'full', label: 'Celé jméno', on: true },
  { key: 'short', label: 'Zkratka (A. Novak)', on: false },
  { key: 'birth', label: 'Datum narození', on: true },
  { key: 'nat', label: 'Národnost', on: true },
  { key: 'op', label: 'Číslo OP', on: true },
  { key: 'pas', label: 'Číslo pasu', on: true },
  { key: 'phone', label: 'Telefon', on: true },
  { key: 'pasd', label: 'Pas platný do', on: false },
] as const
type FieldKey = (typeof FIELDS)[number]['key']

const dmy = (iso: string | null | undefined) => {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return `${d}.${m}.${y}`
}

export default function Podklad() {
  const { people, docs, cars, places, level, toast } = useApp()
  const seeDocs = level('people_docs') !== 'none'
  const [trips, setTrips] = useState<Trip[]>([])
  const [sel, setSel] = useState('')
  const [on, setOn] = useState<Set<FieldKey>>(new Set(FIELDS.filter(f => f.on).map(f => f.key)))
  const [convoy, setConvoy] = useState(false)
  const [sep, setSep] = useState(' ')

  useEffect(() => {
    supabase.from('trips').select('*').gte('trip_date', todayIso(-3)).neq('status', 'Canceled')
      .order('trip_date').order('trip_time').then(({ data }) => setTrips((data as Trip[]) ?? []))
  }, [])

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const trip = trips.find(t => t.id === sel)

  const title = (t: Trip) =>
    `${dmy(t.trip_date)} ${t.trip_time?.slice(0, 5) ?? ''}  ${placeBy.get(t.pup_id ?? '')?.name ?? '?'} → ${placeBy.get(t.dop_id ?? '')?.name ?? '?'}`

  // Celý konvoj = ostatní cesty téhož dne se stejným Pup a Dop
  const group = useMemo(() => {
    if (!trip) return []
    if (!convoy) return [trip]
    return trips.filter(t => t.trip_date === trip.trip_date && t.pup_id === trip.pup_id && t.dop_id === trip.dop_id)
  }, [trip, trips, convoy])

  const guardIds = (t: Trip) => [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean) as string[]

  const shortText = useMemo(() => group.map(t => [
    `${dmy(t.trip_date)} ${t.trip_time ? Number(t.trip_time.slice(0, 2)) + ':' + t.trip_time.slice(3, 5) : ''}`.trim(),
    `${placeBy.get(t.pup_id ?? '')?.name ?? ''}-${placeBy.get(t.dop_id ?? '')?.name ?? ''}`,
    guardIds(t).map(id => personBy.get(id)?.short_name).join('/'),
    carBy.get(t.car_id ?? '')?.label ?? '',
  ].join('\n')).join('\n\n'), [group, placeBy, personBy, carBy])

  const fullText = useMemo(() => group.map(t => {
    const lines = guardIds(t).map(id => {
      const p = personBy.get(id)!
      const d = docs.get(id)
      const parts: Record<FieldKey, string> = {
        full: p ? `${p.first_name} ${p.last_name}` : '', short: p?.short_name ?? '', birth: dmy(p?.birth_date),
        nat: p?.nationality ?? '', op: d?.id_number ?? '', pas: d?.passport_number ?? '', phone: p?.phone ?? '',
        pasd: dmy(d?.passport_valid_to),
      }
      return FIELDS.filter(f => on.has(f.key) && parts[f.key]).map(f => parts[f.key]).join(sep)
    })
    return [...lines, carBy.get(t.car_id ?? '')?.label ?? ''].filter(Boolean).join('\n')
  }).join('\n\n'), [group, on, sep, personBy, docs, carBy])

  const expired = useMemo(() => group.flatMap(guardIds).filter(id => {
    const d = docs.get(id)
    return docState(d?.passport_valid_to ?? null) === 'expired' || docState(d?.id_valid_to ?? null) === 'expired'
  }).map(id => personBy.get(id)?.short_name), [group, docs, personBy])

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast('Zkopírováno, vložte do mailu') }
    catch { toast('Kopírování se nepovedlo. Označte text ručně.', 'err') }
  }

  return (
    <section className="podklad">
      <div className="toolbar">
        <h1>Podklad pro zákazníka</h1>
        <select className="tripselect" value={sel} onChange={e => setSel(e.target.value)}>
          <option value="">Vyberte výjezd…</option>
          {trips.map(t => <option key={t.id} value={t.id}>{title(t)}</option>)}
        </select>
      </div>
      {!trip && <p className="empty">Vyberte výjezd nahoře. Nabízejí se cesty od předevčírka, bez zrušených.</p>}
      {trip && (
        <div className="podgrid">
          <aside className="opts">
            <h2>Co vypsat</h2>
            {FIELDS.filter(f => seeDocs || !['op', 'pas', 'pasd'].includes(f.key)).map(f => (
              <label key={f.key} className="check">
                <input type="checkbox" checked={on.has(f.key)}
                  onChange={e => setOn(cur => { const n = new Set(cur); e.target.checked ? n.add(f.key) : n.delete(f.key); return n })} />
                {f.label}
              </label>
            ))}
            <label className="check"><input type="checkbox" checked={convoy} onChange={e => setConvoy(e.target.checked)} />Celý konvoj</label>
            <label className="field">Oddělovač
              <select value={sep} onChange={e => setSep(e.target.value)}>
                <option value=" ">mezera</option><option value=", ">čárka</option><option value={'\t'}>tabulátor</option><option value=" / ">lomítko</option>
              </select>
            </label>
          </aside>
          <div className="outputs">
            {expired.length > 0 && <p className="warnbox">Pozor: propadlý doklad má {expired.join(', ')}.</p>}
            <div className="out">
              <div className="outhead"><h2>Krátký zápis</h2><button onClick={() => copy(shortText)}>Kopírovat</button></div>
              <pre>{shortText}</pre>
            </div>
            <div className="out">
              <div className="outhead"><h2>Sestava podle výběru</h2><button onClick={() => copy(fullText)}>Kopírovat</button></div>
              <pre>{fullText}</pre>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
