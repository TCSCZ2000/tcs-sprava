import type { Car, CarCategory } from './supabase'

export const ACTIVE_STATES = ['Aktivní', 'V opravě']
export const STATES = ['Aktivní', 'V opravě', 'K prodeji', 'Prodáno', 'Vráceno']
export const SERVICE_SOON_KM = 2000
export const DATE_SOON_DAYS = 30

// Auto se nabízí v Planningu: viditelná kategorie a stav Aktivní / V opravě
export function inPlanning(c: Car, cats: CarCategory[]) {
  const cat = cats.find(x => x.name === c.car_category)
  return (!cat || cat.visible) && ACTIVE_STATES.includes(c.state ?? 'Aktivní')
}

export interface Alert { level: 'due' | 'soon'; text: string }

const days = (iso: string) => Math.floor((new Date(iso + 'T00:00:00').getTime() - Date.now()) / 864e5)
const dmy = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d}. ${m}. ${y}` }
const km = (n: number) => n.toLocaleString('cs-CZ')

// Servis podle km, STK a dálniční známka
export function carAlerts(c: Car): Alert[] {
  if (!ACTIVE_STATES.includes(c.state ?? 'Aktivní')) return []
  const out: Alert[] = []
  if (c.km_current != null && c.service_next_km != null) {
    const left = c.service_next_km - c.km_current
    if (left <= 0) out.push({ level: 'due', text: `Servis po termínu o ${km(-left)} km` })
    else if (left <= SERVICE_SOON_KM) out.push({ level: 'soon', text: `Servis za ${km(left)} km` })
  }
  for (const [d, name] of [[c.stk_until, 'STK'], [c.vignette_until, 'Známka']] as const) {
    if (!d) continue
    const n = days(d)
    if (n < 0) out.push({ level: 'due', text: `${name} propadla ${dmy(d)}` })
    else if (n <= DATE_SOON_DAYS) out.push({ level: 'soon', text: `${name} do ${dmy(d)}` })
  }
  return out
}

export function kmLeft(c: Car): number | null {
  return c.km_current != null && c.service_next_km != null ? c.service_next_km - c.km_current : null
}
