import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { isTcsCustomer, reportDone, tripKind, type Route, type RoutePrice, type Trip, type TripStop } from '../lib/supabase'
import { useApp } from '../lib/data'
import { fmtDT, parseDT } from '../lib/format'
import { LEGS, money, routeIncomplete, totalH, totalKm, totalToll, type Priced } from '../lib/routes'

// Detail reportu: celé datum a čas v polích, trasa z ceníku (úseky, sazby, pevné ceny) a cena na jednom místě.
// Pro vyplňování i pro kontrolu hotového reportu. Ukládá se po polích, stejně jako v tabulce.
export type TimeKey = 'dep_home' | 'arr_pup' | 'dep_pup' | 'arr_dop' | 'dep_dop' | 'arr_home'
const TIMES: { key: TimeKey; label: string; tr?: string }[] = [
  { key: 'dep_home', label: 'Odjezd domov' }, { key: 'arr_pup', label: 'Příjezd Pup' }, { key: 'dep_pup', label: 'Odjezd Pup', tr: 'Naloženo' },
  { key: 'arr_dop', label: 'Příjezd Dop', tr: 'Příjezd na vykládku' }, { key: 'dep_dop', label: 'Odjezd Dop', tr: 'Vyloženo' }, { key: 'arr_home', label: 'Příjezd domov' },
]

export function ReportDialog(p: {
  trip: Trip; stops: TripStop[]; route: Route | undefined; variants: Route[]; prices: RoutePrice[]; priced: Priced | null; auto: Priced | null
  sug: Partial<Trip>; total: string | null; escort: string | null; combi: React.ReactNode
  canEdit: boolean; seePrice: boolean; canRoutes: boolean
  save: (patch: Partial<Trip>) => void; saveStop: (s: TripStop, key: 'arr' | 'dep', v: string, base: string) => void
  nextNumber: () => void; onSaveRoute: () => void; onSupplier: () => void; onClose: () => void; homeFor: (t: Trip) => string | null
}) {
  const { trip: t, stops, route, variants, prices, priced, auto, sug, canEdit, seePrice, save } = p
  const { places, people, cars, customers, toast } = useApp()
  const done = reportDone(t)
  const ed = canEdit && !done
  const transport = tripKind(t) === 'transport'
  const tcs = isTcsCustomer(t.customer, customers)
  const name = (id: string | null) => places.find(x => x.id === id)?.name ?? '?'
  const crew = [t.guard1_id, t.guard2_id, t.guard3_id].filter(Boolean).map(id => people.find(x => x.id === id)?.short_name ?? '?').join(', ')
  const car = cars.find(c => c.id === t.car_id)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') p.onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [p])
  const ready = !!t.report_no && !!t.dep_home && !!t.arr_home
  const num = (v: string) => { const s = v.replace(/\s/g, '').replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : undefined }
  const times = TIMES.filter(x => !(transport && x.key === 'arr_pup'))
  const prevFilled = (i: number) => { for (let k = i - 1; k >= 0; k--) { const v = t[TIMES[k].key]; if (v) return v.replace(' ', 'T') } return `${t.trip_date}T00:00:00` }
  const cur = route?.currency === 'CZK' ? 'Kč' : '€'

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose() }}>
      <div className="dialog cardialog repdialog" role="dialog" aria-label="Report">
        <div className="dialoghead">
          <h2>{t.trip_date.split('-').reverse().join('. ')} {t.trip_time?.slice(0, 5)} · {t.customer ?? 'bez zákazníka'} · {transport && '🚐 '}{name(t.pup_id)} → {name(t.dop_id)}{stops.map(s => ` → ${name(s.place_id)}`).join('')}{done && <span className="nltag">hotovo</span>}</h2>
          <button className="ghost" aria-label="Zavřít" onClick={p.onClose}>×</button>
        </div>
        <p className="quiet small">Posádka {crew || '–'} · auto {car?.plate ?? car?.car_no ?? '–'} · {t.base_from} → {t.base_to}{t.takeover ? ' · take-over' : ''} <button className="link small" onClick={p.onSupplier}>dodavatel</button></p>

        <div className="formgrid">
          <label>#Report<span className="inlinerow"><input className="mono" defaultValue={t.report_no ?? ''} key={'r' + t.report_no} disabled={!ed} onBlur={e => { const v = e.target.value.trim(); if (v === String(t.report_no ?? '')) return; if (v && !/^\d+$/.test(v)) return toast('Číslo reportu jsou jen číslice.', 'err'); save({ report_no: v ? Number(v) : null }) }} />
            {ed && !t.report_no && <button className="link small" onClick={p.nextNumber}>další</button>}</span></label>
          {tcs
            ? <label>Ref. TCS<input className="mono" defaultValue={t.ref_tcs ?? ''} key={'a' + t.ref_tcs} disabled={!ed} placeholder="A12345" onBlur={e => { const v = e.target.value.trim().toUpperCase(); if (v !== (t.ref_tcs ?? '')) save({ ref_tcs: v || null }) }} /></label>
            : <label>Ref. zákazníka<input className="mono" defaultValue={t.customer_ref ?? ''} key={'c' + t.customer_ref} disabled={!ed} placeholder={route?.customer_ref ?? ''} onBlur={e => { const v = e.target.value.trim(); if (v !== (t.customer_ref ?? '')) save({ customer_ref: v || null }) }} /></label>}
          <label>Hodiny ručně<input className="mono" defaultValue={t.hours_manual?.toString().replace('.', ',') ?? ''} key={'h' + t.hours_manual} disabled={!ed} onBlur={e => { const n = num(e.target.value); if (n === undefined) return toast('Hodiny jako číslo.', 'err'); if (n !== (t.hours_manual ?? null)) save({ hours_manual: n }) }} /></label>
          <label>Hodiny<span className="ro">celkem <strong>{p.total ?? '–'}</strong>{!transport && <> · eskorta {p.escort ?? '–'}</>}</span></label>

          <div className="span4 repsection"><strong>Časy</strong> <span className="quiet small">pište jako 3:30 (den se doplní) nebo 2. 11. 3:30; šedě je návrh z trasy</span>
            {ed && Object.keys(sug).length > 0 && <button className="link small" onClick={() => save(sug)}>doplnit prázdná z trasy</button>}</div>
          {times.map((x, i) => (
            <label key={x.key}>{transport && x.tr ? x.tr : x.label}
              <input defaultValue={fmtDT(t[x.key])} key={x.key + t[x.key]} disabled={!ed} placeholder={sug[x.key] ? fmtDT(sug[x.key] as string) + '?' : ''}
                onBlur={e => {
                  if (e.target.value === fmtDT(t[x.key])) return
                  const idx = TIMES.findIndex(y => y.key === x.key)
                  const r = parseDT(e.target.value, idx === 0 ? `${t.trip_date}T00:00:00` : prevFilled(idx), idx > 0)
                  if (r === undefined) return toast('Čas zapište jako 3:30 nebo 2. 11. 3:30.', 'err')
                  const patch: Partial<Trip> = { [x.key]: r }
                  if (x.key === 'dep_dop' && r && !t.arr_home && !stops.length) { const h = p.homeFor({ ...t, dep_dop: r }); if (h) patch.arr_home = h }
                  save(patch)
                }} />
            </label>
          ))}
          {stops.map((s, i) => (
            <div key={s.id} className="span4 repsection small">
              <strong>Dop {i + 2}: {name(s.place_id)}</strong>{' '}
              příjezd <input className="cell time" defaultValue={fmtDT(s.arr)} key={'a' + s.arr} disabled={!ed} onBlur={e => e.target.value !== fmtDT(s.arr) && p.saveStop(s, 'arr', e.target.value, (i ? stops[i - 1].dep ?? stops[i - 1].arr : t.dep_dop ?? t.arr_dop) ?? `${t.trip_date}T00:00:00`)} />{' '}
              odjezd <input className="cell time" defaultValue={fmtDT(s.dep)} key={'d' + s.dep} disabled={!ed} onBlur={e => e.target.value !== fmtDT(s.dep) && p.saveStop(s, 'dep', e.target.value, s.arr ?? `${t.trip_date}T00:00:00`)} />
              {' '}· km {s.km ?? '–'}
            </div>
          ))}

          <div className="span4 repsection"><strong>Km{transport ? '' : ' a mýto'}</strong> <span className="quiet small">{transport ? 'u přepravy jen Km celkem' : 'narůstající stav: Km Pup, Km Dop, Km celkem'}</span></div>
          {(['km_pup', 'km_dop', 'km_total'] as const).filter(k => !transport || k === 'km_total').map(k => (
            <label key={k}>{k === 'km_pup' ? 'Km Pup' : k === 'km_dop' ? 'Km Dop' : 'Km celkem'}
              <input className="mono" defaultValue={t[k]?.toString() ?? ''} key={k + t[k]} disabled={!ed} placeholder={sug[k] != null ? String(sug[k]) + '?' : ''}
                onBlur={e => { const n = num(e.target.value); if (n === undefined) return toast('Km jako celé číslo.', 'err'); if (n !== (t[k] ?? null)) save({ [k]: n === null ? null : Math.round(n) } as Partial<Trip>) }} />
            </label>
          ))}
          {!transport && <label>Mýto<input className="mono" defaultValue={t.toll?.toString().replace('.', ',') ?? ''} key={'t' + t.toll} disabled={!ed} placeholder={sug.toll != null ? String(sug.toll) + '?' : ''}
            onBlur={e => { const n = num(e.target.value); if (n === undefined) return toast('Mýto jako číslo.', 'err'); if (n !== (t.toll ?? null)) save({ toll: n }) }} /></label>}
          <label className="span2">Navazování<span className="ro">{p.combi}</span></label>

          {seePrice && <>
            <div className="span4 repsection"><strong>Trasa z ceníku a cena</strong></div>
            {route ? (
              <div className="span4">
                <table className="grid plain sub2 routelegs">
                  <thead><tr><th>{route.customer ?? '—'}{route.variant ? ` · ${route.variant}` : ''}</th>{LEGS.map(l => <th key={l.key}>{l.label}</th>)}<th>Celkem</th></tr></thead>
                  <tbody>
                    <tr><td>km</td>{LEGS.map(l => <td key={l.key} className="num">{route[`${l.key}_km` as keyof Route] as number ?? '–'}</td>)}<td className="num"><strong>{totalKm(route)}</strong></td></tr>
                    <tr><td>h</td>{LEGS.map(l => <td key={l.key} className="num">{route[`${l.key}_h` as keyof Route] as number ?? '–'}</td>)}<td className="num"><strong>{totalH(route)}</strong></td></tr>
                    {!transport && <tr><td>mýto</td>{LEGS.map(l => <td key={l.key} className="num">{route[`${l.key}_toll` as keyof Route] as number ?? '–'}</td>)}<td className="num"><strong>{totalToll(route)}</strong></td></tr>}
                  </tbody>
                </table>
                <p className="quiet small">Sazby {route.rate_h} {cur}/h na člověka, {route.rate_km} {cur}/km{routeIncomplete(route) ? ' · chybí úsek PUP→DOP' : ''}
                  {variants.length > 1 && <> · varianta <select className="variantsel" disabled={!ed} value={route.id} onChange={e => save({ route_id: e.target.value || null })}>{variants.map(v => <option key={v.id} value={v.id}>{v.variant || 'základní'}{v.customer && v.customer !== t.customer ? ` (${v.customer})` : ''}</option>)}</select></>}</p>
              </div>
            ) : (
              <p className="span4 missingtxt">Tahle trasa v ceníku není. {p.canRoutes && ed && <button className="link" onClick={p.onSaveRoute}>uložit trasu na příště</button>}</p>
            )}
            <label className="span2">Cena podle
              {t.price_manual != null
                ? <span className="ro">ručně {ed && <button className="link small" onClick={() => save({ price_manual: null })}>zrušit</button>}</span>
                : route
                ? <select disabled={!ed} value={t.route_price_id ?? ''} onChange={e => save({ route_price_id: e.target.value || null })}>
                    <option value="">sazby (hodiny × {route.rate_h} + km × {route.rate_km}{transport ? '' : ' + mýto'})</option>
                    {prices.filter(x => x.route_id === route.id).map(x => <option key={x.id} value={x.id}>pevná {x.label}: {money(Number(x.price), x.currency)}{transport && (x.free_load_h != null || x.free_unload_h != null) ? ` (zdarma ${x.free_load_h ?? 0} h nakl., ${x.free_unload_h ?? 0} h vykl.)` : ''}</option>)}
                  </select>
                : <span className="ro quiet">–</span>}
            </label>
            <label className="span2">Cena bez DPH
              <input className="mono" defaultValue={priced ? money(priced.price, priced.currency) : ''} key={'p' + priced?.price + t.price_manual} disabled={!ed} placeholder="zadat ručně"
                onBlur={e => { const n = num(e.target.value.replace(/€|Kč/g, '')); if (n === undefined) return toast('Cenu jako číslo.', 'err'); if (n === null) return save({ price_manual: null }); if (auto && Math.abs(n - auto.price) < 0.005 && t.price_manual == null) return; save({ price_manual: n }) }} />
            </label>
            {priced && <p className="span4 quiet small">{priced.how}<br />Rozklad pro přílohu faktury: HRS price {money(priced.hrs, priced.currency)} · Car price {money(priced.car, priced.currency)} · Toll {money(priced.toll, priced.currency)}</p>}
          </>}

          <label className="span4">Poznámka k reportu<textarea rows={2} defaultValue={t.report_note ?? ''} disabled={!ed} onBlur={e => e.target.value !== (t.report_note ?? '') && save({ report_note: e.target.value.trim() || null })} /></label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={p.onClose}>Zavřít</button>
          {canEdit && !done && <>
            <button className="link small" onClick={() => save({ status: 'Departed' })} title="Vrátit cestu do Planningu se statusem Departed">Do Planningu</button>
            <button className="primary" disabled={!ready} title={ready ? 'Uzavřít report' : 'Chybí číslo reportu, odjezd nebo příjezd domů'} onClick={() => { save({ report_done_at: new Date().toISOString() }); p.onClose() }}>Hotovo</button>
          </>}
          {canEdit && done && <button className="link" onClick={() => save({ report_done_at: null })}>Znovu otevřít</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
