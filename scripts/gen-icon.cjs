// 一次性脚本：用纯 Node（仅 zlib/fs，无图像库）生成 512x512 应用图标 PNG。
// 主题：三色耗时比例条（应用核心视觉）——蓝(直接)/橙(委派)/绿(算力)，叠在深色圆角底上。
// 用法：node scripts/gen-icon.cjs  →  build/icon.png
// electron-builder 接受 ≥256 的 PNG 并自动转 .ico，512 足够。
const fs = require('fs')
const zlib = require('zlib')

const W = 512
const H = 512
const buf = Buffer.alloc(W * H * 4, 0) // 全透明起始

// 深色主题类别色（取自 src/index.html 的 --cat-* 暗色变体，在深底上对比好）
const BG = [0x0e, 0x11, 0x16]
const DIRECT = [0x4c, 0x9f, 0xfb] // 蓝 直接
const DELEGATED = [0xf5, 0x9e, 0x0b] // 橙 委派
const COMPUTE = [0x34, 0xd3, 0x99] // 绿 算力

function blend(x, y, sr, sg, sb, sa) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 4
  const dr = buf[i]
  const dg = buf[i + 1]
  const db = buf[i + 2]
  const da = buf[i + 3] / 255
  const outa = sa + da * (1 - sa)
  if (outa <= 0) return
  buf[i] = Math.round((sr * sa + dr * da * (1 - sa)) / outa)
  buf[i + 1] = Math.round((sg * sa + dg * da * (1 - sa)) / outa)
  buf[i + 2] = Math.round((sb * sa + db * da * (1 - sa)) / outa)
  buf[i + 3] = Math.round(outa * 255)
}

// 圆角矩形：以 coverage 0..1 覆盖率做边缘抗锯齿混合
function roundRect(x0, y0, x1, y1, r, [cr, cg, cb]) {
  for (let y = Math.floor(y0 - 1); y < y1 + 1; y++) {
    for (let x = Math.floor(x0 - 1); x < x1 + 1; x++) {
      const fx = x + 0.5
      const fy = y + 0.5
      // 到最近角的距离
      let dx = 0
      let dy = 0
      if (fx < x0 + r) dx = x0 + r - fx
      else if (fx > x1 - r) dx = fx - (x1 - r)
      if (fy < y0 + r) dy = y0 + r - fy
      else if (fy > y1 - r) dy = fy - (y1 - r)
      let cov
      if (dx > 0 && dy > 0) {
        // 角区：圆覆盖
        const d = Math.sqrt(dx * dx + dy * dy)
        cov = Math.max(0, Math.min(1, r - d + 0.5))
      } else {
        // 边或内部
        cov = Math.max(0, Math.min(1, r - Math.max(dx, dy) + 0.5))
        if (dx === 0 && dy === 0) cov = 1
      }
      if (cov > 0) blend(x, y, cr, cg, cb, cov)
    }
  }
}

// 外层圆角方底（半径 ≈21%）
roundRect(0, 0, W, H, 110, BG)
// 三条比例条：等高、左对齐、递减宽度，垂直居中成组
const barH = 64
const gap = 28
const groupH = barH * 3 + gap * 2 // 248
const top = (H - groupH) / 2 // 132
const left = 96
const full = W - left * 2 // 320
roundRect(left, top, left + full * 1.0, top + barH, 32, DIRECT)
roundRect(left, top + barH + gap, left + full * 0.75, top + barH * 2 + gap, 32, DELEGATED)
roundRect(left, top + (barH + gap) * 2, left + full * 0.5, top + barH * 3 + gap * 2, 32, COMPUTE)

// ── PNG 编码（IHDR/IDAT/IEND + CRC32 + zlib deflate，无外部依赖） ──
function crc32Table() {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}
const CRC = crc32Table()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// 每行前加 filter byte 0
const rowLen = W * 4
const raw = Buffer.alloc((rowLen + 1) * H)
for (let y = 0; y < H; y++) {
  raw[y * (rowLen + 1)] = 0
  buf.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen)
}
const idat = zlib.deflateSync(raw, { level: 9 })

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
])

const out = 'build/icon.png'
fs.mkdirSync('build', { recursive: true })
fs.writeFileSync(out, png)
console.log(`written ${out} (${png.length} bytes, ${W}x${H} RGBA)`)
