import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, type Route, type RoutePrice, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { LEGS, totalH, totalKm, totalToll } from '../lib/routes'
import { todayIso } from '../lib/format'
import { Text } from './Plan'

type Num = number | null
const num = (v: string): Num | undefined => {
  const s = v.trim().replace(/\s/g, '').replace(',', '.')
  if (!s) return null
  const x = Number(s)
  return Number.isFinite(x) ? x : undefined
}
const fmt = (v: Num) => (v == null ? '' : String(v).replace('.', ','))

export default function Routes() {
  const { level, places, toast, reloadLists } = useApp()
  const canEdit = level('routes') === 'write'
  const [routes, setRoutes] = useState<Route[]>([])
  const [prices, setPrices] = useState<RoutePrice[]>([])
  const [trips, setTrips] = useState<Pick<Trip, 'id' | 'pup_id' | 'dop_id' | 'trip_date' | 'status'>[]>([])
  const [q, setQ] = useState('')
  const [copyFrom, setCopyFrom] = useState<Route | null>(null)
  const [newPup, setNewPup] = useState('')
  const [newDop, setNewDop] = useState('')
  const [showMissing, setShowMissing] = useState(true)

  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const placeByName = useMemo(() => new Map(places.map(p => [p.name.toLowerCase(), p])), [places])

  const load = useCallback(async () => {
    const [r, p, t] = await Promise.all([
      supabase.from('routes').select('*'),
      supabase.from('route_prices').select('*').order('sort'),
      supabase.from('trips').select('id,pup_id,dop_id,trip_date,status').gte('trip_date', todayIso(-60)).neq('status', 'Canceled'),
    ])
    if (r.error) toast(explain(r.error), 'err')
    setRoutes((r.data as Route[]) ?? []); setPrices((p.data as RoutePrice[]) ?? []); setTrips((t.data as Trip[]) ?? [])
  }, [toast])
  useEffect(() => { load() }, [load])

  const name = (id: string) => placeBy.get(id)?.name ?? '?'
  const city = (id: string) => (placeBy.get(id)?.city ?? '').trim().toLowerCase()
  const routeKey = (pup: string, dop: string) => `${pup}|${dop}`
  const routeBy = useMemo(() => new Map(routes.map(r => [routeKey(r.pup_id, r.dop_id), r])), [routes])

  // Cesty, ke kterým chybí trasa → návrh kopie ze stejných měst
  const missing = useMemo(() => {
    const seen = new Map<string, { pup: string; dop: string; count: number }>()
    for (const t of trips) {
      if (!t.pup_id || !t.dop_id || routeBy.has(routeKey(t.pup_id, t.dop_id))) continue
      const k = routeKey(t.pup_id, t.dop_id)
      const cur = seen.get(k) ?? { pup: t.pup_id, dop: t.dop_id, count: 0 }
      cur.count++; seen.set(k, cur)
    }
    return [...seen.values()].map(m => ({ ...m, suggestions: suggest(m.pup, m.dop) })).sort((a, b) => b.count - a.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips, routeBy, places])

  function suggest(pup: string, dop: string): { route: Route; why: string }[] {
    const pc = city(pup), dc = city(dop)
    const out: { route: Route; why: string; score: number }[] = []
    for (const r of routes) {
      const samePup = r.pup_id === pup, sameDop = r.dop_id === dop
      const pupCity = !!pc && city(r.pup_id) === pc, dopCity = !!dc && city(r.dop_id) === dc
      if ((samePup || pupCity) && (sameDop || dopCity)) {
        out.push({ route: r, score: (samePup ? 2 : 1) + (sameDop ? 2 : 1), why: [samePup ? 'stejné Pup' : `Pup v ${placeBy.get(pup)?.city}`, sameDop ? 'stejné Dop' : `Dop v ${placeBy.get(dop)?.city}`].join(', ') })
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3)
  }

  async function createRoute(pup: string, dop: string, src?: Route) {
    const base = src ? Object.fromEntries(Object.entries(src).filter(([k]) => !['id', 'pup_id', 'dop_id', 'copied_from', 'updated_at', 'updated_by', 'note'].includes(k))) : {}
    const { data, error } = await supabase.from('routes').insert({ ...base, pup_id: pup, dop_id: dop, copied_from: src?.id ?? null }).select().single()
    if (error) return toast(error.code === '23505' ? 'Tahle trasa už existuje.' : explain(error), 'err')
    if (src) {
      const ps = prices.filter(p => p.route_id === src.id).map(p => ({ route_id: (data as Route).id, label: p.label, pup_dop_h: p.pup_dop_h, price: p.price, sort: p.sort }))
      if (ps.length) await supabase.from('route_prices').insert(ps)
    }
    toast(src ? `Trasa zkopírována z ${name(src.pup_id)} → ${name(src.dop_id)}. Zkontrolujte km a ceny.` : 'Trasa založena, doplňte úseky a ceny.')
    setCopyFrom(null); setNewPup(''); setNewDop(''); load()
  }

  async function resolvePlace(v: string): Promise<string | null> {
    const p = placeByName.get(v.trim().toLowerCase())
    if (p) return p.id
    if (!v.trim()) return null
    if (!window.confirm(`Místo „${v.trim()}“ v seznamu není. Založit ho?`)) return null
    const { data, error } = await supabase.from('places').insert({ name: v.trim(), city: v.trim().split(/\s+/).pop() }).select().single()
    if (error) { toast(explain(error), 'err'); return null }
    await reloadLists()
    return (data as { id: string }).id
  }

  async function submitNew() {
    const pup = await resolvePlace(newPup), dop = await resolvePlace(newDop)
    if (!pup || !dop) return toast('Vyplňte Pup i Dop.', 'err')
    createRoute(pup, dop, copyFrom ?? undefined)
  }

  async function saveRoute(r: Route, patch: Partial<Route>) {
    setRoutes(cur => cur.map(x => (x.id === r.id ? { ...x, ...patch } : x)))
    const { error } = await supabase.from('routes').update(patch).eq('id', r.id)
    if (error) { toast(explain(error), 'err'); load() }
  }
  async function removeRoute(r: Route) {
    if (!window.confirm(`Smazat trasu ${name(r.pup_id)} → ${name(r.dop_id)} i s jejími cenami?`)) return
    const { error } = await supabase.from('routes').delete().eq('id', r.id)
    if (error) return toast(explain(error), 'err')
    load()
  }
  async function addPrice(r: Route) {
    const label = window.prompt('Název pevné ceny, např. 10 h nebo 20 h')?.trim()
    if (!label) return
    const pv = num(window.prompt(`Cena „${label}“ v € bez DPH`) ?? '')
    if (pv == null) return toast('Cena musí být číslo.', 'err')
    const h = num(label.replace(/h/i, ''))
    const { error } = await supabase.from('route_prices').insert({ route_id: r.id, label, price: pv, pup_dop_h: h ?? null, sort: prices.filter(p => p.route_id === r.id).length + 1 })
    if (error) return toast(explain(error), 'err')
    load()
  }
  async function savePrice(p: RoutePrice, patch: Partial<RoutePrice>) {
    const { error } = await supabase.from('route_prices').update(patch).eq('id', p.id)
    if (error) toast(explain(error), 'err'); load()
  }
  async function removePrice(p: RoutePrice) {
    if (!window.confirm(`Smazat pevnou cenu ${p.label}?`)) return
    await supabase.from('route_prices').delete().eq('id', p.id); load()
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return routes
      .filter(r => !s || `${name(r.pup_id)} ${name(r.dop_id)}`.toLowerCase().includes(s))
      .sort((a, b) => (name(a.pup_id) + name(a.dop_id)).localeCompare(name(b.pup_id) + name(b.dop_id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, q, places])

  const numCell = (r: Route, k: keyof Route) => (
    <Text disabled={!canEdit} value={fmt(r[k] as Num)} time mono
      onSave={v => { const x = num(v); if (x === undefined) return toast('Pište číslo, třeba 10,5.', 'err'); saveRoute(r, { [k]: x } as Partial<Route>) }} />
  )

  return (
    <section className="list routes size-s">
      <datalist id="dl-places">{places.map(p => <option key={p.id} value={p.name} />)}</datalist>
      <div className="toolbar">
        <h1>Trasy a ceny</h1>
        <span className="count">{routes.length} tras</span>
        <input className="search" placeholder="Hledat místo…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <p className="intro">Cena cesty se počítá jako v 10_26: hodiny každého z posádky × sazba/h + km × sazba/km + mýto. Pevných cen může mít trasa víc (třeba 10 h a 20 h), u cesty si v Reportech jednu vyberete.</p>

      {canEdit && (
        <div className="newroute">
          <strong>{copyFrom ? `Kopie trasy ${name(copyFrom.pup_id)} → ${name(copyFrom.dop_id)} pro:` : 'Nová trasa:'}</strong>
          <input className="search" list="dl-places" placeholder="Pup" value={newPup} onChange={e => setNewPup(e.target.value)} />
          <span>→</span>
          <input className="search" list="dl-places" placeholder="Dop" value={newDop} onChange={e => setNewDop(e.target.value)} />
          <button className="primary" onClick={submitNew}>{copyFrom ? 'Zkopírovat' : 'Založit'}</button>
          {copyFrom && <button className="link" onClick={() => setCopyFrom(null)}>Zrušit kopírování</button>}
        </div>
      )}

      {missing.length > 0 && (
        <div className="missing">
          <button className="link fleetlabel" onClick={() => setShowMissing(s => !s)}>
            Chybí {missing.length} {missing.length === 1 ? 'trasa' : missing.length < 5 ? 'trasy' : 'tras'} pro cesty v plánu a v reportech {showMissing ? '▾' : '▸'}
          </button>
          {showMissing && (
            <ul>
              {missing.slice(0, 30).map(m => (
                <li key={m.pup + m.dop}>
                  <span className="mroute">{name(m.pup)} → {name(m.dop)}</span> <span className="quiet">({m.count}×)</span>
                  {canEdit && m.suggestions.map(s => (
                    <button key={s.route.id} className="chip cust" title={s.why} onClick={() => createRoute(m.pup, m.dop, s.route)}>
                      Zkopírovat z {name(s.route.pup_id)} → {name(s.route.dop_id)}
                    </button>
                  ))}
                  {canEdit && <button className="link" onClick={() => createRoute(m.pup, m.dop)}>Založit prázdnou</button>}
                  {m.suggestions.length === 0 && <span className="quiet"> Žádná podobná trasa. Zkontrolujte města v Místech.</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="tablewrap">
        <table className="grid plain routegrid">
          <thead>
            <tr>
              <th rowSpan={2}>Pup</th><th rowSpan={2}>Dop</th>
              {LEGS.map(l => <th key={l.key} colSpan={3} className="legh">{l.label}</th>)}
              <th colSpan={3} className="legh">Celkem</th>
              <th rowSpan={2}>€/h</th><th rowSpan={2}>€/km</th><th rowSpan={2}>Pevné ceny</th>{canEdit && <th rowSpan={2} />}
            </tr>
            <tr>
              {[...LEGS, { key: 'sum' }].map(l => [<th key={l.key + 'k'}>km</th>, <th key={l.key + 'h'}>h</th>, <th key={l.key + 't'}>mýto</th>])}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className="ro">{name(r.pup_id)}</td>
                <td className="ro">{name(r.dop_id)}{r.copied_from && <span className="quiet small" title="Zkopírováno z jiné trasy"> ⧉</span>}</td>
                {LEGS.map(l => [
                  <td key={l.key + 'k'}>{numCell(r, `${l.key}_km` as keyof Route)}</td>,
                  <td key={l.key + 'h'}>{numCell(r, `${l.key}_h` as keyof Route)}</td>,
                  <td key={l.key + 't'}>{numCell(r, `${l.key}_toll` as keyof Route)}</td>,
                ])}
                <td className="ro num sum">{totalKm(r)}</td><td className="ro num sum">{fmt(totalH(r))}</td><td className="ro num sum">{totalToll(r)}</td>
                <td>{numCell(r, 'rate_h')}</td><td>{numCell(r, 'rate_km')}</td>
                <td className="prices">
                  {prices.filter(p => p.route_id === r.id).map(p => (
                    <span key={p.id} className="pricechip">
                      <Text disabled={!canEdit} value={p.label} time onSave={v => v.trim() && savePrice(p, { label: v.trim() })} />
                      <Text disabled={!canEdit} value={fmt(p.price)} time mono
                        onSave={v => { const x = num(v); if (x == null) return toast('Cena musí být číslo.', 'err'); savePrice(p, { price: x }) }} />
                      {canEdit && <button className="ghost" aria-label={`Smazat cenu ${p.label}`} onClick={() => removePrice(p)}>×</button>}
                    </span>
                  ))}
                  {canEdit && <button className="link small" onClick={() => addPrice(r)}>+ cena</button>}
                </td>
                {canEdit && (
                  <td className="actions nowrap">
                    <button className="link small" onClick={() => { setCopyFrom(r); setNewPup(name(r.pup_id)); setNewDop(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Kopírovat</button>
                    <button className="ghost" aria-label="Smazat trasu" onClick={() => removeRoute(r)}>×</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? 'Žádná trasa neodpovídá hledání.' : 'Zatím žádné trasy.'}</p>}
      </div>
    </section>
  )
}
