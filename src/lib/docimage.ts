// Práce s fotkami dokladů: načtení se správným otočením (EXIF), otočení, oříznutí, zmenšení, export do PDF.
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { supabase } from './supabase'
import type { PersonDoc } from './supabase'

export const isImageDoc = (d: { mime: string | null; file_name: string | null }) => (d.mime ?? '').startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/i.test(d.file_name ?? '')
export const isPdfDoc = (d: { mime: string | null; file_name: string | null }) => d.mime === 'application/pdf' || /\.pdf$/i.test(d.file_name ?? '')

export async function fetchDoc(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from('people-files').download(path)
  if (error || !data) throw new Error(error?.message ?? 'Soubor nejde stáhnout')
  return data
}

/** Načte obrázek už otočený podle EXIF, do canvasu. */
export async function blobToCanvas(blob: Blob, maxSide = 0): Promise<HTMLCanvasElement> {
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }) }
  catch { bmp = await createImageBitmap(blob) }
  let w = bmp.width, h = bmp.height
  if (maxSide && Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k) }
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h); bmp.close()
  return c
}

export function rotateCanvas(src: HTMLCanvasElement, deg: 90 | -90 | 180): HTMLCanvasElement {
  const c = document.createElement('canvas')
  const swap = deg !== 180
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height
  const ctx = c.getContext('2d')!
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((deg * Math.PI) / 180); ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return c
}

export function cropCanvas(src: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h))
  c.getContext('2d')!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height)
  return c
}

export function canvasToJpeg(c: HTMLCanvasElement, q = 0.88): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('export selhal'))), 'image/jpeg', q))
}

// ---------- PDF ----------
export interface PdfItem { doc: PersonDoc; personName: string; kindLabel: string }

let fontCache: { reg: ArrayBuffer; bold: ArrayBuffer } | null = null
async function fonts() {
  if (!fontCache) {
    const [r, b] = await Promise.all([fetch('/fonts/LiberationSans-Regular.ttf'), fetch('/fonts/LiberationSans-Bold.ttf')])
    fontCache = { reg: await r.arrayBuffer(), bold: await b.arrayBuffer() }
  }
  return fontCache
}

const dmy = (iso: string | null) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-'); return `${+d}. ${+m}. ${y}` }

/** Sestaví PDF: každý doklad na stránce A4 s hlavičkou. PDF přílohy se vloží po stránkách. Vrací Blob. */
export async function buildDocsPdf(items: PdfItem[], onProgress?: (i: number, n: number) => void): Promise<Blob> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const f = await fonts()
  const reg = await pdf.embedFont(f.reg, { subset: true }); const bold = await pdf.embedFont(f.bold, { subset: true })
  const A4: [number, number] = [595.28, 841.89]; const M = 40
  let i = 0
  for (const it of items) {
    onProgress?.(++i, items.length)
    const d = it.doc
    const title = `${it.personName} – ${it.kindLabel}${d.name && d.kind === 'jine' ? ` (${d.name})` : ''}`
    const sub = [d.number ? `č. ${d.number}` : '', d.valid_to ? `platí do ${dmy(d.valid_to)}` : ''].filter(Boolean).join(' · ')
    const header = (page: ReturnType<typeof pdf.addPage>, extra = '') => {
      page.drawText(title, { x: M, y: A4[1] - M - 14, size: 13, font: bold, color: rgb(0.1, 0.12, 0.15) })
      if (sub || extra) page.drawText([sub, extra].filter(Boolean).join(' · '), { x: M, y: A4[1] - M - 32, size: 10, font: reg, color: rgb(0.35, 0.38, 0.42) })
      page.drawLine({ start: { x: M, y: A4[1] - M - 40 }, end: { x: A4[0] - M, y: A4[1] - M - 40 }, thickness: 0.6, color: rgb(0.75, 0.78, 0.8) })
    }
    if (!d.path) { const p = pdf.addPage(A4); header(p, 'bez souboru'); continue }
    let blob: Blob
    try { blob = await fetchDoc(d.path) } catch (e) { const p = pdf.addPage(A4); header(p, 'soubor nejde načíst'); continue }
    if (isPdfDoc(d)) {
      try {
        const src = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true })
        const pages = await pdf.copyPages(src, src.getPageIndices())
        pages.forEach((pg, n) => { pdf.addPage(pg); if (n === 0) { const w = pg.getWidth(), h = pg.getHeight(); pg.drawRectangle({ x: 0, y: h - 26, width: w, height: 26, color: rgb(1, 1, 1), opacity: 0.85 }); pg.drawText(title + (sub ? ' · ' + sub : ''), { x: 20, y: h - 18, size: 9, font: bold, color: rgb(0.1, 0.12, 0.15) }) } })
      } catch { const p = pdf.addPage(A4); header(p, 'PDF nejde vložit') }
      continue
    }
    if (!isImageDoc(d)) { const p = pdf.addPage(A4); header(p, `soubor ${d.file_name ?? ''} není obrázek ani PDF`); continue }
    const canvas = await blobToCanvas(blob, 1800)
    const jpg = await pdf.embedJpg(await (await canvasToJpeg(canvas, 0.85)).arrayBuffer())
    const page = pdf.addPage(A4); header(page)
    const boxW = A4[0] - 2 * M, boxH = A4[1] - 2 * M - 52
    const k = Math.min(boxW / jpg.width, boxH / jpg.height, 1.5)
    const w = jpg.width * k, h = jpg.height * k
    page.drawImage(jpg, { x: M + (boxW - w) / 2, y: M + (boxH - h) / 2, width: w, height: h })
  }
  pdf.setTitle('Doklady'); pdf.setProducer('TCS Správa')
  const bytes = await pdf.save()
  return new Blob([bytes], { type: 'application/pdf' })
}

export function downloadBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000)
}
