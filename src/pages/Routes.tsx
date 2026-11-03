import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, type Route, type RoutePrice, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { BaseSelect } from '../lib/BaseSelect'
import { baseLabel, loadStops, routeKeyOf, type StopsMap } from '../lib/supabase'
import { LEGS, composeRoute, copyRoute, createComposedRoute, routeIncomplete, suggestRoutes, totalH, totalKm, totalToll, type LegPick, type MidPick } from '../lib/routes'
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
  const [trips, setTrips] = useState<Pick<Trip, 'id' | 'pup_id' | 'dop_id' | 'trip_date' | 'status' | 'base_from' | 'base_to'>[]>([])
  const [q, setQ] = useState('')
  const [copyFrom, setCopyFrom] = useState<Route | null>(null)
  const [newPup, setNewPup] = useState('')
  const [newDop, setNewDop] = useState('')
  const [newFrom, setNewFrom] = useState('CZ')
  const [newTo, setNewTo] = useState('CZ')
  const [newVariant, setNewVariant] = useState('')
  const [stops, setStops] = useState<StopsMap>(new Map())
  const [showMissing, setShowMissing] = useState(true)

  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])
  const placeByName = useMemo(() => new Map(places.map(p => [p.name.toLowerCase(), p])), [places])

  const load = useCallback(async () => {
    const [r, p, t] = await Promise.all([
      supabase.from('routes').select('*'),
      supabase.from('route_prices').select('*').order('sort'),
      supabase.from('trips').select('id,pup_id,dop_id,trip_date,status,base_from,base_to').gte('trip_date', todayIso(-60)).neq('status', 'Canceled'),
    ])
    if (r.error) toast(explain(r.error), 'err')
    setRoutes((r.data as Route[]) ?? []); setPrices((p.data as RoutePrice[]) ?? []); setTrips((t.data as Trip[]) ?? [])
    setStops(await loadStops(((t.data as Trip[]) ?? []).map(x => x.id)))
  }, [toast])
  useEffect(() => { load() }, [load])

  const name = (id: string) => placeBy.get(id)?.name ?? '?'
  const city = (id: string) => (placeBy.get(id)?.city ?? '').trim().toLowerCase()
  const routeKey = (pup: string, dop: string, from: string, to: string, st: string[] = []) => routeKeyOf(pup, dop, from, to, st)
  const routeBy = useMemo(() => new Map(routes.map(r => [routeKey(r.pup_id, r.dop_id, r.base_from, r.base_to, r.stops), r])), [routes]) // libovolná varianta

  // Cesty, ke kterým chybí trasa → návrh kopie ze stejných měst
  const missing = useMemo(() => {
    const seen = new Map<string, { pup: string; dop: string; from: string; to: string; st: string[]; count: number }>()
    for (const t of trips) {
      const st = (stops.get(t.id) ?? []).map(s => s.place_id)
      if (!t.pup_id || !t.dop_id || routeBy.has(routeKey(t.pup_id, t.dop_id, t.base_from, t.base_to, st))) continue
      const k = routeKey(t.pup_id, t.dop_id, t.base_from, t.base_to, st)
      const cur = seen.get(k) ?? { pup: t.pup_id, dop: t.dop_id, from: t.base_from, to: t.base_to, st, count: 0 }
      cur.count++; seen.set(k, cur)
    }
    return [...seen.values()].map(m => ({ ...m, suggestions: suggestRoutes(m.pup, m.dop, m.from, m.to, routes, placeBy, m.st), comp: composeRoute(m.pup, m.dop, m.from, m.to, routes, placeBy, m.st) })).sort((a, b) => b.count - a.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trips, routeBy, places, stops])

  async function composeFor(pup: string, dop: string, from: string, to: string, ho: LegPick | null, dh: LegPick | null, st: string[] = [], mid: MidPick | null = null) {
    const { error } = await createComposedRoute(pup, dop, from, to, ho, dh, st, mid)
    if (error) return toast(error, 'err')
    toast(mid ? 'Trasa založena z úseků včetně PUP→DOP. Zkontrolujte ji.' : 'Trasa založena z úseků, doplňte PUP→DOP (km, hodiny, mýto).'); load()
  }

  async function createRoute(pup: string, dop: string, from: string, to: string, src?: Route, variant = '', st: string[] = []) {
    const { error } = await copyRoute(src, pup, dop, from, to, prices, variant, st)
    if (error) return toast(error, 'err')
    toast(src ? `Trasa zkopírována z ${name(src.pup_id)} → ${name(src.dop_id)}. Zkontrolujte km a ceny.` : 'Trasa založena, doplňte úseky a ceny.')
    setCopyFrom(null); setNewPup(''); setNewDop(''); setNewFrom('CZ'); setNewTo('CZ'); setNewVariant(''); load()
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
    createRoute(pup, dop, newFrom, newTo, copyFrom ?? undefined, newVariant.trim())
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
    // každé slovo zvlášť („frankfurt rudna“ najde KN Frankfurt → Schenker Rudná), bez diakritiky, i v městech
    const words = fold(q).split(/\s+/).filter(Boolean)
    return routes
      .filter(r => {
        if (!words.length) return true
        const hay = fold(`${name(r.pup_id)} ${city(r.pup_id)} ${name(r.dop_id)} ${city(r.dop_id)}`)
        return words.every(w => hay.includes(w))
      })
      .sort((a, b) => (name(a.pup_id) + name(a.dop_id) + a.base_from + a.base_to + a.variant).localeCompare(name(b.pup_id) + name(b.dop_id) + b.base_from + b.base_to + b.variant, 'cs'))
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
        <input className="search" placeholder="Hledat (třeba frankfurt rudna)" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <p className="intro">Cena cesty se počítá jako v 10_26: hodiny každého z posádky × sazba/h + km × sazba/km + mýto. Sazba/h je na jednoho člena posádky. Z hodin Výjezd→PUP a DOP→Návrat počítá Planning Start a Home (základny CZ, NL, … spravujete v Místech). Pevných cen může mít trasa víc (třeba 10 h a 20 h), u cesty si v Reportech jednu vyberete; každá započatá čtvrthodina od requestu do odjezdu z Dop nad sjednané hodiny se připočte × počet lidí × sazba/h.</p>

      {canEdit && (
        <div className="newroute">
          <strong>{copyFrom ? `Kopie trasy ${name(copyFrom.pup_id)} → ${name(copyFrom.dop_id)} pro:` : 'Nová trasa:'}</strong>
          <input className="search" list="dl-places" placeholder="Pup" value={newPup} onChange={e => setNewPup(e.target.value)} />
          <span>→</span>
          <input className="search" list="dl-places" placeholder="Dop" value={newDop} onChange={e => setNewDop(e.target.value)} />
          <span className="quiet">výjezd z</span><BaseSelect value={newFrom} onChange={setNewFrom} /><span className="quiet">návrat do</span><BaseSelect value={newTo} onChange={setNewTo} />
          <input className="search" style={{ minWidth: '8rem', flex: '0 1 10rem' }} placeholder="varianta (třeba přes Francii)" title="Vyplňte, když stejná trasa jede jinudy: přes Francii, přes Švýcarsko… Prázdné = základní varianta." value={newVariant} onChange={e => setNewVariant(e.target.value)} />
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
                <li key={m.pup + m.dop + m.from + m.to}>
                  <span className="mroute">{name(m.pup)} → {name(m.dop)}{m.st.map(s => ` → ${name(s)}`).join('')}{baseLabel(m.from, m.to) && <span className="nltag">{baseLabel(m.from, m.to)}</span>}</span> <span className="quiet">({m.count}×)</span>
                  {canEdit && m.suggestions.map(s => (
                    <button key={s.route.id} className="chip cust" title={s.why} onClick={() => createRoute(m.pup, m.dop, m.from, m.to, s.route, '', m.st)}>
                      Zkopírovat z {name(s.route.pup_id)} → {name(s.route.dop_id)}
                    </button>
                  ))}
                  {canEdit && m.suggestions.length === 0 && (m.comp.ho || m.comp.dh) && (
                    <button className="chip cust" title={`${m.from}→PUP ${m.comp.ho ? 'z ' + m.comp.ho.why : 'chybí'}; ${m.comp.mid ? 'PUP→DOP součet ' + m.comp.mid.parts.join(' + ') + '; ' : ''}DOP→${m.to} ${m.comp.dh ? 'z ' + m.comp.dh.why : 'chybí'}.${m.comp.mid ? '' : ' PUP→DOP doplníte.'}`}
                      onClick={() => composeFor(m.pup, m.dop, m.from, m.to, m.comp.ho, m.comp.dh, m.st, m.comp.mid)}>Založit z úseků{m.comp.mid ? ' (i PUP→DOP)' : m.comp.ho && m.comp.dh ? '' : m.comp.ho ? ' (jen Výjezd→PUP)' : ' (jen DOP→Návrat)'}</button>
                  )}
                  {canEdit && <button className="link" onClick={() => createRoute(m.pup, m.dop, m.from, m.to, undefined, '', m.st)}>Založit prázdnou</button>}
                  {m.suggestions.length === 0 && !m.comp.ho && !m.comp.dh && <span className="quiet"> Žádná podobná trasa ani úsek. Zkontrolujte města v Místech.</span>}
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
              <th rowSpan={2}>Pup</th><th rowSpan={2}>Dop</th><th rowSpan={2} title="Varianta stejné trasy, třeba přes Francii / přes Švýcarsko. Prázdné = základní. V Reportech a Planningu si u cesty vyberete, která platí.">Varianta</th>
              {LEGS.map(l => <th key={l.key} colSpan={3} className="legh">{l.label}</th>)}
              <th colSpan={3} className="legh">Celkem</th>
              <th rowSpan={2} title="Základna: odkud posádka vyjíždí a kam se vrací. Výchozí CZ → CZ. Cesta v Planningu si vybere trasu se stejnou dvojicí.">Základna výjezd / návrat</th><th rowSpan={2}>€/h</th><th rowSpan={2}>€/km</th><th rowSpan={2}>Pevné ceny</th>{canEdit && <th rowSpan={2} />}
            </tr>
            <tr>
              {[...LEGS, { key: 'sum' }].map(l => [<th key={l.key + 'k'}>km</th>, <th key={l.key + 'h'}>h</th>, <th key={l.key + 't'}>mýto</th>])}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={routeIncomplete(r) ? 'incomplete' : ''} title={routeIncomplete(r) ? 'Chybí úsek PUP→DOP' + (r.note ? '. ' + r.note : '') : r.note ?? undefined}>
                <td className="ro">{name(r.pup_id)}</td>
                <td className="ro">{name(r.dop_id)}{r.stops.map(s => <span key={s} className="quiet"> → {name(s)}</span>)}{r.copied_from && <span className="quiet small" title="Zkopírováno z jiné trasy"> ⧉</span>}</td>
                <td className="variantcell"><Text disabled={!canEdit} value={r.variant} placeholder="základní" onSave={v => saveRoute(r, { variant: v.trim() })} /></td>
                {LEGS.map(l => [
                  <td key={l.key + 'k'}>{numCell(r, `${l.key}_km` as keyof Route)}</td>,
                  <td key={l.key + 'h'}>{numCell(r, `${l.key}_h` as keyof Route)}</td>,
                  <td key={l.key + 't'}>{numCell(r, `${l.key}_toll` as keyof Route)}</td>,
                ])}
                <td className="ro num sum">{totalKm(r)}</td><td className="ro num sum">{fmt(totalH(r))}</td><td className="ro num sum">{totalToll(r)}</td>
                <td className="basecell"><BaseSelect value={r.base_from} disabled={!canEdit} onChange={v => saveRoute(r, { base_from: v })} />→<BaseSelect value={r.base_to} disabled={!canEdit} onChange={v => saveRoute(r, { base_to: v })} /></td>
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
                    <button className="link small" onClick={() => { setCopyFrom(r); setNewPup(name(r.pup_id)); setNewDop(''); setNewFrom(r.base_from); setNewTo(r.base_to); setNewVariant(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Kopírovat</button>
                    <button className="link small" title="Založí další variantu téhle trasy (stejný Pup, Dop i základny) se stejnými hodnotami k úpravě" onClick={() => { const v = window.prompt('Název varianty, třeba „přes Francii“')?.trim(); if (v) createRoute(r.pup_id, r.dop_id, r.base_from, r.base_to, r, v, r.stops) }}>Varianta</button>
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

// bez diakritiky a malými písmeny, aby „rudna“ našlo Rudná
function fold(v: string) { return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }
