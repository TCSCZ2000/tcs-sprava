import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from '../lib/supabase'
import type { PersonDoc } from '../lib/supabase'
import { explain, useApp } from '../lib/data'
import { blobToCanvas, canvasToJpeg, cropCanvas, fetchDoc, rotateCanvas } from '../lib/docimage'

type Rect = { x: number; y: number; w: number; h: number }

// Úprava fotky dokladu: otočit, oříznout tažením, uložit (nahradí soubor).
export function ImageEditor({ doc, onClose, onSaved }: { doc: PersonDoc; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const [orig, setOrig] = useState<HTMLCanvasElement | null>(null)
  const [cur, setCur] = useState<HTMLCanvasElement | null>(null)
  const [sel, setSel] = useState<Rect | null>(null)
  const [busy, setBusy] = useState<string | null>('načítám…')
  const [dirty, setDirty] = useState(false)
  const view = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!doc.path) return
    fetchDoc(doc.path).then(b => blobToCanvas(b, 2400)).then(c => { setOrig(c); setCur(c); setBusy(null) }).catch(e => { toast('Fotku nejde načíst: ' + (e?.message ?? ''), 'err'); onClose() })
  }, [doc.path]) // eslint-disable-line react-hooks/exhaustive-deps

  // vykreslení náhledu + výběru
  useEffect(() => {
    const v = view.current; if (!v || !cur) return
    const maxW = Math.min(window.innerWidth - 80, 1100), maxH = window.innerHeight - 190
    const k = Math.min(maxW / cur.width, maxH / cur.height, 1)
    v.width = Math.round(cur.width * k); v.height = Math.round(cur.height * k)
    const ctx = v.getContext('2d')!
    ctx.drawImage(cur, 0, 0, v.width, v.height)
    if (sel) {
      ctx.fillStyle = 'rgba(0,0,0,.45)'
      ctx.fillRect(0, 0, v.width, sel.y * k); ctx.fillRect(0, (sel.y + sel.h) * k, v.width, v.height - (sel.y + sel.h) * k)
      ctx.fillRect(0, sel.y * k, sel.x * k, sel.h * k); ctx.fillRect((sel.x + sel.w) * k, sel.y * k, v.width - (sel.x + sel.w) * k, sel.h * k)
      ctx.strokeStyle = '#ffd98a'; ctx.lineWidth = 2; ctx.strokeRect(sel.x * k, sel.y * k, sel.w * k, sel.h * k)
    }
  }, [cur, sel])

  const scale = () => (cur && view.current ? cur.width / view.current.width : 1)
  const pt = (e: React.PointerEvent) => { const r = view.current!.getBoundingClientRect(); const k = scale(); return { x: Math.max(0, Math.min(cur!.width, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(cur!.height, (e.clientY - r.top) * k)) } }
  const down = (e: React.PointerEvent) => { if (!cur) return; drag.current = pt(e); setSel(null); (e.target as Element).setPointerCapture(e.pointerId) }
  const move = (e: React.PointerEvent) => { if (!drag.current || !cur) return; const p = pt(e); const a = drag.current; setSel({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }) }
  const up = () => { if (sel && (sel.w < 20 || sel.h < 20)) setSel(null); drag.current = null }

  const rotate = (deg: 90 | -90) => { if (!cur) return; setCur(rotateCanvas(cur, deg)); setSel(null); setDirty(true) }
  const crop = () => { if (!cur || !sel) return; setCur(cropCanvas(cur, sel)); setSel(null); setDirty(true) }
  const reset = () => { setCur(orig); setSel(null); setDirty(false) }

  async function save() {
    if (!cur || !doc.path) return
    setBusy('ukládám…')
    try {
      const blob = await canvasToJpeg(cur, 0.9)
      const base = (doc.file_name ?? 'doklad').replace(/\.[^.]+$/, '')
      const safe = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const path = `${doc.person_id}/${Date.now()}_${safe}.jpg`
      const upl = await supabase.storage.from('people-files').upload(path, blob, { contentType: 'image/jpeg' })
      if (upl.error) throw new Error(upl.error.message)
      const { error } = await supabase.from('person_documents').update({ path, file_name: base + '.jpg', mime: 'image/jpeg', size: blob.size }).eq('id', doc.id)
      if (error) { await supabase.storage.from('people-files').remove([path]); throw new Error(explain(error)) }
      await supabase.storage.from('people-files').remove([doc.path])
      toast('Fotka uložena.'); onSaved(); onClose()
    } catch (e) { toast('Uložení se nezdařilo: ' + ((e as Error).message ?? ''), 'err'); setBusy(null) }
  }

  return createPortal(
    <div className="overlay lightbox editor" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="lbbar top">
        <strong>{doc.file_name}</strong>
        <button className="ghostbtn" disabled={!cur || !!busy} onClick={() => rotate(-90)} title="Otočit doleva">⟲ doleva</button>
        <button className="ghostbtn" disabled={!cur || !!busy} onClick={() => rotate(90)} title="Otočit doprava">⟳ doprava</button>
        <button className="ghostbtn" disabled={!sel || !!busy} onClick={crop} title="Oříznout na vybraný rámeček">✂ oříznout výběr</button>
        <button className="ghostbtn" disabled={!dirty || !!busy} onClick={reset}>zpět na původní</button>
        <span className="quiet">{busy ?? (sel ? 'rámeček vybrán – klikněte Oříznout' : 'tažením myší vyberte výřez')}</span>
        <button className="primary" disabled={!dirty || !!busy} onClick={save}>Uložit</button>
        <button className="ghost" onClick={onClose} aria-label="Zavřít">×</button>
      </div>
      <canvas ref={view} className="editcanvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      {cur && <div className="lbbar small">{cur.width} × {cur.height} px · uložením se nahradí původní soubor (zmenšený na max. 2400 px, JPG)</div>}
    </div>, document.body)
}
