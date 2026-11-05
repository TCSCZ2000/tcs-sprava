import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type Route, type Trip } from '../lib/supabase'
import { useApp } from '../lib/data'
import type { LegPick, MidPick } from '../lib/routes'

// Uložení trasy do ceníku „na příště“ přímo z Reportů, když trasa chybí.
// Předvyplní se z toho, co je po ruce: hodnoty z reportu (km a časy téhle cesty), podobná trasa (stejný Pup/Dop nebo město) a hotové úseky.
// Člověk si před uložením upraví, co se má uložit (km, hodiny, mýto, sazby, varianta, zákazník).
type Leg = { km: string; h: string; toll: string; from: string }
type Form = { customer: string; currency: 'EUR' | 'CZK'; variant: string; rate_h: string; rate_km: string; note: string; ho: Leg; pd: Leg; dh: Leg; fixedLabel: string; fixedPrice: string; linkTrip: boolean }

const f = (v: number | string | null | undefined) => (v == null || v === '' ? '' : String(v).replace('.', ','))
const n = (v: string) => { const t = v.replace(/\s/g, '').replace(',', '.'); if (!t) return null; const x = Number(t); return Number.isFinite(x) ? x : undefined }
const hrs = (a: string | null, b: string | null) => (a && b ? Math.round(((Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 36e5) * 4) / 4 : null)

export function RouteSaveDialog({ trip, placeName, similar, composed, onSaved, onClose }: {
  trip: Trip; placeName: (id: string | null) => string
  similar?: { route: Route; why: string }           // „použít X → Y“
  composed?: { ho: LegPick | null; dh: LegPick | null; mid: MidPick | null }
  onSaved: (routeId: string) => void; onClose: () => void
}) {
  const { customers, toast } = useApp()
  const src = similar?.route ?? composed?.ho?.route ?? composed?.dh?.route
  const rep = {   // z reportu: km narůstají (Km Pup, Km Dop, Km celkem), časy po úsecích
    hoKm: trip.km_pup, pdKm: trip.km_pup != null && trip.km_dop != null ? trip.km_dop - trip.km_pup : null, dhKm: trip.km_dop != null && trip.km_total != null ? trip.km_total - trip.km_dop : null,
    hoH: hrs(trip.dep_home, trip.arr_pup), pdH: hrs(trip.dep_pup, trip.arr_dop), dhH: hrs(trip.dep_dop, trip.arr_home),
  }
  const leg = (km: number | null | undefined, h: number | null | undefined, toll: number | null | undefined, from: string, alt?: { km?: number | null; h?: number | null; toll?: number | null; from: string }): Leg =>
    km != null || h != null ? { km: f(km), h: f(h), toll: f(toll), from } : alt && (alt.km != null || alt.h != null) ? { km: f(alt.km), h: f(alt.h), toll: f(alt.toll), from: alt.from } : { km: '', h: '', toll: '', from: '' }
  const hoSrc = similar?.route ?? composed?.ho?.route, dhSrc = similar?.route ?? composed?.dh?.route, pdSrc = similar?.route
  const [form, setForm] = useState<Form>({
    customer: trip.customer ?? src?.customer ?? '', currency: src?.currency ?? 'EUR', variant: '', note: '',
    rate_h: f(src?.rate_h ?? 10), rate_km: f(src?.rate_km ?? 0.28),
    ho: leg(rep.hoKm, rep.hoH, null, 'z reportu', hoSrc ? { km: hoSrc.ho_pup_km, h: hoSrc.ho_pup_h, toll: hoSrc.ho_pup_toll, from: similar ? similar.why : composed?.ho?.why ?? '' } : undefined),
    pd: leg(rep.pdKm, rep.pdH, null, 'z reportu', pdSrc ? { km: pdSrc.pup_dop_km, h: pdSrc.pup_dop_h, toll: pdSrc.pup_dop_toll, from: similar?.why ?? '' } : composed?.mid ? { km: composed.mid.km, h: composed.mid.h, toll: composed.mid.toll, from: 'součet ' + composed.mid.parts.join(' + ') } : undefined),
    dh: leg(rep.dhKm, rep.dhH, null, 'z reportu', dhSrc ? { km: dhSrc.dop_ho_km, h: dhSrc.dop_ho_h, toll: dhSrc.dop_ho_toll, from: similar ? similar.why : composed?.dh?.why ?? '' } : undefined),
    fixedLabel: '', fixedPrice: '', linkTrip: true,
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(cur => ({ ...cur, [k]: v }))
  const setLeg = (k: 'ho' | 'pd' | 'dh', p: Partial<Leg>) => setForm(cur => ({ ...cur, [k]: { ...cur[k], ...p, from: 'upraveno' } }))

  async function save() {
    const vals: Record<string, unknown> = {}
    for (const [k, key] of [['ho', 'ho_pup'], ['pd', 'pup_dop'], ['dh', 'dop_ho']] as const) {
      for (const [fld, col] of [['km', 'km'], ['h', 'h'], ['toll', 'toll']] as const) {
        const v = n(form[k][fld]); if (v === undefined) return toast(`${key} ${col}: pište číslo.`, 'err'); vals[`${key}_${col}`] = v
      }
    }
    const rh = n(form.rate_h), rk = n(form.rate_km)
    if (rh == null || rk == null) return toast('Sazby za hodinu a km musí být čísla.', 'err')
    const fp = n(form.fixedPrice); if (fp === undefined) return toast('Pevná cena musí být číslo.', 'err')
    setSaving(true)
    const { data, error } = await supabase.from('routes').insert({
      ...vals, pup_id: trip.pup_id, dop_id: trip.dop_id, base_from: trip.base_from, base_to: trip.base_to, variant: form.variant.trim(),
      stops: [], customer: form.customer || null, currency: form.currency, rate_h: rh, rate_km: rk, copied_from: src?.id ?? null,
      note: [form.note.trim(), `Uloženo z reportu ${trip.report_no ?? trip.ref_tcs ?? trip.trip_date}`].filter(Boolean).join('. '),
    }).select('id').single()
    setSaving(false)
    if (error || !data) return toast(error?.code === '23505' ? 'Tahle trasa (stejný Pup, Dop, základna, varianta a zákazník) už existuje.' : error?.message ?? 'Chyba', 'err')
    if (fp != null && form.fixedLabel.trim()) await supabase.from('route_prices').insert({ route_id: data.id, label: form.fixedLabel.trim(), price: fp, pup_dop_h: n(form.fixedLabel.replace(/h/i, '')) ?? null, currency: form.currency })
    toast('Trasa uložena do ceníku. Příště se použije sama.')
    onSaved(form.linkTrip ? data.id : '')
  }
  const legRow = (k: 'ho' | 'pd' | 'dh', label: string) => (
    <tr key={k}>
      <td><strong>{label}</strong></td>
      <td><input className="cell time mono" value={form[k].km} onChange={e => setLeg(k, { km: e.target.value })} placeholder="km" /></td>
      <td><input className="cell time mono" value={form[k].h} onChange={e => setLeg(k, { h: e.target.value })} placeholder="h" /></td>
      <td><input className="cell time mono" value={form[k].toll} onChange={e => setLeg(k, { toll: e.target.value })} placeholder="mýto" /></td>
      <td className="quiet small">{form[k].from}</td>
    </tr>
  )
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Uložit trasu">
        <div className="dialoghead"><h2>Uložit trasu na příště: {placeName(trip.pup_id)} → {placeName(trip.dop_id)}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <p className="intro">Předvyplněno z reportu téhle cesty{src ? ` a z trasy ${placeName(src.pup_id)} → ${placeName(src.dop_id)}` : ''}. Upravte, co se má do ceníku uložit (hodiny zaokrouhlené na čtvrthodiny; z reportu bývá lepší vzít km, z podobné trasy mýto). Sloupec vpravo říká, odkud číslo je.</p>
        <div className="formgrid">
          <label>Zákazník<select value={form.customer} onChange={e => set('customer', e.target.value)}><option value="">—</option>{customers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>
          <label>Měna<select value={form.currency} onChange={e => set('currency', e.target.value as Form['currency'])}><option>EUR</option><option>CZK</option></select></label>
          <label title="Sazba za hodinu na jednoho člena posádky">Sazba /h<input type="text" value={form.rate_h} onChange={e => set('rate_h', e.target.value)} /></label>
          <label>Sazba /km<input type="text" value={form.rate_km} onChange={e => set('rate_km', e.target.value)} /></label>
          <label className="span2" title="Prázdné = základní trasa. Vyplňte, když tahle cesta jela jinudy než obvykle (přes Francii, přes Švýcarsko…)">Varianta / poznámka k trase<input type="text" value={form.variant} onChange={e => set('variant', e.target.value)} placeholder="třeba přes Francii" /></label>
          <label className="span2">Poznámka<input type="text" value={form.note} onChange={e => set('note', e.target.value)} placeholder="co je na téhle trase zvláštní" /></label>
          <div className="span4 tablewrap">
            <table className="grid plain sub2">
              <thead><tr><th>Úsek</th><th>km</th><th>h</th><th>mýto</th><th>odkud</th></tr></thead>
              <tbody>{legRow('ho', `${trip.base_from} → PUP`)}{legRow('pd', 'PUP → DOP')}{legRow('dh', `DOP → ${trip.base_to}`)}</tbody>
            </table>
          </div>
          <label title="Nepovinné: pevná cena pro tuhle trasu, název třeba „10 h“">Pevná cena – název<input type="text" value={form.fixedLabel} onChange={e => set('fixedLabel', e.target.value)} placeholder="10 h" /></label>
          <label>Pevná cena – částka<input type="text" value={form.fixedPrice} onChange={e => set('fixedPrice', e.target.value)} placeholder={form.currency === 'CZK' ? 'Kč' : '€'} /></label>
          <label className="checkline span2"><input type="checkbox" checked={form.linkTrip} onChange={e => set('linkTrip', e.target.checked)} /> Použít tuhle trasu i pro tenhle report (cena, navrhované časy)</label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít bez uložení</button>
          <button className="primary" disabled={saving} onClick={save}>{saving ? 'Ukládám…' : 'Uložit do ceníku'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
