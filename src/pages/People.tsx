import { useMemo, useState } from 'react'
import { supabase, type Person } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { docState } from '../lib/format'
import { exportXlsx, printPdf } from '../lib/export'
import ListTable, { type Col } from './ListTable'
import { PersonDialog } from './PersonDialog'
import { DocsImport } from './DocsImport'

// Lidé: seznam s rychlou editací, detail (⋯) s doklady a cestami
export function People() {
  const { people, pdocs, docKinds, level, toast, reloadLists } = useApp()
  const canEdit = level('people') === 'write'
  const seeDocs = level('people_docs') !== 'none'
  const editDocs = level('people_docs') === 'write'
  const [onlyActive, setOnlyActive] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [imp, setImp] = useState(false)

  // nejbližší platnost dokladu daného druhu (potvrzené mají přednost)
  const best = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of pdocs) {
      if (!d.valid_to) continue
      const k = d.person_id + '|' + d.kind
      const cur = m.get(k)
      if (!cur || d.valid_to > cur) m.set(k, d.valid_to)
    }
    return m
  }, [pdocs])
  const counts = useMemo(() => {
    const m = new Map<string, { n: number; unsorted: number; proposed: number }>()
    for (const d of pdocs) {
      const c = m.get(d.person_id) ?? { n: 0, unsorted: 0, proposed: 0 }
      c.n++; if (d.kind === 'nezarazeno') c.unsorted++; if (d.status === 'navrzeno') c.proposed++
      m.set(d.person_id, c)
    }
    return m
  }, [pdocs])
  const dupShort = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of people) m.set(p.short_name, (m.get(p.short_name) ?? 0) + 1)
    return new Set([...m].filter(([, n]) => n > 1).map(([s]) => s))
  }, [people])

  const rows = useMemo(() => (onlyActive ? people.filter(p => p.active) : people), [people, onlyActive])

  async function savePerson(p: Person, patch: Partial<Person>) {
    const { error } = await supabase.from('people').update(patch).eq('id', p.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const first = window.prompt('Jméno nového člověka')?.trim()
    if (!first) return
    const last = window.prompt('Příjmení')?.trim()
    if (!last) return
    const { data, error } = await supabase.from('people').insert({ first_name: first, last_name: last }).select('id').single()
    if (error) toast(explain(error), 'err'); else { toast(`${first} ${last} přidán. V Planningu je hned v nabídce.`); await reloadLists(); if (data) setOpen(data.id) }
  }
  const dateOf = (p: Person, kind: string) => best.get(p.id + '|' + kind) ?? ''

  const cols: Col<Person>[] = [
    { key: 'first', label: 'Jméno', get: r => r.first_name, save: (r, v) => v && savePerson(r, { first_name: v }) },
    { key: 'last', label: 'Příjmení', get: r => r.last_name, save: (r, v) => v && savePerson(r, { last_name: v }) },
    { key: 'short', label: 'V rozpisu', get: r => r.short_name + (dupShort.has(r.short_name) ? ' ⚠' : '') },
    { key: 'phone', label: 'Telefon', get: r => r.phone ?? '', save: (r, v) => savePerson(r, { phone: v || null }), mono: true },
    { key: 'birth', label: 'Narozen', type: 'date', get: r => r.birth_date ?? '', save: (r, v) => savePerson(r, { birth_date: v || null }) },
    { key: 'nat', label: 'Národnost', get: r => r.nationality ?? '', save: (r, v) => savePerson(r, { nationality: v || null }) },
  ]
  if (seeDocs) {
    cols.push(
      { key: 'op', label: 'OP do', type: 'date', get: r => dateOf(r, 'op'), mark: r => docState(dateOf(r, 'op') || null) },
      { key: 'pas', label: 'Pas do', type: 'date', get: r => dateOf(r, 'pas'), mark: r => docState(dateOf(r, 'pas') || null) },
      { key: 'rp', label: 'ŘP do', type: 'date', get: r => dateOf(r, 'rp'), mark: r => docState(dateOf(r, 'rp') || null) },
      { key: 'docs', label: 'Doklady', get: r => { const c = counts.get(r.id); if (!c) return ''; return `${c.n}${c.unsorted ? ` · ${c.unsorted} nezařaz.` : ''}${c.proposed ? ` · ${c.proposed} navrž.` : ''}` } },
    )
  }
  cols.push({ key: 'active', label: 'Aktivní', type: 'check', get: r => String(r.active), save: (r, v) => savePerson(r, { active: v === 'true' }) })

  function excel() {
    const head = ['Jméno', 'Příjmení', 'V rozpisu', 'Telefon', 'E-mail', 'Narozen', 'Národnost', ...(seeDocs ? ['OP číslo', 'OP do', 'Pas číslo', 'Pas do', 'ŘP do'] : []), 'Aktivní', 'Poznámka']
    const num = (p: Person, kind: string) => pdocs.filter(d => d.person_id === p.id && d.kind === kind && d.number).sort((a, b) => (b.valid_to ?? '').localeCompare(a.valid_to ?? ''))[0]?.number ?? ''
    const body = rows.map(p => [p.first_name, p.last_name, p.short_name, p.phone ?? '', p.email ?? '', p.birth_date ?? '', p.nationality ?? '',
      ...(seeDocs ? [num(p, 'op'), dateOf(p, 'op'), num(p, 'pas'), dateOf(p, 'pas'), dateOf(p, 'rp')] : []), p.active ? 'ano' : 'ne', p.note ?? ''])
    exportXlsx(`Lide_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: 'Lidé', rows: [head, ...body], widths: [12, 14, 14, 16, 22, 11, 10, 12, 11, 12, 11, 11, 7, 30] }])
  }

  const unsortedTotal = [...counts.values()].reduce((a, c) => a + c.unsorted, 0)
  const proposedTotal = [...counts.values()].reduce((a, c) => a + c.proposed, 0)
  return (
    <>
      <ListTable title="Lidé" rows={rows} cols={cols} canEdit={canEdit} onAdd={add} addLabel="Přidat člověka"
        search={r => `${r.first_name} ${r.last_name} ${r.short_name} ${r.phone ?? ''} ${r.nationality ?? ''}`}
        lead={r => <button className="ghost dots" title="Detail: doklady, cesty, nastavení zkratky" aria-label="Detail člověka" onClick={() => setOpen(r.id)}>⋯</button>}
        rowClass={r => (r.active ? undefined : 'inactive')}
        tools={<>
          <button className="link" onClick={excel}>Excel</button>
          <button className="link" onClick={printPdf}>Tisk / PDF</button>
          {editDocs && <button className="link" onClick={() => setImp(true)}>Import dokladů ze složky</button>}
        </>}
        filters={<div className="filterrow">
          <label className="check"><input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />Jen aktivní ({people.filter(p => p.active).length} z {people.length})</label>
          {seeDocs && unsortedTotal > 0 && <span className="quiet small">{unsortedTotal} dokladů čeká na zařazení</span>}
          {seeDocs && proposedTotal > 0 && <span className="quiet small">{proposedTotal} navržených k potvrzení</span>}
          {dupShort.size > 0 && <span className="quiet small">⚠ stejná zkratka: {[...dupShort].join(', ')} – doplňte rozlišení v detailu</span>}
        </div>}
        intro={<>Neaktivní lidé zmizí z nabídky v Planningu, ale zůstanou u starých cest. Detail (⋯) má doklady{seeDocs ? '' : ' (bez oprávnění je nevidíte)'} a historii cest. {seeDocs && 'Doklad je červeně po platnosti a oranžově 90 dní před koncem.'}</>} />
      {open && people.find(p => p.id === open) && <PersonDialog person={people.find(p => p.id === open)!} onClose={() => setOpen(null)} />}
      {imp && <DocsImport onClose={() => setImp(false)} kinds={docKinds} />}
    </>
  )
}
