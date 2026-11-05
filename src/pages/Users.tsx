import { useCallback, useEffect, useState } from 'react'
import { supabase, type Level, type Profile, type Role } from '../lib/supabase'
import { explain, useApp } from '../lib/data'

interface Invite { email: string; full_name: string; role: Role; perms: Record<string, Level> }
interface Perm { user_id: string; module: string; level: Level }
interface Def { role: Role; module: string; level: Level }
type Draft = Record<string, Level>

const ROLES: Role[] = ['admin', 'viewer', 'custom']
const ROLE: Record<string, string> = { admin: 'Správce', viewer: 'Náhled', custom: 'Individuální', dispatcher: 'Individuální' }
const LEVEL: Record<Level, string> = { none: 'nevidí', read: 'čte', write: 'upravuje' }

type Row = { key: string; label: string; kind: 'tri' | 'bin' | 'view'; names?: Partial<Record<Level, string>>; viewer?: boolean }
const GROUPS: { tab: string; rows: Row[] }[] = [
  { tab: 'Planning', rows: [
    { key: 'planning', label: 'Přístup', kind: 'tri', viewer: true, names: { none: 'nevidí', read: 'jen vidí', write: 'píše poznámky' } },
    { key: 'planning_create', label: 'Přidávat a mazat cesty', kind: 'bin' },
    { key: 'planning_status', label: 'Status a reference', kind: 'bin' },
    { key: 'planning_crew', label: 'Posádka a auto', kind: 'bin' },
    { key: 'planning_route', label: 'Datum, čas a trasa', kind: 'bin' },
  ] },
  { tab: 'Podklad pro zákazníka', rows: [{ key: 'podklad', label: 'Přístup', kind: 'view', viewer: true }] },
  { tab: 'Reporty', rows: [{ key: 'reports', label: 'Přístup', kind: 'tri', viewer: true, names: { none: 'nevidí', read: 'čte', write: 'dopisuje reporty' } }] },
  { tab: 'Trasy a ceny', rows: [{ key: 'routes', label: 'Přístup', kind: 'tri', viewer: true }] },
  { tab: 'Hodiny', rows: [{ key: 'hours', label: 'Přístup', kind: 'tri', viewer: true }] },
  { tab: 'Auta – PINy', rows: [{ key: 'cars_pins', label: 'PINy tankovacích karet (po zadání hesla k PINům)', kind: 'tri', viewer: true }] },
  { tab: 'Lidé', rows: [
    { key: 'people', label: 'Kontakty', kind: 'tri', viewer: true },
    { key: 'people_docs', label: 'Doklady a pasy', kind: 'tri', viewer: true },
  ] },
  { tab: 'Dodavatelé', rows: [{ key: 'suppliers', label: 'Přístup (firemní údaje, kontakty, sazby)', kind: 'tri', viewer: true }] },
  { tab: 'Auta', rows: [{ key: 'cars', label: 'Přístup', kind: 'tri', viewer: true }] },
  { tab: 'Místa', rows: [{ key: 'places', label: 'Přístup', kind: 'tri', viewer: true }] },
  { tab: 'Uživatelé', rows: [{ key: 'users', label: 'Přístup', kind: 'tri' }] },
]
const ALL_KEYS = GROUPS.flatMap(g => g.rows.map(r => r.key))
const VIEWER_KEYS = GROUPS.flatMap(g => g.rows.filter(r => r.viewer).map(r => r.key))

// Šablony pro rychlé nastavení Individuální role
const PRESETS: { name: string; perms: Draft }[] = [
  { name: 'Dispečer', perms: { planning: 'write', planning_create: 'write', planning_status: 'write', planning_crew: 'write', planning_route: 'write',
    podklad: 'read', reports: 'read', routes: 'none', hours: 'none', cars_pins: 'none', people: 'write', people_docs: 'read', suppliers: 'read', cars: 'read', places: 'write', users: 'none' } },
  { name: 'Vše zakázat', perms: Object.fromEntries(ALL_KEYS.map(k => [k, 'none'])) as Draft },
]

const VIEWER_DEFAULT: Draft = { planning: 'read', podklad: 'read', reports: 'none', routes: 'none', hours: 'none', cars_pins: 'none', people: 'read', people_docs: 'none', suppliers: 'none', cars: 'read', places: 'read' }

function cap(role: Role, d: Draft): Draft {
  if (role === 'admin') return {}
  const keys = role === 'viewer' ? VIEWER_KEYS : ALL_KEYS
  return Object.fromEntries(keys.map(k => [k, role === 'viewer' && d[k] === 'write' ? 'read' : (d[k] ?? 'none')])) as Draft
}

export default function Users() {
  const { profile, toast } = useApp()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [perms, setPerms] = useState<Perm[]>([])
  const [defs, setDefs] = useState<Def[]>([])
  const [pinKeys, setPinKeys] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', full_name: '', role: 'viewer' as Role })
  const [draft, setDraft] = useState<Draft>(VIEWER_DEFAULT)

  const load = useCallback(async () => {
    const [p, i, pm, d, pk] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('invites').select('*').order('full_name'),
      supabase.from('permissions').select('*'),
      supabase.from('role_defaults').select('*'),
      supabase.from('pin_keys').select('user_id'),
    ])
    setProfiles((p.data as Profile[]) ?? []); setInvites((i.data as Invite[]) ?? [])
    setPerms((pm.data as Perm[]) ?? []); setDefs((d.data as Def[]) ?? [])
    setPinKeys(new Set(((pk.data as { user_id: string }[]) ?? []).map(x => x.user_id)))
  }, [])
  useEffect(() => { load() }, [load])

  // PINy tankovacích karet: přístup na osobu (hlavní klíč zabalený jejím heslem)
  async function grantPins(p: Profile) {
    const mine = window.prompt(`Vaše heslo k PINům (pro předání přístupu uživateli ${p.full_name})`); if (!mine) return
    const theirs = window.prompt(`Počáteční heslo k PINům pro ${p.full_name} (aspoň 6 znaků). Sdělte mu ho, pak si ho změní.`); if (!theirs) return
    const { error } = await supabase.rpc('pins_grant', { p_my_password: mine, p_user: p.id, p_their_password: theirs })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    toast(`${p.full_name} má přístup k PINům.`); load()
  }
  async function revokePins(p: Profile) {
    if (!window.confirm(`Zrušit ${p.full_name} přístup k PINům?`)) return
    const { error } = await supabase.rpc('pins_revoke', { p_user: p.id })
    if (error) return toast(error.message.replace(/^.*?: /, ''), 'err')
    toast('Přístup k PINům zrušen.'); load()
  }

  const roleLevel = (r: Role, k: string): Level => defs.find(d => d.role === r && d.module === k)?.level ?? 'none'
  const eff = (p: Profile, k: string): Level => {
    if (p.role === 'admin') return 'write'
    const l = perms.find(x => x.user_id === p.id && x.module === k)?.level ?? roleLevel(p.role, k)
    return p.role === 'viewer' && l === 'write' ? 'read' : l
  }

  function pickRole(r: Role) {
    setForm(f => ({ ...f, role: r }))
    setDraft(r === 'viewer' ? VIEWER_DEFAULT : r === 'custom' ? PRESETS[0].perms : {})
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    const email = form.email.trim().toLowerCase(), full_name = form.full_name.trim()
    if (!email || !full_name) return
    if (profiles.some(p => p.email === email)) return toast('Tenhle člověk už účet má. Práva mu upravte v seznamu níž.', 'err')
    const { error } = await supabase.from('invites').upsert({ email, full_name, role: form.role, perms: cap(form.role, draft) })
    if (error) return toast(explain(error), 'err')
    toast(`${full_name} je pozvaný. Přihlásí se svým e-mailem na adrese aplikace.`)
    setForm({ email: '', full_name: '', role: 'viewer' }); setDraft(VIEWER_DEFAULT); load()
  }

  // Změna role zachová, co člověk dosud viděl (Náhled jen pro čtení)
  async function changeRole(p: Profile, role: Role) {
    if (p.id === profile?.id && role !== 'admin') return toast('Sami sobě správcovská práva neodeberete.', 'err')
    const current = Object.fromEntries(ALL_KEYS.map(k => [k, eff(p, k)])) as Draft
    const { error } = await supabase.from('profiles').update({ role }).eq('id', p.id)
    if (error) return toast(explain(error), 'err')
    await supabase.from('permissions').delete().eq('user_id', p.id)
    const rows = Object.entries(cap(role, current)).map(([module, level]) => ({ user_id: p.id, module, level }))
    if (rows.length) await supabase.from('permissions').insert(rows)
    load()
  }

  async function setActive(p: Profile, active: boolean) {
    if (p.id === profile?.id) return toast('Sami sebe zablokovat nemůžete.', 'err')
    const { error } = await supabase.from('profiles').update({ active }).eq('id', p.id)
    if (error) return toast(explain(error), 'err')
    load()
  }

  async function setPerm(p: Profile, module: string, level: Level) {
    const { error } = await supabase.from('permissions').upsert({ user_id: p.id, module, level })
    if (error) return toast(explain(error), 'err')
    load()
  }

  const summary = (get: (k: string) => Level, role: Role) => {
    if (role === 'admin') return 'Vše'
    const tabs: string[] = []
    if (get('planning') !== 'none') {
      const can = [['planning_create', 'cesty'], ['planning_status', 'status'], ['planning_crew', 'posádka'], ['planning_route', 'trasa']]
        .filter(([k]) => role !== 'viewer' && get(k) === 'write').map(([, l]) => l)
      tabs.push(`Planning ${can.length === 4 ? '(upravuje vše)' : can.length ? '(mění ' + can.join(', ') + ')' : '(čte)'}`)
    }
    if (get('podklad') !== 'none') tabs.push('Podklad')
    if (get('routes') !== 'none') tabs.push('Trasy a ceny' + (get('routes') === 'read' ? ' (čte)' : ''))
    if (get('hours') !== 'none') tabs.push('Hodiny' + (get('hours') === 'read' ? ' (čte)' : ''))
    if (get('cars_pins') !== 'none') tabs.push('PINy karet')
    if (get('reports') !== 'none') tabs.push('Reporty' + (get('reports') === 'read' ? ' (čte)' : ''))
    for (const [k, l] of [['people', 'Lidé'], ['people_docs', 'Doklady'], ['suppliers', 'Dodavatelé'], ['cars', 'Auta'], ['places', 'Místa'], ['users', 'Uživatelé']])
      if (get(k) !== 'none') tabs.push(l + (get(k) === 'read' ? ' (čte)' : ''))
    return tabs.length ? tabs.join(' · ') : 'nic nevidí'
  }

  const pending = invites.filter(i => !profiles.some(p => p.email === i.email))

  return (
    <section className="users">
      <div className="toolbar"><h1>Správa uživatelů</h1></div>

      <form className="inviteform" onSubmit={invite}>
        <div className="invitefields">
          <label className="field">E-mail<input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">Jméno<input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} /></label>
          <div className="field">Role
            <span className="seg" role="group" aria-label="Role">
              {ROLES.map(r => <button key={r} type="button" className={form.role === r ? 'on' : ''} aria-pressed={form.role === r} onClick={() => pickRole(r)}>{ROLE[r]}</button>)}
            </span>
          </div>
          <button className="primary" type="submit">Pozvat</button>
        </div>
        <RoleHelp role={form.role} />
        {form.role === 'custom' && (
          <p className="presets">Začít podle šablony:{' '}
            {PRESETS.map(pr => <button key={pr.name} type="button" className="link" onClick={() => setDraft(pr.perms)}>{pr.name}</button>)}
          </p>
        )}
        {form.role !== 'admin' && (
          <PermEditor role={form.role} eff={k => cap(form.role, draft)[k] ?? 'none'} onSet={(k, l) => setDraft(d => ({ ...d, [k]: l }))} />
        )}
      </form>

      <p className="intro">Pozvaný se přihlásí svým e-mailem, přijde mu odkaz. Bez pozvánky se do aplikace nedostane nikdo. Práva jde kdykoli změnit v seznamu níž.</p>

      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr><th>Jméno</th><th>E-mail</th><th>Role</th><th>Přístup</th><th /></tr></thead>
          <tbody>
            {profiles.map(p => [
              <tr key={p.id} className={p.active ? '' : 'inactive'}>
                <td><span className="ro">{p.full_name}</span></td>
                <td><span className="ro mono">{p.email}</span></td>
                <td>
                  <select value={p.role === 'dispatcher' ? 'custom' : p.role} onChange={e => changeRole(p, e.target.value as Role)}>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE[r]}</option>)}
                  </select>
                </td>
                <td>
                  <span className="ro access">{p.active ? summary(k => eff(p, k), p.role) : 'zablokovaný'}</span>
                  {p.id !== profile?.id && (
                    <button className="link" onClick={() => setActive(p, !p.active)}>{p.active ? 'Zablokovat' : 'Odblokovat'}</button>
                  )}
                  {p.active && eff(p, 'cars_pins') !== 'none' && (pinKeys.has(p.id)
                    ? <span className="pintag" title="Má vlastní heslo k PINům tankovacích karet">PINy ✓ {pinKeys.size > 0 && <button className="link small" onClick={() => revokePins(p)}>zrušit</button>}</span>
                    : pinKeys.size > 0 ? <button className="link small" onClick={() => grantPins(p)} title="Dát přístup k PINům tankovacích karet">dát přístup k PINům</button> : null)}
                </td>
                <td>
                  {p.role !== 'admin' && (
                    <button className="link" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Skrýt práva' : 'Upravit práva'}</button>
                  )}
                </td>
              </tr>,
              open === p.id && p.role !== 'admin' && (
                <tr key={p.id + '-perm'} className="permrow">
                  <td colSpan={5}><PermEditor role={p.role} eff={k => eff(p, k)} onSet={(k, l) => setPerm(p, k, l)} /></td>
                </tr>
              ),
            ])}
            {pending.map(i => (
              <tr key={i.email} className="pending">
                <td><span className="ro">{i.full_name}</span></td>
                <td><span className="ro mono">{i.email}</span></td>
                <td><span className="ro">{ROLE[i.role]}</span></td>
                <td>
                  <span className="ro access">Pozvaný, ještě se nepřihlásil · {summary(k => (i.role === 'admin' ? 'write' : i.perms?.[k] ?? 'none'), i.role)}</span>
                </td>
                <td>
                  <button className="link" onClick={async () => { await supabase.from('invites').delete().eq('email', i.email); load() }}>Zrušit pozvánku</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RoleHelp({ role }: { role: Role }) {
  const text: Record<string, string> = {
    admin: 'Správce vidí a upravuje všechno, včetně dokladů a správy uživatelů. Nic se mu nenastavuje.',
    viewer: 'Náhled nic nezmění. Vyberte, které části aplikace uvidí.',
    custom: 'Individuální: každou část i každou úpravu v Planningu povolíte nebo zakážete zvlášť.',
  }
  return <p className="rolehelp">{text[role]}</p>
}

function PermEditor(props: { role: Role; eff: (k: string) => Level; onSet: (k: string, l: Level) => void }) {
  const viewer = props.role === 'viewer'
  return (
    <div className="permgroups">
      {GROUPS.filter(g => !viewer || g.rows.some(r => r.viewer)).map(g => (
        <fieldset key={g.tab} className="permgroup">
          <legend>{g.tab}</legend>
          {g.rows.filter(r => !viewer || r.viewer).map(r => {
            const cur = props.eff(r.key)
            const off = r.key.startsWith('planning_') && props.eff('planning') === 'none'
            const opts: Level[] = viewer || r.kind === 'view' ? ['none', 'read'] : r.kind === 'bin' ? ['none', 'write'] : ['none', 'read', 'write']
            const name = (l: Level) => viewer || r.kind === 'view' ? (l === 'none' ? 'nevidí' : 'vidí')
              : r.names?.[l] ?? (r.kind === 'bin' ? (l === 'write' ? 'smí' : 'nesmí') : LEVEL[l])
            return (
              <div key={r.key} className={'permline' + (off ? ' off' : '')}>
                <span className="permlabel">{r.label}</span>
                <span className="seg small" role="group" aria-label={`${g.tab}: ${r.label}`}>
                  {opts.map(l => (
                    <button key={l} type="button" disabled={off} className={cur === l ? 'on' : ''} aria-pressed={cur === l}
                      onClick={() => props.onSet(r.key, l)}>{name(l)}</button>
                  ))}
                </span>
              </div>
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
