// Иконки приложения: прицел на тёмном фоне. Рисуем попиксельно и пишем PNG без зависимостей.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const BG = [17, 19, 24]
const RING = [255, 255, 255]
const DOT = [232, 117, 42]

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
// сглаживание края: доля пикселя внутри фигуры
const edge = (d, r, w = 1) => Math.min(1, Math.max(0, (r - d) / w + 0.5))

function pixels(size) {
  const c = size / 2
  const ringR = size * 0.3
  const ringW = size * 0.075
  const dotR = size * 0.1
  const buf = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    buf[p++] = 0 // фильтр строки
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      let col = BG
      const ring = Math.min(edge(d, ringR + ringW / 2), 1 - edge(d, ringR - ringW / 2))
      col = mix(col, RING, ring)
      col = mix(col, DOT, edge(d, dotR))
      buf[p++] = col[0]
      buf[p++] = col[1]
      buf[p++] = col[2]
      buf[p++] = 255
    }
  }
  return buf
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (b) => (b.reduce((c, v) => crcTable[(c ^ v) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}

function png(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(pixels(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size] of [
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  writeFileSync(name, png(size))
  console.log(name, size)
}
