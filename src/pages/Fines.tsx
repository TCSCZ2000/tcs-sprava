import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { exportXlsx, printPdf } from '../lib/export'
import { dmyOf } from '../lib/service'
import { fmtDT, todayIso } from '../lib/format'
import { usePref } from './Plan'

// Pokuty: dávky převzatých obálek / datovky, jednotlivé pokuty spárované s autem, cestou a posádkou, stav vyřízení a potvrzení.
// Čtení skenů a potvrzení dělá serverová funkce fines-parse (Claude); člověk potvrdí.
export interface FineBatch { id: string; received_on: string; channel: 'posta' | 'datovka' | 'jine'; handed_to: string | null; handed_on: string | null; note: string | null; created_at: string }
export interface Fine {
  id: string; batch_id: string | null; status: FineStatus; country: string | null; authority: string | null; case_no: string | null; offense_at: string | null; place: string | null
  plate: string | null; car_id: string | null; trip_id: string | null; person_id: string | null; offense: string | null; amount: number | null; currency: string | null
  due_pay: string | null; due_driver: string | null; payment_iban: string | null; payment_ref: string | null; phase: 'doprovod' | 'presun' | 'mimo' | null; liability: 'TCS' | 'SEMS' | null
  paid_on: string | null; paid_amount: number | null; paid_ok: boolean | null; driver_reported_on: string | null; reported_ok: boolean | null
  parse_status: 'navrzeno' | 'potvrzeno' | null; parsed: unknown; note: string | null; created_at: string; updated_at: string
}
export interface FineFile { id: string; fine_id: string | null; batch_id: string | null; kind: 'sken' | 'pokuta' | 'platba' | 'nahlaseni' | 'jine'; path: string; file_name: string | null; mime: string | null; size: number | null; pages: string | null; parsed: unknown; parse_note: string | null; uploaded_at: string }
export type FineStatus = 'nova' | 'predano' | 'zaplaceno' | 'ridic_nahlasen' | 'odvolani' | 'uzavreno' | 'neni_pokuta'
export const STATUS_LABEL: Record<FineStatus, string> = { nova: 'nová', predano: 'předáno SEMS', zaplaceno: 'zaplaceno', ridic_nahlasen: 'řidič nahlášen', odvolani: 'odvolání', uzavreno: 'uzavřeno', neni_pokuta: 'není pokuta' }
const OPEN: FineStatus[] = ['nova', 'predano', 'odvolani']
const CHANNEL: Record<string, string> = { posta: 'pošta', datovka: 'datovka', jine: 'jiné' }
const PHASE: Record<string, string> = { doprovod: 'během doprovodu', presun: 'při přesunu', mimo: 'mimo cestu' }
type Cand = { trip_id: string; trip_date: string; report_no: number | null; customer: string | null; pup: string; dop: string; guard1: string | null; guard2: string | null; dep_home: string | null; arr_pup: string | null; dep_dop: string | null; arr_home: string | null; phase: string | null }

const dueState = (d: string | null) => { if (!d) return ''; const days = Math.round((Date.parse(d) - Date.now()) / 864e5); return days < 0 ? 'expired' : days <= 7 ? 'soon' : '' }
const money = (v: number | null, cur: string | null) => (v == null ? '' : v.toLocaleString('cs-CZ') + ' ' + (cur === 'CZK' ? 'Kč' : cur === 'CHF' ? 'CHF' : cur === 'PLN' ? 'zł' : '€'))

export default function Fines() {
  const { level, cars, people, toast } = useApp()
  const canEdit = level('fines') === 'write'
  const [batches, setBatches] = useState<FineBatch[]>([])
  const [fines, setFines] = useState<Fine[]>([])
  const [files, setFiles] = useState<FineFile[]>([])
  const [onlyOpen, setOnlyOpen] = usePref<'1' | '0'>('fines.open', '1')
  const [batchFilter, setBatchFilter] = useState('')
  const [q, setQ] = useState('')
  const [newBatch, setNewBatch] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [b, f, fl] = await Promise.all([
      supabase.from('fine_batches').select('*').order('received_on', { ascending: false }),
      supabase.from('fines').select('*').order('offense_at', { ascending: false }),
      supabase.from('fine_files').select('*').order('uploaded_at'),
    ])
    if (f.error) toast(explain(f.error), 'err')
    setBatches((b.data as FineBatch[]) ?? []); setFines((f.data as Fine[]) ?? []); setFiles((fl.data as FineFile[]) ?? [])
  }, [toast])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const ch = supabase.channel('fines').on('postgres_changes', { event: '*', schema: 'public', table: 'fines' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fine_files' }, () => load()).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const carBy = useMemo(() => new Map(cars.map(c => [c.id, c])), [cars])
  const personBy = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const batchBy = useMemo(() => new Map(batches.map(b => [b.id, b])), [batches])
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const rows = useMemo(() => fines.filter(f => (onlyOpen === '0' || OPEN.includes(f.status)) && (!batchFilter || f.batch_id === batchFilter))
    .filter(f => { if (!q.trim()) return true; const hay = fold([f.country, f.authority, f.case_no, f.place, f.plate, carBy.get(f.car_id ?? '')?.plate, f.offense, personBy.get(f.person_id ?? '')?.short_name, f.note].filter(Boolean).join(' ')); return q.trim().toLowerCase().split(/\s+/).every(w => hay.includes(fold(w))) }), [fines, onlyOpen, batchFilter, q, carBy, personBy])

  async function save(f: Fine, patch: Partial<Fine>) {
    setFines(cur => cur.map(x => (x.id === f.id ? { ...x, ...patch } : x)))
    const { error } = await supabase.from('fines').update(patch).eq('id', f.id)
    if (error) { toast(explain(error), 'err'); load() }
  }
  async function parseBatch(batchId: string) {
    setBusy(batchId)
    const { data, error } = await supabase.functions.invoke('fines-parse', { body: { action: 'batch', batch_id: batchId } })
    setBusy(null)
    if (error) return toast('Čtení se nezdařilo: ' + (error.message ?? ''), 'err')
    if (data?.error) return toast(data.error, 'err')
    toast(`Přečteno: ${data.created} dokumentů${data.errors?.length ? `, chyby: ${data.errors.join('; ')}` : ''}.`)
    load()
  }
  const unparsed = (batchId: string) => files.filter(x => x.batch_id === batchId && x.kind === 'sken' && !x.parsed).length

  function excel() {
    const head = ['Přijato', 'Došlo', 'Země', 'Úřad', 'Č. j.', 'Přestupek dne', 'Místo', 'SPZ', 'Auto', 'Cesta', 'Řidič', 'Fáze', 'Přestupek', 'Částka', 'Měna', 'Lhůta platby', 'Lhůta řidič', 'Stav', 'K tíži', 'Zaplaceno', 'Platba OK', 'Řidič nahlášen', 'Poznámka']
    const body = rows.map(f => { const b = batchBy.get(f.batch_id ?? ''); const c = carBy.get(f.car_id ?? ''); return [b?.received_on ?? '', b ? CHANNEL[b.channel] : '', f.country, f.authority, f.case_no, f.offense_at ? fmtDT(f.offense_at) : '', f.place, f.plate, c?.plate ?? '', f.trip_id ? 'ano' : '', personBy.get(f.person_id ?? '')?.short_name ?? '', f.phase ? PHASE[f.phase] : '', f.offense, f.amount, f.currency, f.due_pay, f.due_driver, STATUS_LABEL[f.status], f.liability, f.paid_on, f.paid_ok == null ? '' : f.paid_ok ? 'ano' : 'NE', f.driver_reported_on, f.note] })
    exportXlsx(`Pokuty_${todayIso()}.xlsx`, [{ name: 'Pokuty', rows: [head, ...body], widths: [10, 8, 5, 24, 16, 15, 20, 9, 9, 6, 12, 14, 28, 8, 6, 11, 11, 14, 7, 10, 8, 12, 30] }])
  }

  const openFine = openId ? fines.find(f => f.id === openId) : null
  const totalOpen = fines.filter(f => OPEN.includes(f.status)).length
  const overdue = fines.filter(f => OPEN.includes(f.status) && (dueState(f.due_pay) === 'expired' || dueState(f.due_driver) === 'expired')).length
  return (
    <section className="plan fines">
      <div className="toolbar">
        <h1>Pokuty <span className="count">{totalOpen} otevřených{overdue ? ` · ${overdue} po lhůtě` : ''}</span></h1>
        {canEdit && <button className="primary" onClick={() => setNewBatch(true)}>Nová dávka</button>}
        <input className="search" placeholder="Hledat (SPZ, úřad, č. j., člověk…)" value={q} onChange={e => setQ(e.target.value)} />
        <select value={batchFilter} onChange={e => setBatchFilter(e.target.value)}><option value="">všechny dávky</option>{batches.map(b => <option key={b.id} value={b.id}>{dmyOf(b.received_on)} · {CHANNEL[b.channel]}{b.note ? ` · ${b.note}` : ''}</option>)}</select>
        <label className="check"><input type="checkbox" checked={onlyOpen === '1'} onChange={e => setOnlyOpen(e.target.checked ? '1' : '0')} />jen otevřené</label>
        <button className="ghostbtn" onClick={excel}>Excel</button>
        <button className="ghostbtn" onClick={printPdf}>Tisk / PDF</button>
      </div>
      <p className="intro">Obálky prožeňte skenerem do jednoho PDF (nebo stáhněte PDF z datovky) a založte dávku s datem převzetí. Aplikace sken rozdělí na jednotlivé pokuty, přečte je a spáruje s autem, cestou a posádkou (údaje jsou „navržené“, potvrďte je v detailu). SEMS pak nahraje potvrzení o platbě nebo o nahlášení řidiče; aplikace je porovná s pokutou a lhůtou. Dávka slouží jako kontrola, že nic nezapadlo.</p>

      {batches.length > 0 && (
        <div className="batches">
          {batches.slice(0, 8).map(b => {
            const bf = fines.filter(f => f.batch_id === b.id && f.status !== 'neni_pokuta')
            const byC = new Map<string, number>(); for (const f of bf) byC.set(f.country ?? '?', (byC.get(f.country ?? '?') ?? 0) + 1)
            const open = bf.filter(f => OPEN.includes(f.status)).length
            const np = unparsed(b.id)
            return (
              <button key={b.id} className={'batchcard' + (batchFilter === b.id ? ' on' : '')} onClick={() => setBatchFilter(batchFilter === b.id ? '' : b.id)}>
                <strong>{dmyOf(b.received_on)}</strong> <span className="quiet">{CHANNEL[b.channel]}{b.handed_on ? ` · předáno ${b.handed_to ?? ''} ${dmyOf(b.handed_on)}` : ''}</span><br />
                {bf.length ? <>{[...byC].map(([c, n]) => `${n}× ${c}`).join(', ')} · <span className={open ? 'missingtxt' : 'quiet'}>{open ? `${open} otevřených` : 'vše vyřízeno'}</span></> : <span className="quiet">zatím žádné pokuty</span>}
                {np > 0 && canEdit && <> · <span className="link" onClick={e => { e.stopPropagation(); parseBatch(b.id) }}>{busy === b.id ? 'čtu…' : `přečíst ${np} ${np === 1 ? 'sken' : 'skeny'}`}</span></>}
              </button>
            )
          })}
        </div>
      )}

      <div className="tablewrap">
        <table className="grid dense finesgrid">
          <thead><tr><th className="w-dots" /><th>Přijato</th><th>Země</th><th>Úřad</th><th>Č. j.</th><th>Přestupek dne</th><th>Místo</th><th>SPZ / auto</th><th>Cesta</th><th>Řidič</th><th>Fáze</th><th>Přestupek</th><th className="num">Částka</th><th>Lhůta</th><th>Stav</th><th>K tíži</th><th>Poznámka</th></tr></thead>
          <tbody>
            {rows.map(f => {
              const b = batchBy.get(f.batch_id ?? ''); const c = carBy.get(f.car_id ?? '')
              const due = [f.due_pay, f.due_driver].filter(Boolean).sort()[0] ?? null
              const st = OPEN.includes(f.status) ? dueState(due) : ''
              return (
                <tr key={f.id} className={(f.parse_status === 'navrzeno' ? 'proposed ' : '') + (f.status === 'neni_pokuta' ? 'inactive' : '')}>
                  <td className="w-dots"><button className="ghost dots" aria-label="Detail pokuty" onClick={() => setOpenId(f.id)}>⋯</button></td>
                  <td className="nowrap">{b ? dmyOf(b.received_on) : ''}</td>
                  <td><strong>{f.country}</strong></td>
                  <td className="wrapcell">{f.authority}</td>
                  <td className="mono">{f.case_no}</td>
                  <td className="nowrap">{f.offense_at ? fmtDT(f.offense_at) : ''}</td>
                  <td className="wrapcell">{f.place}</td>
                  <td className="nowrap">{c ? c.plate : <span className="missingtxt" title="SPZ nesedí na žádné auto">{f.plate ?? '?'}</span>}</td>
                  <td className="nowrap">{f.trip_id ? <span className="quiet">spárováno</span> : <span className="missingtxt">nespárováno</span>}</td>
                  <td>{personBy.get(f.person_id ?? '')?.short_name ?? ''}</td>
                  <td className="nowrap">{f.phase ? PHASE[f.phase] : ''}</td>
                  <td className="wrapcell">{f.offense}</td>
                  <td className="num nowrap">{money(f.amount, f.currency)}</td>
                  <td className={'nowrap ' + st}>{due ? dmyOf(due) : ''}</td>
                  <td className="nowrap">{STATUS_LABEL[f.status]}{f.paid_ok === false && <span className="missingtxt"> ✗ platba</span>}{f.reported_ok === false && <span className="missingtxt"> ✗ nahlášení</span>}{f.parse_status === 'navrzeno' && <span className="badge soon">navrženo</span>}</td>
                  <td>{f.liability ?? ''}</td>
                  <td className="wrapcell quiet">{f.note}</td>
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={17} className="quiet">{fines.length ? 'Nic k zobrazení (zkuste vypnout „jen otevřené“).' : 'Zatím žádná pokuta. Začněte tlačítkem Nová dávka.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {newBatch && <BatchDialog onClose={() => setNewBatch(false)} onCreated={id => { setNewBatch(false); load(); parseBatch(id) }} />}
      {openFine && <FineDialog fine={openFine} files={files.filter(x => x.fine_id === openFine.id)} batch={batchBy.get(openFine.batch_id ?? '')} canEdit={canEdit} save={p => save(openFine, p)} reload={load} onClose={() => setOpenId(null)} />}
    </section>
  )
}

// ---------- Nová dávka ----------
function BatchDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ received_on: todayIso(), channel: 'posta', handed_to: 'SEMS', handed_on: todayIso(), note: '' })
  const [list, setList] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  async function create() {
    if (!list.length) return toast('Přidejte aspoň jeden sken nebo PDF.', 'err')
    setBusy(true)
    const { data, error } = await supabase.from('fine_batches').insert({ received_on: f.received_on, channel: f.channel, handed_to: f.handed_to || null, handed_on: f.handed_on || null, note: f.note.trim() || null }).select('id').single()
    if (error || !data) { setBusy(false); return toast(explain(error), 'err') }
    for (const file of list) {
      const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const path = `${data.id}/${Date.now()}_${safe}`
      const up = await supabase.storage.from('fines').upload(path, file, { contentType: file.type || undefined })
      if (up.error) { toast(`${file.name}: ${up.error.message}`, 'err'); continue }
      await supabase.from('fine_files').insert({ batch_id: data.id, kind: 'sken', path, file_name: file.name, mime: file.type || null, size: file.size })
    }
    setBusy(false); onCreated(data.id)
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Nová dávka pokut">
        <div className="dialoghead"><h2>Nová dávka pokut</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <div className="formgrid">
          <label>Převzato<input type="date" value={f.received_on} onChange={e => setF({ ...f, received_on: e.target.value })} /></label>
          <label>Došlo<select value={f.channel} onChange={e => setF({ ...f, channel: e.target.value })}><option value="posta">pošta</option><option value="datovka">datovka</option><option value="jine">jiné</option></select></label>
          <label>Předáno komu<input type="text" value={f.handed_to} onChange={e => setF({ ...f, handed_to: e.target.value })} /></label>
          <label>Předáno kdy<input type="date" value={f.handed_on} onChange={e => setF({ ...f, handed_on: e.target.value })} /></label>
          <label className="span4">Poznámka<input type="text" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="třeba: 8× DE, 1× F, 3× BE" /></label>
          <label className="span4">Skeny / PDF<input type="file" multiple accept="application/pdf,image/*" onChange={e => setList(Array.from(e.target.files ?? []))} />
            <span className="quiet small">Jeden vícestránkový PDF z průjezdového skeneru stačí; aplikace ho rozdělí. Z datovky nahrajte stažené přílohy. Do 50 MB na soubor.</span></label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose} disabled={busy}>Zavřít</button>
          <button className="primary" disabled={busy} onClick={create}>{busy ? 'Nahrávám…' : 'Založit a přečíst'}</button>
        </div>
      </div>
    </div>, document.body)
}

// ---------- Detail pokuty ----------
function FineDialog({ fine: f, files, batch, canEdit, save, reload, onClose }: { fine: Fine; files: FineFile[]; batch?: FineBatch; canEdit: boolean; save: (p: Partial<Fine>) => void; reload: () => void; onClose: () => void }) {
  const { cars, people, toast } = useApp()
  const [cands, setCands] = useState<Cand[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [proofKind, setProofKind] = useState<'platba' | 'nahlaseni'>('platba')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!f.car_id || !f.offense_at) { setCands([]); return }
    supabase.rpc('fine_candidates', { p_car: f.car_id, p_at: f.offense_at }).then(({ data }) => setCands((data as Cand[]) ?? []))
  }, [f.car_id, f.offense_at])
  const car = cars.find(c => c.id === f.car_id)
  const num = (v: string) => { const s = v.replace(/\s/g, '').replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : undefined }
  const F = ({ label, k, type, span, mono }: { label: string; k: keyof Fine; type?: string; span?: number; mono?: boolean }) => {
    const cur = f[k] == null ? '' : String(f[k])
    return (
      <label className={span ? `span${span}` : undefined}>{label}
        <input type={type ?? 'text'} className={mono ? 'mono' : undefined} defaultValue={type === 'datetime-local' && cur ? cur.slice(0, 16) : cur} key={String(k) + cur} disabled={!canEdit}
          onBlur={e => { const v = e.target.value.trim(); if (v === (type === 'datetime-local' ? cur.slice(0, 16) : cur)) return; if (k === 'amount' || k === 'paid_amount') { const n = num(v); if (n === undefined) return toast('Částku jako číslo.', 'err'); save({ [k]: n } as Partial<Fine>) } else save({ [k]: v || null } as Partial<Fine>) }} />
      </label>
    )
  }
  async function openFile(x: FineFile) {
    const { data, error } = await supabase.storage.from('fines').createSignedUrl(x.path, 300)
    if (error || !data) return toast('Soubor nejde otevřít.', 'err')
    window.open(data.signedUrl, '_blank')
  }
  async function uploadProof(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    for (const file of Array.from(list)) {
      const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const path = `${f.batch_id ?? 'x'}/${f.id}/${Date.now()}_${safe}`
      const up = await supabase.storage.from('fines').upload(path, file, { contentType: file.type || undefined })
      if (up.error) { toast(`${file.name}: ${up.error.message}`, 'err'); continue }
      const { data, error } = await supabase.from('fine_files').insert({ fine_id: f.id, batch_id: f.batch_id, kind: proofKind, path, file_name: file.name, mime: file.type || null, size: file.size }).select('id').single()
      if (error || !data) { toast(explain(error), 'err'); continue }
      const r = await supabase.functions.invoke('fines-parse', { body: { action: 'proof', file_id: data.id } })
      if (r.error || r.data?.error) toast('Potvrzení nahráno, ale kontrola se nezdařila: ' + (r.data?.error ?? r.error?.message ?? ''), 'err')
      else toast(r.data?.result?.ok ? 'Potvrzení sedí.' : 'Potvrzení nesedí: ' + (r.data?.note ?? ''), r.data?.result?.ok ? undefined : 'err')
    }
    setBusy(false); reload()
  }
  async function removeFine() {
    if (!window.confirm('Smazat tuhle pokutu včetně souborů?')) return
    for (const x of files) if (x.kind !== 'sken') await supabase.storage.from('fines').remove([x.path])
    const { error } = await supabase.from('fines').delete().eq('id', f.id)
    if (error) toast(explain(error), 'err'); else { onClose(); reload() }
  }
  const pick = (c: Cand | null) => {
    if (!c) return save({ trip_id: null, person_id: null, phase: 'mimo' })
    const t = people.find(p => p.short_name === c.guard1)
    save({ trip_id: c.trip_id, phase: (c.phase as Fine['phase']) ?? 'mimo', person_id: t?.id ?? f.person_id, liability: c.phase === 'presun' ? 'SEMS' : f.liability })
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog repdialog" role="dialog" aria-label="Pokuta">
        <div className="dialoghead">
          <h2>{f.country ?? '?'} · {f.authority ?? 'pokuta'} · {f.case_no ?? ''} {f.parse_status === 'navrzeno' && <span className="badge soon">navrženo – zkontrolujte</span>}</h2>
          <button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button>
        </div>
        <p className="quiet small">{batch ? `Převzato ${dmyOf(batch.received_on)} (${CHANNEL[batch.channel]})${batch.handed_on ? `, předáno ${batch.handed_to ?? ''} ${dmyOf(batch.handed_on)}` : ''}` : 'Bez dávky'} · založeno {fmtDT(f.created_at)}</p>
        <div className="formgrid">
          <label>Stav<select value={f.status} disabled={!canEdit} onChange={e => save({ status: e.target.value as FineStatus })}>{(Object.keys(STATUS_LABEL) as FineStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
          <label title="Během doprovodu rozhodnete vy; při přesunu jde za SEMS">K tíži<select value={f.liability ?? ''} disabled={!canEdit} onChange={e => save({ liability: (e.target.value || null) as Fine['liability'] })}><option value="">nerozhodnuto</option><option value="TCS">TCS (výkon doprovodu)</option><option value="SEMS">SEMS (nedbalost řidiče)</option></select></label>
          <F label="Země" k="country" /><F label="Č. j." k="case_no" mono />
          <F label="Úřad" k="authority" span={2} /><F label="Přestupek dne a čas" k="offense_at" type="datetime-local" /><F label="Místo" k="place" />
          <F label="Přestupek" k="offense" span={2} /><F label="Částka" k="amount" mono /><F label="Měna" k="currency" />
          <F label="Lhůta zaplacení" k="due_pay" type="date" /><F label="Lhůta nahlášení řidiče" k="due_driver" type="date" /><F label="IBAN" k="payment_iban" mono /><F label="Reference platby" k="payment_ref" mono />

          <div className="span4 repsection"><strong>Auto, cesta, posádka</strong> <span className="quiet small">podle SPZ a času přestupku z reportů</span></div>
          <label>SPZ na pokutě<input className="mono" defaultValue={f.plate ?? ''} key={'pl' + f.plate} disabled={!canEdit} onBlur={e => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v === (f.plate ?? '')) return; const c = cars.find(x => (x.plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === v); save({ plate: v || null, car_id: c?.id ?? f.car_id }) }} /></label>
          <label>Auto<select value={f.car_id ?? ''} disabled={!canEdit} onChange={e => save({ car_id: e.target.value || null, trip_id: null, person_id: null, phase: null })}><option value="">—</option>{cars.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
          <label>Řidič / nahlášený<select value={f.person_id ?? ''} disabled={!canEdit} onChange={e => save({ person_id: e.target.value || null })}><option value="">—</option>{people.filter(p => p.active || p.id === f.person_id).map(p => <option key={p.id} value={p.id}>{p.short_name}</option>)}</select></label>
          <label>Fáze<select value={f.phase ?? ''} disabled={!canEdit} onChange={e => save({ phase: (e.target.value || null) as Fine['phase'] })}><option value="">—</option>{Object.entries(PHASE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <div className="span4">
            {!car && <p className="quiet small">Nejdřív vyberte auto, pak se nabídnou cesty kolem času přestupku.</p>}
            {car && cands && cands.length === 0 && <p className="quiet small">Žádná cesta auta {car.plate} kolem {f.offense_at ? fmtDT(f.offense_at) : '?'} v databázi: nejspíš mimo cestu (přesun bez reportu, servis…).</p>}
            {cands && cands.length > 0 && (
              <table className="grid plain sub2">
                <thead><tr><th /><th>Cesta</th><th>#Report</th><th>Posádka</th><th>Odjezd</th><th>Příjezd Pup</th><th>Odjezd Dop</th><th>Příjezd</th><th>Fáze</th></tr></thead>
                <tbody>
                  {cands.map(c => (
                    <tr key={c.trip_id} className={f.trip_id === c.trip_id ? 'open' : undefined}>
                      <td><input type="radio" name="cand" disabled={!canEdit} checked={f.trip_id === c.trip_id} onChange={() => pick(c)} /></td>
                      <td>{dmyOf(c.trip_date)} {c.customer} {c.pup} → {c.dop}</td><td>{c.report_no}</td><td>{[c.guard1, c.guard2].filter(Boolean).join(', ')}</td>
                      <td>{fmtDT(c.dep_home)}</td><td>{fmtDT(c.arr_pup)}</td><td>{fmtDT(c.dep_dop)}</td><td>{fmtDT(c.arr_home)}</td>
                      <td>{c.phase ? <strong>{PHASE[c.phase]}</strong> : <span className="quiet">mimo časy reportu</span>}</td>
                    </tr>
                  ))}
                  <tr><td><input type="radio" name="cand" disabled={!canEdit} checked={!f.trip_id} onChange={() => pick(null)} /></td><td colSpan={8} className="quiet">žádná z nich (mimo cestu)</td></tr>
                </tbody>
              </table>
            )}
          </div>

          <div className="span4 repsection"><strong>Vyřízení</strong></div>
          <F label="Zaplaceno dne" k="paid_on" type="date" /><F label="Zaplacená částka" k="paid_amount" mono />
          <label>Platba sedí<span className="ro">{f.paid_ok == null ? '–' : f.paid_ok ? '✓ ano' : <span className="missingtxt">✗ ne</span>}</span></label>
          <F label="Řidič nahlášen dne" k="driver_reported_on" type="date" />
          <div className="span4">
            <table className="grid plain sub2">
              <thead><tr><th>Soubor</th><th>Druh</th><th>Výsledek kontroly</th><th>Nahráno</th></tr></thead>
              <tbody>
                {files.map(x => <tr key={x.id}><td><button className="link" onClick={() => openFile(x)}>{x.file_name ?? x.path}</button></td><td>{x.kind}</td><td className={x.parse_note?.startsWith('✗') ? 'missingtxt' : undefined}>{x.parse_note}</td><td className="quiet">{fmtDT(x.uploaded_at)}</td></tr>)}
                {files.length === 0 && <tr><td colSpan={4} className="quiet">Bez souboru.</td></tr>}
              </tbody>
            </table>
            {canEdit && <p className="newroute"><strong>Nahrát potvrzení:</strong> <select value={proofKind} onChange={e => setProofKind(e.target.value as 'platba' | 'nahlaseni')}><option value="platba">o zaplacení</option><option value="nahlaseni">o nahlášení řidiče</option></select> <input type="file" multiple accept="application/pdf,image/*" disabled={busy} onChange={e => uploadProof(e.target.files)} /> <span className="quiet small">aplikace porovná částku, referenci a datum s lhůtou</span></p>}
          </div>
          <label className="span4">Poznámka<textarea rows={2} defaultValue={f.note ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (f.note ?? '') && save({ note: e.target.value.trim() || null })} /></label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít</button>
          {canEdit && <button className="link" onClick={removeFine}>Smazat</button>}
          {canEdit && f.parse_status === 'navrzeno' && <button className="primary" onClick={() => save({ parse_status: 'potvrzeno' })}>Údaje jsou správně</button>}
        </div>
      </div>
    </div>, document.body)
}
