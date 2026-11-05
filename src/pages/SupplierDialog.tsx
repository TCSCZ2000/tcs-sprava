import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supplierLabel, type Trip } from '../lib/supabase'
import { useApp } from '../lib/data'

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
                  <option value="">podle člověka ({supplierLabel(p?.supplier)})</option>
                  {active.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
              </label>
            )
          })}
          <label className="span2">Auto
            <select value={car} onChange={e => setCar(e.target.value)}>
              <option value="">TCS / půjčovna (nic se dodavateli neplatí)</option>
              {active.map(s => <option key={s.name} value={s.name}>auto od: {s.name}{s.rate_km ? ` (${s.rate_km} Kč/km)` : ''}</option>)}
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
    if (id && s && s !== (personBy.get(id)?.supplier ?? '')) out.push(`${personBy.get(id)?.short_name ?? '?'}: ${s}`)
  }
  if (t.car_supplier) out.push(`auto od ${t.car_supplier}${t.supplier_km != null ? `, ${t.supplier_km} km` : ''}${t.supplier_toll ? `, mýto ${t.supplier_toll}` : ''}`)
  return out
}

