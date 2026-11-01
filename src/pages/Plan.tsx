import { useEffect, useMemo, useState } from 'react'
import { supabase, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { computeStart, dateLabel, docState, hm, inkOn, todayIso } from '../lib/format'

type GuardKey = 'guard1_id' | 'guard2_id' | 'guard3_id'
const GUARDS: GuardKey[] = ['guard1_id', 'guard2_id', 'guard3_id']
const GROUP = 'Skupina ✅'
const EARLY = ['HEADS-UP', 'Confirmed', 'Send']

export default function Plan() {
  const { level, people, cars, places, statuses, docs, toast, reloadLists } = useApp()
  const canNotes = level('planning') === 'write'
  const canCreate = level('planning_create') === 'write'
  const canStatus = level('planning_status') === 'write'
  const canCrew = level('planning_crew') === 'write'
  const canRoute = level('planning_route') === 'write'
  const canAddPlace = level('places') === 'write'
  const [trips, setTrips] = useState<Trip[]>([])
  const [from, setFrom] = useState(todayIso(-1))
  const [to, setTo] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [carFilter, setCarFilter] = useState<string | null>(null)
  const [fleetOpen, setFleetOpen] = useState(true)
  const [view, setView] = usePref<'days' | 'list'>('plan.view', 'days')
  const [size, setSize] = usePref<'m' | 's' | 'xs'>('plan.size', 'm')

  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const personByName = useMemo(() => new Map(people.map(p => [p.short_name.toLowerCase(), p])), [people])
  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const placeByName = useMemo(() => new Map(places.map(p => [p.name.toLowerCase(), p])), [places])
  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const carByLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of cars) { m.set(c.label.toLowerCase(), c.id); m.set(c.plate.toLowerCase(), c.id) }
    return m
  }, [cars])
  const statusBy = useMemo(() => new Map(statuses.map(s => [s.name, s])), [statuses])

  useEffect(() => {
    // Načte vybrané období a navíc všechny rozjeté cesty (jako řádky, které v Excelu ještě nejsou smazané)
    supabase.from('trips').select('*')
      .or(`trip_date.gte.${from},status.is.null,status.not.in.(Finished,Canceled)`)
      .order('trip_date').order('trip_time', { nullsFirst: true })
      .then(({ data, error }) => {
      if (error) toast(explain(error), 'err')
      setTrips((data as Trip[]) ?? [])
      setLoaded(true)
    })
  }, [from, toast])

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
      .filter(t => t.trip_date >= from && (!to || t.trip_date <= to))
      .filter(t => !hidden.has(t.status ?? ''))
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
  }, [trips, hidden, q, placeBy, personBy, carBy, from, to, carFilter])

  const days = useMemo(() => {
    if (view === 'list') return [['all', visible] as [string, Trip[]]]
    const m = new Map<string, Trip[]>()
    for (const t of visible) { if (!m.has(t.trip_date)) m.set(t.trip_date, []); m.get(t.trip_date)!.push(t) }
    return [...m.entries()]
  }, [visible, view])

  // Jako v Excelu: kolikrát je auto v celém plánu (bez Finished a Canceled)
  const carUse = useMemo(() => {
    const m = new Map<string, Trip[]>()
    for (const t of trips) {
      if (!t.car_id || t.status === 'Finished' || t.status === 'Canceled') continue
      if (!m.has(t.car_id)) m.set(t.car_id, [])
      m.get(t.car_id)!.push(t)
    }
    return m
  }, [trips])
  const useTitle = (id: string) => (carUse.get(id) ?? [])
    .map(t => `${dateLabel(t.trip_date)} ${hm(t.trip_time)} ${placeBy.get(t.pup_id ?? '')?.name ?? ''} → ${placeBy.get(t.dop_id ?? '')?.name ?? ''}`).join('\n')
  const fleet = cars.filter(c => c.state === 'Aktivní' || c.state === 'V opravě')

  function toggleStatus(name: string) {
    setHidden(cur => { const n = new Set(cur); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  return (
    <section className={'plan size-' + size + ' view-' + view}>
      <div className="toolbar">
        <label className="field">Od<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="field">Do<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <input className="search" placeholder="Hledat místo, jméno, SPZ, Ref…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="statusfilter">
          {statuses.map(s => (
            <button key={s.name} className={'chip' + (hidden.has(s.name) ? ' off' : '')}
              style={{ ['--c' as string]: s.color }} onClick={() => toggleStatus(s.name)} title={hidden.has(s.name) ? 'Zobrazit' : 'Skrýt'}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Zobrazení">
          <button className={view === 'days' ? 'on' : ''} aria-pressed={view === 'days'} onClick={() => setView('days')}>Po dnech</button>
          <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>Seznam</button>
        </div>
        <div className="seg" role="group" aria-label="Velikost písma">
          <button className={'fs-m' + (size === 'm' ? ' on' : '')} aria-pressed={size === 'm'} onClick={() => setSize('m')} title="Normální písmo">A</button>
          <button className={'fs-s' + (size === 's' ? ' on' : '')} aria-pressed={size === 's'} onClick={() => setSize('s')} title="Menší písmo">A</button>
          <button className={'fs-xs' + (size === 'xs' ? ' on' : '')} aria-pressed={size === 'xs'} onClick={() => setSize('xs')} title="Nejmenší písmo">A</button>
        </div>
        {canCreate && <button className="primary" onClick={addTrip}>Nová cesta</button>}
      </div>

      <datalist id="dl-status">{statuses.map(x => <option key={x.name} value={x.name} />)}</datalist>
      <datalist id="dl-people">{people.filter(p => p.active).map(p => <option key={p.id} value={p.short_name} />)}</datalist>
      <datalist id="dl-places">{places.map(p => <option key={p.id} value={p.name} />)}</datalist>
      <datalist id="dl-cars">{cars.filter(c => c.state === 'Aktivní' || c.state === 'V opravě').map(c => <option key={c.id} value={c.label} />)}</datalist>

      {fleet.length > 0 && (
        <div className="fleet" aria-label="Auta v plánu">
          <button className="fleetlabel link" onClick={() => setFleetOpen(o => !o)}>
            Auta v plánu: {fleet.filter(c => carUse.has(c.id)).length} jede, {fleet.filter(c => !carUse.has(c.id)).length} volných
          </button>
          {fleetOpen && fleet.map(c => {
            const n = carUse.get(c.id)?.length ?? 0
            return (
              <button key={c.id} className={'car' + (n ? ' used' : '') + (carFilter === c.id ? ' on' : '') + (c.state === 'V opravě' ? ' repair' : '')}
                title={`${c.label}${c.state === 'V opravě' ? ' · v opravě' : ''}${n ? '\n' + useTitle(c.id) : '\nvolné'}`}
                onClick={() => setCarFilter(f => (f === c.id ? null : c.id))}>
                {c.car_no ?? c.plate}{n > 1 && <span className="times">{n}×</span>}
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
              <th className="w-status">Status</th><th className="w-date">Datum</th><th className="w-time">Čas</th><th>Pup</th><th>Dop</th>
              <th>Guard 1</th><th>Guard 2</th><th>Guard 3</th><th>Auto</th><th>Odkud</th>
              <th className="w-ref">Ref. TCS</th><th className="w-time">Start</th><th>Poznámka</th><th>Změna</th>
              {canCreate && <th className="w-x" aria-label="Akce" />}
            </tr>
          </thead>
          {days.map(([date, rows]) => (
            <tbody key={date}>
              {view === 'days' && <tr className="dayrow">
                <td colSpan={canCreate ? 15 : 14}>
                  <span className="daylabel">{dateLabel(date)}</span>
                  <span className="daycount">{rows.length} {rows.length === 1 ? 'cesta' : rows.length < 5 ? 'cesty' : 'cest'}</span>
                </td>
              </tr>}
              {rows.map((t, i) => {
                const st = statusBy.get(t.status ?? '')
                const pup = placeBy.get(t.pup_id ?? '')
                const car = carBy.get(t.car_id ?? '')
                const start = computeStart(t.trip_date, t.trip_time, pup?.travel_time ?? null, pup?.ferry ?? false)
                return (
                  <tr key={t.id} className={'trip' + (view === 'list' && i > 0 && rows[i - 1].trip_date !== t.trip_date ? ' newday' : '')}
                    style={{ ['--c' as string]: st?.color ?? '#c9d1d6' }}>
                    <td className="statuscell">
                      <StatusInput disabled={!canStatus} color={st?.color}
                        value={t.ref_tcs ?? t.status ?? ''} title={t.ref_tcs ? `${t.ref_tcs} · ${t.status ?? 'bez statusu'}` : undefined}
                        onSave={v => {
                          const n = v.trim()
                          if (!n) return
                          // Nové referenční číslo posune cestu na Skupinu jen z ranějších stavů; jinak status drží
                          if (/^a\d{5}$/i.test(n)) return save(t, {
                            ref_tcs: n.toUpperCase(),
                            status: !t.status || EARLY.includes(t.status) ? GROUP : t.status,
                          })
                          const hit = statuses.find(x => x.name.toLowerCase() === n.toLowerCase())
                          if (!hit) return toast(`Napište status ze seznamu nebo referenční číslo ve tvaru A12345.`, 'err')
                          save(t, { status: hit.name })
                        }} />
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
                      + (t.car_id && carUse.get(t.car_id)?.length === 1 ? 'once' : '')}
                      title={clash(t, t.car_id) ? 'Auto má ten den ještě jinou cestu'
                        : t.car_id ? `V plánu ${carUse.get(t.car_id)?.length ?? 0}×:\n${useTitle(t.car_id)}` : undefined}>
                      <Text disabled={!canCrew} list="dl-cars" value={car?.label ?? ''} carcell
                        onSave={v => {
                          const n = v.trim()
                          if (!n) return save(t, { car_id: null })
                          const id = carByLabel.get(n.toLowerCase()) ?? carByLabel.get(n.split(',')[0].trim().toLowerCase())
                          if (!id) return toast(`Auto „${n}“ není v seznamu aut.`, 'err')
                          save(t, { car_id: id })
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
                    <td className={'start' + (start === 'ferry' ? ' ferry' : '')}>{start}</td>
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
          <p className="empty">V tomhle období nejsou žádné cesty{hidden.size ? ' s vybranými statusy' : ''}.{canCreate && ' Přidejte první tlačítkem Nová cesta.'}</p>
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
