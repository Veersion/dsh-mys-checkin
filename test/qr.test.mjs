import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeQr, qrSvgDataUrl } from '../lib/qr.js'

// Independent copies of the standard tables, so a typo in the encoder's copy
// cannot silently validate itself.
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
}

const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292,
  10: 346, 11: 404, 12: 466, 13: 532, 14: 581, 15: 655,
}

const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 3, 15: 3 }

const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]], 11: [30, [[1, 50], [4, 51]]], 12: [22, [[6, 36], [2, 37]]],
  13: [22, [[8, 37], [1, 38]]], 14: [24, [[4, 40], [5, 41]]], 15: [24, [[5, 41], [5, 42]]],
}

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value
    LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255]
})()

function mul(left, right) {
  if (left === 0 || right === 0) return 0
  return EXP[LOG[left] + LOG[right]]
}

function functionMap(version) {
  const size = version * 4 + 17
  const reserved = new Uint8Array(size * size)
  const reserve = (row, col) => {
    if (row >= 0 && col >= 0 && row < size && col < size) reserved[row * size + col] = 1
  }
  for (const [row, col] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dr = -1; dr <= 7; dr += 1) for (let dc = -1; dc <= 7; dc += 1) reserve(row + dr, col + dc)
  }
  for (const row of ALIGNMENT[version]) {
    for (const col of ALIGNMENT[version]) {
      if (row === 6 && col === 6) continue
      if (reserved[row * size + col] === 1) continue
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) reserve(row + dr, col + dc)
    }
  }
  for (let index = 8; index < size - 8; index += 1) {
    reserve(index, 6)
    reserve(6, index)
  }
  for (let index = 0; index < 9; index += 1) {
    reserve(8, index)
    reserve(index, 8)
  }
  for (let index = 0; index < 8; index += 1) {
    reserve(8, size - 1 - index)
    reserve(size - 1 - index, 8)
  }
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      reserve(Math.floor(index / 3), (index % 3) + size - 11)
      reserve((index % 3) + size - 11, Math.floor(index / 3))
    }
  }
  return { size, reserved }
}

function readFormat(matrix) {
  const { size, modules } = matrix
  let bits = 0
  for (let index = 0; index < 15; index += 1) {
    let dark
    if (index < 6) dark = modules[index * size + 8]
    else if (index < 8) dark = modules[(index + 1) * size + 8]
    else dark = modules[(size - 15 + index) * size + 8]
    if (dark === 1) bits |= 1 << index
  }
  const data = (bits ^ 0b101010000010010) >> 10
  return { level: data >> 3, mask: data & 7 }
}

function readCodewords(matrix, version) {
  const { size, reserved } = functionMap(version)
  const { modules } = matrix
  const format = readFormat(matrix)
  assert.equal(format.level, 0b00, 'format info must say level M')

  const bits = []
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let column = 0; column < 2; column += 1) {
        const col = right - column
        if (reserved[row * size + col] === 1) continue
        let value = modules[row * size + col]
        const [r, c] = [row, col]
        const mask = [
          (r + c) % 2 === 0,
          r % 2 === 0,
          c % 3 === 0,
          (r + c) % 3 === 0,
          (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
          ((r * c) % 2) + ((r * c) % 3) === 0,
          (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
          (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
        ][format.mask]
        if (mask) value ^= 1
        bits.push(value)
      }
    }
    upward = !upward
  }

  const bytes = []
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset]
    bytes.push(byte)
  }
  return { bytes, mask: format.mask, dataModules: bits.length }
}

function deinterleave(bytes, version) {
  const [ecLength, groups] = BLOCKS[version]
  const layout = []
  for (const [count, length] of groups) for (let index = 0; index < count; index += 1) layout.push(length)

  const blocks = layout.map((length) => ({ data: new Array(length).fill(0), ec: new Array(ecLength).fill(0) }))
  let cursor = 0
  const maxData = Math.max(...layout)
  for (let index = 0; index < maxData; index += 1) {
    for (const block of blocks) if (index < block.data.length) block.data[index] = bytes[cursor++]
  }
  for (let index = 0; index < ecLength; index += 1) {
    for (const block of blocks) block.ec[index] = bytes[cursor++]
  }

  for (const block of blocks) {
    const codeword = [...block.data, ...block.ec]
    for (let power = 0; power < ecLength; power += 1) {
      let acc = 0
      for (const byte of codeword) acc = mul(acc, EXP[power]) ^ byte
      assert.equal(acc, 0, `RS syndrome ${power} must vanish`)
    }
  }
  return blocks.flatMap((block) => block.data)
}

function decodeText(matrix) {
  const version = (matrix.size - 17) / 4
  const { bytes, mask, dataModules } = readCodewords(matrix, version)
  assert.equal(dataModules, 8 * TOTAL_CODEWORDS[version] + REMAINDER_BITS[version], 'data module count must match the version capacity')
  const data = deinterleave(bytes, version)

  const bits = []
  for (const byte of data) for (let offset = 7; offset >= 0; offset -= 1) bits.push((byte >> offset) & 1)
  const take = (count) => {
    let value = 0
    for (let index = 0; index < count; index += 1) value = (value << 1) | bits.shift()
    return value
  }
  const mode = take(4)
  assert.equal(mode, 0b0100, 'byte mode marker')
  const length = take(version <= 9 ? 8 : 16)
  const out = []
  for (let index = 0; index < length; index += 1) out.push(take(8))
  return { text: new TextDecoder().decode(Uint8Array.from(out)), version, mask }
}

test('QR round-trips short payloads', () => {
  for (const text of ['hello', 'https://user.mihoyo.com/qr_login/?app_id=bll8iq97cem8&ticket=abc', '米游社扫码登录']) {
    const matrix = encodeQr(text)
    const decoded = decodeText(matrix)
    assert.equal(decoded.text, text)
  }
})

test('QR round-trips a long login URL at every supported version boundary', () => {
  const base = 'https://user.mihoyo.com/qr_login/?app_id=bll8iq97cem8&ticket='
  for (const length of [1, 20, 60, 90, 120, 160, 200, 240]) {
    const text = base + 'x'.repeat(length)
    const matrix = encodeQr(text)
    const decoded = decodeText(matrix)
    assert.equal(decoded.text, text, `length ${length} at version ${decoded.version}`)
  }
})

test('QR matrix has valid finder and timing patterns', () => {
  const { size, modules } = encodeQr('https://example.com/scan')
  const at = (row, col) => modules[row * size + col] === 1
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(at(top, left), true, 'finder corner')
    assert.equal(at(top + 1, left + 1), false, 'finder separator')
    assert.equal(at(top + 3, left + 3), true, 'finder core')
  }
  for (let index = 8; index < size - 8; index += 1) {
    assert.equal(at(6, index), index % 2 === 0, 'horizontal timing')
    assert.equal(at(index, 6), index % 2 === 0, 'vertical timing')
  }
  assert.equal(at(size - 8, 8), true, 'dark module')
})

test('QR rejects oversized payloads instead of producing garbage', () => {
  assert.throws(() => encodeQr('x'.repeat(600)), /过长/)
})

test('qrSvgDataUrl returns a self-contained SVG image', () => {
  const url = qrSvgDataUrl('https://example.com', { scale: 4, margin: 2 })
  assert.match(url, /^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8')
  assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /<path d="M/)
})
