import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../lib/data'
import { BaseSelect } from '../lib/BaseSelect'
import type { Trip, TripStop } from '../lib/supabase'
import { todayIso } from '../lib/format'

// Detail cesty: jedno okno pro všechno, co se do tabulky nevejde (další vykládky, Guard 3, základny, take-over…)
// Pro novou cestu se nic nezaloží, dokud nedáte Uložit.
export type TripForm = {
  trip_date: string; trip_time: string; pup: string; dop: string; stops: string[]
  guard1: string; guard2: string; guard3: string; car: string; car_origin: string; car_origin_other: string
  customer: string; status: string; ref_tcs: string; base_from: string; base_to: string; takeover: boolean; remarks: string; kind: string
}

export function emptyForm(date: string): TripForm {
  return { trip_date: date, trip_time: '', pup: '', dop: '', stops: [], guard1: '', guard2: '', guard3: '', car: '', car_origin: '', car_origin_other: '',
    customer: '', status: 'HEADS-UP', ref_tcs: '', base_from: 'CZ', base_to: 'CZ', takeover: false, remarks: '', kind: '' }
}

export function TripDialog({ title, initial, onSave, onClose, saving, can }: {
  title: string; initial: TripForm; onSave: (f: TripForm) => void; onClose: () => void; saving: boolean
  can: { route: boolean; crew: boolean; status: boolean }
}) {
  const { people, cars, places, statuses, customers } = useApp()
  const [f, setF] = useState<TripForm>(initial)
  useEffect(() => setF(initial), [initial])
  const set = <K extends keyof TripForm>(k: K, v: TripForm[K]) => setF(cur => ({ ...cur, [k]: v }))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-label={title}>
        <div className="dialoghead"><h2>{title}</h2><button className="ghost" aria-label="Zavřít" onClick={onClose}>×</button></div>
        <datalist id="dlg-places">{places.map(p => <option key={p.id} value={p.name} />)}</datalist>
        <datalist id="dlg-people">{people.filter(p => p.active).map(p => <option key={p.id} value={p.short_name}>{p.first_name} {p.last_name}{p.phone ? ' · ' + p.phone : ''}</option>)}</datalist>
        <datalist id="dlg-cars">{cars.map(c => <option key={c.id} value={c.label} />)}</datalist>

        <div className="formgrid">
          <label>Datum<input type="date" value={f.trip_date} disabled={!can.route} onChange={e => set('trip_date', e.target.value)} /></label>
          <label>Čas<input type="text" placeholder="hh:mm" value={f.trip_time} disabled={!can.route} onChange={e => set('trip_time', e.target.value)} /></label>
          <label>Status
            <select value={f.status} disabled={!can.status} onChange={e => set('status', e.target.value)}>
              <option value="">–</option>{statuses.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label>Ref. TCS<input type="text" placeholder="A12345" value={f.ref_tcs} disabled={!can.status} onChange={e => set('ref_tcs', e.target.value.toUpperCase())} /></label>
          <label className="span2">Pup<input type="text" list="dlg-places" value={f.pup} disabled={!can.route} onChange={e => set('pup', e.target.value)} /></label>
          <label className="span2">Dop<input type="text" list="dlg-places" value={f.dop} disabled={!can.route} onChange={e => set('dop', e.target.value)} /></label>
          <div className="span4 stopsbox">
            <span className="lbl">Další vykládky</span>
            {f.stops.map((s, i) => (
              <span key={i} className="stopitem">
                <span className="quiet">Dop {i + 2}</span>
                <input type="text" list="dlg-places" value={s} disabled={!can.route} onChange={e => set('stops', f.stops.map((x, j) => (j === i ? e.target.value : x)))} />
                {can.route && <button className="ghost" aria-label="Odebrat vykládku" onClick={() => set('stops', f.stops.filter((_, j) => j !== i))}>×</button>}
              </span>
            ))}
            {can.route && f.stops.length < 8 && <button className="link small" onClick={() => set('stops', [...f.stops, ''])}>+ přidat vykládku</button>}
            {f.stops.length === 0 && <span className="quiet small"> Běžná cesta má jen Pup a Dop; vykládky navíc přidejte jen když jich je víc.</span>}
          </div>
          <label>Guard 1<input type="text" list="dlg-people" value={f.guard1} disabled={!can.crew} onChange={e => set('guard1', e.target.value)} /></label>
          <label>Guard 2<input type="text" list="dlg-people" value={f.guard2} disabled={!can.crew} onChange={e => set('guard2', e.target.value)} /></label>
          <label title="Třetí člen posádky, jen výjimečně">Guard 3<input type="text" list="dlg-people" value={f.guard3} disabled={!can.crew} onChange={e => set('guard3', e.target.value)} /></label>
          <label>Auto<input type="text" list="dlg-cars" placeholder="SPZ nebo Sixt" value={f.car} disabled={!can.crew} onChange={e => set('car', e.target.value)} /></label>
          <label title="Kde auto před cestou stojí: Praha, Příbram, jinde">Auto z
            <select value={f.car_origin} disabled={!can.crew} onChange={e => set('car_origin', e.target.value)}>
              <option value="">–</option><option>Praha</option><option>Příbram</option><option>Jiné</option>
            </select>
          </label>
          {f.car_origin === 'Jiné' && <label>Kde<input type="text" value={f.car_origin_other} disabled={!can.crew} onChange={e => set('car_origin_other', e.target.value)} /></label>}
          <label>Zákazník
            <select value={f.customer} disabled={!can.route} onChange={e => set('customer', e.target.value)}>
              <option value="">–</option>{customers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <label title="Základna, ze které posádka vyjíždí (CZ = Praha/Příbram)">Výjezd z<BaseSelect value={f.base_from} disabled={!can.route} onChange={v => set('base_from', v)} /></label>
          <label title="Základna, kam se posádka vrací">Návrat do<BaseSelect value={f.base_to} disabled={!can.route} onChange={v => set('base_to', v)} /></label>
          <label title="Doprovod je standard. Přeprava dodávkou: JTi vždy, TCS občas. „podle zákazníka“ = JTi přeprava, ostatní doprovod.">Druh
            <select value={f.kind} disabled={!can.route} onChange={e => set('kind', e.target.value)}>
              <option value="">podle zákazníka ({(f.customer.toUpperCase().startsWith('JTI') ? 'přeprava' : 'doprovod')})</option>
              <option value="escort">Doprovod</option><option value="transport">Přeprava dodávkou 🚐</option>
            </select>
          </label>
          <label className="checkline"><input type="checkbox" checked={f.takeover} disabled={!can.route} onChange={e => set('takeover', e.target.checked)} /> Take-over (přebíráme od cizí posádky)</label>
          <label className="span4">Poznámka<textarea rows={2} value={f.remarks} onChange={e => set('remarks', e.target.value)} /></label>
        </div>
        <div className="dialogfoot">
          <button className="link" onClick={onClose}>Zavřít bez uložení</button>
          <button className="primary" disabled={saving} onClick={() => onSave(f)}>{saving ? 'Ukládám…' : 'Uložit'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function formFromTrip(t: Trip, stops: TripStop[], name: {
  place: (id: string | null) => string; person: (id: string | null) => string; car: (id: string | null) => string
}): TripForm {
  return {
    trip_date: t.trip_date, trip_time: t.trip_time?.slice(0, 5) ?? '', pup: name.place(t.pup_id), dop: name.place(t.dop_id), stops: stops.map(s => name.place(s.place_id)),
    guard1: name.person(t.guard1_id), guard2: name.person(t.guard2_id), guard3: name.person(t.guard3_id), car: name.car(t.car_id),
    car_origin: t.car_origin ?? '', car_origin_other: t.car_origin_other ?? '', customer: t.customer ?? '', status: t.status ?? '', ref_tcs: t.ref_tcs ?? '',
    base_from: t.base_from, base_to: t.base_to, takeover: t.takeover, remarks: t.remarks ?? '', kind: t.kind ?? '',
  }
}

export const tomorrow = () => todayIso(1)
