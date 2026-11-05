import { useMemo, useState, type ReactNode } from 'react'
import { Text } from './Plan'

export interface Col<T> {
  key: string
  label: string
  get: (row: T) => string
  save?: (row: T, value: string) => void
  type?: 'text' | 'date' | 'check'
  mark?: (row: T) => 'expired' | 'soon' | null
  wide?: boolean
  mono?: boolean
}

export default function ListTable<T extends { id: string }>(props: {
  title: string
  intro: ReactNode
  rows: T[]
  cols: Col<T>[]
  canEdit: boolean
  onAdd?: () => void
  addLabel?: string
  search: (row: T) => string
  lead?: (row: T) => ReactNode       // první sloupec, třeba tlačítko ⋯ s detailem
  tools?: ReactNode                   // další tlačítka v liště (Excel, tisk…)
  filters?: ReactNode                 // řádek pod lištou (přepínače)
  rowClass?: (row: T) => string | undefined
}) {
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? props.rows.filter(r => props.search(r).toLowerCase().includes(s)) : props.rows
  }, [q, props])

  return (
    <section className="list">
      <div className="toolbar">
        <h1>{props.title}</h1>
        <span className="count">{props.rows.length}</span>
        <input className="search" placeholder="Hledat…" value={q} onChange={e => setQ(e.target.value)} />
        {props.canEdit && props.onAdd && <button className="primary" onClick={props.onAdd}>{props.addLabel ?? 'Přidat'}</button>}
        {props.tools}
      </div>
      <p className="intro">{props.intro}</p>
      {props.filters}
      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr>{props.lead && <th className="leadcol" />}{props.cols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={props.rowClass?.(r)}>
                {props.lead && <td className="leadcol">{props.lead(r)}</td>}
                {props.cols.map(c => {
                  const m = c.mark?.(r)
                  const editable = props.canEdit && !!c.save
                  if (c.type === 'check') {
                    return (
                      <td key={c.key} className="mid">
                        <input type="checkbox" disabled={!editable} checked={c.get(r) === 'true'}
                          onChange={e => c.save?.(r, String(e.target.checked))} />
                      </td>
                    )
                  }
                  return (
                    <td key={c.key} className={m ?? undefined}>
                      {editable
                        ? <Text value={c.get(r)} type={c.type === 'date' ? 'date' : 'text'} wide={c.wide} mono={c.mono} onSave={v => c.save!(r, v)} />
                        : <span className="ro">{c.type === 'date' && c.get(r) ? c.get(r).split('-').reverse().join('. ').replace(/^0/, '') : c.get(r)}</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">{q ? 'Nic neodpovídá hledání.' : 'Seznam je zatím prázdný.'}</p>}
      </div>
    </section>
  )
}
