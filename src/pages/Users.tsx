import { useCallback, useEffect, useState } from 'react'
import { supabase, type Level, type Profile, type Role } from '../lib/supabase'
import { explain, useApp } from '../lib/data'

interface Invite { email: string; full_name: string; role: Role }
interface Mod { key: string; name: string; sort: number }
interface Perm { user_id: string; module: string; level: Level }
interface Def { role: Role; module: string; level: Level }

const ROLE: Record<Role, string> = { admin: 'Správce', dispatcher: 'Dispečer', viewer: 'Náhled' }
const LEVEL: Record<Level, string> = { none: 'nevidí', read: 'čte', write: 'upravuje' }

export default function Users() {
  const { profile, toast } = useApp()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [mods, setMods] = useState<Mod[]>([])
  const [perms, setPerms] = useState<Perm[]>([])
  const [defs, setDefs] = useState<Def[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState<Invite>({ email: '', full_name: '', role: 'viewer' })

  const load = useCallback(async () => {
    const [p, i, m, pm, d] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name'),
      supabase.from('invites').select('*').order('full_name'),
      supabase.from('modules').select('*').order('sort'),
      supabase.from('permissions').select('*'),
      supabase.from('role_defaults').select('*'),
    ])
    setProfiles((p.data as Profile[]) ?? []); setInvites((i.data as Invite[]) ?? [])
    setMods((m.data as Mod[]) ?? []); setPerms((pm.data as Perm[]) ?? []); setDefs((d.data as Def[]) ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    const row = { ...form, email: form.email.trim().toLowerCase(), full_name: form.full_name.trim() }
    if (!row.email || !row.full_name) return
    const { error } = await supabase.from('invites').upsert(row)
    if (error) return toast(explain(error), 'err')
    toast(`${row.full_name} je pozvaný. Přihlásí se svým e-mailem na adrese aplikace.`)
    setForm({ email: '', full_name: '', role: 'viewer' }); load()
  }

  async function update(p: Profile, patch: Partial<Profile>) {
    if (p.id === profile?.id && (patch.active === false || (patch.role && patch.role !== 'admin')))
      return toast('Sami sobě správcovská práva neodeberete.', 'err')
    const { error } = await supabase.from('profiles').update(patch).eq('id', p.id)
    if (error) return toast(explain(error), 'err')
    if (patch.role) await supabase.from('invites').update({ role: patch.role }).eq('email', p.email)
    load()
  }

  async function setPerm(p: Profile, module: string, value: string) {
    const { error } = value === ''
      ? await supabase.from('permissions').delete().eq('user_id', p.id).eq('module', module)
      : await supabase.from('permissions').upsert({ user_id: p.id, module, level: value })
    if (error) return toast(explain(error), 'err')
    load()
  }

  const pending = invites.filter(i => !profiles.some(p => p.email === i.email))
  const roleLevel = (r: Role, k: string): Level => defs.find(d => d.role === r && d.module === k)?.level ?? 'none'
  const eff = (p: Profile, k: string): Level => perms.find(x => x.user_id === p.id && x.module === k)?.level ?? roleLevel(p.role, k)
  const summary = (p: Profile) => {
    const pl = eff(p, 'planning')
    if (pl === 'none') return 'bez Planningu'
    const can = [['planning_create', 'cesty'], ['planning_status', 'status'], ['planning_crew', 'posádka'], ['planning_route', 'trasa']]
      .filter(([k]) => eff(p, k) === 'write').map(([, l]) => l)
    const tabs = [['people', 'Lidé'], ['cars', 'Auta'], ['places', 'Místa'], ['users', 'Uživatelé']]
      .filter(([k]) => eff(p, k) !== 'none').map(([k, l]) => l + (eff(p, k) === 'read' ? ' (čte)' : ''))
    return `Planning: ${can.length === 4 ? 'upravuje vše' : can.length ? 'mění ' + can.join(', ') : 'jen čte'}${tabs.length ? ' · ' + tabs.join(', ') : ''}`
  }

  return (
    <section className="users">
      <div className="toolbar"><h1>Správa uživatelů</h1></div>
      <form className="inviteform" onSubmit={invite}>
        <label className="field">E-mail<input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
        <label className="field">Jméno<input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} /></label>
        <label className="field">Role
          <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE) as Role[]).map(r => <option key={r} value={r}>{ROLE[r]}</option>)}
          </select>
        </label>
        <button className="primary" type="submit">Pozvat</button>
      </form>
      <p className="intro">Pozvaný se přihlásí svým e-mailem, přijde mu odkaz. Bez pozvánky se do aplikace nedostane nikdo. Role nastaví výchozí práva, u každého člověka pak v „Upravit práva“ můžete cokoli povolit nebo zakázat.</p>
      <dl className="roles">
        <div><dt>Správce</dt><dd>Vidí a upravuje všechno, včetně dokladů, aut a správy uživatelů.</dd></div>
        <div><dt>Dispečer</dt><dd>Plánuje: zakládá a maže cesty, mění status, posádku, auto i trasu, upravuje Lidi a Místa. Doklady a Auta jen čte, uživatele nevidí.</dd></div>
        <div><dt>Náhled</dt><dd>Planning, Podklad, Lidi, Auta a Místa jen čte, nic nezmění. Doklady a pasy nevidí.</dd></div>
      </dl>

      <div className="tablewrap">
        <table className="grid plain">
          <thead><tr><th>Jméno</th><th>E-mail</th><th>Role</th><th>Přístup</th><th /></tr></thead>
          <tbody>
            {profiles.map(p => {
              const own = perms.filter(x => x.user_id === p.id)
              return [
                <tr key={p.id} className={p.active ? '' : 'inactive'}>
                  <td><span className="ro">{p.full_name}</span></td>
                  <td><span className="ro mono">{p.email}</span></td>
                  <td>
                    <select value={p.role} onChange={e => update(p, { role: e.target.value as Role })}>
                      {(Object.keys(ROLE) as Role[]).map(r => <option key={r} value={r}>{ROLE[r]}</option>)}
                    </select>
                  </td>
                  <td>
                    <span className="ro access">{p.active ? summary(p) : 'zablokovaný'}</span>
                    {p.id !== profile?.id && (
                      <button className="link" onClick={() => update(p, { active: !p.active })}>{p.active ? 'Zablokovat' : 'Odblokovat'}</button>
                    )}
                  </td>
                  <td>
                    <button className="link" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {open === p.id ? 'Skrýt práva' : `Upravit práva${own.length ? ` (výjimky: ${own.length})` : ''}`}
                    </button>
                  </td>
                </tr>,
                open === p.id && (
                  <tr key={p.id + '-perm'} className="permrow">
                    <td colSpan={5}>
                      <PermEditor role={p.role} eff={k => eff(p, k)} isOverride={k => own.some(x => x.module === k)}
                        onSet={(k, l) => setPerm(p, k, l === roleLevel(p.role, k) ? '' : l)} />
                    </td>
                  </tr>
                ),
              ]
            })}
            {pending.map(i => (
              <tr key={i.email} className="pending">
                <td><span className="ro">{i.full_name}</span></td>
                <td><span className="ro mono">{i.email}</span></td>
                <td><span className="ro">{ROLE[i.role]}</span></td>
                <td colSpan={2}>
                  <span className="ro quiet">Pozvaný, ještě se nepřihlásil</span>{' '}
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

type Row = { key: string; label: string; kind: 'tri' | 'bin'; names?: Partial<Record<Level, string>> }
const GROUPS: { tab: string; rows: Row[] }[] = [
  { tab: 'Planning a Podklad', rows: [
    { key: 'planning', label: 'Přístup', kind: 'tri', names: { none: 'nevidí', read: 'jen vidí', write: 'píše poznámky' } },
    { key: 'planning_create', label: 'Přidávat a mazat cesty', kind: 'bin' },
    { key: 'planning_status', label: 'Status a reference', kind: 'bin' },
    { key: 'planning_crew', label: 'Posádka a auto', kind: 'bin' },
    { key: 'planning_route', label: 'Datum, čas a trasa', kind: 'bin' },
  ] },
  { tab: 'Lidé', rows: [
    { key: 'people', label: 'Kontakty', kind: 'tri' },
    { key: 'people_docs', label: 'Doklady a pasy', kind: 'tri' },
  ] },
  { tab: 'Auta', rows: [{ key: 'cars', label: 'Přístup', kind: 'tri' }] },
  { tab: 'Místa', rows: [{ key: 'places', label: 'Přístup', kind: 'tri' }] },
  { tab: 'Uživatelé', rows: [{ key: 'users', label: 'Přístup', kind: 'tri' }] },
]

function PermEditor(props: { role: Role; eff: (k: string) => Level; isOverride: (k: string) => boolean; onSet: (k: string, l: Level) => void }) {
  return (
    <div className="permgroups">
      {GROUPS.map(g => (
        <fieldset key={g.tab} className="permgroup">
          <legend>{g.tab}</legend>
          {g.rows.map(r => {
            const cur = props.eff(r.key)
            const off = r.key.startsWith('planning_') && props.eff('planning') === 'none'
            const opts: Level[] = r.kind === 'bin' ? ['none', 'write'] : ['none', 'read', 'write']
            const name = (l: Level) => r.names?.[l] ?? (r.kind === 'bin' ? (l === 'write' ? 'smí' : 'nesmí') : LEVEL[l])
            return (
              <div key={r.key} className={'permline' + (off ? ' off' : '')}>
                <span className="permlabel">{r.label}</span>
                <span className="seg small" role="group" aria-label={r.label}>
                  {opts.map(l => (
                    <button key={l} type="button" disabled={off} className={cur === l ? 'on' : ''} aria-pressed={cur === l}
                      onClick={() => props.onSet(r.key, l)}>{name(l)}</button>
                  ))}
                </span>
                <span className="permsrc">{props.isOverride(r.key) ? 'výjimka' : 'podle role'}</span>
              </div>
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
