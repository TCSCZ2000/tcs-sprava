import { useApp } from './data'

// Výběr základny (CZ, NL, …); CZ je výchozí
export function BaseSelect({ value, onChange, disabled, title }: { value: string; onChange: (v: string) => void; disabled?: boolean; title?: string }) {
  const { bases } = useApp()
  const list = bases.some(b => b.code === value) ? bases : [...bases, { code: value, name: value, sort: 99 }]
  return (
    <select className={'baseselect' + (value === 'CZ' ? ' cz' : '')} value={value} disabled={disabled} title={title} onChange={e => onChange(e.target.value)}>
      {list.map(b => <option key={b.code} value={b.code} title={b.name}>{b.code}</option>)}
    </select>
  )
}
