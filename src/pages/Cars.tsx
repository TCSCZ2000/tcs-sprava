import { useEffect, useMemo, useState } from 'react'
import { supabase, type Car } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { carAlerts, kmLeft, OWN_STATES, RENTAL_STATES, STATES } from '../lib/cars'
import { todayIso } from '../lib/format'
import { STAGE_LABEL, serviceStatus, type CarKm, type CarService, type ServiceGroup, type WorkKind } from '../lib/service'
import { CarDialog } from './CarDialog'
import { exportXlsx, printPdf } from '../lib/export'
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
  const [records, setRecords] = useState<CarService[]>([])
  const [kms, setKms] = useState<CarKm[]>([])
  const [sgroups, setSgroups] = useState<ServiceGroup[]>([])
  const [kinds, setKinds] = useState<WorkKind[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const loadService = () => Promise.all([
    supabase.from('car_service').select('*').order('done_on'),
    supabase.from('car_km').select('*').order('at'),
    supabase.from('car_service_groups').select('*').order('sort'),
    supabase.from('car_work_kinds').select('*').order('sort'),
  ]).then(([a, b, c, d]) => { setRecords((a.data as CarService[]) ?? []); setKms((b.data as CarKm[]) ?? []); setSgroups((c.data as ServiceGroup[]) ?? []); setKinds((d.data as WorkKind[]) ?? []) })
  useEffect(() => { loadService() }, [])
  const statusOf = (c: Car) => serviceStatus(c, records, kms, sgroups, kinds)

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
    if (!window.confirm(`Smazat auto ${c.plate ?? c.car_no ?? 'bez SPZ'}? Smazání nejde vrátit.`)) return
    const { error } = await supabase.from('cars').delete().eq('id', c.id)
    if (error) {
      if (error.code === '23503') return toast(`${c.plate ?? c.car_no ?? 'bez SPZ'} je u cest v Planningu nebo v Reportech, smazat ho nejde. Dejte mu stav Prodáno nebo Vráceno a zmizí z nabídky.`, 'err')
      return toast(explain(error), 'err')
    }
    toast(`Auto ${c.plate ?? c.car_no ?? 'bez SPZ'} smazáno`); reloadLists()
  }
  async function orderRental(company: string) {
    const { error } = await supabase.from('cars').insert({ car_category: company })
    if (error) toast(explain(error), 'err'); else { toast(`Objednané auto ${company} přidáno s dalším volným číslem. SPZ a model doplňte, až je budete znát.`); reloadLists() }
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

  // Upozornění: servis podle historie a skupiny (jako hodinová kontrola), jinak podle ručně zapsaných km
  function alertsOf(c: Car) {
    const base = carAlerts({ ...c, service_next_km: null })
    const st = statusOf(c)
    if (st.left != null && (!st.group || st.group.notify) && (c.state ?? 'Aktivní') !== 'Prodáno') {
      if (st.left < 0) base.unshift({ level: 'due', text: `Servis po termínu o ${(-st.left).toLocaleString('cs-CZ')} km` })
      else if (st.left <= 3000) base.unshift({ level: 'soon', text: `Servis (${st.nextKind}) za ${st.left.toLocaleString('cs-CZ')} km` })
    } else if (st.left == null && c.km_current != null && c.service_next_km != null) {
      const l = c.service_next_km - c.km_current
      if (l <= 0) base.unshift({ level: 'due', text: `Servis po termínu o ${(-l).toLocaleString('cs-CZ')} km` }); else if (l <= 2000) base.unshift({ level: 'soon', text: `Servis za ${l.toLocaleString('cs-CZ')} km` })
    }
    if (st.timingLeft != null && st.timingLeft <= 3000 && (!st.group || st.group.notify)) base.push({ level: st.timingLeft < 0 ? 'due' : 'soon', text: st.timingLeft < 0 ? `Rozvody po termínu o ${(-st.timingLeft).toLocaleString('cs-CZ')} km` : `Rozvody za ${st.timingLeft.toLocaleString('cs-CZ')} km` })
    return base
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return cars
      .filter(c => !hiddenCat.has(c.car_category ?? '—'))
      .filter(c => !hiddenState.has(c.state ?? 'Aktivní'))
      .filter(c => !onlyAlerts || alertsOf(c).length > 0)
      .filter(c => !s || `${c.label} ${c.gps ?? ''} ${c.note ?? ''} ${c.car_category ?? ''}`.toLowerCase().includes(s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cars, hiddenCat, hiddenState, onlyAlerts, q, records, kms, sgroups, kinds])

  const kindOf = (c: Car) => carCategories.find(k => k.name === c.car_category)?.kind
  const isOwn = (c: Car) => kindOf(c) === 'own' || kindOf(c) === 'rental'
  const alertCount = cars.filter(c => alertsOf(c).length > 0).length
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
        {canEdit && <button className="primary" onClick={add}>Přidat naše auto</button>}
        <button className="link" onClick={() => {
          const head = ['SPZ', 'Číslo', 'Model', 'Barva', 'Kategorie', 'Stav', 'Km', 'Další servis', 'STK do', 'Známka CZ do', 'GPS', 'LOC', 'Pojišťovna', 'Rok', 'VIN', 'Poznámka']
          const body = rows.map(c => { const st = statusOf(c); return [c.plate ?? '', c.car_no ?? '', c.model ?? '', c.color ?? '', c.car_category ?? '', c.state ?? '', st.kmMax ?? '', st.nextKm ?? '', c.stk_until ?? '', c.vignette_until ?? '', c.gps ?? '', c.loc ?? '', c.insurer ?? '', c.year ?? '', c.vin ?? '', c.note ?? ''] })
          exportXlsx(`Auta_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: 'Auta', rows: [head, ...body], widths: [9, 6, 18, 8, 12, 10, 9, 11, 11, 12, 10, 8, 12, 6, 19, 30] }])
        }}>Excel</button>
        <button className="link" onClick={printPdf}>Tisk / PDF</button>
        {canEdit && (
          <select className="orderrental" value="" onChange={e => { if (e.target.value) orderRental(e.target.value) }} aria-label="Objednat auto z půjčovny">
            <option value="">Objednat auto z půjčovny…</option>
            {carCategories.filter(k => k.kind === 'rental').map(k => <option key={k.name} value={k.name}>{k.name}</option>)}
          </select>
        )}
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
          <p className="intro">Naše auta (TCS a Manažerská) se číslují samy podle SPZ, nejdřív TCS a za nimi manažerská. Číslo mají Aktivní, V opravě a K prodeji, prodaná ho uvolní. Auta z půjčovny dostanou číslo podle půjčovny (Sixt1, Sixt2…) a vrácené auto ho uvolní pro další objednávku. Osobní auta řidičů mají číslo, jaké jim napíšete. Kategorie, která není „v Planningu“, se nenabízí u cest ani v řádku Auta v plánu. Auta v ní ale zůstanou tady.</p>
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
              <th className="w-dots" aria-label="Detail" /><th>Upozornění</th><th>Č.</th><th>SPZ</th><th>Model</th><th>Barva</th><th>Kategorie</th><th>GPS platforma</th><th>GPS jednotka</th><th>Stav</th>
              {svc && <><th title="Nejvyšší stav km z odečtů a ručních zápisů">Stav km</th><th>Km k datu</th><th title="Z historie servisů">Poslední servis</th><th title="Podle servisní skupiny">Další servis</th><th>Zbývá km</th><th>STK do</th><th>Známka CZ do</th></>}
              {other && <><th>Třída</th><th>LOC</th><th>UTA</th><th>Pojišťovna</th><th>Pneu</th></>}
              <th>Poznámka</th>
              {canEdit && <th className="w-x" aria-label="Akce" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const al = alertsOf(c), st = statusOf(c), left = st.left ?? kmLeft(c)
              return (
                <tr key={c.id} className={al.some(a => a.level === 'due') ? 'alert-due' : al.length ? 'alert-soon' : ''}>
                  <td className="w-dots"><button className="ghost dots" title="Detail auta: servis, km, soubory, karty" aria-label="Detail auta" onClick={() => setOpen(c.id)}>⋯</button></td>
                  <td className="alerts">{al.map(a => <span key={a.text} className={'badge ' + a.level}>{a.text}</span>)}</td>
                  <td>{isOwn(c)
                    ? <span className="ro mono" title={kindOf(c) === 'rental' ? 'Auta z půjčovny se číslují samy podle půjčovny' : 'Naše auta se číslují samy podle SPZ (TCS, pak Manažerská)'}>{c.car_no ?? ''}</span>
                    : txt(c, 'car_no', { mono: true })}</td>
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
                      {(kindOf(c) === 'rental' ? RENTAL_STATES : OWN_STATES).map(x => <option key={x}>{x}</option>)}
                    </select>
                  </td>
                  {svc && <>
                    <td>{st.kmMax != null && st.kmMax !== c.km_current ? <span className="ro mono" title="Z odečtů v detailu auta">{st.kmMax.toLocaleString('cs-CZ')}</span> : kmCell(c, 'km_current')}</td>
                    <td><span className="ro quiet">{st.kmAt ? st.kmAt.slice(0, 10).split('-').reverse().join('. ') : c.km_updated ? c.km_updated.split('-').reverse().join('. ') : ''}</span></td>
                    <td>{st.lastService ? <span className="ro mono" title={`${st.lastService.kind} ${st.lastService.done_on}`}>{st.lastService.km?.toLocaleString('cs-CZ')}</span> : kmCell(c, 'service_last_km')}</td>
                    <td>{st.nextKm != null ? <span className="ro mono" title={`${st.nextKind} servis, skupina ${st.group?.name}`}>{st.nextKm.toLocaleString('cs-CZ')} <span className="quiet small">{st.nextKind}</span></span> : kmCell(c, 'service_next_km')}</td>
                    <td className={'num ' + (left == null ? '' : left <= 0 ? 'expired' : left <= 3000 ? 'soon' : '')} title={st.stage ? STAGE_LABEL[st.stage] : undefined}><span className="ro">{left == null ? '' : left.toLocaleString('cs-CZ')}</span></td>
                    <td>{dateCell(c, 'stk_until')}</td>
                    <td>{dateCell(c, 'vignette_until')}</td>
                  </>}
                  {other && <>
                    <td>{txt(c, 'category')}</td><td>{txt(c, 'loc')}</td><td>{txt(c, 'uta_card')}</td><td>{txt(c, 'insurer')}</td><td>{txt(c, 'tyres')}</td>
                  </>}
                  <td>{txt(c, 'note', { wide: true })}</td>
                  {canEdit && <td className="w-x"><button className="ghost" title={`Smazat auto ${c.plate ?? c.car_no ?? 'bez SPZ'}`} aria-label={`Smazat auto ${c.plate ?? c.car_no ?? 'bez SPZ'}`} onClick={() => removeCar(c)}>×</button></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">Žádné auto neodpovídá filtrům.</p>}
      </div>
      {open && cars.find(c => c.id === open) && (
        <CarDialog car={cars.find(c => c.id === open)!} records={records} kms={kms} groups={sgroups} kinds={kinds} onClose={() => setOpen(null)} onChanged={() => { loadService(); reloadLists() }} />
      )}
    </section>
  )
}
