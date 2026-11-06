import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, NO_SUPPLIER, supplierLabel, type Trip, type TripCrew } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { fmtDT, parseDT } from '../lib/format'
import { fmtH, round2 } from '../lib/hours'

// Posádka a hodiny u jedné cesty: každý člověk má od–do z reportu, nebo vlastní (střídání), případně hodiny napřímo;
// u náhradníka navíc auto a km (a dodavatel, když není SEMS). Cena pro zákazníka se tím nemění.
const ms = (v: string) => Date.parse(v.replace(' ', 'T'))
type Row = { person: string; inPlan: boolean; ov: TripCrew | null }

export function CrewDialog({ trip: t, canEdit, onClose }: { trip: Trip; canEdit: boolean; onClose: () => void }) {
  const { people, cars, suppliers, crewOf, toast } = useApp()
  const [adding, setAdding] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const ovs = crewOf(t.id)
  const guards = [t.guard1_id, t.guard2_id, t.guard3_id].filter((x): x is string => !!x)
  const rows: Row[] = [...guards.map(p => ({ person: p, inPlan: true, ov: ovs.find(o => o.person_id === p) ?? null })),
    ...ovs.filter(o => !guards.includes(o.person_id)).map(o => ({ person: o.person_id, inPlan: false, ov: o }))]
  const name = (id: string) => people.find(p => p.id === id)?.short_name ?? '?'
  const num = (v: string) => { const s = v.replace(/\s/g, '').replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : undefined }

  async function upsert(person: string, patch: Partial<TripCrew>) {
    const cur = ovs.find(o => o.person_id === person)
    const { error } = cur
      ? await supabase.from('trip_crew').update(patch).eq('id', cur.id)
      : await supabase.from('trip_crew').insert({ trip_id: t.id, person_id: person, ...patch })
    if (error) toast(explain(error), 'err')
  }
  async function clear(r: Row) {
    if (!r.ov) return
    if (!window.confirm(r.inPlan ? `Zrušit vlastní údaje u ${name(r.person)} (bude mít časy jako cesta)?` : `Odebrat ${name(r.person)} z cesty?`)) return
    const { error } = await supabase.from('trip_crew').delete().eq('id', r.ov.id)
    if (error) toast(explain(error), 'err')
  }
  const hoursOf = (r: Row) => {
    if (r.ov?.hours != null) return Number(r.ov.hours)
    if (t.hours_manual != null && !r.ov) return Number(t.hours_manual)
    const a = r.ov?.start_at ?? t.dep_home, b = r.ov?.end_at ?? t.arr_home
    return a && b ? round2((ms(b) - ms(a)) / 36e5) : null
  }
  const base = `${t.trip_date}T00:00:00`
  const timeField = (r: Row, k: 'start_at' | 'end_at') => {
    const fallback = k === 'start_at' ? t.dep_home : t.arr_home
    const v = r.ov?.[k] ?? null
    return (
      <input className="cell time" defaultValue={fmtDT(v)} key={k + v} disabled={!canEdit} placeholder={fallback ? fmtDT(fallback) : '–'} title="Prázdné = jako cesta. Pište 14:00 nebo 14. 10. 14:00"
        onBlur={e => {
          if (e.target.value === fmtDT(v)) return
          if (!e.target.value.trim()) return upsert(r.person, { [k]: null })
          const p = parseDT(e.target.value, (k === 'end_at' ? (r.ov?.start_at ?? t.dep_home) ?? base : base).replace(' ', 'T'), k === 'end_at')
          if (p === undefined) return toast('Čas zapište jako 14:00 nebo 14. 10. 14:00.', 'err')
          upsert(r.person, { [k]: p })
        }} />
    )
  }
  const candidates = people.filter(p => p.active && !rows.some(r => r.person === p.id)).sort((a, b) => a.short_name.localeCompare(b.short_name, 'cs'))

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label="Posádka a hodiny">
        <div className="dialoghead"><h2>Posádka a hodiny · {t.trip_date.split('-').reverse().join('. ')} {t.trip_time?.slice(0, 5) ?? ''}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <p className="quiet small">Cesta: odjezd {fmtDT(t.dep_home) || '–'} → příjezd {fmtDT(t.arr_home) || '–'}{t.hours_manual != null ? ` · hodiny ručně ${fmtH(Number(t.hours_manual))}` : ''}. Vyplňte jen, co se u člověka liší – ostatní zůstane podle cesty. Cena pro zákazníka se nemění, jen hodiny lidí (a km u náhradníka).</p>
        <div className="tablewrap">
          <table className="grid plain sub2 crewgrid">
            <thead><tr><th>Člověk</th><th>Od</th><th>Do</th><th className="num">Hodiny</th><th>Auto</th><th className="num">Km</th><th>Dodavatel</th><th>Poznámka</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.person} className={r.ov ? 'proposed' : undefined}>
                  <td className="nowrap"><strong>{name(r.person)}</strong>{!r.inPlan && <span className="suptag" title="Není v posádce v Planningu – náhradník">náhradník</span>}</td>
                  <td>{timeField(r, 'start_at')}</td>
                  <td>{timeField(r, 'end_at')}</td>
                  <td className="num"><input className="cell mono short" defaultValue={r.ov?.hours != null ? String(r.ov.hours).replace('.', ',') : ''} key={'h' + r.ov?.hours} disabled={!canEdit} placeholder={fmtH(hoursOf(r)) || '–'} title="Hodiny napřímo (přebijí od–do)"
                    onBlur={e => { const n = num(e.target.value); if (n === undefined) return toast('Hodiny jako číslo.', 'err'); if (n !== (r.ov?.hours ?? null)) upsert(r.person, { hours: n }) }} /></td>
                  <td><select className="cell" value={r.ov?.car_id ?? ''} disabled={!canEdit} onChange={e => upsert(r.person, { car_id: e.target.value || null })}><option value="">{r.inPlan ? 'jako cesta' : '—'}</option>{cars.map(c => <option key={c.id} value={c.id}>{c.plate ?? c.car_no}</option>)}</select></td>
                  <td className="num"><input className="cell mono short" defaultValue={r.ov?.km?.toString() ?? ''} key={'k' + r.ov?.km} disabled={!canEdit} title="Km, které tenhle člověk najel navíc (třeba cesta náhradníka na místo střídání)"
                    onBlur={e => { const n = num(e.target.value); if (n === undefined) return toast('Km jako číslo.', 'err'); if (n !== (r.ov?.km ?? null)) upsert(r.person, { km: n == null ? null : Math.round(n) }) }} /></td>
                  <td><select className="cell" value={r.ov?.supplier ?? ''} disabled={!canEdit} onChange={e => upsert(r.person, { supplier: e.target.value || null })}><option value="">{supplierLabel(people.find(p => p.id === r.person)?.supplier ?? NO_SUPPLIER)} (výchozí)</option>{suppliers.filter(s => s.active).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}</select></td>
                  <td><input className="cell wide" defaultValue={r.ov?.note ?? ''} key={'n' + r.ov?.note} disabled={!canEdit} placeholder="vystřídán v Liège…" onBlur={e => e.target.value !== (r.ov?.note ?? '') && upsert(r.person, { note: e.target.value.trim() || null })} /></td>
                  <td>{canEdit && r.ov && <button className="ghost" title={r.inPlan ? 'Zrušit vlastní údaje' : 'Odebrat z cesty'} onClick={() => clear(r)}>×</button>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="quiet">Cesta nemá posádku.</td></tr>}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <p className="newroute"><strong>Přidat náhradníka:</strong>
            <select value={adding} onChange={e => setAdding(e.target.value)}><option value="">— vyberte člověka —</option>{candidates.map(p => <option key={p.id} value={p.id}>{p.short_name}</option>)}</select>
            <button className="link" disabled={!adding} onClick={() => { upsert(adding, {}); setAdding('') }}>přidat</button>
            <span className="quiet small">pak mu doplňte od–do, auto a km</span>
          </p>
        )}
        <div className="dialogfoot"><button className="link" onClick={onClose}>Zavřít</button></div>
      </div>
    </div>, document.body)
}

// Krátký souhrn pro buňku posádky: „střídání“ / „+ náhradník“
export function crewSummary(ovs: TripCrew[], guards: (string | null)[], nameOf: (id: string) => string): string[] {
  const out: string[] = []
  for (const o of ovs) {
    if (!guards.includes(o.person_id)) out.push(`+ ${nameOf(o.person_id)}`)
    else if (o.start_at || o.end_at || o.hours != null) out.push(`${nameOf(o.person_id)}: ${o.hours != null ? fmtH(Number(o.hours)) + ' h' : [o.start_at ? 'od ' + fmtDT(o.start_at) : '', o.end_at ? 'do ' + fmtDT(o.end_at) : ''].filter(Boolean).join(' ')}`)
  }
  return out
}
