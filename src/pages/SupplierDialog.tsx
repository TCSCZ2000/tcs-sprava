import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, SUPPLIER_OWN, type Supplier, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'

// Dodavatel u cesty (z Reportů): kdo dodal jednotlivé členy posádky (výchozí podle člověka, většinou SEMS)
// a jestli je auto od dodavatele; pak se mu platí km (výchozí Km celkem z reportu) a mýto (výchozí Mýto z reportu).
export function SupplierDialog({ trip, onSave, onClose }: { trip: Trip; onSave: (patch: Partial<Trip>) => Promise<void> | void; onClose: () => void }) {
  const { people, suppliers } = useApp()
  const [g, setG] = useState({ 1: trip.guard1_supplier ?? '', 2: trip.guard2_supplier ?? '', 3: trip.guard3_supplier ?? '' })
  const [car, setCar] = useState(trip.car_supplier ?? '')
  const [km, setKm] = useState(trip.supplier_km?.toString() ?? trip.km_total?.toString() ?? '')
  const [toll, setToll] = useState(trip.supplier_toll?.toString().replace('.', ',') ?? trip.toll?.toString().replace('.', ',') ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const active = suppliers.filter(s => s.active)
  const slots = ([[1, trip.guard1_id], [2, trip.guard2_id], [3, trip.guard3_id]] as const).filter(([, id]) => id)
  const person = (id: string | null) => people.find(p => p.id === id)
  const num = (v: string) => { const t = v.replace(/\s/g, '').replace(',', '.'); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : undefined }

  async function save() {
    const k = num(km), t = num(toll)
    if (car && (k === undefined || t === undefined)) return
    setSaving(true)
    await onSave({
      guard1_supplier: g[1] || null, guard2_supplier: g[2] || null, guard3_supplier: g[3] || null,
      car_supplier: car || null, supplier_km: car ? k : null, supplier_toll: car ? t : null,
    })
    setSaving(false); onClose()
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Dodavatel">
        <div className="dialoghead"><h2>Dodavatel – {trip.ref_tcs ?? trip.report_no ?? trip.trip_date}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <p className="intro">Většinu lidí dodává SEMS (platí se hodiny). Když je tahle cesta výjimka, přepněte dodavatele u konkrétního člověka; když je auto od dodavatele, platí se mu km a mýto.</p>
        <div className="formgrid">
          {slots.map(([n, id]) => {
            const p = person(id)
            return (
              <label key={n} className="span2">Guard {n}: {p?.short_name}
                <select value={g[n]} onChange={e => setG({ ...g, [n]: e.target.value })}>
                  <option value="">podle člověka ({p?.supplier ?? SUPPLIER_OWN})</option>
                  {active.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              </label>
            )
          })}
          <label className="span2">Auto
            <select value={car} onChange={e => setCar(e.target.value)}>
              <option value="">TCS / půjčovna (nic se dodavateli neplatí)</option>
              {active.filter(s => s.name !== SUPPLIER_OWN).map(s => <option key={s.name} value={s.name}>auto od: {s.name}{s.rate_km ? ` (${s.rate_km} Kč/km)` : ''}</option>)}
            </select>
          </label>
          {car && <>
            <label>Km dodavateli<input type="text" value={km} onChange={e => setKm(e.target.value)} placeholder={trip.km_total?.toString() ?? 'km'} /></label>
            <label>Mýto dodavateli<input type="text" value={toll} onChange={e => setToll(e.target.value)} placeholder={trip.toll?.toString() ?? '0'} /></label>
            <p className="quiet small span4">Předvyplněno z reportu (Km celkem, Mýto). Km a hodiny dodáváte vy, dodavatel případně rozporuje, tak sem napište, na čem jste se shodli.</p>
          </>}
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít bez uložení</button>
          <button className="primary" disabled={saving} onClick={save}>{saving ? 'Ukládám…' : 'Uložit'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Souhrn dodavatelů u cesty pro buňku v Reportech: jen odchylky od standardu
export function supplierSummary(t: Trip, personBy: Map<string, { supplier: string | null; short_name: string }>): string[] {
  const out: string[] = []
  for (const [id, s] of [[t.guard1_id, t.guard1_supplier], [t.guard2_id, t.guard2_supplier], [t.guard3_id, t.guard3_supplier]] as const) {
    if (id && s && s !== (personBy.get(id)?.supplier ?? SUPPLIER_OWN)) out.push(`${personBy.get(id)?.short_name ?? '?'}: ${s}`)
  }
  if (t.car_supplier) out.push(`auto od ${t.car_supplier}${t.supplier_km != null ? `, ${t.supplier_km} km` : ''}${t.supplier_toll ? `, mýto ${t.supplier_toll}` : ''}`)
  return out
}

// Správa číselníku dodavatelů (v Lidech)
export function SuppliersPanel() {
  const { suppliers, level, toast, reloadLists } = useApp()
  const canEdit = level('people') === 'write'
  async function patch(s: Supplier, p: Partial<Supplier>) {
    const { error } = await supabase.from('suppliers').update(p).eq('name', s.name)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const name = window.prompt('Název dodavatele')?.trim()
    if (!name) return
    const { error } = await supabase.from('suppliers').insert({ name, sort: 10 })
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const numIn = (s: Supplier, k: 'rate_h' | 'rate_km') => (
    <input className="cell time mono" defaultValue={s[k]?.toString() ?? ''} key={k + s[k]} disabled={!canEdit}
      onBlur={e => { const v = e.target.value.replace(',', '.').trim(); if (v === (s[k]?.toString() ?? '')) return; if (v && isNaN(Number(v))) return toast('Sazbu pište jako číslo.', 'err'); patch(s, { [k]: v ? Number(v) : null }) }} />
  )
  return (
    <div className="catpanel">
      <p className="intro">Dodavatelé posádek. <strong>SEMS</strong> je výchozí u lidí (platí se jen hodiny), <strong>TCS</strong> znamená vlastní. Dodavatel, který dává i auto, má sazbu za km; u cesty se mu pak v Reportech zapíšou km a mýto. Sazby jsou jen pro vyúčtování v Hodinách.</p>
      <table className="grid plain catgrid">
        <thead><tr><th>Dodavatel</th><th>Dává auto</th><th className="num">Kč/h</th><th className="num">Kč/km</th><th>Poznámka</th><th>Aktivní</th></tr></thead>
        <tbody>
          {suppliers.map(s => (
            <tr key={s.name}>
              <td><span className="ro"><strong>{s.name}</strong></span></td>
              <td className="mid"><input type="checkbox" disabled={!canEdit || s.name === SUPPLIER_OWN} checked={s.provides_car} onChange={e => patch(s, { provides_car: e.target.checked })} /></td>
              <td className="num">{numIn(s, 'rate_h')}</td><td className="num">{numIn(s, 'rate_km')}</td>
              <td><input className="cell wide" defaultValue={s.note ?? ''} key={'n' + s.note} disabled={!canEdit} onBlur={e => e.target.value !== (s.note ?? '') && patch(s, { note: e.target.value.trim() || null })} /></td>
              <td className="mid"><input type="checkbox" disabled={!canEdit || s.name === SUPPLIER_OWN || s.name === 'SEMS'} checked={s.active} onChange={e => patch(s, { active: e.target.checked })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {canEdit && <p><button className="link" onClick={add}>Přidat dodavatele</button></p>}
    </div>
  )
}
