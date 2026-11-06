import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type Route, type RoutePrice } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { BaseSelect } from '../lib/BaseSelect'

// Trasa v ceníku v jednom okně: Pup, Dop, základny, varianta, zákazník, měna, sazby, úseky (km, h, mýto), pevné ceny, výchozí reference.
// Pro založení (prázdná, kopie, varianta, z úseků) i pro úpravu existující trasy.
type Leg = { km: string; h: string; toll: string }
type PriceRow = { id?: string; label: string; price: string; pup_dop_h: string; free_load_h: string; free_unload_h: string }
export type RouteDraft = {
  id?: string; pup: string; dop: string; stops: string[]; base_from: string; base_to: string; variant: string
  customer: string; currency: 'EUR' | 'CZK'; rate_h: string; rate_km: string; customer_ref: string; note: string
  ho: Leg; pd: Leg; dh: Leg; prices: PriceRow[]; copied_from: string | null
}
const f = (v: number | string | null | undefined) => (v == null || v === '' ? '' : String(v).replace('.', ','))
const n = (v: string) => { const t = v.replace(/\s/g, '').replace(',', '.'); if (!t) return null; const x = Number(t); return Number.isFinite(x) ? x : undefined }

export function draftFrom(r: Route | undefined, prices: RoutePrice[], placeName: (id: string) => string, over: Partial<RouteDraft> = {}): RouteDraft {
  const leg = (k: 'ho_pup' | 'pup_dop' | 'dop_ho'): Leg => r ? { km: f(r[`${k}_km`]), h: f(r[`${k}_h`]), toll: f(r[`${k}_toll`]) } : { km: '', h: '', toll: '' }
  return {
    id: undefined, pup: r ? placeName(r.pup_id) : '', dop: r ? placeName(r.dop_id) : '', stops: r?.stops ?? [], base_from: r?.base_from ?? 'CZ', base_to: r?.base_to ?? 'CZ', variant: r?.variant ?? '',
    customer: r?.customer ?? 'TCS NL', currency: r?.currency ?? 'EUR', rate_h: f(r?.rate_h ?? 10), rate_km: f(r?.rate_km ?? 0.28), customer_ref: r?.customer_ref ?? '', note: '',
    ho: leg('ho_pup'), pd: leg('pup_dop'), dh: leg('dop_ho'),
    prices: r ? prices.filter(p => p.route_id === r.id).map(p => ({ id: undefined, label: p.label, price: f(p.price), pup_dop_h: f(p.pup_dop_h), free_load_h: f(p.free_load_h), free_unload_h: f(p.free_unload_h) })) : [],
    copied_from: r?.id ?? null, ...over,
  }
}
export function draftForEdit(r: Route, prices: RoutePrice[], placeName: (id: string) => string): RouteDraft {
  const d = draftFrom(r, prices, placeName)
  return { ...d, id: r.id, note: r.note ?? '', copied_from: r.copied_from, prices: prices.filter(p => p.route_id === r.id).map(p => ({ id: p.id, label: p.label, price: f(p.price), pup_dop_h: f(p.pup_dop_h), free_load_h: f(p.free_load_h), free_unload_h: f(p.free_unload_h) })) }
}

export function RouteDialog({ initial, title, onSaved, onClose }: { initial: RouteDraft; title: string; onSaved: () => void; onClose: () => void }) {
  const { places, customers, toast, reloadLists } = useApp()
  const [d, setD] = useState<RouteDraft>(initial)
  const [saving, setSaving] = useState(false)
  useEffect(() => setD(initial), [initial])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const set = <K extends keyof RouteDraft>(k: K, v: RouteDraft[K]) => setD(cur => ({ ...cur, [k]: v }))
  const setLeg = (k: 'ho' | 'pd' | 'dh', p: Partial<Leg>) => setD(cur => ({ ...cur, [k]: { ...cur[k], ...p } }))
  const setPrice = (i: number, p: Partial<PriceRow>) => setD(cur => ({ ...cur, prices: cur.prices.map((x, j) => (j === i ? { ...x, ...p } : x)) }))
  const transport = d.customer.toUpperCase().startsWith('JTI')
  const cur = d.currency === 'CZK' ? 'Kč' : '€'
  const placeName = (id: string) => places.find(p => p.id === id)?.name ?? '?'

  async function resolvePlace(v: string): Promise<string | null> {
    const p = places.find(x => x.name.toLowerCase() === v.trim().toLowerCase())
    if (p) return p.id
    if (!v.trim()) return null
    if (!window.confirm(`Místo „${v.trim()}“ v seznamu není. Založit ho?`)) return null
    const { data, error } = await supabase.from('places').insert({ name: v.trim(), city: v.trim().split(/\s+/).pop() }).select().single()
    if (error) { toast(explain(error), 'err'); return null }
    await reloadLists()
    return (data as { id: string }).id
  }
  async function save() {
    const pup = await resolvePlace(d.pup), dop = await resolvePlace(d.dop)
    if (!pup || !dop) return toast('Vyplňte Pup i Dop.', 'err')
    const vals: Record<string, unknown> = {}
    for (const [k, key] of [['ho', 'ho_pup'], ['pd', 'pup_dop'], ['dh', 'dop_ho']] as const)
      for (const fld of ['km', 'h', 'toll'] as const) { const v = n(d[k][fld]); if (v === undefined) return toast(`${key} ${fld}: pište číslo.`, 'err'); vals[`${key}_${fld}`] = v }
    const rh = n(d.rate_h), rk = n(d.rate_km)
    if (rh == null || rk == null) return toast('Sazby za hodinu a km musí být čísla.', 'err')
    const prices: { id?: string; label: string; price: number; pup_dop_h: number | null; free_load_h: number | null; free_unload_h: number | null }[] = []
    for (const p of d.prices) {
      if (!p.label.trim() && !p.price.trim()) continue
      const pv = n(p.price); if (pv == null) return toast(`Pevná cena „${p.label}“: částka musí být číslo.`, 'err')
      const h = n(p.pup_dop_h), fl = n(p.free_load_h), fu = n(p.free_unload_h)
      if (h === undefined || fl === undefined || fu === undefined) return toast(`Pevná cena „${p.label}“: hodiny jako číslo.`, 'err')
      prices.push({ id: p.id, label: p.label.trim() || `${pv} ${cur}`, price: pv, pup_dop_h: transport ? null : h ?? n(p.label.replace(/h/i, '')) ?? null, free_load_h: transport ? fl : null, free_unload_h: transport ? fu : null })
    }
    setSaving(true)
    const row = { ...vals, pup_id: pup, dop_id: dop, stops: d.stops, base_from: d.base_from, base_to: d.base_to, variant: d.variant.trim(), customer: d.customer || null, currency: d.currency,
      rate_h: rh, rate_km: rk, customer_ref: d.customer_ref.trim() || null, note: d.note.trim() || null }
    let id = d.id
    if (id) {
      const { error } = await supabase.from('routes').update(row).eq('id', id)
      if (error) { setSaving(false); return toast(error.code === '23505' ? 'Trasa se stejným Pup, Dop, základnou, variantou a zákazníkem už existuje.' : explain(error), 'err') }
    } else {
      const { data, error } = await supabase.from('routes').insert({ ...row, copied_from: d.copied_from }).select('id').single()
      if (error || !data) { setSaving(false); return toast(error?.code === '23505' ? 'Tahle trasa už existuje. Pro další variantu (přes Francii…) vyplňte název varianty.' : explain(error), 'err') }
      id = data.id
    }
    // pevné ceny: existující upravit, nové vložit, smazané odstranit
    const keep = prices.filter(p => p.id).map(p => p.id!)
    if (d.id) { const q = supabase.from('route_prices').delete().eq('route_id', id); await (keep.length ? q.not('id', 'in', `(${keep.join(',')})`) : q) }
    for (const [i, p] of prices.entries()) {
      const vals2 = { route_id: id, label: p.label, price: p.price, pup_dop_h: p.pup_dop_h, free_load_h: p.free_load_h, free_unload_h: p.free_unload_h, currency: d.currency, sort: i + 1 }
      const { error } = p.id ? await supabase.from('route_prices').update(vals2).eq('id', p.id) : await supabase.from('route_prices').insert(vals2)
      if (error) toast(explain(error), 'err')
    }
    setSaving(false); toast(d.id ? 'Trasa uložena.' : 'Trasa založena.'); onSaved()
  }

  const legRow = (k: 'ho' | 'pd' | 'dh', label: string) => (
    <tr key={k}>
      <td><strong>{label}</strong></td>
      <td><input className="cell time mono" value={d[k].km} onChange={e => setLeg(k, { km: e.target.value })} placeholder="km" /></td>
      <td><input className="cell time mono" value={d[k].h} onChange={e => setLeg(k, { h: e.target.value })} placeholder="h" /></td>
      <td><input className="cell time mono" value={d[k].toll} onChange={e => setLeg(k, { toll: e.target.value })} placeholder="mýto" /></td>
    </tr>
  )
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label={title}>
        <div className="dialoghead"><h2>{title}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <datalist id="rd-places">{places.map(p => <option key={p.id} value={p.name} />)}</datalist>
        <div className="formgrid">
          <label className="span2">Pup<input type="text" list="rd-places" value={d.pup} onChange={e => set('pup', e.target.value)} /></label>
          <label className="span2">Dop<input type="text" list="rd-places" value={d.dop} onChange={e => set('dop', e.target.value)} />{d.stops.length > 0 && <span className="quiet small">další vykládky: {d.stops.map(placeName).join(' → ')}</span>}</label>
          <label>Výjezd z<BaseSelect value={d.base_from} onChange={v => set('base_from', v)} /></label>
          <label>Návrat do<BaseSelect value={d.base_to} onChange={v => set('base_to', v)} /></label>
          <label title="Prázdné = základní trasa. Vyplňte, když stejná trasa jede jinudy (přes Francii, přes Švýcarsko…)">Varianta<input type="text" value={d.variant} onChange={e => set('variant', e.target.value)} placeholder="základní" /></label>
          <label title="Komu ceník patří; stejná trasa může mít ceny pro víc zákazníků">Zákazník<select value={d.customer} onChange={e => set('customer', e.target.value)}><option value="">—</option>{customers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
          <label>Měna<select value={d.currency} onChange={e => set('currency', e.target.value as RouteDraft['currency'])}><option>EUR</option><option>CZK</option></select></label>
          <label title="Sazba za hodinu na jednoho člena posádky">Sazba /h ({cur})<input type="text" className="mono" value={d.rate_h} onChange={e => set('rate_h', e.target.value)} /></label>
          <label>Sazba /km ({cur})<input type="text" className="mono" value={d.rate_km} onChange={e => set('rate_km', e.target.value)} /></label>
          <label title="U opakujících se tras (JTi) se u nové cesty předvyplní">Výchozí ref. zákazníka<input type="text" className="mono" value={d.customer_ref} onChange={e => set('customer_ref', e.target.value)} /></label>
          <div className="span4 repsection"><strong>Úseky</strong> <span className="quiet small">km, hodiny a mýto; z hodin Výjezd→PUP a DOP→Návrat počítá Planning Start a Home</span></div>
          <div className="span4 tablewrap">
            <table className="grid plain sub2">
              <thead><tr><th>Úsek</th><th>km</th><th>h</th><th>mýto</th></tr></thead>
              <tbody>{legRow('ho', `${d.base_from} → PUP`)}{legRow('pd', 'PUP → DOP')}{legRow('dh', `DOP → ${d.base_to}`)}</tbody>
            </table>
          </div>
          <div className="span4 repsection"><strong>Pevné ceny</strong> <span className="quiet small">{transport ? 'u přepravy: cena + hodiny zdarma na nakládku (od objednaného času do naložení) a na vykládku (od příjezdu do vyložení)' : 'název (třeba 10 h), hodiny v ceně od requestu do odjezdu z Dop, částka; přesah se účtuje po čtvrthodinách × sazba/h × posádka'}</span>
            {' '}<button className="link small" onClick={() => set('prices', [...d.prices, { label: '', price: '', pup_dop_h: '', free_load_h: transport ? '3' : '', free_unload_h: transport ? '4' : '' }])}>+ pevná cena</button></div>
          {d.prices.length > 0 && (
            <div className="span4 tablewrap">
              <table className="grid plain sub2">
                <thead><tr><th>Název</th><th>Částka ({cur})</th>{transport ? <><th>Zdarma nakládka h</th><th>Zdarma vykládka h</th></> : <th>Hodin v ceně</th>}<th /></tr></thead>
                <tbody>
                  {d.prices.map((p, i) => (
                    <tr key={i}>
                      <td><input className="cell" value={p.label} onChange={e => setPrice(i, { label: e.target.value, ...(transport || p.pup_dop_h ? {} : { pup_dop_h: f(n(e.target.value.replace(/h/i, '')) ?? '') }) })} placeholder={transport ? 'třeba standard' : '10 h'} /></td>
                      <td><input className="cell time mono" value={p.price} onChange={e => setPrice(i, { price: e.target.value })} /></td>
                      {transport
                        ? <><td><input className="cell time mono" value={p.free_load_h} onChange={e => setPrice(i, { free_load_h: e.target.value })} /></td><td><input className="cell time mono" value={p.free_unload_h} onChange={e => setPrice(i, { free_unload_h: e.target.value })} /></td></>
                        : <td><input className="cell time mono" value={p.pup_dop_h} onChange={e => setPrice(i, { pup_dop_h: e.target.value })} /></td>}
                      <td><button className="ghost" aria-label="Odebrat cenu" onClick={() => set('prices', d.prices.filter((_, j) => j !== i))}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <label className="span4">Poznámka<input type="text" value={d.note} onChange={e => set('note', e.target.value)} /></label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít bez uložení</button>
          <button className="primary" disabled={saving} onClick={save}>{saving ? 'Ukládám…' : d.id ? 'Uložit' : 'Založit trasu'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
