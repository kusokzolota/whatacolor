export interface Sample {
  hex: string
  name: string // название на языке, выбранном в момент замера; на экране пересчитывается из hex
  timestamp: number // ms
}

export interface Gains {
  r: number
  g: number
  b: number
}

export type Facing = 'environment' | 'user'

const LIBRARY_KEY = 'library'
export const LIBRARY_MAX = 500
const LEGACY_PREFIX = 'colors:'

// У фронталки и основной камеры разная цветопередача — ручная калибровка своя для каждой
const gainsKey = (f: Facing) => (f === 'user' ? 'calibration:user' : 'calibration')
const FACING_KEY = 'facing'

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* приватный режим / переполнение — работаем без сохранения */
  }
}

function isSample(x: unknown): x is Sample {
  const s = x as Sample
  return !!s && typeof s.hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(s.hex) && typeof s.timestamp === 'number'
}

// Старый формат хранил цвета по дням в ключах colors:YYYY-MM-DD — переносим их в библиотеку один раз.
function migrateLegacy(): Sample[] {
  const found: Sample[] = []
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(LEGACY_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      try {
        const arr = JSON.parse(localStorage.getItem(k) ?? '[]')
        if (Array.isArray(arr)) {
          for (const o of arr) {
            if (o && typeof o.hex === 'string' && typeof o.t === 'number') {
              found.push({ hex: o.hex.toUpperCase(), name: typeof o.name === 'string' ? o.name : '', timestamp: o.t })
            }
          }
        }
      } catch {
        /* битый ключ — пропускаем */
      }
      localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
  return found
}

// Записи хранятся от старых к новым.
export function loadLibrary(): Sample[] {
  let list: Sample[] = []
  const raw = safeGet(LIBRARY_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed.filter(isSample)
    } catch {
      /* ignore */
    }
  }
  const legacy = migrateLegacy()
  if (legacy.length) {
    list = [...list, ...legacy].sort((a, b) => a.timestamp - b.timestamp).slice(-LIBRARY_MAX)
    saveLibrary(list)
  }
  return list
}

export function saveLibrary(list: Sample[]) {
  safeSet(LIBRARY_KEY, JSON.stringify(list))
}

// Кольцевой буфер: при переполнении выпадает самая старая запись.
export function pushSample(list: Sample[], s: Sample): Sample[] {
  const next = [...list, s]
  return next.length > LIBRARY_MAX ? next.slice(next.length - LIBRARY_MAX) : next
}

export function isSameDay(a: number, b: number) {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

export function dateStamp(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function loadGains(f: Facing): Gains | null {
  const raw = safeGet(gainsKey(f))
  if (!raw) return null
  try {
    const g = JSON.parse(raw)
    if ([g.r, g.g, g.b].every((v) => typeof v === 'number' && isFinite(v))) return g
  } catch {
    /* ignore */
  }
  return null
}

export function saveGains(f: Facing, g: Gains) {
  safeSet(gainsKey(f), JSON.stringify(g))
}

export function clearGains(f: Facing) {
  try {
    localStorage.removeItem(gainsKey(f))
  } catch {
    /* ignore */
  }
}

export function loadFacing(): Facing {
  return safeGet(FACING_KEY) === 'user' ? 'user' : 'environment'
}

export function saveFacing(f: Facing) {
  safeSet(FACING_KEY, f)
}
