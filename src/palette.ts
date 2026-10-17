import { encode } from 'uqr'
import { hexToRgb, nearestColor, textColorFor } from './color'
import { APP_NAME, SITE_URL } from './config'
import { colorName, getLang, isRtl, t } from './i18n'
import type { Sample } from './storage'

const W = 1080
const H = 1920
const HEADER = 220
const FOOTER = 340 // рекламный блок: QR-код, название и адрес сервиса
// Поля под интерфейс сторис: сверху имя профиля, снизу строка ответа.
// Всё важное держим между ними, иначе реклама сервиса окажется под кнопками.
const SAFE_TOP = 170
const SAFE_BOTTOM = 230
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

const ACCENT = '#E8752A' // оранжевая точка прицела, как на иконке
const SITE_HOST = SITE_URL.replace(/^https?:\/\//, '')

// Перенос строки по ширине. В японском, китайском и тайском пробелов между словами нет — режем по символам.
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const spaced = text.includes(' ')
  const tokens = spaced ? text.split(' ') : [...text]
  const lines: string[] = []
  let line = ''
  for (const tok of tokens) {
    const next = line ? line + (spaced ? ' ' : '') + tok : tok
    if (ctx.measureText(next).width <= maxW || !line) line = next
    else {
      lines.push(line)
      line = tok
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    lines.length = maxLines
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S?$/, '…')
  }
  return lines
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// QR-код на белой подложке: тёмные модули на светлом читаются любой камерой
function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, maxSize: number): number {
  const { data, size } = encode(url, { ecc: 'M', border: 0 })
  const quiet = 2 // поле вокруг кода в модулях
  const cell = Math.floor(maxSize / (size + quiet * 2))
  const box = cell * (size + quiet * 2)
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, x, y, box, box, 18)
  ctx.fill()
  ctx.fillStyle = '#0d0d0d'
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (data[r][c]) ctx.fillRect(x + (quiet + c) * cell, y + (quiet + r) * cell, cell, cell)
    }
  }
  return box
}

// Знак whatacolor — прицел с оранжевой точкой
function drawMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = r * 0.26
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = ACCENT
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.36, 0, Math.PI * 2)
  ctx.fill()
}

// Нижний блок карточки — явная реклама сервиса: откуда цвета и где попробовать самому
function drawFooter(ctx: CanvasRenderingContext2D, rtl: boolean) {
  const y0 = H - SAFE_BOTTOM - FOOTER
  const pad = 72
  ctx.fillStyle = '#151517'
  ctx.fillRect(0, y0, W, FOOTER)

  const qrMax = 236
  const qrX = rtl ? W - pad - qrMax : pad
  const box = drawQr(ctx, `${SITE_URL}/?ref=card`, qrX, y0 + (FOOTER - qrMax) / 2, qrMax)

  const gap = 44
  const textW = W - pad * 2 - box - gap
  const textStart = rtl ? W - pad - box - gap : pad + box + gap
  ctx.textAlign = rtl ? 'right' : 'left'
  ctx.textBaseline = 'middle'

  // знак и название
  const markR = 24
  const markX = rtl ? textStart - markR : textStart + markR
  drawMark(ctx, markX, y0 + 82, markR)
  ctx.fillStyle = '#ffffff'
  ctx.font = `800 60px ${FONT}`
  ctx.direction = 'ltr'
  ctx.textAlign = rtl ? 'right' : 'left'
  ctx.fillText(APP_NAME, rtl ? textStart - markR * 2 - 18 : textStart + markR * 2 + 18, y0 + 84)
  ctx.direction = rtl ? 'rtl' : 'ltr'

  // откуда эти цвета
  ctx.fillStyle = 'rgba(255,255,255,0.6)'
  ctx.font = `500 30px ${FONT}`
  ctx.fillText(wrap(ctx, t('cardFound'), textW, 1)[0], textStart, y0 + 146)

  // призыв
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 34px ${FONT}`
  wrap(ctx, t('cardCta'), textW, 2).forEach((line, i) => ctx.fillText(line, textStart, y0 + 198 + i * 44))

  // адрес
  ctx.fillStyle = ACCENT
  ctx.font = `700 34px ${FONT}`
  ctx.direction = 'ltr'
  ctx.fillText(SITE_HOST, textStart, y0 + FOOTER - 46)
  ctx.direction = rtl ? 'rtl' : 'ltr'
}

export interface CardOptions {
  title?: string // название палитры вместо даты в шапке
  showTime?: boolean // время замера на полосах — только для палитры дня
}

export async function renderPalette(samples: Sample[], opts: CardOptions = {}): Promise<Blob> {
  const list = pickSamples(samples)
  const showTime = opts.showTime ?? !opts.title
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

  // Шапка: название палитры, а без него — дата словами
  const heading =
    opts.title || new Date(list[0]?.timestamp ?? Date.now()).toLocaleDateString(getLang(), { day: 'numeric', month: 'long' })
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.textAlign = alignStart
  fitText(ctx, heading, 700, 96, W - 144)
  ctx.fillText(heading, start, SAFE_TOP + HEADER / 2 + 8)

  const stripesTop = SAFE_TOP + HEADER
  const stripeH = (H - stripesTop - FOOTER - SAFE_BOTTOM) / list.length
  const pad = 72
  list.forEach((s, i) => {
    const y = stripesTop + i * stripeH
    ctx.fillStyle = s.hex
    // +1 убирает субпиксельные щели между полосами
    ctx.fillRect(0, Math.floor(y), W, Math.ceil(stripeH) + 1)

    const rgb = hexToRgb(s.hex)
    const fg = textColorFor(rgb)
    ctx.fillStyle = fg
    ctx.textAlign = alignStart
    const name = colorName(nearestColor(rgb))
    const time = showTime ? formatTime(s.timestamp) : ''
    ctx.font = `500 40px ${FONT}`
    const timeW = time ? ctx.measureText(time).width : 0
    const nameSize = fitText(ctx, name, 700, Math.min(64, stripeH * 0.34), W - pad * 2 - timeW - 40)
    ctx.font = `700 ${nameSize}px ${FONT}`
    ctx.fillText(name, start, y + stripeH / 2 - 14)

    // Без полупрозрачности: она съедает контраст на средне-серых фонах. Иерархию держим размером и весом.
    ctx.direction = 'ltr' // HEX и время всегда слева направо, даже в арабском
    ctx.font = `400 34px ${FONT}`
    ctx.fillText(s.hex, start, y + stripeH / 2 + nameSize * 0.55 + 4)
    if (time) {
      ctx.textAlign = alignEnd
      ctx.font = `400 40px ${FONT}`
      ctx.fillText(time, end, y + stripeH / 2)
    }
    ctx.direction = rtl ? 'rtl' : 'ltr'
  })

  drawFooter(ctx, rtl)

  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
  }
  return canvas.convertToBlob({ type: 'image/png' })
}
