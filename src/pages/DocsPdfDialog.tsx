import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../lib/data'
import { buildDocsPdf, downloadBlob } from '../lib/docimage'
import { usePref } from './Plan'

// Hromadný export dokladů více lidí do jednoho PDF (třeba OP + pas posádky pro zákazníka).
export function DocsPdfDialog({ onClose, initial }: { onClose: () => void; initial?: string[] }) {
  const { people, pdocs, docKinds, toast } = useApp()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>(initial ?? [])
  const [kinds, setKinds] = usePref<string>('docspdf.kinds', 'op,pas')
  const [busy, setBusy] = useState('')
  const kindSet = new Set(kinds.split(',').filter(Boolean))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const hits = useMemo(() => { const w = fold(q.trim()); if (!w) return []; return people.filter(p => !picked.includes(p.id) && fold(`${p.first_name} ${p.last_name} ${p.short_name}`).includes(w)).slice(0, 8) }, [q, people, picked])
  const items = useMemo(() => picked.flatMap(pid => {
    const p = people.find(x => x.id === pid); if (!p) return []
    return pdocs.filter(d => d.person_id === pid && d.path && kindSet.has(d.kind)).sort((a, b) => (docKinds.find(k => k.key === a.kind)?.sort ?? 50) - (docKinds.find(k => k.key === b.kind)?.sort ?? 50) || (b.valid_to ?? '').localeCompare(a.valid_to ?? ''))
      .map(d => ({ doc: d, personName: `${p.first_name} ${p.last_name}`, kindLabel: docKinds.find(k => k.key === d.kind)?.label ?? d.kind }))
  }), [picked, people, pdocs, kinds, docKinds]) // eslint-disable-line react-hooks/exhaustive-deps
  const missing = picked.filter(pid => !items.some(i => i.doc.person_id === pid)).map(pid => people.find(p => p.id === pid)?.short_name ?? '?')
  async function go() {
    if (!items.length) return toast('Nic k exportu – vyberte lidi a druhy dokladů.', 'err')
    setBusy('připravuji…')
    try {
      const blob = await buildDocsPdf(items, (i, n) => setBusy(`${i}/${n}`))
      downloadBlob(blob, `Doklady_${picked.length === 1 ? (people.find(p => p.id === picked[0])?.last_name ?? '') : picked.length + '_lidi'}_${new Date().toISOString().slice(0, 10)}.pdf`)
    } catch (e) { toast('PDF se nepodařilo vytvořit: ' + ((e as Error).message ?? ''), 'err') }
    setBusy('')
  }
  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="dialog" role="dialog" aria-label="Doklady do PDF">
        <div className="dialoghead"><h2>Doklady do PDF</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <div className="formgrid">
          <label className="span4">Lidé<input placeholder="hledat jméno…" value={q} onChange={e => setQ(e.target.value)} />
            {hits.length > 0 && <div className="hits">{hits.map(p => <button key={p.id} className="link" onClick={() => { setPicked([...picked, p.id]); setQ('') }}>{p.first_name} {p.last_name}</button>)}</div>}
          </label>
          <div className="span4 chips">
            {picked.map(pid => { const p = people.find(x => x.id === pid); return <span key={pid} className="chip on">{p ? `${p.first_name} ${p.last_name}` : '?'} <button className="ghost" onClick={() => setPicked(picked.filter(x => x !== pid))}>×</button></span> })}
            {picked.length === 0 && <span className="quiet small">zatím nikdo vybraný</span>}
          </div>
          <div className="span4">Druhy dokladů: {docKinds.filter(k => k.key !== 'nezarazeno' && k.key !== 'foto').map(k => (
            <label key={k.key} className="check inline"><input type="checkbox" checked={kindSet.has(k.key)} onChange={e => { const s = new Set(kindSet); e.target.checked ? s.add(k.key) : s.delete(k.key); setKinds([...s].join(',')) }} />{k.label}</label>
          ))}</div>
          <p className="span4 quiet small">{items.length} {items.length === 1 ? 'soubor' : items.length < 5 ? 'soubory' : 'souborů'} · každý na stránce A4 s jménem, druhem, číslem a platností{missing.length ? ` · bez dokladu: ${missing.join(', ')}` : ''}</p>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose} disabled={!!busy}>Zavřít</button>
          <button className="primary" disabled={!items.length || !!busy} onClick={go}>{busy ? `PDF ${busy}` : 'Stáhnout PDF'}</button>
        </div>
      </div>
    </div>, document.body)
}
