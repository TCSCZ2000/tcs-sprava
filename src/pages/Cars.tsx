import { useMemo, useState } from 'react'
import { supabase, type Car } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { carAlerts, kmLeft, STATES } from '../lib/cars'
import { todayIso } from '../lib/format'
import { Text } from './Plan'

const KIND: Record<string, string> = { own: 'naše auto', rental: 'půjčovna', driver: 'osobní auto řidiče' }

function usePrefSet(key: string, initial: string[]): [Set<string>, (s: Set<string>) => void] {
  const [v, setV] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(key); return new Set(raw ? JSON.parse(raw) : initial) } catch { return new Set(initial) }
  })
  return [v, s => { setV(s); try { localStorage.setItem(key, JSON.stringify([...s])) } catch { /* bez paměti */ } }]
}

export default function Cars() {
  const { cars, carCategories, level, toast, reloadLists } = useApp()
  const canEdit = level('cars') === 'write'
  const [hiddenCat, setHiddenCat] = usePrefSet('cars.hiddenCat', [])
  const [hiddenState, setHiddenState] = usePrefSet('cars.hiddenState', ['Prodáno', 'K prodeji', 'Vráceno'])
  const [groups, setGroups] = usePrefSet('cars.groups', [])
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [q, setQ] = useState('')
  const [showCats, setShowCats] = useState(false)

  const toggle = (set: Set<string>, save: (s: Set<string>) => void, k: string) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); save(n) }

  async function saveCar(c: Car, patch: Partial<Car>) {
    const { error } = await supabase.from('cars').update(patch).eq('id', c.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const plate = window.prompt('SPZ nového auta')?.trim().toUpperCase()
    if (!plate) return
    const { error } = await supabase.from('cars').insert({ plate, car_category: 'TCS', state: 'Aktivní' })
    if (error) toast(explain(error), 'err'); else { toast(`Auto ${plate} přidáno. Doplňte model, kategorii a GPS.`); reloadLists() }
  }
  async function removeCar(c: Car) {
    if (!window.confirm(`Smazat auto ${c.plate}? Smazání nejde vrátit.`)) return
    const { error } = await supabase.from('cars').delete().eq('id', c.id)
    if (error) {
      if (error.code === '23503') return toast(`${c.plate} je u cest v Planningu nebo v Reportech, smazat ho nejde. Dejte mu stav Prodáno nebo Vráceno a zmizí z nabídky.`, 'err')
      return toast(explain(error), 'err')
    }
    toast(`Auto ${c.plate} smazáno`); reloadLists()
  }
  async function addRental() {
    const name = window.prompt('Název půjčovny (např. Avis)')?.trim()
    if (!name) return
    const { error } = await supabase.from('car_categories').insert({ name, kind: 'rental', sort: 10 + carCategories.length, visible: true })
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function setCatVisible(name: string, visible: boolean) {
    const { error } = await supabase.from('car_categories').update({ visible }).eq('name', name)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return cars
      .filter(c => !hiddenCat.has(c.car_category ?? '—'))
      .filter(c => !hiddenState.has(c.state ?? 'Aktivní'))
      .filter(c => !onlyAlerts || carAlerts(c).length > 0)
      .filter(c => !s || `${c.label} ${c.gps ?? ''} ${c.note ?? ''} ${c.car_category ?? ''}`.toLowerCase().includes(s))
  }, [cars, hiddenCat, hiddenState, onlyAlerts, q])

  const alertCount = cars.filter(c => carAlerts(c).length > 0).length
  const svc = groups.has('service'), other = groups.has('other')
  const ed = canEdit
  const txt = (c: Car, k: keyof Car, opts: { mono?: boolean; wide?: boolean; upper?: boolean } = {}) => (
    <Text disabled={!ed} value={(c[k] as string | null) ?? ''} mono={opts.mono} wide={opts.wide}
      onSave={v => saveCar(c, { [k]: (opts.upper ? v.toUpperCase() : v).trim() || null } as Partial<Car>)} />
  )
  const kmCell = (c: Car, k: 'km_current' | 'service_last_km' | 'service_next_km') => (
    <Text disabled={!ed} value={c[k]?.toString() ?? ''} mono time
      onSave={v => {
        const n = v.replace(/\s/g, '')
        if (n && !/^\d+$/.test(n)) return toast('Km pište jako celé číslo.', 'err')
        saveCar(c, { [k]: n ? Number(n) : null, ...(k === 'km_current' ? { km_updated: todayIso() } : {}) } as Partial<Car>)
      }} />
  )
  const dateCell = (c: Car, k: 'stk_until' | 'vignette_until') => (
    <Text disabled={!ed} value={c[k] ?? ''} type="date" onSave={v => saveCar(c, { [k]: v || null } as Partial<Car>)} />
  )

  return (
    <section className="list cars">
      <div className="toolbar">
        <h1>Auta</h1>
        <span className="count">{rows.length} z {cars.length}</span>
        <input className="search" placeholder="Hledat SPZ, model, GPS…" value={q} onChange={e => setQ(e.target.value)} />
        {canEdit && <button className="primary" onClick={add}>Přidat auto</button>}
      </div>

      <div className="carfilters">
        <div className="filterrow"><span className="flabel">Kategorie</span>
          {[...carCategories.map(c => c.name), '—'].map(n => (
            <button key={n} className={'chip cust' + (hiddenCat.has(n) ? ' off' : '')} onClick={() => toggle(hiddenCat, setHiddenCat, n)}>
              {n === '—' ? 'bez kategorie' : n}
            </button>
          ))}
          <button className="link" onClick={() => setShowCats(s => !s)}>{showCats ? 'Zavřít nastavení kategorií' : 'Nastavit kategorie'}</button>
        </div>
        <div className="filterrow"><span className="flabel">Stav</span>
          {STATES.map(n => (
            <button key={n} className={'chip cust' + (hiddenState.has(n) ? ' off' : '')} onClick={() => toggle(hiddenState, setHiddenState, n)}>{n}</button>
          ))}
        </div>
        <div className="filterrow"><span className="flabel">Ukázat</span>
          <label className="check"><input type="checkbox" checked={svc} onChange={() => toggle(groups, setGroups, 'service')} />Servis, km, STK a známky</label>
          <label className="check"><input type="checkbox" checked={other} onChange={() => toggle(groups, setGroups, 'other')} />Ostatní údaje (třída, LOC, UTA, pojišťovna, pneu)</label>
          <label className="check"><input type="checkbox" checked={onlyAlerts} onChange={e => setOnlyAlerts(e.target.checked)} />Jen auta s upozorněním ({alertCount})</label>
        </div>
      </div>

      {showCats && (
        <div className="catpanel">
          <p className="intro">Kategorie, která není „v Planningu“, se nenabízí u cest ani v řádku Auta v plánu. Auta v ní ale zůstanou tady.</p>
          <table className="grid plain catgrid">
            <thead><tr><th>Kategorie</th><th>Druh</th><th>V Planningu</th><th>Aut</th></tr></thead>
            <tbody>
              {carCategories.map(c => (
                <tr key={c.name}>
                  <td><span className="ro">{c.name}</span></td>
                  <td><span className="ro quiet">{KIND[c.kind]}</span></td>
                  <td className="mid"><input type="checkbox" disabled={!canEdit} checked={c.visible} onChange={e => setCatVisible(c.name, e.target.checked)} /></td>
                  <td><span className="ro">{cars.filter(x => x.car_category === c.name).length}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && <button className="link" onClick={addRental}>Přidat půjčovnu</button>}
        </div>
      )}

      <div className="tablewrap">
        <table className="grid plain cargrid">
          <thead>
            <tr>
              <th>Upozornění</th><th>Č.</th><th>SPZ</th><th>Model</th><th>Barva</th><th>Kategorie</th><th>GPS platforma</th><th>GPS jednotka</th><th>Stav</th>
              {svc && <><th>Aktuální km</th><th>Km zapsané</th><th>Poslední servis</th><th>Další servis</th><th>Zbývá km</th><th>STK do</th><th>Známka CZ do</th></>}
              {other && <><th>Třída</th><th>LOC</th><th>UTA</th><th>Pojišťovna</th><th>Pneu</th></>}
              <th>Poznámka</th>
              {canEdit && <th className="w-x" aria-label="Akce" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const al = carAlerts(c), left = kmLeft(c)
              return (
                <tr key={c.id} className={al.some(a => a.level === 'due') ? 'alert-due' : al.length ? 'alert-soon' : ''}>
                  <td className="alerts">{al.map(a => <span key={a.text} className={'badge ' + a.level}>{a.text}</span>)}</td>
                  <td>{txt(c, 'car_no', { mono: true })}</td>
                  <td>{txt(c, 'plate', { mono: true, upper: true })}</td>
                  <td>{txt(c, 'model')}</td>
                  <td>{txt(c, 'color')}</td>
                  <td>
                    <select disabled={!ed} value={c.car_category ?? ''} onChange={e => saveCar(c, { car_category: e.target.value || null })}>
                      <option value="">—</option>
                      {carCategories.map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select disabled={!ed} value={c.gps_platform ?? ''} onChange={e => saveCar(c, { gps_platform: (e.target.value || null) as Car['gps_platform'] })}
                      className={'gps ' + (c.gps_platform ?? 'none')}>
                      <option value="">—</option><option>GpsGate</option><option>RexGPS</option>
                    </select>
                  </td>
                  <td>{txt(c, 'gps')}</td>
                  <td>
                    <select disabled={!ed} value={c.state ?? ''} onChange={e => saveCar(c, { state: e.target.value || null })}>
                      {STATES.map(x => <option key={x}>{x}</option>)}
                    </select>
                  </td>
                  {svc && <>
                    <td>{kmCell(c, 'km_current')}</td>
                    <td><span className="ro quiet">{c.km_updated ? c.km_updated.split('-').reverse().join('. ') : ''}</span></td>
                    <td>{kmCell(c, 'service_last_km')}</td>
                    <td>{kmCell(c, 'service_next_km')}</td>
                    <td className={'num ' + (left == null ? '' : left <= 0 ? 'expired' : left <= 2000 ? 'soon' : '')}><span className="ro">{left == null ? '' : left.toLocaleString('cs-CZ')}</span></td>
                    <td>{dateCell(c, 'stk_until')}</td>
                    <td>{dateCell(c, 'vignette_until')}</td>
                  </>}
                  {other && <>
                    <td>{txt(c, 'category')}</td><td>{txt(c, 'loc')}</td><td>{txt(c, 'uta_card')}</td><td>{txt(c, 'insurer')}</td><td>{txt(c, 'tyres')}</td>
                  </>}
                  <td>{txt(c, 'note', { wide: true })}</td>
                  {canEdit && <td className="w-x"><button className="ghost" title={`Smazat auto ${c.plate}`} aria-label={`Smazat auto ${c.plate}`} onClick={() => removeCar(c)}>×</button></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">Žádné auto neodpovídá filtrům.</p>}
      </div>
    </section>
  )
}
