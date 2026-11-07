import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, EXTRA_KINDS, type ExtraKind, type HoursExtra, type Trip } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { todayIso } from '../lib/format'
import { dmyOf } from '../lib/service'
import { fmtH } from '../lib/hours'

// Hodiny navíc (domluvené): vyzvednutí auta, auto do servisu, čekání… Kdo má právo Hodiny, uloží rovnou schválené;
// kdo má jen „Návrhy hodin“, zadá návrh a správce hodin ho v Hodinách schválí.
export const STATUS_LABEL: Record<HoursExtra['status'], string> = { navrzeno: 'navrženo', schvaleno: 'schváleno', zamitnuto: 'zamítnuto' }

export function ExtraHoursDialog({ trip, person, onClose, onSaved }: { trip?: Trip | null; person?: string | null; onClose: () => void; onSaved?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Hodiny navíc">
        <div className="dialoghead"><h2>Hodiny navíc{trip ? ` · ${dmyOf(trip.trip_date)} ${trip.trip_time?.slice(0, 5) ?? ''}` : ''}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <ExtraHoursPanel trip={trip} person={person} onSaved={onSaved} />
        <div className="dialogfoot"><button className="link" onClick={onClose}>Zavřít</button></div>
      </div>
    </div>, document.body)
}

export function ExtraHoursPanel({ trip, person, onSaved }: { trip?: Trip | null; person?: string | null; onSaved?: () => void }) {
  const { level, people, session, toast } = useApp()
  const canApprove = level('hours') === 'write'
  const [f, setF] = useState({ person: person ?? trip?.guard1_id ?? '', date: trip?.trip_date ?? todayIso(), kind: 'vyzvednuti' as ExtraKind, hours: '', note: '' })
  const [mine, setMine] = useState<HoursExtra[]>([])
  const [busy, setBusy] = useState(false)
  const loadMine = () => { if (!session) return; supabase.from('hours_extra').select('*').eq('created_by', session.user.id).order('created_at', { ascending: false }).limit(30).then(({ data }) => setMine((data as HoursExtra[]) ?? [])) }
  useEffect(loadMine, [session]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => people.find(p => p.id === id)?.short_name ?? '?'

  async function save() {
    const h = Number(f.hours.replace(',', '.'))
    if (!f.person || !f.date || !Number.isFinite(h) || h <= 0) return toast('Vyplňte člověka, datum a hodiny.', 'err')
    setBusy(true)
    const { error } = await supabase.from('hours_extra').insert({ person_id: f.person, work_date: f.date, kind: f.kind, hours: h, note: f.note.trim() || null, trip_id: trip?.id ?? null, status: canApprove ? 'schvaleno' : 'navrzeno' })
    setBusy(false)
    if (error) return toast(explain(error), 'err')
    toast(canApprove ? 'Hodiny uloženy.' : 'Návrh uložen – čeká na schválení.')
    setF({ ...f, hours: '', note: '' }); loadMine(); onSaved?.()
  }
  async function remove(e: HoursExtra) {
    if (!window.confirm('Smazat tenhle návrh?')) return
    const { error } = await supabase.from('hours_extra').delete().eq('id', e.id)
    if (error) return toast(explain(error), 'err')
    loadMine(); onSaved?.()
  }
  return (
    <div>
        <p className="quiet small">{canApprove ? 'Uloží se rovnou jako schválené a započítají do hodin.' : 'Uloží se jako návrh; do hodin se započítá, až ho správce hodin schválí. Svoje návrhy a jejich stav vidíte níže.'}</p>
        <div className="formgrid">
          <label>Člověk<select value={f.person} onChange={e => setF({ ...f, person: e.target.value })}><option value="">— vyberte —</option>{people.filter(p => p.active || p.id === f.person).map(p => <option key={p.id} value={p.id}>{p.short_name}</option>)}</select></label>
          <label>Datum<input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
          <label>Druh<select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value as ExtraKind })}>{EXTRA_KINDS.map(k => <option key={k.key} value={k.key} title={k.hint}>{k.label}</option>)}</select></label>
          <label>Hodiny<input className="mono" value={f.hours} onChange={e => setF({ ...f, hours: e.target.value })} placeholder="2,5" /></label>
          <label className="span4">Poznámka<input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="třeba: vyzvednutí auta v Praze před cestou, domluveno se Štěpánem" /></label>
        </div>
        <p><button className="primary" disabled={busy} onClick={save}>{canApprove ? 'Uložit' : 'Odeslat návrh'}</button></p>
        {mine.length > 0 && (
          <div className="tablewrap">
            <table className="grid plain sub2">
              <thead><tr><th>Datum</th><th>Člověk</th><th>Druh</th><th className="num">Hodiny</th><th>Poznámka</th><th>Stav</th><th /></tr></thead>
              <tbody>
                {mine.map(e => (
                  <tr key={e.id} className={e.status === 'navrzeno' ? 'proposed' : e.status === 'zamitnuto' ? 'inactive' : undefined}>
                    <td>{dmyOf(e.work_date)}</td><td>{name(e.person_id)}</td><td>{EXTRA_KINDS.find(k => k.key === e.kind)?.label}</td><td className="num">{fmtH(Number(e.hours))}</td>
                    <td className="quiet">{e.note}</td>
                    <td>{STATUS_LABEL[e.status]}{e.decision_note ? <span className="quiet small"> · {e.decision_note}</span> : ''}</td>
                    <td>{e.status === 'navrzeno' && <button className="ghost" title="Smazat návrh" onClick={() => remove(e)}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// Samostatná stránka pro ty, kdo mají jen právo navrhovat
export function ProposalsPage() {
  return (
    <section className="list">
      <div className="toolbar"><h1>Návrhy hodin</h1></div>
      <p className="intro">Domluvené hodiny nad rámec reportu (vyzvednutí auta, auto do servisu, čekání…). Návrh schvaluje správce hodin; do hodin se započítá až po schválení.</p>
      <div className="card"><ExtraHoursPanel /></div>
    </section>
  )
}
