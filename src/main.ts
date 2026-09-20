import './style.css'
import { hexToRgb, meanRgb, medianRgb, nearestColor, rgbToHex, type RGB } from './color'
import { APP_NAME, DONATE_URL } from './config'
import { colorName, getLang, LANGS, isRtl, setLang, t, tf, type Key } from './i18n'
import { formatTime, pickSamples, renderPalette } from './palette'
import {
  clearGains,
  dateStamp,
  isSameDay,
  LIBRARY_MAX,
  loadFacing,
  loadGains,
  loadLibrary,
  pushSample,
  saveFacing,
  saveGains,
  saveLibrary,
  storageFailed,
  type Facing,
  type Gains,
  type Sample,
} from './storage'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const video = $<HTMLVideoElement>('video')
const live = $('live')
const liveSwatch = $('live-swatch')
const liveName = $('live-name')
const liveHex = $('live-hex')
const ribbon = $('ribbon')
const hint = $('hint')
const detail = $('detail')
const paletteBtn = $('palette-btn')
const shutter = $('shutter')
const modeBtn = $('mode-btn')
const libraryThumb = $('library-thumb')
const flipBtn = $('flip-btn')
const calibOverlay = $('calib')
const calibFrame = $('calib-frame')
const errorOverlay = $('error')
const bottom = $('bottom')
const toast = $('toast')
const announcer = $('announcer')

const SAMPLE = 20 // сторона области замера в пикселях видео
const INTERVAL = 100 // не чаще 10 замеров в секунду
const PALETTE_MIN = 4
const AUTO_FRAMES = 10
const AUTO_MIN = 0.7
const AUTO_MAX = 1.4
const MANUAL_MIN = 0.5
const MANUAL_MAX = 2.0

let stream: MediaStream | null = null
let facing: Facing = loadFacing()
let manualGains: Gains | null = loadGains(facing) // по белому листу, сохраняется
let autoGains: Gains | null = null // серый мир, считается заново при каждом старте камеры
let library: Sample[] = loadLibrary()
let current: { rgb: RGB; hex: string } | null = null
let errorKeys: [Key, Key] | null = null

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- Замер ----------

const sampleCanvas = document.createElement('canvas')
sampleCanvas.width = SAMPLE
sampleCanvas.height = SAMPLE
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true })!

const frameCanvas = document.createElement('canvas')
frameCanvas.width = 64
frameCanvas.height = 64
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })!

// Ручная калибровка важнее автоматической
function activeGains(): Gains | null {
  return manualGains ?? autoGains
}

function applyGains([r, g, b]: RGB): RGB {
  const k = activeGains()
  if (!k) return [r, g, b]
  const c = (v: number) => clamp(Math.round(v), 0, 255)
  return [c(r * k.r), c(g * k.g), c(b * k.b)]
}

// Прямоугольник экрана → прямоугольник в координатах кадра (с учётом object-fit: cover).
function screenRectToVideo(rect: DOMRect) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const cw = video.clientWidth
  const ch = video.clientHeight
  const scale = Math.max(cw / vw, ch / vh)
  const ox = (cw - vw * scale) / 2
  const oy = (ch - vh * scale) / 2
  return { x: (rect.left - ox) / scale, y: (rect.top - oy) / scale, w: rect.width / scale, h: rect.height / scale }
}

function videoReady() {
  return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2
}

function readCenter(): RGB | null {
  if (!videoReady()) return null
  const vw = video.videoWidth
  const vh = video.videoHeight
  sampleCtx.drawImage(video, (vw - SAMPLE) / 2, (vh - SAMPLE) / 2, SAMPLE, SAMPLE, 0, 0, SAMPLE, SAMPLE)
  return medianRgb(sampleCtx.getImageData(0, 0, SAMPLE, SAMPLE).data)
}

// Средние по каналам в прямоугольнике кадра (по умолчанию — весь кадр)
function readMean(x = 0, y = 0, w = video.videoWidth, h = video.videoHeight): RGB {
  frameCtx.drawImage(video, x, y, w, h, 0, 0, frameCanvas.width, frameCanvas.height)
  return meanRgb(frameCtx.getImageData(0, 0, frameCanvas.width, frameCanvas.height).data)
}

let storageWarned = false
let lastSample = 0
function loop(now: number) {
  requestAnimationFrame(loop)
  if (openModals.size || now - lastSample < INTERVAL) return
  lastSample = now
  const raw = readCenter()
  if (!raw) return
  const rgb = applyGains(raw)
  const hex = rgbToHex(rgb)
  if (current?.hex === hex) return
  const name = colorName(nearestColor(rgb))
  current = { rgb, hex }
  liveSwatch.style.background = hex
  liveHex.textContent = hex
  if (liveName.textContent !== name) liveName.textContent = name
}

// ---------- Камера ----------

async function startCamera(): Promise<boolean> {
  errorOverlay.hidden = true
  errorKeys = null
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('errUnavailableTitle', window.isSecureContext ? 'errNoBrowser' : 'errInsecure')
    return false
  }
  try {
    stream?.getTracks().forEach((tr) => tr.stop())
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    // Фронталку зеркалим, как в обычном селфи. Центр кадра от зеркала не меняется, замер тот же.
    const actual = stream.getVideoTracks()[0]?.getSettings().facingMode
    video.classList.toggle('mirrored', (actual ?? facing) === 'user')
    video.srcObject = stream
    if (!openModals.size) await video.play().catch(() => {})
    requestWakeLock()
    updateFlipButton()
    autoCalibrate()
    return true
  } catch (e) {
    const name = (e as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') showError('errDeniedTitle', 'errDenied')
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') showError('errNotFoundTitle', 'errNotFound')
    else if (name === 'NotReadableError') showError('errBusyTitle', 'errBusy')
    else showError('errGenericTitle', 'errGeneric')
    return false
  }
}

function showError(title: Key, text: Key) {
  errorKeys = [title, text]
  $('error-title').textContent = t(title)
  $('error-text').textContent = t(text)
  errorOverlay.hidden = false
}

// Фиксируем баланс белого и экспозицию: 'manual' держит текущие значения,
// 'single-shot' — один раз подстраивается и держит. Не поддерживается — молча продолжаем.
async function lockCamera() {
  const track = stream?.getVideoTracks()[0]
  if (!track) return
  let caps: Record<string, unknown> = {}
  try {
    caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
  } catch {
    return
  }
  for (const key of ['whiteBalanceMode', 'exposureMode']) {
    const modes = caps[key]
    if (!Array.isArray(modes)) continue
    const mode = modes.includes('manual') ? 'manual' : modes.includes('single-shot') ? 'single-shot' : null
    if (!mode) continue
    try {
      await track.applyConstraints({ advanced: [{ [key]: mode } as MediaTrackConstraintSet] })
    } catch {
      /* не поддерживается */
    }
  }
}

function nextFrame(): Promise<void> {
  return new Promise((res) => {
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => res())
    else setTimeout(res, 50)
  })
}

// Автокалибровка «серый мир»: 10 кадров, средние по каналам всего кадра,
// gain = средняя яркость / среднее канала, осторожный диапазон 0.7–1.4.
let autoRun = 0
let autoRetries = 0
async function autoCalibrate(isRetry = false) {
  const run = ++autoRun
  if (!isRetry) autoRetries = 0
  autoGains = null
  renderMode()
  // ждём первые кадры и даём камере устаканить экспозицию, потом фиксируем
  for (let i = 0; i < 50 && !videoReady(); i++) await sleep(100)
  await sleep(600)
  if (run !== autoRun) return
  await lockCamera()

  const acc = [0, 0, 0]
  let frames = 0
  for (let tries = 0; frames < AUTO_FRAMES && tries < AUTO_FRAMES * 4; tries++) {
    await Promise.race([nextFrame(), sleep(120)])
    if (run !== autoRun) return
    if (!videoReady()) continue
    const [r, g, b] = readMean()
    if (r + g + b < 15) continue // чёрные кадры прогрева камеры не считаем
    acc[0] += r
    acc[1] += g
    acc[2] += b
    frames++
  }
  if (run !== autoRun) return
  if (!frames) {
    // кадры были чёрными (закрыт объектив, темнота) — попробуем ещё раз попозже
    if (autoRetries < 5) {
      autoRetries++
      setTimeout(() => autoCalibrate(true), 2000)
    }
    return
  }
  const [r, g, b] = acc.map((v) => v / frames)
  const target = (r + g + b) / 3
  const k = (m: number) => clamp(target / Math.max(m, 1), AUTO_MIN, AUTO_MAX)
  autoGains = { r: k(r), g: k(g), b: k(b) }
  renderMode()
  current = null
}

let wakeLock: WakeLockSentinel | null = null
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => (wakeLock = null))
    }
  } catch {
    /* ignore */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  requestWakeLock()
  const track = stream?.getVideoTracks()[0]
  if (stream && (!track || track.readyState === 'ended')) startCamera()
  else if (!openModals.size) video.play().catch(() => {})
})

$('error-retry').addEventListener('click', () => startCamera())

// ---------- Экраны поверх камеры ----------

// Пока открыт экран с размытием, видео на паузе: размывается неподвижный кадр, и это дёшево.
const openModals = new Set<string>()
const closeTimers = new Map<HTMLElement, number>()

function pauseFor(id: string) {
  openModals.add(id)
  video.pause()
}

function resumeFor(id: string) {
  openModals.delete(id)
  if (!openModals.size) video.play().catch(() => {})
}

function openSheet(host: HTMLElement) {
  clearTimeout(closeTimers.get(host))
  hideDetail()
  host.hidden = false
  void host.offsetWidth // фиксируем начальное состояние, чтобы переход отыграл
  host.classList.add('open')
  pauseFor(host.id)
}

function closeSheet(host: HTMLElement) {
  host.classList.remove('open')
  closeTimers.set(host, window.setTimeout(() => (host.hidden = true), 240))
  resumeFor(host.id)
}

// Тап по затемнению вокруг листа закрывает его
for (const host of document.querySelectorAll<HTMLElement>('.sheet-host')) {
  host.addEventListener('click', (e) => {
    if (e.target === host) closeSheet(host)
  })
}

let toastTimer = 0
function showToast(text: string) {
  toast.textContent = text
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1500)
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // запасной путь для браузеров без Clipboard API
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

// ---------- Замеры и лента за сегодня ----------

function todaySamples(): Sample[] {
  const now = Date.now()
  return library.filter((s) => isSameDay(s.timestamp, now))
}

function ltr(text: string) {
  const el = document.createElement('bdi')
  el.dir = 'ltr'
  el.textContent = text
  return el
}

// Название считаем по HEX заново — так оно следует за выбранным языком.
function sampleName(s: Sample) {
  return colorName(nearestColor(hexToRgb(s.hex)))
}

function persist() {
  saveLibrary(library)
  refreshCameraUi()
}

function refreshCameraUi() {
  const today = todaySamples()
  paletteBtn.hidden = today.length < PALETTE_MIN
  hint.hidden = today.length > 0
  const last = library[library.length - 1]
  libraryThumb.style.background = last ? last.hex : ''
  libraryThumb.classList.toggle('filled', !!last)
}

function renderRibbon(newest = false) {
  const today = todaySamples()
  ribbon.replaceChildren(
    ...today.map((s, i) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'chip'
      el.style.background = s.hex
      el.setAttribute('role', 'listitem')
      el.setAttribute('aria-label', `${sampleName(s)}, ${s.hex}, ${formatTime(s.timestamp)}`)
      if (newest && i === today.length - 1) el.classList.add('new')
      bindChip(el, s)
      return el
    }),
  )
  // В RTL лента растёт влево, и scrollLeft там отрицательный
  if (newest) ribbon.scrollTo({ left: isRtl() ? -ribbon.scrollWidth : ribbon.scrollWidth, behavior: 'smooth' })
}

function capture() {
  if (!current) return
  const last = library[library.length - 1]
  // timestamp служит идентификатором записи — делаем его уникальным
  const timestamp = Math.max(Date.now(), (last?.timestamp ?? 0) + 1)
  library = pushSample(library, { hex: current.hex, name: colorName(nearestColor(current.rgb)), timestamp })
  persist()
  renderRibbon(true)
  navigator.vibrate?.(30)
  announcer.textContent = tf('savedColor', { name: sampleName(library[library.length - 1]), hex: current.hex })
  if (storageFailed() && !storageWarned) {
    storageWarned = true
    showToast(t('storageOff'))
  }
  shutter.classList.remove('snap')
  void shutter.offsetWidth // перезапуск анимации при быстрых повторных нажатиях
  shutter.classList.add('snap')
  live.classList.add('pulse')
  setTimeout(() => live.classList.remove('pulse'), 250)
}

shutter.addEventListener('click', () => {
  hideDetail()
  capture()
})
shutter.addEventListener('animationend', () => shutter.classList.remove('snap'))

// Тап по видео замер не делает — только закрывает карточку цвета
$('tap-layer').addEventListener('click', hideDetail)

let detailTimer = 0
function showDetail(s: Sample, chip: HTMLElement) {
  $('detail-swatch').style.background = s.hex
  $('detail-name').textContent = sampleName(s)
  $('detail-meta').replaceChildren(ltr(s.hex), ' · ', ltr(formatTime(s.timestamp)))
  detail.hidden = false
  live.hidden = true // на невысоких экранах карточка иначе наезжает на плашку
  ribbon.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'))
  chip.classList.add('selected')
  clearTimeout(detailTimer)
  detailTimer = window.setTimeout(hideDetail, 4000)
}

function hideDetail() {
  detail.hidden = true
  if (calibOverlay.hidden) live.hidden = false
  ribbon.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'))
}

function removeSample(ts: number) {
  library = library.filter((x) => x.timestamp !== ts)
  persist()
  hideDetail()
  renderRibbon()
}

// Тап — детали, свайп вверх — удалить. Горизонтальный скролл ленты остаётся нативным (touch-action: pan-x).
function bindChip(el: HTMLElement, s: Sample) {
  let sx = 0
  let sy = 0
  let dy = 0
  let active = false

  const reset = () => {
    active = false
    el.classList.remove('dragging')
    el.style.transform = ''
    el.style.opacity = ''
  }
  el.addEventListener('pointerdown', (e) => {
    active = true
    sx = e.clientX
    sy = e.clientY
    dy = 0
    el.classList.add('dragging')
    el.setPointerCapture(e.pointerId)
  })
  el.addEventListener('pointermove', (e) => {
    if (!active) return
    const dx = e.clientX - sx
    dy = Math.min(0, e.clientY - sy)
    if (Math.abs(dx) > 24 && Math.abs(dx) > -dy) {
      reset()
      return
    }
    el.style.transform = `translateY(${dy}px)`
    el.style.opacity = String(Math.max(0.2, 1 + dy / 120))
  })
  el.addEventListener('pointerup', (e) => {
    if (!active) return
    const moved = Math.hypot(e.clientX - sx, e.clientY - sy)
    if (dy < -50) {
      active = false
      el.classList.remove('dragging')
      el.style.transform = 'translateY(-120px)'
      el.style.opacity = '0'
      navigator.vibrate?.(15)
      setTimeout(() => removeSample(s.timestamp), 200)
      return
    }
    reset()
    if (moved < 10) showDetail(s, el)
  })
  el.addEventListener('pointercancel', reset)
  // detail === 0 — клик с клавиатуры, мышиные и сенсорные обрабатываются выше
  el.addEventListener('click', (e) => {
    if (e.detail === 0) showDetail(s, el)
  })
}

// ---------- Калибровка ----------

function renderMode() {
  // «авто» показываем только когда коэффициенты действительно посчитаны
  modeBtn.textContent = t(manualGains ? 'modeSheet' : autoGains ? 'modeAuto' : 'modeNone')
  modeBtn.classList.toggle('sheet', !!manualGains)
  $('calib-reset').hidden = !manualGains
}

modeBtn.addEventListener('click', () => {
  hideDetail()
  calibOverlay.hidden = false
  live.hidden = true
  bottom.hidden = true
})

function closeCalib() {
  calibOverlay.hidden = true
  live.hidden = false
  bottom.hidden = false
  current = null // пересчитать плашку с новыми коэффициентами
}

$('calib-cancel').addEventListener('click', closeCalib)

$('calib-reset').addEventListener('click', () => {
  manualGains = null
  clearGains(facing)
  renderMode()
  closeCalib()
})

$('calib-done').addEventListener('click', async () => {
  if (!videoReady()) return
  await lockCamera()
  const r = screenRectToVideo(calibFrame.getBoundingClientRect())
  const [mr, mg, mb] = readMean(r.x, r.y, r.w, r.h)
  const k = (m: number) => clamp(255 / Math.max(m, 1), MANUAL_MIN, MANUAL_MAX)
  manualGains = { r: k(mr), g: k(mg), b: k(mb) }
  saveGains(facing, manualGains)
  renderMode()
  navigator.vibrate?.(30)
  closeCalib()
})

// ---------- Смена камеры ----------

let switching = false

// Кнопку показываем, только если камер больше одной. Место в ряду сохраняем, чтобы затвор оставался по центру.
async function updateFlipButton() {
  let many = false
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    many = devices.filter((d) => d.kind === 'videoinput').length > 1
  } catch {
    many = false
  }
  flipBtn.style.visibility = many ? '' : 'hidden'
}

function setFacing(f: Facing) {
  facing = f
  saveFacing(f)
  manualGains = loadGains(f)
  renderMode()
  current = null
}

flipBtn.addEventListener('click', async () => {
  if (switching) return
  switching = true
  hideDetail()
  const prev = facing
  setFacing(prev === 'user' ? 'environment' : 'user')
  navigator.vibrate?.(15)
  // Не вышло включить другую камеру — возвращаемся к прежней
  if (!(await startCamera())) {
    setFacing(prev)
    await startCamera()
  }
  switching = false
})

// ---------- Библиотека ----------

const libraryHost = $('library')
const libraryList = $('library-list')
const libraryEmpty = $('library-empty')
const rowMenu = $('row-menu')
const confirmHost = $('confirm')
let menuTs: number | null = null

function capitalize(s: string) {
  return s.charAt(0).toLocaleUpperCase(getLang()) + s.slice(1)
}

function dateLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (days === 0 || days === 1) {
    try {
      return capitalize(new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' }).format(-days, 'day'))
    } catch {
      /* старый браузер — покажем обычную дату */
    }
  }
  return capitalize(
    d.toLocaleDateString(getLang(), {
      day: 'numeric',
      month: 'long',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    }),
  )
}

function renderLibrary() {
  const items = [...library].reverse() // новые сверху
  $('library-count').textContent = `${library.length} / ${LIBRARY_MAX}`
  $<HTMLButtonElement>('library-copy').disabled = !items.length
  $<HTMLButtonElement>('library-clear').disabled = !items.length
  libraryEmpty.hidden = items.length > 0
  libraryList.hidden = !items.length

  const nodes: HTMLElement[] = []
  let lastDay = ''
  for (const s of items) {
    const day = dateStamp(new Date(s.timestamp))
    if (day !== lastDay) {
      lastDay = day
      const h = document.createElement('h3')
      h.className = 'lib-date'
      h.textContent = dateLabel(s.timestamp)
      nodes.push(h)
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'lib-row'
    row.dataset.ts = String(s.timestamp)

    const square = document.createElement('span')
    square.className = 'lib-square'
    square.style.background = s.hex

    const text = document.createElement('span')
    text.className = 'lib-text'
    const name = document.createElement('span')
    name.className = 'lib-name'
    name.textContent = sampleName(s)
    const hex = document.createElement('span')
    hex.className = 'lib-hex'
    hex.textContent = s.hex
    text.append(name, hex)

    const time = document.createElement('span')
    time.className = 'lib-time'
    time.textContent = formatTime(s.timestamp)

    row.append(square, text, time)
    nodes.push(row)
  }
  libraryList.replaceChildren(...nodes)
}

$('library-btn').addEventListener('click', () => {
  renderLibrary()
  libraryList.scrollTop = 0
  openSheet(libraryHost)
})
$('library-close').addEventListener('click', () => {
  hideMenu()
  closeSheet(libraryHost)
})

// Тап по строке — копировать HEX, долгий тап — меню «Удалить»
const LONG_PRESS = 500
let pressTimer = 0
let pressRow: HTMLElement | null = null
let pressX = 0
let pressY = 0
let suppressClick = false

function cancelPress() {
  clearTimeout(pressTimer)
  pressRow?.classList.remove('pressed')
  pressRow = null
}

libraryList.addEventListener('pointerdown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.lib-row')
  if (!row) return
  hideMenu()
  suppressClick = false
  pressRow = row
  pressX = e.clientX
  pressY = e.clientY
  row.classList.add('pressed')
  pressTimer = window.setTimeout(() => {
    suppressClick = true
    navigator.vibrate?.(20)
    showMenu(row)
    cancelPress()
  }, LONG_PRESS)
})
libraryList.addEventListener('pointermove', (e) => {
  if (pressRow && Math.hypot(e.clientX - pressX, e.clientY - pressY) > 10) cancelPress()
})
for (const type of ['pointerup', 'pointercancel']) libraryList.addEventListener(type, cancelPress)
// При прокрутке меню обязано исчезнуть: иначе оно останется висеть над другой строкой
libraryList.addEventListener('scroll', () => {
  cancelPress()
  hideMenu()
})

libraryList.addEventListener('click', async (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.lib-row')
  if (!row) return
  if (suppressClick) {
    suppressClick = false
    return
  }
  const s = library.find((x) => x.timestamp === Number(row.dataset.ts))
  if (!s) return
  if (await copyText(s.hex)) {
    navigator.vibrate?.(15)
    showToast(tf('copied', { hex: s.hex }))
  } else {
    showToast(`${t('copyFailed')}: ${s.hex}`)
  }
})

// Правый клик на десктопе открывает то же меню
libraryList.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const row = (e.target as HTMLElement).closest<HTMLElement>('.lib-row')
  if (row) {
    suppressClick = true
    showMenu(row)
  }
})

function showMenu(row: HTMLElement) {
  menuTs = Number(row.dataset.ts)
  const host = libraryHost.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  rowMenu.hidden = false
  const menuH = rowMenu.offsetHeight
  // под строкой, а если не помещается — над ней
  const below = r.bottom + 4 + menuH < host.bottom - 16
  rowMenu.style.top = `${(below ? r.bottom + 4 : r.top - menuH - 4) - host.top}px`
  rowMenu.style.insetInlineEnd = '24px'
}

function hideMenu() {
  rowMenu.hidden = true
  menuTs = null
}

// Любой тап мимо меню его закрывает
libraryHost.addEventListener(
  'pointerdown',
  (e) => {
    if (!rowMenu.hidden && !rowMenu.contains(e.target as Node)) hideMenu()
  },
  true,
)

$('row-delete').addEventListener('click', () => {
  if (menuTs === null) return
  const ts = menuTs
  hideMenu()
  library = library.filter((x) => x.timestamp !== ts)
  persist()
  renderLibrary()
  renderRibbon()
  navigator.vibrate?.(15)
})

$('library-copy').addEventListener('click', async () => {
  const text = [...library].reverse().map((s) => s.hex).join('\n')
  if (!text) return
  if (await copyText(text)) {
    navigator.vibrate?.(15)
    showToast(t('copiedAll'))
  } else {
    showToast(t('copyFailed'))
  }
})

$('library-clear').addEventListener('click', () => {
  hideMenu()
  confirmHost.hidden = false
})
$('confirm-no').addEventListener('click', () => (confirmHost.hidden = true))
confirmHost.addEventListener('click', (e) => {
  if (e.target === confirmHost) confirmHost.hidden = true
})
$('confirm-yes').addEventListener('click', () => {
  confirmHost.hidden = true
  library = []
  persist()
  renderLibrary()
  renderRibbon()
  navigator.vibrate?.(30)
})

// ---------- Палитра дня ----------

const paletteOverlay = $('palette')
const paletteImg = $<HTMLImageElement>('palette-img')
let paletteBlob: Blob | null = null
let paletteUrl = ''

function paletteFileName() {
  return `${APP_NAME}-${dateStamp()}.png`
}

paletteBtn.addEventListener('click', async () => {
  hideDetail()
  paletteBlob = await renderPalette(todaySamples())
  if (paletteUrl) URL.revokeObjectURL(paletteUrl)
  paletteUrl = URL.createObjectURL(paletteBlob)
  paletteImg.src = paletteUrl
  paletteOverlay.hidden = false
  pauseFor('palette')
})

$('palette-close').addEventListener('click', () => {
  paletteOverlay.hidden = true
  resumeFor('palette')
})

function download() {
  if (!paletteUrl) return
  const a = document.createElement('a')
  a.href = paletteUrl
  a.download = paletteFileName()
  document.body.appendChild(a)
  a.click()
  a.remove()
}

$('palette-download').addEventListener('click', download)

// HEX тех же цветов, что попали на картинку
$('palette-copy').addEventListener('click', async () => {
  const text = pickSamples(todaySamples())
    .map((s) => s.hex)
    .join('\n')
  if (!text) return
  if (await copyText(text)) {
    navigator.vibrate?.(15)
    showToast(t('copiedAll'))
  } else {
    showToast(t('copyFailed'))
  }
})

$('palette-share').addEventListener('click', async () => {
  if (!paletteBlob) return
  const file = new File([paletteBlob], paletteFileName(), { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${APP_NAME} — ${t('palette')}` })
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') download()
    }
  } else {
    download()
  }
})

// ---------- Язык ----------

const langHost = $('lang')
const langList = $('lang-list')

function applyI18n() {
  const root = document.documentElement
  root.lang = getLang()
  root.dir = isRtl() ? 'rtl' : 'ltr'
  document.title = APP_NAME
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as Key)
  })
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as Key))
  })
  document.querySelectorAll<HTMLElement>('[data-i18n-alt]').forEach((el) => {
    el.setAttribute('alt', t(el.dataset.i18nAlt as Key))
  })
  if (errorKeys) showError(...errorKeys)
  renderMode()
  renderRibbon()
  hideDetail()
  current = null // плашка перерисуется на новом языке со следующим замером
}

function renderLangList() {
  langList.replaceChildren(
    ...LANGS.map((l) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'lang-item' + (l.code === getLang() ? ' active' : '')
      b.lang = l.code
      b.textContent = l.native
      b.addEventListener('click', () => {
        setLang(l.code)
        applyI18n()
        closeSheet(langHost)
      })
      return b
    }),
  )
}

$('lang-btn').addEventListener('click', () => {
  renderLangList()
  openSheet(langHost)
})

// ---------- Пожертвования ----------

const donateHost = $('donate')
const donateGo = $<HTMLAnchorElement>('donate-go')

$('donate-btn').addEventListener('click', () => {
  donateGo.hidden = !DONATE_URL
  $('donate-soon').hidden = !!DONATE_URL
  if (DONATE_URL) donateGo.href = DONATE_URL
  openSheet(donateHost)
})
$('donate-close').addEventListener('click', () => closeSheet(donateHost))

// ---------- Смена суток ----------

// Лента и «Палитра дня» показывают сегодняшний день. Если приложение оставили открытым,
// в полночь их нужно перерисовать, иначе вчерашние цвета висят до следующего замера.
function scheduleMidnight() {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2).getTime()
  setTimeout(() => {
    renderRibbon()
    refreshCameraUi()
    if (!libraryHost.hidden) renderLibrary()
    scheduleMidnight()
  }, Math.max(1000, next - Date.now()))
}

// ---------- Клавиатура ----------

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!confirmHost.hidden) confirmHost.hidden = true
  else if (!rowMenu.hidden) hideMenu()
  else if (!libraryHost.hidden) closeSheet(libraryHost)
  else if (!langHost.hidden) closeSheet(langHost)
  else if (!donateHost.hidden) closeSheet(donateHost)
  else if (!paletteOverlay.hidden) {
    paletteOverlay.hidden = true
    resumeFor('palette')
  } else if (!calibOverlay.hidden) closeCalib()
  else if (!detail.hidden) hideDetail()
})

// ---------- Старт ----------

applyI18n()
refreshCameraUi()
scheduleMidnight()
startCamera()
requestAnimationFrame(loop)

// Офлайн: приложению не нужен интернет, кроме загрузки самих файлов
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}))
}
