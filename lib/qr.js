/**
 * Small QR Code encoder (byte mode, error-correction level M, versions 1–15).
 *
 * Only what the login flow needs: about a hundred bytes of URL, scanned from a
 * phone at close range. Levels and versions beyond that are deliberately absent
 * so the tables stay auditable.
 *
 * The implementation follows ISO/IEC 18004: bit stream → Reed–Solomon blocks →
 * matrix with function patterns → best of the eight data masks.
 */

/** Reed–Solomon block layout and EC codewords per block, level M, versions 1–15. */
const BLOCKS_M = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
  11: { ec: 30, groups: [[1, 50], [4, 51]] },
  12: { ec: 22, groups: [[6, 36], [2, 37]] },
  13: { ec: 22, groups: [[8, 37], [1, 38]] },
  14: { ec: 24, groups: [[4, 40], [5, 41]] },
  15: { ec: 24, groups: [[5, 41], [5, 42]] },
}

/** Alignment pattern centre coordinates, versions 1–15. */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
}

// Galois field GF(256) with the QR primitive polynomial x^8+x^4+x^3+x^2+1.
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value
    GF_LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) GF_EXP[index] = GF_EXP[index - 255]
})()

function gfMul(left, right) {
  if (left === 0 || right === 0) return 0
  return GF_EXP[GF_LOG[left] + GF_LOG[right]]
}

function rsGenerator(degree) {
  let poly = [1]
  for (let index = 0; index < degree; index += 1) {
    const alpha = GF_EXP[index]
    const next = new Array(poly.length + 1).fill(0)
    for (let term = 0; term < poly.length; term += 1) {
      next[term] ^= poly[term]
      next[term + 1] ^= gfMul(poly[term], alpha)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLength) {
  const generator = rsGenerator(ecLength)
  const buffer = new Uint8Array(data.length + ecLength)
  buffer.set(data)
  for (let index = 0; index < data.length; index += 1) {
    const factor = buffer[index]
    if (factor === 0) continue
    for (let term = 1; term < generator.length; term += 1) {
      buffer[index + term] ^= gfMul(generator[term], factor)
    }
  }
  return buffer.subarray(data.length)
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text)
}

function characterCountBits(version) {
  return version <= 9 ? 8 : 16
}

function dataCapacity(version) {
  const block = BLOCKS_M[version]
  return block.groups.reduce((total, [count, length]) => total + count * length, 0)
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 15; version += 1) {
    const overhead = 4 + characterCountBits(version)
    if (overhead + byteLength * 8 <= dataCapacity(version) * 8) return version
  }
  return null
}

class BitBuffer {
  constructor() {
    this.bits = []
  }

  push(value, length) {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1)
    }
  }
}

function buildCodewords(version, bytes) {
  const buffer = new BitBuffer()
  buffer.push(0b0100, 4)
  buffer.push(bytes.length, characterCountBits(version))
  for (const byte of bytes) buffer.push(byte, 8)

  const capacityBits = dataCapacity(version) * 8
  const terminator = Math.min(4, capacityBits - buffer.bits.length)
  buffer.push(0, terminator)
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0)

  const data = new Uint8Array(dataCapacity(version))
  for (let index = 0; index < buffer.bits.length; index += 8) {
    let value = 0
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | buffer.bits[index + bit]
    data[index / 8] = value
  }
  let pad = 0
  for (let index = buffer.bits.length / 8; index < data.length; index += 1) {
    data[index] = pad % 2 === 0 ? 0xec : 0x11
    pad += 1
  }
  return data
}

/** Split data into blocks, append EC codewords, and interleave both streams. */
function interleave(version, data) {
  const block = BLOCKS_M[version]
  const blocks = []
  let offset = 0
  for (const [count, length] of block.groups) {
    for (let index = 0; index < count; index += 1) {
      const slice = data.subarray(offset, offset + length)
      offset += length
      blocks.push({ data: slice, ec: rsRemainder(slice, block.ec) })
    }
  }

  const out = []
  const maxData = Math.max(...blocks.map((item) => item.data.length))
  for (let index = 0; index < maxData; index += 1) {
    for (const item of blocks) if (index < item.data.length) out.push(item.data[index])
  }
  for (let index = 0; index < block.ec; index += 1) {
    for (const item of blocks) out.push(item.ec[index])
  }
  return Uint8Array.from(out)
}

function bitLength(value) {
  let length = 0
  let rest = value
  while (rest !== 0) {
    rest >>>= 1
    length += 1
  }
  return length
}

function bchRemainder(value, poly, polyBits) {
  let remainder = value
  while (bitLength(remainder) > polyBits) {
    // Align the generator's top bit (at `polyBits`) with the remainder's top bit.
    remainder ^= poly << (bitLength(remainder) - polyBits - 1)
  }
  return remainder
}

function formatBits(mask) {
  const data = (0b00 << 3) | mask // level M = 00
  const rem = bchRemainder(data << 10, 0b10100110111, 10)
  return ((data << 10) | rem) ^ 0b101010000010010
}

function versionBits(version) {
  const rem = bchRemainder(version << 12, 0b1111100100101, 12)
  return (version << 12) | rem
}

const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

/**
 * Build the full module matrix for one mask.
 * `null` marks an unset module; function patterns are written first.
 */
function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17
  const modules = new Int8Array(size * size).fill(-1)

  const set = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return
    modules[row * size + col] = dark ? 1 : 0
  }
  const isSet = (row, col) => modules[row * size + col] !== -1

  const finder = (row, col) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = row + dr
        const c = col + dc
        if (r < 0 || c < 0 || r >= size || c >= size) continue
        const onRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6))
          || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6))
        const onCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        set(r, c, onRing || onCore)
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  // Alignment squares go down before the timing lines: a centre that sits on a
  // timing line (versions 7+) replaces that stretch of it, which is what the
  // spec draws.
  for (const row of ALIGNMENT[version]) {
    for (const col of ALIGNMENT[version]) {
      if (row === 6 && col === 6) continue
      if (isSet(row, col)) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)
          set(row + dr, col + dc, dark)
        }
      }
    }
  }

  for (let index = 8; index < size - 8; index += 1) {
    if (!isSet(index, 6)) set(index, 6, index % 2 === 0)
    if (!isSet(6, index)) set(6, index, index % 2 === 0)
  }

  const bits = formatBits(mask)
  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >> index) & 1) === 1
    if (index < 6) set(index, 8, dark)
    else if (index < 8) set(index + 1, 8, dark)
    else set(size - 15 + index, 8, dark)

    if (index < 8) set(8, size - index - 1, dark)
    else if (index < 9) set(8, 15 - index, dark)
    else set(8, 15 - index - 1, dark)
  }
  set(size - 8, 8, true)

  if (version >= 7) {
    const value = versionBits(version)
    for (let index = 0; index < 18; index += 1) {
      const dark = ((value >> index) & 1) === 1
      set(Math.floor(index / 3), (index % 3) + size - 11, dark)
      set((index % 3) + size - 11, Math.floor(index / 3), dark)
    }
  }

  // Data placement: two-module columns, bottom-up then top-down, skipping the
  // vertical timing column and every function module.
  let bit = 0
  const totalBits = codewords.length * 8
  const maskFn = MASKS[mask]
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let column = 0; column < 2; column += 1) {
        const col = right - column
        if (isSet(row, col)) continue
        let dark = false
        if (bit < totalBits) {
          dark = ((codewords[bit >> 3] >> (7 - (bit & 7))) & 1) === 1
        }
        bit += 1
        modules[row * size + col] = (dark !== maskFn(row, col)) ? 1 : 0
      }
    }
    upward = !upward
  }

  return { size, modules }
}

function penalty({ size, modules }) {
  const at = (row, col) => modules[row * size + col] === 1
  let score = 0

  for (let row = 0; row < size; row += 1) {
    let run = 1
    for (let col = 1; col < size; col += 1) {
      if (at(row, col) === at(row, col - 1)) run += 1
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let col = 0; col < size; col += 1) {
    let run = 1
    for (let row = 1; row < size; row += 1) {
      if (at(row, col) === at(row - 1, col)) run += 1
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const first = at(row, col)
      if (first === at(row, col + 1) && first === at(row + 1, col) && first === at(row + 1, col + 1)) {
        score += 3
      }
    }
  }

  const finderA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const finderB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const window = new Array(11)
  const matches = (get, start) => {
    for (let index = 0; index < 11; index += 1) window[index] = get(start + index) ? 1 : 0
    const isA = finderA.every((value, index) => window[index] === value)
    if (isA) return true
    return finderB.every((value, index) => window[index] === value)
  }
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col <= size - 11; col += 1) {
      if (matches((index) => at(row, index), col)) score += 40
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row <= size - 11; row += 1) {
      if (matches((index) => at(index, col), row)) score += 40
    }
  }

  let dark = 0
  for (let index = 0; index < modules.length; index += 1) if (modules[index] === 1) dark += 1
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10
  return score
}

/**
 * Encode text into a QR matrix.
 *
 * @param {string} text
 * @returns {{version: number, size: number, modules: Uint8Array}}
 */
export function encodeQr(text) {
  const bytes = utf8Bytes(String(text))
  const version = chooseVersion(bytes.length)
  if (version === null) throw new RangeError('二维码内容过长，无法编码')
  const data = buildCodewords(version, bytes)
  const codewords = interleave(version, data)

  let best = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = buildMatrix(version, codewords, mask)
    const score = penalty(matrix)
    if (score < bestScore) {
      bestScore = score
      best = matrix
    }
  }
  return { version, size: best.size, modules: best.modules }
}

/**
 * Render text as a self-contained SVG data URL.
 *
 * A single path with one `M` per dark run keeps the payload small enough to
 * stay well inside the settings transport's message limits.
 */
export function qrSvgDataUrl(text, { scale = 6, margin = 3 } = {}) {
  const { size, modules } = encodeQr(text)
  const total = size + margin * 2
  const parts = []
  for (let row = 0; row < size; row += 1) {
    let col = 0
    while (col < size) {
      if (modules[row * size + col] !== 1) {
        col += 1
        continue
      }
      const start = col
      while (col < size && modules[row * size + col] === 1) col += 1
      parts.push(`M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * scale}" height="${total * scale}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
