import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type Supplier, type SupplierContact } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { exportXlsx, printPdf } from '../lib/export'
import ListTable, { type Col } from './ListTable'

// Dodavatelé posádek (SEMS, Aleš Knap, …): firemní údaje, kontaktní osoby, sazby. Kdo je čí, se nastavuje u člověka; výjimky u cesty v Reportech.
export default function Suppliers() {
  const { suppliers, people, level, toast, reloadLists } = useApp()
  const canEdit = level('suppliers') === 'write'
  const [open, setOpen] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const rows = useMemo(() => suppliers.filter(s => showInactive || s.active).map(s => ({ ...s, id: s.name })), [suppliers, showInactive])
  const count = (name: string) => people.filter(p => p.supplier === name && p.active).length

  async function save(s: Supplier, patch: Partial<Supplier>) {
    const { error } = await supabase.from('suppliers').update(patch).eq('name', s.name)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const name = window.prompt('Název dodavatele (firma nebo jméno)')?.trim()
    if (!name) return
    const { error } = await supabase.from('suppliers').insert({ name })
    if (error) toast(explain(error), 'err'); else { await reloadLists(); setOpen(name) }
  }
  const num = (v: string) => { const t = v.replace(',', '.').trim(); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : undefined }
  const cols: Col<Supplier & { id: string }>[] = [
    { key: 'name', label: 'Dodavatel', get: r => r.name },
    { key: 'ico', label: 'IČO', get: r => r.ico ?? '', save: (r, v) => save(r, { ico: v.trim() || null }), mono: true },
    { key: 'phone', label: 'Telefon', get: r => r.phone ?? '', save: (r, v) => save(r, { phone: v.trim() || null }), mono: true },
    { key: 'email', label: 'E-mail', get: r => r.email ?? '', save: (r, v) => save(r, { email: v.trim() || null }) },
    { key: 'car', label: 'Dává auto', type: 'check', get: r => String(r.provides_car), save: (r, v) => save(r, { provides_car: v === 'true' }) },
    { key: 'rate_h', label: 'Kč/h', get: r => r.rate_h?.toString() ?? '', save: (r, v) => { const n = num(v); if (n === undefined) return toast('Sazbu pište jako číslo.', 'err'); save(r, { rate_h: n }) }, mono: true },
    { key: 'rate_km', label: 'Kč/km', get: r => r.rate_km?.toString() ?? '', save: (r, v) => { const n = num(v); if (n === undefined) return toast('Sazbu pište jako číslo.', 'err'); save(r, { rate_km: n }) }, mono: true },
    { key: 'people', label: 'Lidí', get: r => String(count(r.name)) },
    { key: 'note', label: 'Poznámka', wide: true, get: r => r.note ?? '', save: (r, v) => save(r, { note: v.trim() || null }) },
    { key: 'active', label: 'Aktivní', type: 'check', get: r => String(r.active), save: (r, v) => save(r, { active: v === 'true' }) },
  ]
  function excel() {
    const head = ['Dodavatel', 'IČO', 'DIČ', 'Adresa', 'Telefon', 'E-mail', 'Web', 'Dává auto', 'Kč/h', 'Kč/km', 'Splatnost', 'Lidí', 'Poznámka', 'Aktivní']
    const body = rows.map(s => [s.name, s.ico ?? '', s.dic ?? '', s.address ?? '', s.phone ?? '', s.email ?? '', s.web ?? '', s.provides_car ? 'ano' : '', s.rate_h ?? '', s.rate_km ?? '', s.payment_terms ?? '', count(s.name), s.note ?? '', s.active ? 'ano' : 'ne'])
    exportXlsx(`Dodavatele_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: 'Dodavatelé', rows: [head, ...body], widths: [18, 10, 12, 30, 16, 24, 20, 9, 7, 7, 12, 6, 30, 7] }])
  }
  return (
    <>
      <ListTable title="Dodavatelé" rows={rows} cols={cols} canEdit={canEdit} onAdd={add} addLabel="Přidat dodavatele"
        search={r => `${r.name} ${r.ico ?? ''} ${r.email ?? ''} ${r.note ?? ''}`}
        lead={r => <button className="ghost dots" title="Detail: firemní údaje, kontakty, lidé" aria-label="Detail dodavatele" onClick={() => setOpen(r.name)}>⋯</button>}
        rowClass={r => (r.active ? undefined : 'inactive')}
        tools={<><button className="link" onClick={excel}>Excel</button><button className="link" onClick={printPdf}>Tisk / PDF</button></>}
        filters={<div className="filterrow"><label className="check"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />I neaktivní</label></div>}
        intro={<>Kdo dodává lidi do posádek. <strong>SEMS</strong> je výchozí u lidí a platí se mu hodiny (viz Hodiny). Dodavatel, který dává i auto, má sazbu za km; u cesty se mu pak v Reportech zapíšou km a mýto. Který člověk patří ke kterému dodavateli, je v detailu člověka v Lidech.</>} />
      {open && suppliers.find(s => s.name === open) && <SupplierDetail supplier={suppliers.find(s => s.name === open)!} onClose={() => setOpen(null)} />}
    </>
  )
}

const TABS = [['zaklad', 'Základ'], ['kontakty', 'Kontakty'], ['lide', 'Lidé']] as const
type Tab = typeof TABS[number][0]

function SupplierDetail({ supplier: s, onClose }: { supplier: Supplier; onClose: () => void }) {
  const { level, people, toast, reloadLists } = useApp()
  const canEdit = level('suppliers') === 'write'
  const [tab, setTab] = useState<Tab>('zaklad')
  const [contacts, setContacts] = useState<SupplierContact[]>([])
  const load = () => supabase.from('supplier_contacts').select('*').eq('supplier', s.name).order('sort').order('name').then(({ data }) => setContacts((data as SupplierContact[]) ?? []))
  useEffect(() => { load() }, [s.name]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  async function save(patch: Partial<Supplier>) {
    const { error } = await supabase.from('suppliers').update(patch).eq('name', s.name)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function addContact() {
    const name = window.prompt('Jméno kontaktní osoby')?.trim()
    if (!name) return
    const { error } = await supabase.from('supplier_contacts').insert({ supplier: s.name, name })
    if (error) toast(explain(error), 'err'); else load()
  }
  async function patchContact(c: SupplierContact, p: Partial<SupplierContact>) {
    const { error } = await supabase.from('supplier_contacts').update(p).eq('id', c.id)
    if (error) toast(explain(error), 'err'); else load()
  }
  async function removeContact(c: SupplierContact) {
    if (!window.confirm(`Smazat kontakt ${c.name}?`)) return
    const { error } = await supabase.from('supplier_contacts').delete().eq('id', c.id)
    if (error) toast(explain(error), 'err'); else load()
  }
  const mine = people.filter(p => p.supplier === s.name).sort((a, b) => a.last_name.localeCompare(b.last_name, 'cs'))
  const F = ({ label, k, type, mono, span }: { label: string; k: keyof Supplier; type?: string; mono?: boolean; span?: boolean }) => {
    const cur = s[k] == null ? '' : String(s[k])
    return (
      <label className={span ? 'span2' : undefined}>{label}
        <input type={type ?? 'text'} className={mono ? 'mono' : undefined} defaultValue={cur} key={k + cur} disabled={!canEdit}
          onBlur={e => { const v = e.target.value.trim(); if (v === cur) return; if (k === 'rate_h' || k === 'rate_km') { const n = v ? Number(v.replace(',', '.')) : null; if (n !== null && !Number.isFinite(n)) return toast('Sazbu pište jako číslo.', 'err'); save({ [k]: n } as Partial<Supplier>) } else save({ [k]: v || null } as Partial<Supplier>) }} />
      </label>
    )
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label={s.name}>
        <div className="dialoghead">
          <h2>{s.name}{!s.active && <span className="nltag">neaktivní</span>}</h2>
          <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{k === 'kontakty' && contacts.length ? ` (${contacts.length})` : ''}{k === 'lide' && mine.length ? ` (${mine.length})` : ''}</button>)}</div>
          <button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button>
        </div>
        {tab === 'zaklad' && (
          <div className="formgrid">
            <F label="IČO" k="ico" mono /><F label="DIČ" k="dic" mono /><F label="Telefon" k="phone" mono /><F label="E-mail" k="email" type="email" />
            <F label="Adresa / sídlo" k="address" span /><F label="Web" k="web" /><F label="Splatnost / fakturace" k="payment_terms" />
            <F label="Kč/h za člověka" k="rate_h" mono /><F label="Kč/km za auto" k="rate_km" mono />
            <label className="checkline"><input type="checkbox" checked={s.provides_car} disabled={!canEdit} onChange={e => save({ provides_car: e.target.checked })} /> Dává i auto (platí se km + mýto)</label>
            <label className="checkline"><input type="checkbox" checked={s.active} disabled={!canEdit || s.name === 'SEMS'} onChange={e => save({ active: e.target.checked })} /> Aktivní</label>
            <label className="span4">Poznámka<textarea rows={2} defaultValue={s.note ?? ''} disabled={!canEdit} onBlur={e => e.target.value !== (s.note ?? '') && save({ note: e.target.value.trim() || null })} /></label>
          </div>
        )}
        {tab === 'kontakty' && (
          <div>
            {canEdit && <div className="newroute"><button className="primary small" onClick={addContact}>Přidat kontaktní osobu</button></div>}
            <div className="tablewrap">
              <table className="grid plain sub2">
                <thead><tr><th>Jméno</th><th>Role</th><th>Telefon</th><th>E-mail</th><th>Poznámka</th><th /></tr></thead>
                <tbody>
                  {contacts.map(c => (
                    <tr key={c.id}>
                      {(['name', 'role', 'phone', 'email', 'note'] as const).map(k => (
                        <td key={k}><input className={'cell' + (k === 'note' ? ' wide' : '')} defaultValue={c[k] ?? ''} key={k + (c[k] ?? '')} disabled={!canEdit}
                          onBlur={e => { const v = e.target.value.trim(); if (v === (c[k] ?? '')) return; if (k === 'name' && !v) return; patchContact(c, { [k]: v || null }) }} /></td>
                      ))}
                      <td>{canEdit && <button className="ghost" aria-label="Smazat" onClick={() => removeContact(c)}>×</button>}</td>
                    </tr>
                  ))}
                  {contacts.length === 0 && <tr><td colSpan={6} className="quiet">Zatím žádná kontaktní osoba.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === 'lide' && (
          <div className="tablewrap">
            <p className="intro">Lidé s tímhle dodavatelem jako výchozím. Mění se v detailu člověka (Lidé → ⋯ → Dodavatel).</p>
            <table className="grid plain sub2">
              <thead><tr><th>Jméno</th><th>V rozpisu</th><th>Telefon</th><th>Aktivní</th></tr></thead>
              <tbody>
                {mine.map(p => <tr key={p.id} className={p.active ? undefined : 'inactive'}><td>{p.first_name} {p.last_name}</td><td>{p.short_name}</td><td className="mono">{p.phone}</td><td>{p.active ? 'ano' : 'ne'}</td></tr>)}
                {mine.length === 0 && <tr><td colSpan={4} className="quiet">Nikdo.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
