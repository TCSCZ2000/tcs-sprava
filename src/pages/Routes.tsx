import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, type Route, type RoutePrice, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { BaseSelect } from '../lib/BaseSelect'
import { baseLabel, loadStops, routeKeyOf, type StopsMap } from '../lib/supabase'
import { LEGS, composeRoute, routeIncomplete, suggestRoutes, totalH, totalKm, totalToll, type LegPick, type MidPick } from '../lib/routes'
import { RouteDialog, draftFrom, draftForEdit, type RouteDraft } from './RouteDialog'
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
  const { level, places, customers, toast, reloadLists } = useApp()
  // přeprava (JTi): pevná cena má hodiny zdarma na nakládku/vykládku místo „hodin v ceně“
  const transportCust = (c: string | null) => (c ?? '').toUpperCase().startsWith('JTI')
  const canEdit = level('routes') === 'write'
  const [routes, setRoutes] = useState<Route[]>([])
  const [prices, setPrices] = useState<RoutePrice[]>([])
  const [trips, setTrips] = useState<Pick<Trip, 'id' | 'pup_id' | 'dop_id' | 'trip_date' | 'status' | 'base_from' | 'base_to'>[]>([])
  const [q, setQ] = useState('')
  const [dlg, setDlg] = useState<{ draft: RouteDraft; title: string } | null>(null)
  const [custFilter, setCustFilter] = useState<string>('')   // '' = všichni
  const [showCust, setShowCust] = useState(false)
  const isAdmin = level('users') === 'write'
  async function saveCustomer(name: string, patch: Record<string, unknown>) {
    const { error } = await supabase.from('customers').update(patch).eq('name', name)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const [stops, setStops] = useState<StopsMap>(new Map())
  const [showMissing, setShowMissing] = useState(true)

  const placeBy = useMemo(() => new Map(places.map(p => [p.id, p])), [places])

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

  // Založení / úprava trasy v okně
  const f = (v: number | string | null | undefined) => (v == null || v === '' ? '' : String(v).replace('.', ','))
  const base = (over: Partial<RouteDraft>) => draftFrom(undefined, prices, name, { customer: custFilter || 'TCS NL', ...over })
  const openNew = () => setDlg({ draft: base({}), title: 'Nová trasa' })
  const openCopy = (src: Route, over: Partial<RouteDraft> = {}) => setDlg({ draft: draftFrom(src, prices, name, { dop: '', ...over }), title: `Kopie trasy ${name(src.pup_id)} → ${name(src.dop_id)}` })
  const openVariant = (src: Route) => setDlg({ draft: draftFrom(src, prices, name, { variant: '' }), title: `Nová varianta trasy ${name(src.pup_id)} → ${name(src.dop_id)}` })
  const openEdit = (r: Route) => setDlg({ draft: draftForEdit(r, prices, name), title: `Trasa ${name(r.pup_id)} → ${name(r.dop_id)}${r.variant ? ' · ' + r.variant : ''}` })
  const openComposed = (m: { pup: string; dop: string; from: string; to: string; st: string[]; comp: { ho: LegPick | null; dh: LegPick | null; mid: MidPick | null } }) => {
    const src = m.comp.ho?.route ?? m.comp.dh?.route
    const d = base({ pup: name(m.pup), dop: name(m.dop), base_from: m.from, base_to: m.to, stops: m.st, copied_from: src?.id ?? null, rate_h: f(src?.rate_h ?? 10), rate_km: f(src?.rate_km ?? 0.28), currency: src?.currency ?? 'EUR', customer: src?.customer ?? custFilter ?? 'TCS NL' })
    if (m.comp.ho) d.ho = { km: f(m.comp.ho.route.ho_pup_km), h: f(m.comp.ho.route.ho_pup_h), toll: f(m.comp.ho.route.ho_pup_toll) }
    if (m.comp.dh) d.dh = { km: f(m.comp.dh.route.dop_ho_km), h: f(m.comp.dh.route.dop_ho_h), toll: f(m.comp.dh.route.dop_ho_toll) }
    if (m.comp.mid) d.pd = { km: f(m.comp.mid.km), h: f(m.comp.mid.h), toll: f(m.comp.mid.toll) }
    d.note = `Složeno z úseků: ${m.from}→PUP ${m.comp.ho ? 'z ' + m.comp.ho.why : 'chybí'}; ${m.comp.mid ? 'PUP→DOP součet ' + m.comp.mid.parts.join(' + ') + '; ' : ''}DOP→${m.to} ${m.comp.dh ? 'z ' + m.comp.dh.why : 'chybí'}`
    setDlg({ draft: d, title: `Nová trasa ${name(m.pup)} → ${name(m.dop)} z úseků` })
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
    const pv = num(window.prompt(`Cena „${label}“ v ${r.currency === 'CZK' ? 'Kč' : '€'} bez DPH`) ?? '')
    if (pv == null) return toast('Cena musí být číslo.', 'err')
    const h = num(label.replace(/h/i, ''))
    let free: { free_load_h: number | null; free_unload_h: number | null } = { free_load_h: null, free_unload_h: null }
    if (transportCust(r.customer)) {
      const fl = num(window.prompt('Hodin zdarma na nakládku (od objednaného času do naložení)', '3') ?? '')
      const fu = num(window.prompt('Hodin zdarma na vykládku (od příjezdu na vykládku do vyložení)', '4') ?? '')
      free = { free_load_h: fl ?? null, free_unload_h: fu ?? null }
    }
    const { error } = await supabase.from('route_prices').insert({ route_id: r.id, label, price: pv, pup_dop_h: transportCust(r.customer) ? null : h ?? null, currency: r.currency, ...free, sort: prices.filter(p => p.route_id === r.id).length + 1 })
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
      .filter(r => !custFilter || (r.customer ?? '') === custFilter)
      .filter(r => {
        if (!words.length) return true
        const hay = fold(`${name(r.pup_id)} ${city(r.pup_id)} ${name(r.dop_id)} ${city(r.dop_id)} ${r.customer_ref ?? ''}`)
        return words.every(w => hay.includes(w))
      })
      .sort((a, b) => (name(a.pup_id) + name(a.dop_id) + a.base_from + a.base_to + a.variant).localeCompare(name(b.pup_id) + name(b.dop_id) + b.base_from + b.base_to + b.variant, 'cs'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, q, places, custFilter])

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
        <div className="statusfilter custfilter">
          {[{ name: '' }, ...customers].map(c => (
            <button key={c.name} className={'chip cust' + (custFilter === c.name ? '' : ' off')} onClick={() => setCustFilter(c.name)}>{c.name || 'všichni'}{c.name ? ` (${routes.filter(r => r.customer === c.name).length})` : ''}</button>
          ))}
          {isAdmin && <button className="link small" onClick={() => setShowCust(v => !v)}>{showCust ? 'zavřít zákazníky' : 'zákazníci a výchozí sazby'}</button>}
        </div>
      </div>
      <p className="intro">Cena cesty se počítá jako v 10_26: hodiny každého z posádky × sazba/h + km × sazba/km + mýto. Sazba/h je na jednoho člena posádky. Z hodin Výjezd→PUP a DOP→Návrat počítá Planning Start a Home (základny CZ, NL, … spravujete v Místech). Pevných cen může mít trasa víc (třeba 10 h a 20 h), u cesty si v Reportech jednu vyberete; každá započatá čtvrthodina od requestu do odjezdu z Dop nad sjednané hodiny se připočte × počet lidí × sazba/h. Každá trasa patří zákazníkovi (čipy nahoře filtrují ceník); u JTi má pevná cena místo hodin v ceně hodiny zdarma na nakládku (od objednaného času do naložení) a na vykládku (od příjezdu na vykládku do vyložení), přesah se účtuje po čtvrthodinách; měna EUR nebo CZK.</p>

      {showCust && (
        <div className="catpanel">
          <p className="intro">Výchozí sazby zákazníka se použijí, když cesta nemá trasu v ceníku: hodiny × sazba × posádka + Km celkem × sazba/km + mýto z reportu. Řada čísel reportů: TCS NL a TCS DE sdílí řadu TCS, JTi mají každý svou.</p>
          <table className="grid plain catgrid">
            <thead><tr><th>Zákazník</th><th>Řada reportů</th><th className="num">Sazba /h</th><th className="num">Sazba /km</th><th>Měna</th><th>Aktivní</th></tr></thead>
            <tbody>
              {customers.map(c => (
                <tr key={c.name}>
                  <td><span className="ro"><strong>{c.name}</strong></span></td>
                  <td><span className="ro quiet">{c.report_series}</span></td>
                  <td className="num"><Text value={c.rate_h?.toString() ?? ''} time mono onSave={v => { const x = num(v); if (x === undefined) return toast('Sazbu pište jako číslo.', 'err'); saveCustomer(c.name, { rate_h: x }) }} /></td>
                  <td className="num"><Text value={c.rate_km?.toString() ?? ''} time mono onSave={v => { const x = num(v); if (x === undefined) return toast('Sazbu pište jako číslo.', 'err'); saveCustomer(c.name, { rate_km: x }) }} /></td>
                  <td><select className="variantsel" value={c.currency} onChange={e => saveCustomer(c.name, { currency: e.target.value })}><option>EUR</option><option>CZK</option></select></td>
                  <td className="mid"><input type="checkbox" checked={c.active} onChange={e => saveCustomer(c.name, { active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && <p><button className="primary" onClick={openNew}>Nová trasa</button> <span className="quiet small">Otevře okno, kde trasu nastavíte celou: úseky, sazby, pevné ceny, zákazníka a měnu. Kopii nebo variantu existující trasy založíte z jejího řádku.</span></p>}

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
                    <button key={s.route.id} className="chip cust" title={s.why} onClick={() => openCopy(s.route, { pup: name(m.pup), dop: name(m.dop), base_from: m.from, base_to: m.to, stops: m.st })}>
                      Zkopírovat z {name(s.route.pup_id)} → {name(s.route.dop_id)}
                    </button>
                  ))}
                  {canEdit && m.suggestions.length === 0 && (m.comp.ho || m.comp.dh) && (
                    <button className="chip cust" title={`${m.from}→PUP ${m.comp.ho ? 'z ' + m.comp.ho.why : 'chybí'}; ${m.comp.mid ? 'PUP→DOP součet ' + m.comp.mid.parts.join(' + ') + '; ' : ''}DOP→${m.to} ${m.comp.dh ? 'z ' + m.comp.dh.why : 'chybí'}.${m.comp.mid ? '' : ' PUP→DOP doplníte.'}`}
                      onClick={() => openComposed(m)}>Založit z úseků{m.comp.mid ? ' (i PUP→DOP)' : m.comp.ho && m.comp.dh ? '' : m.comp.ho ? ' (jen Výjezd→PUP)' : ' (jen DOP→Návrat)'}</button>
                  )}
                  {canEdit && <button className="link" onClick={() => setDlg({ draft: base({ pup: name(m.pup), dop: name(m.dop), base_from: m.from, base_to: m.to, stops: m.st }), title: `Nová trasa ${name(m.pup)} → ${name(m.dop)}` })}>Založit prázdnou</button>}
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
              <th rowSpan={2} className="w-dots" /><th rowSpan={2}>Pup</th><th rowSpan={2}>Dop</th><th rowSpan={2} title="Varianta stejné trasy, třeba přes Francii / přes Švýcarsko. Prázdné = základní. V Reportech a Planningu si u cesty vyberete, která platí.">Varianta</th>
              {LEGS.map(l => <th key={l.key} colSpan={3} className="legh">{l.label}</th>)}
              <th colSpan={3} className="legh">Celkem</th>
              <th rowSpan={2} title="Základna: odkud posádka vyjíždí a kam se vrací. Výchozí CZ → CZ. Cesta v Planningu si vybere trasu se stejnou dvojicí.">Základna výjezd / návrat</th><th rowSpan={2} title="Komu ceník patří; stejná trasa může mít ceny pro víc zákazníků">Zákazník</th><th rowSpan={2}>Měna</th><th rowSpan={2} title="Sazba za hodinu na jednoho člena posádky">/h</th><th rowSpan={2}>/km</th><th rowSpan={2} title="Pevná cena; u přeprav i hodiny zdarma na nakládku a vykládku">Pevné ceny</th><th rowSpan={2} title="Výchozí reference zákazníka u opakujících se tras (JTi); u cesty se předvyplní">Výchozí ref.</th>{canEdit && <th rowSpan={2} />}
            </tr>
            <tr>
              {[...LEGS, { key: 'sum' }].map(l => [<th key={l.key + 'k'}>km</th>, <th key={l.key + 'h'}>h</th>, <th key={l.key + 't'}>mýto</th>])}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={routeIncomplete(r) ? 'incomplete' : ''} title={routeIncomplete(r) ? 'Chybí úsek PUP→DOP' + (r.note ? '. ' + r.note : '') : r.note ?? undefined}>
                <td className="w-dots"><button className="ghost dots" title="Celá trasa v jednom okně: úseky, sazby, pevné ceny" aria-label="Detail trasy" onClick={() => openEdit(r)}>⋯</button></td>
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
                <td><select className="variantsel" disabled={!canEdit} value={r.customer ?? ''} onChange={e => saveRoute(r, { customer: e.target.value || null })}><option value="">—</option>{customers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></td>
                <td><select className="variantsel" disabled={!canEdit} value={r.currency} onChange={e => { const cur = e.target.value as Route['currency']; saveRoute(r, { currency: cur }); supabase.from('route_prices').update({ currency: cur }).eq('route_id', r.id).then(() => load()) }}><option>EUR</option><option>CZK</option></select></td>
                <td>{numCell(r, 'rate_h')}</td><td>{numCell(r, 'rate_km')}</td>
                <td className="prices">
                  {prices.filter(p => p.route_id === r.id).map(p => (
                    <span key={p.id} className="pricechip" title={transportCust(r.customer) ? 'Pevná cena · hodiny zdarma na nakládku · na vykládku' : 'Název (hodiny v ceně) · cena'}>
                      <Text disabled={!canEdit} value={p.label} time onSave={v => v.trim() && savePrice(p, { label: v.trim(), ...(transportCust(r.customer) ? {} : { pup_dop_h: num(v.replace(/h/i, '')) ?? p.pup_dop_h }) })} />
                      <Text disabled={!canEdit} value={fmt(p.price)} time mono
                        onSave={v => { const x = num(v); if (x == null) return toast('Cena musí být číslo.', 'err'); savePrice(p, { price: x }) }} />
                      {transportCust(r.customer) && <>
                        <Text disabled={!canEdit} value={fmt(p.free_load_h)} time mono placeholder="nakl. h" onSave={v => { const x = num(v); if (x === undefined) return toast('Hodiny jako číslo.', 'err'); savePrice(p, { free_load_h: x }) }} />
                        <Text disabled={!canEdit} value={fmt(p.free_unload_h)} time mono placeholder="vykl. h" onSave={v => { const x = num(v); if (x === undefined) return toast('Hodiny jako číslo.', 'err'); savePrice(p, { free_unload_h: x }) }} />
                      </>}
                      {canEdit && <button className="ghost" aria-label={`Smazat cenu ${p.label}`} onClick={() => removePrice(p)}>×</button>}
                    </span>
                  ))}
                  {canEdit && <button className="link small" onClick={() => addPrice(r)}>+ cena</button>}
                </td>
                <td><Text disabled={!canEdit} value={r.customer_ref ?? ''} mono placeholder="–" onSave={v => saveRoute(r, { customer_ref: v.trim() || null })} /></td>
                {canEdit && (
                  <td className="actions nowrap">
                    <button className="link small" title="Nová trasa se stejnými úseky, sazbami a cenami; Dop si zvolíte" onClick={() => openCopy(r)}>Kopírovat</button>
                    <button className="link small" title="Další varianta téhle trasy (stejný Pup, Dop i základny), třeba přes Francii" onClick={() => openVariant(r)}>Varianta</button>
                    <button className="ghost" aria-label="Smazat trasu" onClick={() => removeRoute(r)}>×</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? 'Žádná trasa neodpovídá hledání.' : 'Zatím žádné trasy.'}</p>}
      </div>
      {dlg && <RouteDialog initial={dlg.draft} title={dlg.title} onSaved={() => { setDlg(null); load() }} onClose={() => setDlg(null)} />}
    </section>
  )
}

// bez diakritiky a malými písmeny, aby „rudna“ našlo Rudná
function fold(v: string) { return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') }
