import { COLORS, type NamedColor } from './colors'

export type RGB = [number, number, number]
type Lab = [number, number, number]

// sRGB (0–255) → линейный канал (0–1)
function toLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

// Белая точка D65
const XN = 0.95047
const YN = 1.0
const ZN = 1.08883
const EPS = 216 / 24389
const KAPPA = 24389 / 27

function f(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116
}

export function rgbToLab([r8, g8, b8]: RGB): Lab {
  const r = toLinear(r8)
  const g = toLinear(g8)
  const b = toLinear(b8)

  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b

  const fx = f(x / XN)
  const fy = f(y / YN)
  const fz = f(z / ZN)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

const LABS: Lab[] = COLORS.map((c) => rgbToLab(hexToRgb(c.hex)))

// Ближайшее название по ΔE (CIE76) — евклидово расстояние в Lab.
export function nearestColor(rgb: RGB): NamedColor {
  const [l, a, b] = rgbToLab(rgb)
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < LABS.length; i++) {
    const [l2, a2, b2] = LABS[i]
    const d = (l - l2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return COLORS[best]
}

// Относительная яркость (WCAG). Выше порога — на фоне читается чёрный текст.
export function luminance([r, g, b]: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

// Коэффициент контраста WCAG: (L1 + 0.05) / (L2 + 0.05)
export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

// Берём тот из чёрного и белого, у которого контраст с фоном выше.
// Точка переключения — L ≈ 0.179 (примерно #767676 для серого).
export function textColorFor(rgb: RGB): string {
  const l = luminance(rgb)
  return contrastRatio(l, 0) >= contrastRatio(l, 1) ? '#000000' : '#ffffff'
}

// Медиана по каждому каналу — устойчива к бликам, в отличие от среднего.
export function medianRgb(data: Uint8ClampedArray): RGB {
  const n = data.length / 4
  const r = new Uint8Array(n)
  const g = new Uint8Array(n)
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    r[i] = data[i * 4]
    g[i] = data[i * 4 + 1]
    b[i] = data[i * 4 + 2]
  }
  const mid = n >> 1
  const med = (arr: Uint8Array) => {
    arr.sort()
    return n % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2)
  }
  return [med(r), med(g), med(b)]
}

export function meanRgb(data: Uint8ClampedArray): RGB {
  let r = 0, g = 0, b = 0
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
  }
  return [r / n, g / n, b / n]
}
