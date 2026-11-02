import { useEffect, useState } from 'react'
import { configured, supabase } from './lib/supabase'
import { useApp, type ModuleKey } from './lib/data'
import Plan from './pages/Plan'
import Podklad from './pages/Podklad'
import { People, Places } from './pages/Lists'
import Cars from './pages/Cars'
import Users from './pages/Users'
import Reports from './pages/Reports'
import Routes from './pages/Routes'

const PAGES: { id: string; label: string; module: ModuleKey; el: () => JSX.Element }[] = [
  { id: 'plan', label: 'Planning', module: 'planning', el: () => <Plan /> },
  { id: 'podklad', label: 'Podklad', module: 'podklad', el: () => <Podklad /> },
  { id: 'reporty', label: 'Reporty', module: 'reports', el: () => <Reports /> },
  { id: 'trasy', label: 'Trasy a ceny', module: 'routes', el: () => <Routes /> },
  { id: 'lide', label: 'Lidé', module: 'people', el: () => <People /> },
  { id: 'auta', label: 'Auta', module: 'cars', el: () => <Cars /> },
  { id: 'mista', label: 'Místa', module: 'places', el: () => <Places /> },
  { id: 'uzivatele', label: 'Uživatelé', module: 'users', el: () => <Users /> },
]

function useHash() {
  const [h, setH] = useState(() => location.hash.slice(2) || 'plan')
  useEffect(() => {
    const f = () => setH(location.hash.slice(2) || 'plan')
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return h
}

export default function App() {
  const { session, profile, loading, level, toastMsg } = useApp()
  const page = useHash()

  if (!configured) return <Center><h1>Chybí nastavení</h1><p>Aplikace nezná adresu databáze. Doplňte VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY.</p></Center>
  if (!session) return <Login />
  if (loading) return <Center><p className="quiet">Načítám…</p></Center>
  if (!profile || !profile.active)
    return (
      <Center>
        <h1>Účet nemá přístup</h1>
        <p>Přihlásili jste se jako {session.user.email}, ale tenhle e-mail nemá pozvánku nebo je zablokovaný. Požádejte správce o pozvánku.</p>
        <button onClick={() => supabase.auth.signOut()}>Odhlásit</button>
      </Center>
    )

  const allowed = PAGES.filter(p => level(p.module) !== 'none')
  const current = allowed.find(p => p.id === page) ?? allowed[0]

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/plan"><img src="/emblem.png" alt="" className="emblem" /> TCS Správa</a>
        <nav>
          {allowed.map(p => (
            <a key={p.id} href={`#/${p.id}`} className={current?.id === p.id ? 'on' : ''}
              aria-current={current?.id === p.id ? 'page' : undefined}>{p.label}</a>
          ))}
        </nav>
        <div className="me">
          <span>{profile.full_name}</span>
          <button className="link" onClick={() => supabase.auth.signOut()}>Odhlásit</button>
        </div>
      </header>
      <main>{current ? current.el() : <p className="empty">Nemáte přístup do žádného modulu.</p>}</main>
      {toastMsg && <div className={'toast ' + toastMsg.kind} role="status">{toastMsg.msg}</div>}
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="center"><div className="panel"><img src="/emblem.png" alt="The Cargo Security Company" className="emblem big" /><img src="/wordmark.png" alt="" className="wordmark" />{children}</div></div>
}

function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  async function send(e: React.FormEvent) {
    e.preventDefault(); setErr('')
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: location.origin } })
    if (error) setErr(error.message.includes('rate') ? 'Odkaz už odešel, další můžete poslat za minutu.' : error.message)
    else setSent(true)
  }
  return (
    <Center>
      <h1>Přihlášení</h1>
      {sent
        ? <p>Na {email} odešel odkaz. Otevřete ho v tomhle prohlížeči a budete přihlášeni.</p>
        : (
          <form onSubmit={send} className="loginform">
            <label className="field">Pracovní e-mail<input type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)} /></label>
            <button className="primary" type="submit">Poslat přihlašovací odkaz</button>
            {err && <p className="err">{err}</p>}
          </form>
        )}
    </Center>
  )
}
