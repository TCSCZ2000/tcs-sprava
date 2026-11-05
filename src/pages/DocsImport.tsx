import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase, type DocKind, type Person } from '../lib/supabase'
import { explain, useApp } from '../lib/data'

// Přenos dokladů ze složky „Doklady“ (Google Drive stažené nebo synchronizované na disk): Doklady/<Příjmení Jméno>/<soubory>
// Složka → člověk podle tabulky drive_folders (připravená mapa), jinak podle jména; neznámý člověk se založí jako neaktivní.
type Folder = { name: string; files: File[]; person?: Person; create?: { first: string; last: string }; skipped: number }
type DriveFolder = { folder_name: string; person_id: string | null; first_name: string | null; last_name: string | null; imported_at: string | null }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim()
const nameKey = (s: string) => fold(s).split(' ').filter(Boolean).sort().join(' ')

export function guessKind(fileName: string): { kind: string; name?: string } {
  const n = fileName.normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (/dpp|smlouva|dohoda/i.test(n)) return { kind: 'dpp' }
  if (/(^|[^a-z])op([^a-z]|$)|obcansk|\bid\b/i.test(n)) return { kind: 'op' }
  if (/(^|[^a-z])rp([^a-z]|$)|ridic|driving/i.test(n)) return { kind: 'rp' }
  if (/(^|[^a-z])pas([^a-z]|$)|passport/i.test(n)) return { kind: 'pas' }
  if (/straz/i.test(n)) return { kind: 'strazny' }
  if (/zbroj/i.test(n)) return { kind: 'zbrojni' }
  if (/maturit|vysvedc|certifik|osvedc|diplom/i.test(n)) return { kind: 'jine', name: fileName.replace(/\.[^.]+$/, '') }
  return { kind: 'nezarazeno' }
}

export function DocsImport({ onClose, kinds }: { onClose: () => void; kinds: DocKind[] }) {
  const { people, pdocs, toast, reloadLists } = useApp()
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [finished, setFinished] = useState(false)

  const byKey = useMemo(() => { const m = new Map<string, Person[]>(); for (const p of people) { const k = nameKey(p.first_name + ' ' + p.last_name); m.set(k, [...(m.get(k) ?? []), p]) } return m }, [people])
  const existing = useMemo(() => new Set(pdocs.map(d => `${d.person_id}|${d.file_name}|${d.size}`)), [pdocs])

  async function pick(list: FileList | null) {
    if (!list?.length) return
    const { data } = await supabase.from('drive_folders').select('*')
    const dm = (data as DriveFolder[]) ?? []
    const all = Array.from(list).filter(f => !f.name.startsWith('.') && !/\.zip$/i.test(f.name) && f.size > 0)
    const segs = all.map(f => (f.webkitRelativePath || f.name).split('/'))
    const depth3 = segs.filter(s => s.length >= 3).length
    const useRoot = depth3 > all.length / 2
    const groups = new Map<string, File[]>()
    all.forEach((f, i) => {
      const s = segs[i]
      const person = useRoot ? s[1] : s[0]
      if (!person || (useRoot ? s.length < 3 : s.length < 2)) return
      groups.set(person.trim(), [...(groups.get(person.trim()) ?? []), f])
    })
    const out: Folder[] = []
    for (const [name, files] of groups) {
      const df = dm.find(x => x.folder_name === name)
      let person = df?.person_id ? people.find(p => p.id === df.person_id) : undefined
      if (!person) { const c = byKey.get(nameKey(name)); if (c?.length === 1) person = c[0] }
      let create: Folder['create']
      if (!person) {
        if (df?.first_name && df.last_name) create = { first: df.first_name, last: df.last_name }
        else { const w = name.split(/\s+/); create = { first: w.slice(1).join(' ') || '?', last: w[0] } }
      }
      out.push({ name, files, person, create, skipped: 0 })
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'cs'))
    setFolders(out)
  }

  async function run() {
    if (!folders) return
    setRunning(true)
    const todo = folders.flatMap(f => f.files)
    setTotal(todo.length); setDone(0)
    const created = new Map<string, string>()   // "Jméno|Příjmení" → id (dvě složky stejného nového člověka)
    let n = 0, added = 0, skipped = 0
    const say = (s: string) => setLog(l => [...l.slice(-200), s])
    for (const f of folders) {
      let pid = f.person?.id
      if (!pid && f.create) {
        const key = fold(f.create.first + '|' + f.create.last)
        pid = created.get(key)
        if (!pid) {
          const { data, error } = await supabase.from('people').insert({ first_name: f.create.first, last_name: f.create.last, note: 'Založeno přenosem dokladů z Drive' }).select('id').single()
          if (error || !data) { say(`✗ ${f.name}: ${explain(error)}`); n += f.files.length; setDone(n); continue }
          pid = data.id; created.set(key, pid!)
          say(`+ založen ${f.create.first} ${f.create.last}`)
        }
        await supabase.from('drive_folders').upsert({ folder_name: f.name, person_id: pid, first_name: f.create.first, last_name: f.create.last })
      }
      for (const file of f.files) {
        n++; setDone(n)
        if (existing.has(`${pid}|${file.name}|${file.size}`)) { skipped++; continue }
        const sub = (file.webkitRelativePath || '').split('/').slice(-2, -1)[0]
        const subNote = sub && sub !== f.name ? sub : null
        const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80)
        const path = `${pid}/drive_${Date.now()}_${safe}`
        const up = await supabase.storage.from('people-files').upload(path, file, { contentType: file.type || undefined })
        if (up.error) { say(`✗ ${f.name}/${file.name}: ${up.error.message}`); continue }
        const g = guessKind(file.name)
        const { error } = await supabase.from('person_documents').insert({
          person_id: pid, kind: g.kind, name: g.name ?? null, path, file_name: file.name, mime: file.type || null, size: file.size,
          source: 'drive', status: g.kind === 'nezarazeno' ? null : 'navrzeno', note: subNote,
        })
        if (error) { say(`✗ ${f.name}/${file.name}: ${explain(error)}`); await supabase.storage.from('people-files').remove([path]); continue }
        added++
      }
      await supabase.from('drive_folders').upsert({ folder_name: f.name, person_id: pid, imported_at: new Date().toISOString() })
    }
    say(`Hotovo: ${added} souborů přeneseno, ${skipped} už bylo, ${created.size} nových lidí.`)
    setRunning(false); setFinished(true); reloadLists()
    toast(`Přeneseno ${added} souborů.`)
  }

  const newCount = folders?.filter(f => !f.person).length ?? 0
  const fileCount = folders?.reduce((a, f) => a + f.files.length, 0) ?? 0
  const alreadyCount = folders?.reduce((a, f) => a + f.files.filter(x => f.person && existing.has(`${f.person.id}|${x.name}|${x.size}`)).length, 0) ?? 0
  const kindLabel = (k: string) => kinds.find(x => x.key === k)?.label ?? k

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !running) onClose() }}>
      <div className="dialog cardialog" role="dialog" aria-label="Import dokladů">
        <div className="dialoghead"><h2>Import dokladů ze složky</h2><button className="ghost" aria-label="Zavřít" disabled={running} onClick={onClose}>×</button></div>
        {!folders && (
          <div>
            <p className="intro">Vyberte složku <strong>Doklady</strong> z Google Drive (stáhněte ji z Drive jako ZIP a rozbalte, nebo ji mějte synchronizovanou přes Drive pro počítač). Uvnitř má být složka na každého člověka: <code>Doklady/Příjmení Jméno/soubory</code>. Soubory se zkopírují do aplikace k příslušnému člověku jako doklady; typ se odhadne z názvu souboru (OP, ŘP, pas, DPP…), ostatní zůstanou „nezařazeno“ a zařadí se později. Lidé, kteří v databázi nejsou, se založí (aktivní, ať je Planning nabídne; vyřadit je jde v Lidech). Spustit to jde opakovaně, co už je přenesené, se přeskočí.</p>
            <p><input type="file" multiple onChange={e => pick(e.target.files)} ref={el => { if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') } }} /></p>
          </div>
        )}
        {folders && !finished && (
          <div>
            <p className="intro">{folders.length} složek, {fileCount} souborů{alreadyCount ? ` (${alreadyCount} už přenesených, přeskočí se)` : ''}. {newCount > 0 && <>{newCount} lidí v databázi není, založí se.</>}</p>
            {running && <p className="warn">Přenáším… {done} z {total}. Nezavírejte okno.</p>}
            {!running && <p><button className="primary" onClick={run}>Spustit přenos</button> <button className="link" onClick={() => setFolders(null)}>Vybrat jinou složku</button></p>}
            <div className="tablewrap" style={{ maxHeight: '50vh', overflow: 'auto' }}>
              <table className="grid plain sub2">
                <thead><tr><th>Složka</th><th>Člověk</th><th className="num">Souborů</th><th>Odhad typů</th></tr></thead>
                <tbody>
                  {folders.map(f => {
                    const ks = new Map<string, number>()
                    for (const x of f.files) { const k = guessKind(x.name).kind; ks.set(k, (ks.get(k) ?? 0) + 1) }
                    return (
                      <tr key={f.name}>
                        <td>{f.name}</td>
                        <td>{f.person ? <>{f.person.first_name} {f.person.last_name}{!f.person.active && <span className="quiet small"> (neaktivní)</span>}</> : <span className="badge soon">nový: {f.create?.first} {f.create?.last}</span>}</td>
                        <td className="num">{f.files.length}</td>
                        <td className="quiet small">{[...ks].map(([k, n]) => `${kindLabel(k)} ${n}`).join(', ')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {(log.length > 0) && (
          <div className="importlog">
            {log.map((l, i) => <div key={i} className={l.startsWith('✗') ? 'err' : undefined}>{l}</div>)}
          </div>
        )}
        {finished && <div className="dialogfoot"><button className="primary" onClick={onClose}>Zavřít</button></div>}
      </div>
    </div>,
    document.body,
  )
}
