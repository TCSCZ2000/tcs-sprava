// Doba jízdy: Postgres vrací "10:30:00" nebo "1 day 05:00:00"
export function intervalToMinutes(v: string | null | undefined): number | null {
  if (!v) return null
  let days = 0
  const d = v.match(/(\d+)\s+days?/)
  if (d) days = Number(d[1])
  const t = v.match(/(-?\d+):(\d{2})(?::(\d{2}))?/)
  const h = t ? Number(t[1]) : 0
  const m = t ? Number(t[2]) : 0
  if (!d && !t) return null
  return days * 1440 + h * 60 + m
}

export function minutesToHM(min: number | null): string {
  if (min == null) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

// "3:30" nebo "3,5" → interval pro Postgres
export function parseDuration(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const hm = s.match(/^(\d+):(\d{1,2})$/)
  if (hm) return `${hm[1]}:${hm[2].padStart(2, '0')}`
  const num = Number(s.replace(',', '.'))
  if (!Number.isNaN(num)) {
    const total = Math.round(num * 60)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }
  throw new Error('Dobu jízdy zapište jako 3:30 nebo 3,5')
}

const DAYS = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so']

export function dateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${DAYS[dt.getDay()]} ${d}. ${m}.`
}

export function shortDate(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${Number(d)}. ${Number(m)}. ${y}`
}

export function hm(time: string | null): string {
  return time ? time.slice(0, 5) : ''
}

export function todayIso(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Start = datum + čas − doba jízdy z TCS k místu nakládky
export function computeStart(date: string, time: string | null, travel: string | null, ferry: boolean): string {
  if (ferry) return 'ferry'
  const mins = intervalToMinutes(travel)
  if (!time || mins == null) return ''
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const dt = new Date(y, m - 1, d, hh, mm)
  dt.setMinutes(dt.getMinutes() - mins)
  const p = (n: number) => String(n).padStart(2, '0')
  const sameDay = dt.getDate() === d && dt.getMonth() === m - 1
  return sameDay ? `${p(dt.getHours())}:${p(dt.getMinutes())}` : `${dt.getDate()}. ${dt.getMonth() + 1}. ${p(dt.getHours())}:${p(dt.getMinutes())}`
}

// Doklad: 'expired' po platnosti, 'soon' do 90 dní
export function docState(iso: string | null): 'expired' | 'soon' | null {
  if (!iso) return null
  const t = new Date(iso + 'T00:00:00').getTime()
  const now = Date.now()
  if (t < now) return 'expired'
  if (t < now + 90 * 864e5) return 'soon'
  return null
}

// Čitelný text na barvě statusu
export function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1d2b36' : '#ffffff'
}

// "2026-11-02T03:30:00" → "2. 11. 3:30"
export function fmtDT(v: string | null) {
  if (!v) return ''
  const [d, t] = v.replace(' ', 'T').split('T')
  const [, mo, da] = d.split('-').map(Number)
  return `${da}. ${mo}. ${t.slice(0, 5)}`
}

// "3:30" → den podle předchozího času (a když by byl dřív, tak další den); "2.11. 3:30" → přesně
export function parseDT(v: string, base: string, rollForward: boolean): string | null | undefined {
  const s = v.trim()
  if (!s) return null
  const p = (n: number) => String(n).padStart(2, '0')
  const full = s.match(/^(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(\d{4})?\s+(\d{1,2})[:.](\d{2})$/)
  if (full) {
    const y = Number(full[3] ?? base.slice(0, 4))
    const d = new Date(y, Number(full[2]) - 1, Number(full[1]), Number(full[4]), Number(full[5]))
    if (Number.isNaN(d.getTime()) || Number(full[4]) > 23 || Number(full[5]) > 59) return undefined
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
  }
  const tm = s.match(/^(\d{1,2})[:.]?(\d{2})$/)
  if (!tm) return undefined
  const h = Number(tm[1]), mi = Number(tm[2])
  if (h > 23 || mi > 59) return undefined
  const [bd, bt] = base.split('T')
  const [y, mo, da] = bd.split('-').map(Number)
  const d = new Date(y, mo - 1, da, h, mi)
  const b = new Date(y, mo - 1, da, Number(bt.slice(0, 2)), Number(bt.slice(3, 5)))
  if (rollForward && d < b) d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
}


// Posun času o hodiny; výsledek zaokrouhlený nahoru na čtvrthodiny (9:43 + 4,5 h → 14:15)
export function addHoursIso(iso: string, h: number, roundUpMin = 15): string {
  const d = new Date(iso.replace(' ', 'T'))
  d.setMinutes(d.getMinutes() + Math.round(h * 60))
  const r = d.getMinutes() % roundUpMin
  if (r) d.setMinutes(d.getMinutes() + roundUpMin - r)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
}

// Čas vůči dni cesty: stejný den jen „9:45“, jiný den „3. 11. 9:45“
export function fmtRel(iso: string | null, tripDate: string): string {
  if (!iso) return ''
  const v = iso.replace(' ', 'T')
  return v.slice(0, 10) === tripDate ? v.slice(11, 16) : fmtDT(v)
}
