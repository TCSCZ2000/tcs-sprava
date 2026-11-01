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
      <p className="intro">Pozvaný se přihlásí svým e-mailem, přijde mu odkaz. Bez pozvánky se do aplikace nedostane nikdo. Role nastaví výchozí práva, u každého člověka můžete udělat výjimku.</p>

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
                    <button className="link" onClick={() => update(p, { active: !p.active })}>{p.active ? 'Zablokovat' : 'Odblokovat'}</button>
                  </td>
                  <td>
                    <button className="link" onClick={() => setOpen(open === p.id ? null : p.id)}>
                      {open === p.id ? 'Skrýt práva' : `Práva${own.length ? ` (${own.length} výjimky)` : ''}`}
                    </button>
                  </td>
                </tr>,
                open === p.id && (
                  <tr key={p.id + '-perm'} className="permrow">
                    <td colSpan={5}>
                      <div className="permgrid">
                        {mods.map(m => {
                          const def = defs.find(d => d.role === p.role && d.module === m.key)?.level ?? 'none'
                          const ov = own.find(x => x.module === m.key)?.level
                          return (
                            <label key={m.key} className={'field' + (ov ? ' override' : '')}>{m.name}
                              <select value={ov ?? ''} onChange={e => setPerm(p, m.key, e.target.value)}>
                                <option value="">podle role ({LEVEL[def]})</option>
                                {(Object.keys(LEVEL) as Level[]).map(l => <option key={l} value={l}>{LEVEL[l]}</option>)}
                              </select>
                            </label>
                          )
                        })}
                      </div>
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
