import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type Person, type PersonDoc } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { docState } from '../lib/format'
import { dmyOf } from '../lib/service'

// Detail člověka: základní údaje, doklady (soubor + číslo + platnost), historie cest.
const TABS = [['zaklad', 'Základ'], ['doklady', 'Doklady'], ['cesty', 'Cesty']] as const
type Tab = typeof TABS[number][0]

export function PersonDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const { level, toast, reloadLists, people, suppliers } = useApp()
  const canEdit = level('people') === 'write'
  const seeDocs = level('people_docs') !== 'none'
  const [tab, setTab] = useState<Tab>('zaklad')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(patch: Partial<Person>) {
    const { error } = await supabase.from('people').update(patch).eq('id', person.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const sameShort = people.filter(p => p.id !== person.id && p.short_name === person.short_name)
  const sameName = people.filter(p => p.id !== person.id && p.first_name.toLowerCase() === person.first_name.toLowerCase() && p.last_name.toLowerCase() === person.last_name.toLowerCase())
  const title = `${person.first_name} ${person.last_name}${person.tag ? ` (${person.tag})` : ''}`

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label={title}>
        <div className="dialoghead">
          <h2>{title}{!person.active && <span className="nltag">neaktivní</span>}</h2>
          <div className="tabs">{TABS.filter(([k]) => k !== 'doklady' || seeDocs).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          <button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button>
        </div>

        {tab === 'zaklad' && (
          <div className="formgrid">
            <Fld label="Jméno" p={person} k="first_name" can={canEdit} save={save} required />
            <Fld label="Příjmení" p={person} k="last_name" can={canEdit} save={save} required />
            <Fld label="Rozlišení" p={person} k="tag" can={canEdit} save={save} title="Jen když mají dva lidé stejné jméno i příjmení: město, ročník… Objeví se v závorce ve zkratce." placeholder={sameName.length ? 'třeba město nebo ročník' : ''} />
            <label title="Zkratka do Planningu a reportů. Automaticky: první písmeno jména + příjmení; u stejných příjmení víc písmen (Mat. Rada / Mir. Rada).">V rozpisu
              <span className="inlinerow">
                <input type="text" defaultValue={person.short_name} key={person.short_name + String(person.short_name_auto)} disabled={!canEdit || person.short_name_auto}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== person.short_name) save({ short_name: v }) }} />
                <label className="check small"><input type="checkbox" checked={person.short_name_auto} disabled={!canEdit} onChange={e => save({ short_name_auto: e.target.checked })} />auto</label>
              </span>
            </label>
            {sameShort.length > 0 && <p className="warn span4">Stejnou zkratku „{person.short_name}“ má i {sameShort.map(p => `${p.first_name} ${p.last_name}`).join(', ')}. Doplňte rozlišení, ať se v Planningu nepletou.</p>}
            <Fld label="Telefon" p={person} k="phone" can={canEdit} save={save} />
            <Fld label="E-mail" p={person} k="email" can={canEdit} save={save} type="email" />
            <Fld label="Narozen" p={person} k="birth_date" can={canEdit} save={save} type="date" />
            <Fld label="Národnost" p={person} k="nationality" can={canEdit} save={save} />
            <label title="Kdo člověka dodává (většinou SEMS, platí se hodiny). U jednotlivé cesty jde přepnout v Reportech.">Dodavatel
              <select value={person.supplier ?? ''} disabled={!canEdit} onChange={e => save({ supplier: e.target.value || null })}>
                <option value="">bez dodavatele</option>
                {suppliers.filter(s => s.active || s.name === person.supplier).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
            <label className="checkline"><input type="checkbox" checked={person.active} disabled={!canEdit} onChange={e => save({ active: e.target.checked })} /> Aktivní (nabízí se v Planningu)</label>
            <label className="span4">Poznámka<textarea rows={2} defaultValue={person.note ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (person.note ?? '') && save({ note: e.target.value.trim() || null })} /></label>
          </div>
        )}
        {tab === 'doklady' && seeDocs && <DocsTab person={person} />}
        {tab === 'cesty' && <TripsTab person={person} />}
      </div>
    </div>,
    document.body,
  )
}

function Fld({ label, p, k, can, save, type, required, title, placeholder }: { label: string; p: Person; k: keyof Person; can: boolean; save: (x: Partial<Person>) => void; type?: string; required?: boolean; title?: string; placeholder?: string }) {
  const cur = p[k] == null ? '' : String(p[k])
  return (
    <label title={title}>{label}
      <input type={type ?? 'text'} defaultValue={cur} disabled={!can} key={k + cur} placeholder={placeholder}
        onBlur={e => { const v = e.target.value.trim(); if (v === cur) return; if (required && !v) return; save({ [k]: v || (k === 'tag' ? '' : null) } as Partial<Person>) }} />
    </label>
  )
}

// ---------- Doklady ----------
export const DOC_HINT: Record<string, string> = { op: 'OP', pas: 'pas', rp: 'ŘP', strazny: 'strážný', zbrojni: 'zbrojní', dpp: 'DPP', foto: 'foto', jine: 'jiný', nezarazeno: '?' }

function DocsTab({ person }: { person: Person }) {
  const { level, pdocs, docKinds, toast, reloadLists } = useApp()
  const canEdit = level('people_docs') === 'write'
  const kindSort = (k: string) => docKinds.find(x => x.key === k)?.sort ?? 50
  const kindOf = (k: string) => docKinds.find(x => x.key === k)
  const docs = pdocs.filter(d => d.person_id === person.id).sort((a, b) => kindSort(a.kind) - kindSort(b.kind) || (a.valid_to ?? '').localeCompare(b.valid_to ?? ''))
  const [kind, setKind] = useState('op')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string | null } | null>(null)

  async function upload(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: soubor je větší než 25 MB.`, 'err'); continue }
      const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const path = `${person.id}/${Date.now()}_${safe}`
      const up = await supabase.storage.from('people-files').upload(path, f, { contentType: f.type || undefined })
      if (up.error) { toast(`${f.name}: ${up.error.message}`, 'err'); continue }
      const { error } = await supabase.from('person_documents').insert({ person_id: person.id, kind, path, file_name: f.name, mime: f.type || null, size: f.size, status: 'potvrzeno' })
      if (error) toast(explain(error), 'err')
    }
    setBusy(false); reloadLists()
  }
  async function addNumberOnly() {
    const { error } = await supabase.from('person_documents').insert({ person_id: person.id, kind, status: 'potvrzeno' })
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function open(d: PersonDoc) {
    if (!d.path) return
    const { data, error } = await supabase.storage.from('people-files').createSignedUrl(d.path, 300)
    if (error || !data) return toast('Soubor se nepodařilo otevřít.', 'err')
    const isImg = (d.mime ?? '').startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(d.file_name ?? '')
    if (isImg) setPreview({ url: data.signedUrl, name: d.file_name ?? '', mime: d.mime }); else window.open(data.signedUrl, '_blank')
  }
  async function remove(d: PersonDoc) {
    if (!window.confirm(`Smazat ${d.file_name ?? kindOf(d.kind)?.label ?? 'doklad'}?`)) return
    if (d.path) await supabase.storage.from('people-files').remove([d.path])
    const { error } = await supabase.from('person_documents').delete().eq('id', d.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function patch(d: PersonDoc, p: Partial<PersonDoc>) {
    const { error } = await supabase.from('person_documents').update(p).eq('id', d.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const proposed = docs.filter(d => d.status === 'navrzeno').length
  return (
    <div>
      {canEdit && (
        <div className="newroute">
          <strong>Nahrát:</strong>
          <select value={kind} onChange={e => setKind(e.target.value)}>{docKinds.filter(k => k.key !== 'nezarazeno').map(k => <option key={k.key} value={k.key}>{k.label}</option>)}</select>
          <input type="file" multiple accept="image/*,.pdf,.docx,.doc" disabled={busy} onChange={e => upload(e.target.files)} />
          <button className="link small" onClick={addNumberOnly}>přidat jen číslo bez souboru</button>
          <span className="quiet small">Fotka nebo PDF do 25 MB. Číslo a platnost pak dopište v řádku.</span>
        </div>
      )}
      {proposed > 0 && <p className="warn">{proposed} {proposed === 1 ? 'doklad má' : proposed < 5 ? 'doklady mají' : 'dokladů má'} typ, číslo a platnost jen navržené z fotky. Zkontrolujte a potvrďte, nebo opravte.</p>}
      <div className="tablewrap">
        <table className="grid plain sub2 docs">
          <thead><tr><th>Druh</th><th>Číslo</th><th>Platí do</th><th>Soubor</th><th>Stav</th><th>Poznámka</th><th /></tr></thead>
          <tbody>
            {docs.map(d => {
              const k = kindOf(d.kind); const m = docState(d.valid_to)
              return (
                <tr key={d.id} className={d.status === 'navrzeno' ? 'proposed' : undefined}>
                  <td className="nowrap">
                    {canEdit ? <select value={d.kind} onChange={e => patch(d, { kind: e.target.value })}>{docKinds.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}</select> : k?.label ?? d.kind}
                    {(d.kind === 'jine' || d.kind === 'dpp') && <input className="cell" placeholder="název" defaultValue={d.name ?? ''} key={'n' + d.name} disabled={!canEdit} onBlur={e => e.target.value !== (d.name ?? '') && patch(d, { name: e.target.value.trim() || null })} />}
                  </td>
                  <td>{k?.numbered !== false && <input className="cell mono" defaultValue={d.number ?? ''} key={'c' + d.number} disabled={!canEdit} onBlur={e => e.target.value !== (d.number ?? '') && patch(d, { number: e.target.value.trim() || null })} />}</td>
                  <td className={m ?? undefined}>{k?.expires !== false && <input type="date" defaultValue={d.valid_to ?? ''} key={'v' + d.valid_to} disabled={!canEdit} onBlur={e => e.target.value !== (d.valid_to ?? '') && patch(d, { valid_to: e.target.value || null })} />}</td>
                  <td>{d.path ? <button className="link" onClick={() => open(d)}>{d.file_name}</button> : <span className="quiet small">bez souboru</span>}{d.source === 'drive' && <span className="quiet small"> · z Drive</span>}</td>
                  <td className="nowrap">
                    {d.status === 'navrzeno' && <><span className="badge soon">navrženo</span>{canEdit && <button className="link small" onClick={() => patch(d, { status: 'potvrzeno' })}>potvrdit</button>}</>}
                    {d.status === 'potvrzeno' && d.kind !== 'nezarazeno' && <span className="quiet small">✓</span>}
                    {!d.status && d.kind === 'nezarazeno' && <span className="quiet small">zatím nezařazeno</span>}
                  </td>
                  <td><input className="cell wide" defaultValue={d.note ?? ''} key={'p' + d.note} disabled={!canEdit} onBlur={e => e.target.value !== (d.note ?? '') && patch(d, { note: e.target.value.trim() || null })} /></td>
                  <td>{canEdit && <button className="ghost" aria-label="Smazat" onClick={() => remove(d)}>×</button>}</td>
                </tr>
              )
            })}
            {docs.length === 0 && <tr><td colSpan={7} className="quiet">Zatím žádný doklad.</td></tr>}
          </tbody>
        </table>
      </div>
      {preview && createPortal(
        <div className="overlay lightbox" onMouseDown={() => setPreview(null)}>
          <img src={preview.url} alt={preview.name} />
          <div className="lbbar"><span>{preview.name}</span><a href={preview.url} target="_blank" rel="noreferrer" onMouseDown={e => e.stopPropagation()}>otevřít v novém okně</a><button className="ghost" onClick={() => setPreview(null)}>×</button></div>
        </div>, document.body)}
    </div>
  )
}

// ---------- Cesty ----------
type TripRow = { id: string; trip_date: string; trip_time: string | null; pup_id: string | null; dop_id: string | null; car_id: string | null; status: string | null; report_no: number | null; customer: string | null; guard1_id: string | null; guard2_id: string | null; guard3_id: string | null }
function TripsTab({ person }: { person: Person }) {
  const { places, cars, people } = useApp()
  const [rows, setRows] = useState<TripRow[] | null>(null)
  useEffect(() => {
    supabase.from('trips').select('id,trip_date,trip_time,pup_id,dop_id,car_id,status,report_no,customer,guard1_id,guard2_id,guard3_id')
      .or(`guard1_id.eq.${person.id},guard2_id.eq.${person.id},guard3_id.eq.${person.id}`).order('trip_date', { ascending: false }).limit(300)
      .then(({ data }) => setRows((data as TripRow[]) ?? []))
  }, [person.id])
  const name = (id: string | null) => places.find(p => p.id === id)?.name ?? ''
  const mate = (t: TripRow) => [t.guard1_id, t.guard2_id, t.guard3_id].filter(id => id && id !== person.id).map(id => people.find(p => p.id === id)?.short_name ?? '?').join(', ')
  return (
    <div className="tablewrap">
      <table className="grid plain sub2">
        <thead><tr><th>Datum</th><th>Pup → Dop</th><th>Zákazník</th><th>S kým</th><th>Auto</th><th>Status</th><th>#Report</th></tr></thead>
        <tbody>
          {rows?.map(t => (
            <tr key={t.id}>
              <td className="nowrap">{dmyOf(t.trip_date)} {t.trip_time?.slice(0, 5)}</td>
              <td>{name(t.pup_id)} → {name(t.dop_id)}</td><td>{t.customer}</td><td className="quiet">{mate(t)}</td>
              <td className="quiet">{cars.find(c => c.id === t.car_id)?.label}</td><td>{t.status}</td><td className="quiet">{t.report_no}</td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={7} className="quiet">Žádná cesta v databázi.</td></tr>}
          {!rows && <tr><td colSpan={7} className="quiet">Načítám…</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
