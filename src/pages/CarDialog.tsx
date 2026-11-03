import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type Car } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { OWN_STATES, RENTAL_STATES } from '../lib/cars'
import { STAGE_LABEL, dmyOf, fmtCzk, fmtKm, serviceStatus, type CarKm, type CarService, type ServiceGroup, type WorkKind } from '../lib/service'
import { todayIso } from '../lib/format'

export interface CarFile { id: string; car_id: string; kind: string; name: string; path: string; size: number | null; valid_to: string | null; uploaded_at: string }
export interface CarCard { id: string; car_id: string; provider: string; number: string | null; valid_to: string | null; note: string | null; has_pin?: boolean }

const FILE_KINDS = ['Zelená karta', 'Technický průkaz', 'Faktura', 'Foto', 'Pojistka', 'Jiné']
const TABS = [['zaklad', 'Základ'], ['servis', 'Servis'], ['km', 'Stav km'], ['soubory', 'Soubory'], ['karty', 'Tankovací karty']] as const
type Tab = typeof TABS[number][0]

export function CarDialog({ car, records, kms, groups, kinds, onClose, onChanged }: {
  car: Car; records: CarService[]; kms: CarKm[]; groups: ServiceGroup[]; kinds: WorkKind[]
  onClose: () => void; onChanged: () => void
}) {
  const { level, carCategories, toast, reloadLists } = useApp()
  const canEdit = level('cars') === 'write'
  const canPins = level('cars_pins') !== 'none'
  const isAdmin = level('users') === 'write'
  const [tab, setTab] = useState<Tab>('zaklad')
  const st = useMemo(() => serviceStatus(car, records, kms, groups, kinds), [car, records, kms, groups, kinds])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(patch: Partial<Car>) {
    const { error } = await supabase.from('cars').update(patch).eq('id', car.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const kind = carCategories.find(k => k.name === car.car_category)?.kind
  const title = `${car.plate ?? car.car_no ?? 'Auto'}${car.model ? ', ' + car.model : ''}${car.car_no && car.plate ? ' · ' + car.car_no : ''}`

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label={title}>
        <div className="dialoghead">
          <h2>{title}</h2>
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
          <button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button>
        </div>

        {tab === 'zaklad' && (
          <div className="formgrid">
            <Fld label="SPZ" car={car} k="plate" can={canEdit} save={save} upper />
            <Fld label="Model" car={car} k="model" can={canEdit} save={save} />
            <Fld label="Barva" car={car} k="color" can={canEdit} save={save} />
            <F label="Kategorie"><select value={car.car_category ?? ''} disabled={!canEdit} onChange={e => save({ car_category: e.target.value || null })}><option value="">—</option>{carCategories.map(x => <option key={x.name}>{x.name}</option>)}</select></F>
            <F label="Stav"><select value={car.state ?? ''} disabled={!canEdit} onChange={e => save({ state: e.target.value || null })}>{(kind === 'rental' ? RENTAL_STATES : OWN_STATES).map(x => <option key={x}>{x}</option>)}</select></F>
            <Fld label="VIN" car={car} k="vin" can={canEdit} save={save} upper />
            <Fld label="Rok výroby" car={car} k="year" can={canEdit} save={save} num />
            <Fld label="Třída" car={car} k="category" can={canEdit} save={save} />
            <Fld label="Datum pořízení" car={car} k="purchase_date" can={canEdit} save={save} type="date" />
            <Fld label="Pořizovací cena (Kč)" car={car} k="purchase_price" can={canEdit} save={save} num />
            <Fld label="Km při pořízení" car={car} k="purchase_km" can={canEdit} save={save} num />
            <F label="Najeto od pořízení"><span className="ro">{st.kmMax != null && car.purchase_km != null ? fmtKm(st.kmMax - car.purchase_km) : '–'}</span></F>
            <F label="GPS platforma"><select value={car.gps_platform ?? ''} disabled={!canEdit} onChange={e => save({ gps_platform: (e.target.value || null) as Car['gps_platform'] })}><option value="">—</option><option>GpsGate</option><option>RexGPS</option></select></F>
            <Fld label="GPS jednotka" car={car} k="gps" can={canEdit} save={save} />
            <Fld label="LOC" car={car} k="loc" can={canEdit} save={save} />
            <Fld label="Pojišťovna" car={car} k="insurer" can={canEdit} save={save} />
            <Fld label="STK do" car={car} k="stk_until" can={canEdit} save={save} type="date" />
            <Fld label="Dálniční známka CZ do" car={car} k="vignette_until" can={canEdit} save={save} type="date" />
            <Fld label="Pneu (rozměr)" car={car} k="tyres" can={canEdit} save={save} />
            <F label="Servisní skupina" title="Určuje intervaly: malý servis, velký každý N., rozvody"><select value={car.service_group ?? ''} disabled={!canEdit} onChange={e => save({ service_group: e.target.value || null })}><option value="">—</option>{groups.map(g => <option key={g.name}>{g.name}</option>)}</select></F>
            <F label="Servis u"><select value={car.service_at ?? ''} disabled={!canEdit} onChange={e => save({ service_at: e.target.value || null })}><option value="">—</option><option>TCS</option><option>dealer</option></select></F>
            <F label="Poznámka" className="span4"><textarea rows={2} defaultValue={car.note ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (car.note ?? '') && save({ note: e.target.value.trim() || null })} /></F>
          </div>
        )}

        {tab === 'servis' && <ServiceTab car={car} st={st} records={records} kinds={kinds} canEdit={canEdit} onChanged={onChanged} />}
        {tab === 'km' && <KmTab car={car} kms={kms} canEdit={canEdit} onChanged={onChanged} />}
        {tab === 'soubory' && <FilesTab car={car} canEdit={canEdit} />}
        {tab === 'karty' && <CardsTab car={car} canEdit={canEdit} canPins={canPins} isAdmin={isAdmin} />}
      </div>
    </div>,
    document.body,
  )
}

function F({ label, children, className, title }: { label: string; children: React.ReactNode; className?: string; title?: string }) {
  return <label className={className} title={title}>{label}{children}</label>
}
function Fld({ label, car, k, can, save, type, num, upper }: { label: string; car: Car; k: keyof Car; can: boolean; save: (p: Partial<Car>) => void; type?: string; num?: boolean; upper?: boolean }) {
  const cur = car[k] == null ? '' : String(car[k])
  return (
    <label>{label}
      <input type={type ?? 'text'} defaultValue={cur} disabled={!can} key={k + cur}
        onBlur={e => {
          let v: string | number | null = e.target.value.trim()
          if (upper) v = v.toUpperCase()
          if (v === cur) return
          if (num) { if (v && !/^[\d\s.,]+$/.test(v)) return; v = v ? Number(v.replace(/\s/g, '').replace(',', '.')) : null } else v = v || null
          save({ [k]: v } as Partial<Car>)
        }} />
    </label>
  )
}

// ---------- Servis ----------
function ServiceTab({ car, st, records, kinds, canEdit, onChanged }: { car: Car; st: ReturnType<typeof serviceStatus>; records: CarService[]; kinds: WorkKind[]; canEdit: boolean; onChanged: () => void }) {
  const { toast } = useApp()
  const rec = records.filter(r => r.car_id === car.id).sort((a, b) => b.done_on.localeCompare(a.done_on) || (b.km ?? 0) - (a.km ?? 0))
  const [form, setForm] = useState<{ done_on: string; km: string; kind: string; shop: string; price_net: string; doc_no: string; note: string } | null>(null)
  async function add() {
    if (!form) return
    const km = form.km.replace(/\s/g, '')
    if (!form.done_on || !form.kind) return toast('Vyplňte datum a druh práce.', 'err')
    if (km && !/^\d+$/.test(km)) return toast('Km pište jako celé číslo.', 'err')
    const pn = form.price_net.replace(/\s/g, '').replace(',', '.')
    const { error } = await supabase.from('car_service').insert({ car_id: car.id, done_on: form.done_on, km: km ? Number(km) : null, kind: form.kind, shop: form.shop.trim() || null, price_net: pn ? Number(pn) : null, doc_no: form.doc_no.trim() || null, note: form.note.trim() || null, source: 'ručně' })
    if (error) return toast(explain(error), 'err')
    setForm(null); onChanged()
  }
  async function remove(r: CarService) {
    if (!window.confirm(`Smazat záznam ${dmyOf(r.done_on)} ${r.kind}?`)) return
    const { error } = await supabase.from('car_service').delete().eq('id', r.id)
    if (error) return toast(explain(error), 'err')
    onChanged()
  }
  async function patch(r: CarService, p: Partial<CarService>) {
    const { error } = await supabase.from('car_service').update(p).eq('id', r.id)
    if (error) toast(explain(error), 'err'); else onChanged()
  }
  const years = Object.keys(st.costYear).sort().reverse()
  return (
    <div className="svctab">
      <div className="svcstatus">
        <div><span className="lbl">Stav km</span><strong>{fmtKm(st.kmMax) || '–'}</strong><span className="quiet small"> {st.kmAt ? dmyOf(st.kmAt) : ''}</span></div>
        <div><span className="lbl">Poslední servis</span><strong>{st.lastService ? `${fmtKm(st.lastService.km)} · ${st.lastService.kind}` : '–'}</strong><span className="quiet small"> {st.lastService ? dmyOf(st.lastService.done_on) : ''}</span></div>
        <div><span className="lbl">Další servis</span><strong className={st.stage ? 'st-' + st.stage : ''}>{st.nextKm != null ? `${fmtKm(st.nextKm)} (${st.nextKind})` : st.group ? 'chybí historie servisů' : 'chybí servisní skupina'}</strong>
          {st.left != null && <span className={'small st-' + st.stage}> zbývá {st.left.toLocaleString('cs-CZ')} km · {STAGE_LABEL[st.stage!]}</span>}</div>
        <div><span className="lbl">Rozvody</span><strong className={st.timingStage && st.timingStage !== 'none' ? 'st-' + st.timingStage : ''}>{st.timingStage === 'none' ? 'nehlídá se' : st.timingNextKm != null ? `další ${fmtKm(st.timingNextKm)}` : '–'}</strong>
          {st.timingLeft != null && <span className="small quiet"> zbývá {st.timingLeft.toLocaleString('cs-CZ')} km{st.lastTiming ? `, poslední ${fmtKm(st.lastTiming.km)}` : ''}</span>}</div>
        <div><span className="lbl">Brzdy</span><span className="small">přední {st.brakesFront ? `${dmyOf(st.brakesFront.done_on)}${st.brakesFront.km ? ', ' + fmtKm(st.brakesFront.km) : ''}` : 'bez záznamu'} · zadní {st.brakesRear ? `${dmyOf(st.brakesRear.done_on)}${st.brakesRear.km ? ', ' + fmtKm(st.brakesRear.km) : ''}` : 'bez záznamu'}</span></div>
        <div><span className="lbl">Přezutí</span><span className="small">přední {st.tyresFront ? `${dmyOf(st.tyresFront.done_on)}${st.tyresFront.km ? ', ' + fmtKm(st.tyresFront.km) : ''}` : 'bez záznamu'} · zadní {st.tyresRear ? `${dmyOf(st.tyresRear.done_on)}${st.tyresRear.km ? ', ' + fmtKm(st.tyresRear.km) : ''}` : 'bez záznamu'}</span></div>
        <div><span className="lbl">Servisní náklady (bez DPH)</span><strong>{fmtCzk(st.costTotal)}</strong><span className="small quiet"> {years.map(y => `${y}: ${fmtCzk(st.costYear[y])}`).join(' · ')}</span>
          {rec.some(r => r.price_net == null) && <span className="small quiet"> · {rec.filter(r => r.price_net == null).length} záznamů bez ceny</span>}</div>
      </div>

      <div className="svctools">
        <span className="count">{rec.length} záznamů</span>
        {canEdit && !form && <button className="primary small" onClick={() => setForm({ done_on: todayIso(), km: st.kmMax?.toString() ?? '', kind: 'Malý servis', shop: 'Koník (Hlavsa)', price_net: '', doc_no: '', note: '' })}>Přidat záznam</button>}
      </div>
      {form && (
        <div className="newroute">
          <input type="date" value={form.done_on} onChange={e => setForm({ ...form, done_on: e.target.value })} />
          <input className="search" style={{ minWidth: '6rem', flex: '0 0 7rem' }} placeholder="km" value={form.km} onChange={e => setForm({ ...form, km: e.target.value })} />
          <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>{kinds.map(k => <option key={k.name}>{k.name}</option>)}</select>
          <input className="search" style={{ minWidth: '8rem', flex: '0 1 10rem' }} placeholder="dílna" value={form.shop} onChange={e => setForm({ ...form, shop: e.target.value })} />
          <input className="search" style={{ minWidth: '6rem', flex: '0 0 7rem' }} placeholder="cena bez DPH" value={form.price_net} onChange={e => setForm({ ...form, price_net: e.target.value })} />
          <input className="search" style={{ minWidth: '6rem', flex: '0 0 8rem' }} placeholder="č. dokladu" value={form.doc_no} onChange={e => setForm({ ...form, doc_no: e.target.value })} />
          <input className="search" placeholder="poznámka" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} />
          <button className="primary" onClick={add}>Uložit</button><button className="link" onClick={() => setForm(null)}>Zrušit</button>
        </div>
      )}
      <div className="tablewrap">
        <table className="grid plain sub2">
          <thead><tr><th>Datum</th><th className="num">Km</th><th>Druh práce</th><th>Dílna</th><th className="num">Bez DPH</th><th>Doklad</th><th>Poznámka</th><th>Zdroj</th><th /></tr></thead>
          <tbody>
            {rec.map(r => (
              <tr key={r.id}>
                <td>{dmyOf(r.done_on)}</td>
                <td className="num"><Inl value={r.km?.toString() ?? ''} can={canEdit} onSave={v => { const n = v.replace(/\s/g, ''); if (n && !/^\d+$/.test(n)) return toast('Km pište jako celé číslo.', 'err'); patch(r, { km: n ? Number(n) : null }) }} /></td>
                <td>{canEdit ? <select value={r.kind} onChange={e => patch(r, { kind: e.target.value })}>{kinds.map(k => <option key={k.name}>{k.name}</option>)}</select> : r.kind}</td>
                <td><Inl value={r.shop ?? ''} can={canEdit} onSave={v => patch(r, { shop: v.trim() || null })} /></td>
                <td className="num"><Inl value={r.price_net?.toString() ?? ''} can={canEdit} onSave={v => { const n = v.replace(/\s/g, '').replace(',', '.'); if (n && isNaN(Number(n))) return toast('Cenu pište jako číslo.', 'err'); patch(r, { price_net: n ? Number(n) : null }) }} /></td>
                <td><Inl value={r.doc_no ?? ''} can={canEdit} onSave={v => patch(r, { doc_no: v.trim() || null })} /></td>
                <td><Inl value={r.note ?? ''} can={canEdit} wide onSave={v => patch(r, { note: v.trim() || null })} /></td>
                <td className="quiet small">{r.source}</td>
                <td>{canEdit && <button className="ghost" aria-label="Smazat" onClick={() => remove(r)}>×</button>}</td>
              </tr>
            ))}
            {rec.length === 0 && <tr><td colSpan={9} className="quiet">Zatím žádný záznam.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- Stav km ----------
function KmTab({ car, kms, canEdit, onChanged }: { car: Car; kms: CarKm[]; canEdit: boolean; onChanged: () => void }) {
  const { toast } = useApp()
  const rows = kms.filter(k => k.car_id === car.id).sort((a, b) => b.at.localeCompare(a.at))
  const [v, setV] = useState('')
  async function add() {
    const n = v.replace(/\s/g, '')
    if (!/^\d+$/.test(n)) return toast('Km pište jako celé číslo.', 'err')
    const last = rows[0]
    if (last && Number(n) < last.km && !window.confirm(`Zapsaný stav ${Number(n).toLocaleString('cs-CZ')} km je nižší než poslední ${last.km.toLocaleString('cs-CZ')} km. Zapsat i tak?`)) return
    const { error } = await supabase.from('car_km').insert({ car_id: car.id, at: new Date().toISOString().slice(0, 19), km: Number(n), source: 'ručně' })
    if (error) return toast(explain(error), 'err')
    await supabase.from('cars').update({ km_current: Math.max(Number(n), car.km_current ?? 0), km_updated: todayIso() }).eq('id', car.id)
    setV(''); onChanged()
  }
  async function remove(k: CarKm) {
    if (!window.confirm(`Smazat odečet ${k.km.toLocaleString('cs-CZ')} km z ${dmyOf(k.at)}?`)) return
    const { error } = await supabase.from('car_km').delete().eq('id', k.id)
    if (error) return toast(explain(error), 'err')
    onChanged()
  }
  return (
    <div>
      {canEdit && <div className="newroute"><strong>Nový odečet:</strong><input className="search" style={{ minWidth: '7rem', flex: '0 0 8rem' }} placeholder="km" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} /><button className="primary" onClick={add}>Zapsat</button><span className="quiet small">Odečty z fotek tachometru přidává bot v Telegramu; tady zapíšete ruční.</span></div>}
      <div className="tablewrap">
        <table className="grid plain sub2">
          <thead><tr><th>Datum a čas</th><th className="num">Km</th><th>Zdroj</th><th>Posádka</th><th>Poznámka</th><th /></tr></thead>
          <tbody>
            {rows.map(k => (
              <tr key={k.id}>
                <td>{dmyOf(k.at)} {k.at.slice(11, 16)}</td><td className="num"><strong>{k.km.toLocaleString('cs-CZ')}</strong></td>
                <td className="quiet">{k.source}</td><td className="quiet">{k.crew}</td>
                <td className="quiet small">{k.link ? <a href={k.link} target="_blank" rel="noreferrer">fotka</a> : null} {k.note}</td>
                <td>{canEdit && <button className="ghost" aria-label="Smazat" onClick={() => remove(k)}>×</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="quiet">Zatím žádný odečet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- Soubory ----------
function FilesTab({ car, canEdit }: { car: Car; canEdit: boolean }) {
  const { toast } = useApp()
  const [files, setFiles] = useState<CarFile[]>([])
  const [kind, setKind] = useState(FILE_KINDS[0])
  const [busy, setBusy] = useState(false)
  const load = () => supabase.from('car_files').select('*').eq('car_id', car.id).order('uploaded_at', { ascending: false }).then(({ data }) => setFiles((data as CarFile[]) ?? []))
  useEffect(() => { load() }, [car.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function upload(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: soubor je větší než 25 MB.`, 'err'); continue }
      const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const path = `${car.id}/${Date.now()}_${safe}`
      const up = await supabase.storage.from('car-files').upload(path, f, { contentType: f.type || undefined })
      if (up.error) { toast(`${f.name}: ${up.error.message}`, 'err'); continue }
      const { error } = await supabase.from('car_files').insert({ car_id: car.id, kind, name: f.name, path, size: f.size })
      if (error) toast(explain(error), 'err')
    }
    setBusy(false); load()
  }
  async function open(f: CarFile) {
    const { data, error } = await supabase.storage.from('car-files').createSignedUrl(f.path, 300)
    if (error || !data) return toast('Soubor se nepodařilo otevřít.', 'err')
    window.open(data.signedUrl, '_blank')
  }
  async function remove(f: CarFile) {
    if (!window.confirm(`Smazat ${f.name}?`)) return
    await supabase.storage.from('car-files').remove([f.path])
    const { error } = await supabase.from('car_files').delete().eq('id', f.id)
    if (error) toast(explain(error), 'err'); else load()
  }
  async function patch(f: CarFile, p: Partial<CarFile>) {
    const { error } = await supabase.from('car_files').update(p).eq('id', f.id)
    if (error) toast(explain(error), 'err'); else load()
  }
  return (
    <div>
      {canEdit && (
        <div className="newroute">
          <strong>Nahrát:</strong>
          <select value={kind} onChange={e => setKind(e.target.value)}>{FILE_KINDS.map(k => <option key={k}>{k}</option>)}</select>
          <input type="file" multiple disabled={busy} onChange={e => upload(e.target.files)} />
          <span className="quiet small">PDF, fotky, do 25 MB. Zelená karta a TP mívají platnost, tu pak doplňte v řádku.</span>
        </div>
      )}
      <div className="tablewrap">
        <table className="grid plain sub2">
          <thead><tr><th>Druh</th><th>Soubor</th><th>Platí do</th><th>Nahráno</th><th className="num">Velikost</th><th /></tr></thead>
          <tbody>
            {files.map(f => (
              <tr key={f.id}>
                <td>{canEdit ? <select value={f.kind} onChange={e => patch(f, { kind: e.target.value })}>{[...new Set([...FILE_KINDS, f.kind])].map(k => <option key={k}>{k}</option>)}</select> : f.kind}</td>
                <td><button className="link" onClick={() => open(f)}>{f.name}</button></td>
                <td><input type="date" defaultValue={f.valid_to ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (f.valid_to ?? '') && patch(f, { valid_to: e.target.value || null })} /></td>
                <td className="quiet">{dmyOf(f.uploaded_at)}</td>
                <td className="num quiet">{f.size ? (f.size / 1024 / 1024 >= 1 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : Math.round(f.size / 1024) + ' kB') : ''}</td>
                <td>{canEdit && <button className="ghost" aria-label="Smazat" onClick={() => remove(f)}>×</button>}</td>
              </tr>
            ))}
            {files.length === 0 && <tr><td colSpan={6} className="quiet">Zatím žádný soubor.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------- Tankovací karty a PINy ----------
function CardsTab({ car, canEdit, canPins, isAdmin }: { car: Car; canEdit: boolean; canPins: boolean; isAdmin: boolean }) {
  const { toast } = useApp()
  const [cards, setCards] = useState<CarCard[]>([])
  const [status, setStatus] = useState<{ configured: boolean; has_key: boolean } | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({})
  const load = async () => {
    const { data } = await supabase.from('car_cards').select('id,car_id,provider,number,valid_to,note').eq('car_id', car.id).order('provider')
    setCards((data as CarCard[]) ?? [])
    if (canPins) { const s = await supabase.rpc('pins_status'); const row = (s.data as { configured: boolean; has_key: boolean }[] | null)?.[0]; setStatus(row ?? null) }
  }
  useEffect(() => { load() }, [car.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const providers = ['UTA', 'DKV']
  async function ensure(provider: string) {
    const { data, error } = await supabase.from('car_cards').insert({ car_id: car.id, provider }).select('id,car_id,provider,number,valid_to,note').single()
    if (error) { toast(explain(error), 'err'); return null }
    await load(); return data as CarCard
  }
  async function patch(c: CarCard, p: Partial<CarCard>) {
    const { error } = await supabase.from('car_cards').update(p).eq('id', c.id)
    if (error) toast(explain(error), 'err'); else load()
  }
  async function reveal(c: CarCard) {
    const pw = window.prompt(`Heslo k PINům (karta ${c.provider})`)
    if (!pw) return
    const { data, error } = await supabase.rpc('pins_reveal', { p_card: c.id, p_password: pw })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    if (!data) return toast('U téhle karty PIN není uložený.', 'err')
    setShown(s => ({ ...s, [c.id]: data as string }))
    setTimeout(() => setShown(s => { const n = { ...s }; delete n[c.id]; return n }), 20000)
  }
  async function setPin(c: CarCard) {
    const pin = window.prompt(`Nový PIN karty ${c.provider} (prázdné = smazat)`)
    if (pin === null) return
    const pw = window.prompt('Vaše heslo k PINům')
    if (!pw) return
    const { error } = await supabase.rpc('pins_set', { p_card: c.id, p_pin: pin.trim(), p_password: pw })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    toast('PIN uložen.')
  }
  async function setup() {
    const pw = window.prompt('Zvolte heslo k PINům (aspoň 6 znaků). Nikde se neukládá, bez něj PINy nejdou přečíst.')
    if (!pw) return
    if (window.prompt('Zadejte heslo ještě jednou') !== pw) return toast('Hesla se neshodují.', 'err')
    const { error } = await supabase.rpc('pins_setup', { p_password: pw })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    toast('Heslo k PINům nastaveno. Dalším lidem dáte přístup v Uživatelích.'); load()
  }
  async function changePw() {
    const o = window.prompt('Současné heslo k PINům'); if (!o) return
    const n = window.prompt('Nové heslo k PINům (aspoň 6 znaků)'); if (!n) return
    const { error } = await supabase.rpc('pins_change_password', { p_old: o, p_new: n })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    toast('Heslo k PINům změněno.')
  }
  return (
    <div>
      <p className="intro">Číslo karty vidí každý, kdo vidí auta. PIN je zašifrovaný a ukáže se jen po zadání vašeho hesla k PINům, na 20 vteřin; každé zobrazení se zapisuje.</p>
      {canPins && status && !status.configured && isAdmin && <p className="warn">PINy ještě nejsou nastavené. <button className="link" onClick={setup}>Nastavit heslo k PINům</button></p>}
      {canPins && status && status.configured && !status.has_key && <p className="warn">Nemáte přístup k PINům. Správce vám ho dá v Uživatelích.</p>}
      {canPins && status?.has_key && <p className="quiet small"><button className="link small" onClick={changePw}>Změnit moje heslo k PINům</button></p>}
      <div className="tablewrap">
        <table className="grid plain sub2">
          <thead><tr><th>Karta</th><th>Číslo</th><th>Platí do</th><th>Poznámka</th><th>PIN</th></tr></thead>
          <tbody>
            {providers.map(p => {
              const c = cards.find(x => x.provider === p)
              return (
                <tr key={p}>
                  <td><strong>{p}</strong></td>
                  <td>{c ? <Inl value={c.number ?? ''} can={canEdit} onSave={v => patch(c, { number: v.trim() || null })} /> : canEdit && <button className="link small" onClick={() => ensure(p)}>přidat kartu</button>}</td>
                  <td>{c && <input type="date" defaultValue={c.valid_to ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (c.valid_to ?? '') && patch(c, { valid_to: e.target.value || null })} />}</td>
                  <td>{c && <Inl value={c.note ?? ''} can={canEdit} wide onSave={v => patch(c, { note: v.trim() || null })} />}</td>
                  <td className="nowrap">
                    {c && canPins && status?.has_key && (shown[c.id]
                      ? <strong className="pinshow">{shown[c.id]}</strong>
                      : <><button className="link small" onClick={() => reveal(c)}>Zobrazit PIN</button>{canEdit && <> <button className="link small quiet" onClick={() => setPin(c)}>změnit</button></>}</>)}
                    {c && !canPins && <span className="quiet small">bez přístupu</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Inl({ value, can, onSave, wide }: { value: string; can: boolean; onSave: (v: string) => void; wide?: boolean }) {
  return <input className={'cell' + (wide ? ' wide' : '')} defaultValue={value} key={value} disabled={!can} onBlur={e => e.target.value !== value && onSave(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}
