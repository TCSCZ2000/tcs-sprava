import { supabase, type Car, type Person, type Place } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { docState, intervalToMinutes, minutesToHM, parseDuration } from '../lib/format'
import ListTable, { type Col } from './ListTable'

type PersonRow = Person & { id_number: string; id_valid_to: string; passport_number: string; passport_valid_to: string }

export function People() {
  const { people, docs, level, toast, reloadLists } = useApp()
  const canEdit = level('people') === 'write'
  const seeDocs = level('people_docs') !== 'none'
  const editDocs = level('people_docs') === 'write'

  const rows: PersonRow[] = people.map(p => {
    const d = docs.get(p.id)
    return { ...p, id_number: d?.id_number ?? '', id_valid_to: d?.id_valid_to ?? '', passport_number: d?.passport_number ?? '', passport_valid_to: d?.passport_valid_to ?? '' }
  })

  async function savePerson(p: Person, patch: Partial<Person>) {
    const { error } = await supabase.from('people').update(patch).eq('id', p.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function saveDoc(p: Person, field: string, value: string) {
    const { error } = await supabase.from('person_docs').upsert({ person_id: p.id, [field]: value || null })
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const first = window.prompt('Jméno nového člověka')?.trim()
    if (!first) return
    const last = window.prompt('Příjmení')?.trim()
    if (!last) return
    const { error } = await supabase.from('people').insert({ first_name: first, last_name: last })
    if (error) toast(explain(error), 'err'); else { toast(`${first} ${last} přidán. V Planningu je hned v nabídce.`); reloadLists() }
  }

  const cols: Col<PersonRow>[] = [
    { key: 'first', label: 'Jméno', get: r => r.first_name, save: (r, v) => v && savePerson(r, { first_name: v }) },
    { key: 'last', label: 'Příjmení', get: r => r.last_name, save: (r, v) => v && savePerson(r, { last_name: v }) },
    { key: 'short', label: 'V rozpisu', get: r => r.short_name },
    { key: 'phone', label: 'Telefon', get: r => r.phone ?? '', save: (r, v) => savePerson(r, { phone: v || null }), mono: true },
    { key: 'birth', label: 'Narozen', type: 'date', get: r => r.birth_date ?? '', save: (r, v) => savePerson(r, { birth_date: v || null }) },
    { key: 'nat', label: 'Národnost', get: r => r.nationality ?? '', save: (r, v) => savePerson(r, { nationality: v || null }) },
  ]
  if (seeDocs) {
    const ds = editDocs ? (f: string) => (r: PersonRow, v: string) => saveDoc(r, f, v) : () => undefined
    cols.push(
      { key: 'op', label: 'Číslo OP', get: r => r.id_number, save: editDocs ? ds('id_number') : undefined, mono: true },
      { key: 'opd', label: 'OP platný do', type: 'date', get: r => r.id_valid_to, save: editDocs ? ds('id_valid_to') : undefined, mark: r => docState(r.id_valid_to || null) },
      { key: 'pas', label: 'Číslo pasu', get: r => r.passport_number, save: editDocs ? ds('passport_number') : undefined, mono: true },
      { key: 'pasd', label: 'Pas platný do', type: 'date', get: r => r.passport_valid_to, save: editDocs ? ds('passport_valid_to') : undefined, mark: r => docState(r.passport_valid_to || null) },
    )
  }
  cols.push({ key: 'active', label: 'Aktivní', type: 'check', get: r => String(r.active), save: (r, v) => savePerson(r, { active: v === 'true' }) })

  return (
    <ListTable title="Lidé" rows={rows} cols={cols} canEdit={canEdit} onAdd={add} addLabel="Přidat člověka"
      search={r => `${r.first_name} ${r.last_name} ${r.phone ?? ''} ${r.nationality ?? ''}`}
      intro={<>Neaktivní lidé zmizí z nabídky v Planningu, ale zůstanou u starých cest. {seeDocs && 'Doklad je červeně po platnosti a oranžově 90 dní před koncem.'}</>} />
  )
}

export function Cars() {
  const { cars, level, toast, reloadLists } = useApp()
  const canEdit = level('cars') === 'write'
  async function saveCar(c: Car, patch: Partial<Car>) {
    const { error } = await supabase.from('cars').update(patch).eq('id', c.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const plate = window.prompt('SPZ nového auta')?.trim().toUpperCase()
    if (!plate) return
    const { error } = await supabase.from('cars').insert({ plate })
    if (error) toast(explain(error), 'err'); else { toast(`Auto ${plate} přidáno`); reloadLists() }
  }
  const t = (k: keyof Car, label: string, extra: Partial<Col<Car>> = {}): Col<Car> => ({
    key: k, label, get: r => (r[k] as string) ?? '', save: (r, v) => saveCar(r, { [k]: v || null } as Partial<Car>), ...extra,
  })
  const cols: Col<Car>[] = [
    t('car_no', 'Č.'), t('plate', 'SPZ', { mono: true, save: (r, v) => v && saveCar(r, { plate: v.toUpperCase() }) }),
    t('model', 'Model'), t('color', 'Barva'), t('loc', 'LOC'), t('category', 'KAT'), t('owner', 'Vlastník'),
    t('gps', 'GPS'), t('uta_card', 'UTA'), t('insurer', 'Pojišťovna'),
    t('stk_until', 'STK do', { type: 'date', mark: r => docState(r.stk_until) }),
    t('vignette_until', 'Známka CZ do', { type: 'date', mark: r => docState(r.vignette_until) }),
    t('tyres', 'Pneu'), t('state', 'Stav'), t('note', 'Poznámka', { wide: true }),
  ]
  return (
    <ListTable title="Auta" rows={cars} cols={cols} canEdit={canEdit} onAdd={add} addLabel="Přidat auto"
      search={r => `${r.label} ${r.owner ?? ''} ${r.state ?? ''}`}
      intro="V Planningu se nabízejí jen auta se stavem Aktivní nebo V opravě. Servis a km přijdou v modulu Servis." />
  )
}

export function Places() {
  const { places, level, toast, reloadLists } = useApp()
  const canEdit = level('places') === 'write'
  async function savePlace(p: Place, patch: Partial<Place>) {
    const { error } = await supabase.from('places').update(patch).eq('id', p.id)
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  async function add() {
    const name = window.prompt('Název místa (Pup / Dop)')?.trim()
    if (!name) return
    const { error } = await supabase.from('places').insert({ name })
    if (error) toast(explain(error), 'err'); else reloadLists()
  }
  const cols: Col<Place>[] = [
    { key: 'name', label: 'Místo', wide: true, get: r => r.name, save: (r, v) => v && savePlace(r, { name: v }) },
    { key: 'tt', label: 'Doba jízdy z TCS', get: r => minutesToHM(intervalToMinutes(r.travel_time)),
      save: (r, v) => { try { savePlace(r, { travel_time: parseDuration(v) }) } catch (e) { toast((e as Error).message, 'err') } } },
    { key: 'ferry', label: 'Trajekt', type: 'check', get: r => String(r.ferry), save: (r, v) => savePlace(r, { ferry: v === 'true' }) },
  ]
  return (
    <ListTable title="Místa" rows={places} cols={cols} canEdit={canEdit} onAdd={add} addLabel="Přidat místo"
      search={r => r.name}
      intro="Start v Planningu = čas nakládky mínus doba jízdy k místu nakládky. Doba platí pro Prahu i Příbram. U trajektu se místo času ukáže ferry." />
  )
}
