import { hexToRgb, nearestColor, textColorFor } from './color'
import { APP_NAME } from './config'
import { colorName, getLang, isRtl } from './i18n'
import type { Sample } from './storage'

const W = 1080
const H = 1920
const HEADER = 240
const FOOTER = 110
const MAX = 8
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif'

export function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })
}

// Не больше 8 цветов: при избытке — с равномерным шагом по времени замеров.
export function pickSamples(samples: Sample[]): Sample[] {
  const sorted = [...samples].sort((a, b) => a.timestamp - b.timestamp)
  if (sorted.length <= MAX) return sorted
  const first = sorted[0].timestamp
  const last = sorted[sorted.length - 1].timestamp
  const picked: Sample[] = []
  const used = new Set<number>()
  for (let i = 0; i < MAX; i++) {
    const target = first + ((last - first) * i) / (MAX - 1)
    let best = -1
    let bestD = Infinity
    sorted.forEach((s, idx) => {
      if (used.has(idx)) return
      const d = Math.abs(s.timestamp - target)
      if (d < bestD) {
        bestD = d
        best = idx
      }
    })
    used.add(best)
    picked.push(sorted[best])
  }
  return picked.sort((a, b) => a.timestamp - b.timestamp)
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number) {
  let s = size
  do {
    ctx.font = `${weight} ${s}px ${FONT}`
    if (ctx.measureText(text).width <= maxW) break
    s -= 2
  } while (s > 20)
  return s
}

function signature() {
  const host = location.hostname
  const local = !host.includes('.') || /^[\d.]+$/.test(host) || host.endsWith('.local')
  return local ? APP_NAME : host
}

export async function renderPalette(samples: Sample[]): Promise<Blob> {
  const list = pickSamples(samples)
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H })
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  const rtl = isRtl()
  ctx.direction = rtl ? 'rtl' : 'ltr'
  // Начало и конец строки: слева/справа, в RTL — наоборот
  const start = rtl ? W - 72 : 72
  const end = rtl ? 72 : W - 72
  const alignStart: CanvasTextAlign = rtl ? 'right' : 'left'
  const alignEnd: CanvasTextAlign = rtl ? 'left' : 'right'

  ctx.fillStyle = '#0d0d0d'
  ctx.fillRect(0, 0, W, H)

  // Дата словами
  const date = new Date(list[0]?.timestamp ?? Date.now()).toLocaleDateString(getLang(), { day: 'numeric', month: 'long' })
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = alignStart
  fitText(ctx, date, 700, 96, W - 144)
  ctx.fillText(date, start, HEADER / 2 + 8)

  const stripeH = (H - HEADER - FOOTER) / list.length
  const pad = 72
  list.forEach((s, i) => {
    const y = HEADER + i * stripeH
    ctx.fillStyle = s.hex
    // +1 убирает субпиксельные щели между полосами
    ctx.fillRect(0, Math.floor(y), W, Math.ceil(stripeH) + 1)

    const rgb = hexToRgb(s.hex)
    const fg = textColorFor(rgb)
    ctx.fillStyle = fg
    ctx.textAlign = alignStart
    const name = colorName(nearestColor(rgb))
    const time = formatTime(s.timestamp)
    ctx.font = `500 40px ${FONT}`
    const timeW = ctx.measureText(time).width
    const nameSize = fitText(ctx, name, 700, Math.min(64, stripeH * 0.34), W - pad * 2 - timeW - 40)
    ctx.font = `700 ${nameSize}px ${FONT}`
    ctx.fillText(name, start, y + stripeH / 2 - 14)

    // Без полупрозрачности: она съедает контраст на средне-серых фонах. Иерархию держим размером и весом.
    ctx.direction = 'ltr' // HEX и время всегда слева направо, даже в арабском
    ctx.font = `400 34px ${FONT}`
    ctx.fillText(s.hex, start, y + stripeH / 2 + nameSize * 0.55 + 4)
    ctx.textAlign = alignEnd
    ctx.font = `400 40px ${FONT}`
    ctx.fillText(time, end, y + stripeH / 2)
    ctx.direction = rtl ? 'rtl' : 'ltr'
  })

  // Подпись-домен; на localhost и по IP (локальная разработка) — название приложения
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.textAlign = 'center'
  ctx.font = `500 32px ${FONT}`
  ctx.fillText(signature(), W / 2, H - FOOTER / 2)

  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
  }
  return canvas.convertToBlob({ type: 'image/png' })
}
