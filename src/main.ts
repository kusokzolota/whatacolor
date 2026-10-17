import './style.css'
import { fromLinear, hexToRgb, medianRgb, nearestColor, nearestPaints, rgbToHex, toLinear, type RGB } from './color'
import { APP_NAME, DONATE_URL } from './config'
import { colorName, getLang, LANGS, isRtl, setLang, t, tf, type Key } from './i18n'
import { formatTime, renderPalette } from './palette'
import {
  clearGains,
  dateStamp,
  DRAFT_MAX,
  LIBRARY_MAX,
  loadDraft,
  loadFacing,
  loadGains,
  loadLibrary,
  loadPalettes,
  pushSample,
  saveDraft,
  saveFacing,
  saveGains,
  saveLibrary,
  savePalettes,
  storageFailed,
  type Facing,
  type Gains,
  type Palette,
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
const saveBtn = $('save-btn')
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
const AUTO_PERIOD = 2000 // как часто пересчитывать поправку
const AUTO_NEAR_MAX = 0.9 // берём пиксели не темнее 90% от самого светлого в кадре
const AUTO_MIN_PATCH = 0.002 // и только если таких набралось хотя бы столько от кадра
const AUTO_MIN_LUMA = 80 // темнее — судить не по чему
const AUTO_MAX_SPREAD = 110 // перекос сильнее — это уже не оттенок света
const AUTO_SMOOTH = 0.6 // сглаживание между пересчётами
// Поправки считаются в линейном свете, как в камерах и эндоскопах: это множители яркости каналов.
// Авто осторожная (±~20% в привычных единицах экрана), ручная по листу — широкая.
const AUTO_MIN = 0.65
const AUTO_MAX = 1.5
const MANUAL_MIN = 0.2
const MANUAL_MAX = 5
// Лист офисной бумаги не идеально белый: отражает около 90% света. К этому значению его и приводим,
// а не к чистому #FFFFFF — иначе всё пересвечивается и светлые цвета сливаются.
const PAPER: RGB = [0xf3, 0xf3, 0xf2]
const PAPER_MIN_LUMA = 70 // темнее — света мало для калибровки
const PAPER_MAX_UNEVEN = 0.12 // разброс яркости внутри рамки: тени, блики, край листа
const PAPER_MAX_TINT = 3.5 // во сколько раз один канал ярче другого — так белое не выглядит даже под лампой
const PALETTE_MIN = 3

let stream: MediaStream | null = null
let facing: Facing = loadFacing()
let manualGains: Gains | null = loadGains(facing) // по белому листу, сохраняется
let autoGains: Gains | null = null // по светлому пятну кадра, не сохраняется между запусками
let library: Sample[] = loadLibrary() // все замеры
let draft: Sample[] = loadDraft() // палитра, которую собирают сейчас
let palettes: Palette[] = loadPalettes()
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
  return [fromLinear(toLinear(r) * k.r), fromLinear(toLinear(g) * k.g), fromLinear(toLinear(b) * k.b)]
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

// Лист внутри рамки калибровки: медиана по каналам (блик или пылинка её не сдвинут)
// и неровность освещения — разброс яркости относительно средней.
function readPaper(x: number, y: number, w: number, h: number): { median: RGB; uneven: number } {
  frameCtx.drawImage(video, x, y, w, h, 0, 0, frameCanvas.width, frameCanvas.height)
  const d = frameCtx.getImageData(0, 0, frameCanvas.width, frameCanvas.height).data
  let sum = 0
  let sq = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    sum += l
    sq += l * l
  }
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean))
  return { median: medianRgb(d), uneven: mean ? sd / mean : 1 }
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

// Автокалибровка по светлому пятну кадра.
// Серый мир (среднее по всему кадру) врёт в одноцветной обстановке: в зелёной операционной
// он считает зелень перекосом камеры, душит зелёный канал — и всё белое уходит в розовый.
// Опираемся вместо этого на самые светлые пиксели: в реальной сцене это почти всегда
// что-то белое или серое — потолок, бумага, плитка, халат.
let autoRun = 0
let autoTimer = 0

function brightPatch(): RGB | null {
  if (!videoReady()) return null
  const w = frameCanvas.width
  const h = frameCanvas.height
  frameCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, w, h)
  const d = frameCtx.getImageData(0, 0, w, h).data
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    luma[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  }
  // Доля от кадра тут не годится: если белого пятна мало, в выборку попадёт фон.
  // Поэтому отсчитываем от самого светлого пикселя.
  let maxLuma = 0
  for (let i = 0; i < n; i++) if (luma[i] > maxLuma) maxLuma = luma[i]
  if (maxLuma < AUTO_MIN_LUMA) return null
  const cut = maxLuma * AUTO_NEAR_MAX
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    if (luma[i] < cut) continue
    r += d[i * 4]
    g += d[i * 4 + 1]
    b += d[i * 4 + 2]
    count++
  }
  return count >= n * AUTO_MIN_PATCH ? [r / count, g / count, b / count] : null
}

// Ориентира в кадре нет — плавно возвращаемся к нулевой поправке, чтобы прошлая
// (например, снятая под тёплой лампой) не красила следующую сцену.
function relaxAutoGains() {
  if (!autoGains) return
  const back = (a: number) => a + (1 - a) * AUTO_SMOOTH
  const next: Gains = { r: back(autoGains.r), g: back(autoGains.g), b: back(autoGains.b) }
  const done = [next.r, next.g, next.b].every((v) => Math.abs(v - 1) < 0.01)
  autoGains = done ? null : next
  renderMode()
  current = null
}

function updateAutoGains() {
  if (manualGains || openModals.size) return
  const patch = brightPatch()
  if (!patch) return relaxAutoGains()
  const [pr, pg, pb] = patch
  // Слишком темно, чтобы судить о белом
  if (0.2126 * pr + 0.7152 * pg + 0.0722 * pb < AUTO_MIN_LUMA) return relaxAutoGains()
  // Оттенок освещения всегда лежит на оси «тёплый — холодный»: либо R ≥ G ≥ B (лампа накаливания),
  // либо B ≥ G ≥ R (тень, облака). Цветной предмет перекашивает каналы иначе — например,
  // у зелёного халата максимум в середине. Такое пятно за белый ориентир не принимаем.
  const warmToCool = (pr >= pg && pg >= pb) || (pb >= pg && pg >= pr)
  if (!warmToCool) return relaxAutoGains()
  if (Math.max(pr, pg, pb) - Math.min(pr, pg, pb) > AUTO_MAX_SPREAD) return relaxAutoGains()

  const lin = [toLinear(pr), toLinear(pg), toLinear(pb)]
  const target = (lin[0] + lin[1] + lin[2]) / 3
  const k = (m: number) => clamp(target / Math.max(m, 1e-4), AUTO_MIN, AUTO_MAX)
  const next: Gains = { r: k(lin[0]), g: k(lin[1]), b: k(lin[2]) }
  const mix = (a: number, b2: number) => a + (b2 - a) * AUTO_SMOOTH
  autoGains = autoGains
    ? { r: mix(autoGains.r, next.r), g: mix(autoGains.g, next.g), b: mix(autoGains.b, next.b) }
    : next
  renderMode()
  current = null
}

async function autoCalibrate() {
  const run = ++autoRun
  clearInterval(autoTimer)
  autoGains = null
  renderMode()
  for (let i = 0; i < 50 && !videoReady(); i++) await sleep(100)
  await sleep(600) // даём камере устаканить экспозицию, потом фиксируем
  if (run !== autoRun) return
  await lockCamera()
  if (run !== autoRun) return
  updateAutoGains()
  // Сцена меняется, пока ходишь с телефоном, поэтому поправку пересчитываем регулярно
  autoTimer = window.setInterval(() => {
    if (run === autoRun) updateAutoGains()
  }, AUTO_PERIOD)
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

// ---------- Замеры и текущая палитра ----------

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
  saveDraft(draft)
  refreshCameraUi()
}

function refreshCameraUi() {
  saveBtn.hidden = draft.length < PALETTE_MIN
  hint.hidden = draft.length > 0
  shutter.classList.toggle('full', draft.length >= DRAFT_MAX)
  const last = library[library.length - 1]
  libraryThumb.style.background = last ? last.hex : ''
  libraryThumb.classList.toggle('filled', !!last)
}

// Полоска внизу — палитра, которую собирают сейчас: цвета плюс пустые места до шести
function renderRibbon(newest = false) {
  const chips = draft.map((s, i) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'chip'
    el.style.background = s.hex
    el.setAttribute('role', 'listitem')
    el.setAttribute('aria-label', `${sampleName(s)}, ${s.hex}`)
    if (newest && i === draft.length - 1) el.classList.add('new')
    bindChip(el, s)
    return el
  })
  const slots = Array.from({ length: Math.max(0, DRAFT_MAX - draft.length) }, () => {
    const el = document.createElement('span')
    el.className = 'chip slot'
    el.setAttribute('aria-hidden', 'true')
    return el
  })
  ribbon.replaceChildren(...chips, ...slots)
}

function capture() {
  if (!current) return
  if (draft.length >= DRAFT_MAX) {
    navigator.vibrate?.([20, 60, 20])
    showToast(t('paletteFull'))
    return
  }
  const last = library[library.length - 1]
  // timestamp служит идентификатором записи — делаем его уникальным
  const timestamp = Math.max(Date.now(), (last?.timestamp ?? 0) + 1)
  const sample: Sample = { hex: current.hex, name: colorName(nearestColor(current.rgb)), timestamp }
  library = pushSample(library, sample) // в историю попадает каждый замер
  draft = [...draft, sample]
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
  $('detail-meta').replaceChildren(ltr(s.hex))
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

// Свайп вверх убирает цвет только из собираемой палитры — в истории он остаётся
function removeFromDraft(ts: number) {
  draft = draft.filter((x) => x.timestamp !== ts)
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
      setTimeout(() => removeFromDraft(s.timestamp), 200)
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
  // Пока не откалибровано по листу — заметная кнопка «Калибровать». Авто работает тихо, как подстраховка.
  modeBtn.textContent = t(manualGains ? 'modeSheet' : 'calibrateBtn')
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

// Калибровка по белому листу, как в хирургических эндоскопах: камера смотрит на заведомо белое,
// и мы находим множители каналов, которые делают его нейтральным. Дальше они применяются ко всем замерам.
$('calib-done').addEventListener('click', async () => {
  if (!videoReady()) return
  await lockCamera()
  const r = screenRectToVideo(calibFrame.getBoundingClientRect())
  const { median, uneven } = readPaper(r.x, r.y, r.w, r.h)
  const [mr, mg, mb] = median
  // Проверяем, что в рамке действительно ровно освещённый белый лист, иначе калибровка испортит цвета
  if (0.2126 * mr + 0.7152 * mg + 0.0722 * mb < PAPER_MIN_LUMA) return showToast(t('calibTooDark'))
  if (uneven > PAPER_MAX_UNEVEN) return showToast(t('calibUneven'))
  const lin = median.map((c) => Math.max(toLinear(c), 1e-4))
  if (Math.max(...lin) / Math.min(...lin) > PAPER_MAX_TINT) return showToast(t('calibNotWhite'))

  const target = PAPER.map(toLinear)
  const k = (i: number) => clamp(target[i] / lin[i], MANUAL_MIN, MANUAL_MAX)
  manualGains = { r: k(0), g: k(1), b: k(2) }
  saveGains(facing, manualGains)
  renderMode()
  navigator.vibrate?.(30)
  closeCalib()
  showToast(t('calibOk'))
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
  renderPalettes()
  libraryList.scrollTop = 0
  paletteList.scrollTop = 0
  setTab(libTab)
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

// Одно окно подтверждения на все необратимые действия
let onConfirm: (() => void) | null = null
function openConfirm(text: string, yes: string, action: () => void) {
  hideMenu()
  $('confirm-text').textContent = text
  $('confirm-yes').textContent = yes
  onConfirm = action
  confirmHost.hidden = false
}
function closeConfirm() {
  confirmHost.hidden = true
  onConfirm = null
}
$('confirm-no').addEventListener('click', closeConfirm)
confirmHost.addEventListener('click', (e) => {
  if (e.target === confirmHost) closeConfirm()
})
$('confirm-yes').addEventListener('click', () => {
  const action = onConfirm
  closeConfirm()
  action?.()
})

// Очищаем историю замеров; сохранённые палитры и текущая палитра не трогаются
$('library-clear').addEventListener('click', () => {
  openConfirm(t('clearConfirm'), t('clearYes'), () => {
    library = []
    persist()
    renderLibrary()
    navigator.vibrate?.(30)
  })
})

// ---------- Карточка палитры для шеринга ----------

const paletteOverlay = $('palette')
const paletteImg = $<HTMLImageElement>('palette-img')
let paletteBlob: Blob | null = null
let paletteUrl = ''
let cardTitle = ''
let cardColors: string[] = []

function paletteFileName() {
  // Имя файла из названия палитры: буквы любого алфавита, цифры и дефисы
  const slug = cardTitle
    .toLocaleLowerCase(getLang())
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${APP_NAME}-${slug || dateStamp()}.png`
}

// Цветные полосы, HEX, название палитры и мелко адрес сайта — готово для сторис и мессенджеров
async function showCard(title: string, colors: string[]) {
  hideDetail()
  cardTitle = title
  cardColors = colors
  const base = Date.now()
  paletteBlob = await renderPalette(
    colors.map((hex, i) => ({ hex, name: '', timestamp: base + i })),
    { title },
  )
  if (paletteUrl) URL.revokeObjectURL(paletteUrl)
  paletteUrl = URL.createObjectURL(paletteBlob)
  paletteImg.src = paletteUrl
  paletteOverlay.hidden = false
  pauseFor('palette')
}

function closeCard() {
  paletteOverlay.hidden = true
  resumeFor('palette')
}

$('palette-close').addEventListener('click', closeCard)

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

// HEX тех же цветов, что на карточке
$('palette-copy').addEventListener('click', async () => {
  const text = cardColors.join('\n')
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
      await navigator.share({ files: [file], title: `${APP_NAME} — ${cardTitle}` })
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') download()
    }
  } else {
    download()
  }
})

// ---------- Сохранение палитры ----------

const saveHost = $('save')
const nameInput = $<HTMLInputElement>('palette-name')

function stripes(colors: string[]) {
  return colors.map((hex) => {
    const el = document.createElement('span')
    el.style.background = hex
    return el
  })
}

saveBtn.addEventListener('click', () => {
  if (draft.length < PALETTE_MIN) return
  $('save-preview').replaceChildren(...stripes(draft.map((s) => s.hex)))
  nameInput.value = ''
  openSheet(saveHost)
  setTimeout(() => nameInput.focus(), 250)
})

$('save-cancel').addEventListener('click', () => closeSheet(saveHost))

$('save-form').addEventListener('submit', (e) => {
  e.preventDefault()
  if (draft.length < PALETTE_MIN) return
  const name = nameInput.value.trim() || t('untitled')
  const palette: Palette = { id: Date.now(), name, colors: draft.map((s) => s.hex), createdAt: Date.now() }
  palettes = [palette, ...palettes]
  savePalettes(palettes)
  draft = []
  persist()
  renderRibbon()
  nameInput.blur()
  closeSheet(saveHost)
  navigator.vibrate?.(30)
  showToast(tf('paletteSaved', { name }))
  // Сразу показываем карточку — ради неё палитру обычно и собирают
  showCard(palette.name, palette.colors)
})

// ---------- Мои палитры ----------

const tabPalettes = $('tab-palettes')
const tabHistory = $('tab-history')
const panePalettes = $('pane-palettes')
const paneHistory = $('pane-history')
const paletteList = $('palette-list')
const palettesEmpty = $('palettes-empty')
const paletteView = $('palette-view')
const pvColors = $('pv-colors')
let libTab: 'palettes' | 'history' = 'palettes'
let openPalette: Palette | null = null

function setTab(tab: 'palettes' | 'history') {
  libTab = tab
  hideMenu()
  tabPalettes.setAttribute('aria-selected', String(tab === 'palettes'))
  tabHistory.setAttribute('aria-selected', String(tab === 'history'))
  panePalettes.hidden = tab !== 'palettes'
  paneHistory.hidden = tab !== 'history'
  $('library-count').hidden = tab !== 'history'
}

tabPalettes.addEventListener('click', () => setTab('palettes'))
tabHistory.addEventListener('click', () => setTab('history'))

function renderPalettes() {
  closePaletteView()
  palettesEmpty.hidden = palettes.length > 0
  paletteList.hidden = !palettes.length
  paletteList.replaceChildren(
    ...palettes.map((p) => {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'pal-card'
      const head = document.createElement('span')
      head.className = 'pal-card-head'
      const name = document.createElement('span')
      name.className = 'pal-card-name'
      name.textContent = p.name
      const date = document.createElement('span')
      date.className = 'pal-card-date'
      date.textContent = dateLabel(p.createdAt)
      head.append(name, date)
      const bar = document.createElement('span')
      bar.className = 'stripes'
      bar.append(...stripes(p.colors))
      card.append(head, bar)
      card.addEventListener('click', () => showPaletteView(p))
      return card
    }),
  )
}

function closePaletteView() {
  openPalette = null
  paletteView.hidden = true
  paletteList.hidden = !palettes.length
  palettesEmpty.hidden = palettes.length > 0
}

// Экран палитры: цвета списком, у каждого — своё меню
function showPaletteView(p: Palette) {
  openPalette = p
  paletteList.hidden = true
  palettesEmpty.hidden = true
  paletteView.hidden = false
  $('pv-name').textContent = p.name
  pvColors.replaceChildren(...p.colors.map(colorItem))
  pvColors.scrollTop = 0
}

function colorItem(hex: string) {
  const item = document.createElement('div')
  item.className = 'pv-item'

  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'lib-row'
  const square = document.createElement('span')
  square.className = 'lib-square'
  square.style.background = hex
  const text = document.createElement('span')
  text.className = 'lib-text'
  const name = document.createElement('span')
  name.className = 'lib-name'
  name.textContent = colorName(nearestColor(hexToRgb(hex)))
  const code = document.createElement('span')
  code.className = 'lib-hex'
  code.textContent = hex
  text.append(name, code)
  row.append(square, text, document.createElement('span'))

  // Меню цвета: копирование и необязательная подсказка «Похожие краски»
  const more = document.createElement('div')
  more.className = 'pv-more'
  more.hidden = true
  const actions = document.createElement('div')
  actions.className = 'pv-more-actions'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'pill soft compact'
  copyBtn.textContent = t('copyHex')
  const paintsBtn = document.createElement('button')
  paintsBtn.type = 'button'
  paintsBtn.className = 'pill soft compact'
  paintsBtn.textContent = t('similarPaints')
  actions.append(copyBtn, paintsBtn)
  const paints = document.createElement('div')
  paints.hidden = true
  more.append(actions, paints)

  row.addEventListener('click', () => {
    const opening = more.hidden
    pvColors.querySelectorAll<HTMLElement>('.pv-item').forEach((el) => {
      el.classList.remove('open')
      el.querySelector<HTMLElement>('.pv-more')!.hidden = true
    })
    if (opening) {
      item.classList.add('open')
      more.hidden = false
    }
  })
  copyBtn.addEventListener('click', async () => {
    if (await copyText(hex)) {
      navigator.vibrate?.(15)
      showToast(tf('copied', { hex }))
    } else {
      showToast(`${t('copyFailed')}: ${hex}`)
    }
  })
  paintsBtn.addEventListener('click', () => {
    if (!paints.hidden) {
      paints.hidden = true
      return
    }
    paints.replaceChildren(...paintRows(hex))
    paints.hidden = false
  })

  item.append(row, more)
  return item
}

// Три ближайшие краски RAL. Близость словами, а не числом ΔE — так понятнее.
function paintRows(hex: string): HTMLElement[] {
  const rows = nearestPaints(hexToRgb(hex), 3).map(({ paint, dE }) => {
    const row = document.createElement('div')
    row.className = 'paint'
    const sw = document.createElement('span')
    sw.className = 'paint-swatch'
    sw.style.background = paint.hex
    const text = document.createElement('span')
    text.className = 'lib-text'
    const code = document.createElement('span')
    code.className = 'paint-code'
    code.textContent = paint.code
    const name = document.createElement('span')
    name.className = 'paint-name'
    name.textContent = paint.name
    text.append(code, name)
    const match = document.createElement('span')
    match.className = 'paint-match'
    match.textContent = t(dE < 3 ? 'matchExact' : dE < 6 ? 'matchClose' : 'matchApprox')
    row.append(sw, text, match)
    return row
  })
  const note = document.createElement('p')
  note.className = 'paints-note'
  note.textContent = t('paintsNote')
  return [...rows, note]
}

$('pv-back').addEventListener('click', closePaletteView)

$('pv-share').addEventListener('click', () => {
  if (openPalette) showCard(openPalette.name, openPalette.colors)
})

$('pv-delete').addEventListener('click', () => {
  const p = openPalette
  if (!p) return
  openConfirm(tf('deletePaletteConfirm', { name: p.name }), t('delete'), () => {
    palettes = palettes.filter((x) => x.id !== p.id)
    savePalettes(palettes)
    renderPalettes()
    navigator.vibrate?.(30)
  })
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
  document.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh as Key)
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
  // Закрываем самое верхнее: карточка может лежать поверх библиотеки
  if (!paletteOverlay.hidden) closeCard()
  else if (!confirmHost.hidden) closeConfirm()
  else if (!rowMenu.hidden) hideMenu()
  else if (!saveHost.hidden) closeSheet(saveHost)
  else if (!libraryHost.hidden && openPalette) closePaletteView()
  else if (!libraryHost.hidden) closeSheet(libraryHost)
  else if (!langHost.hidden) closeSheet(langHost)
  else if (!donateHost.hidden) closeSheet(donateHost)
  else if (!calibOverlay.hidden) closeCalib()
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
