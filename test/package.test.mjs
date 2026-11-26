/**
 * Packaging guard.
 *
 * A byte-order mark at the start of `package.json` makes it invalid JSON for the
 * host loader ("Unexpected token '﻿'"), and the whole plugin shows up as
 * unavailable. Node's `JSON.parse` and most editors tolerate — and some editors
 * and shell tools cheerfully re-add — that prefix, so the check is on the raw
 * bytes rather than on a parse result.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Files the host loader reads as JSON or YAML at boot. */
const MANIFESTS = ['package.json', 'cordis.patch.yml']

function assertNoBom(file) {
  const bytes = fs.readFileSync(file)
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  assert.equal(hasBom, false, `${path.relative(root, file)} starts with a UTF-8 BOM`)
}

test('manifests carry no UTF-8 BOM', () => {
  for (const name of MANIFESTS) assertNoBom(path.join(root, name))
})

test('package.json parses as written on disk', () => {
  const file = path.join(root, 'package.json')
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(text.charCodeAt(0) === 0xfeff, false, 'package.json decodes with a BOM')
  const manifest = JSON.parse(text)
  assert.equal(manifest.name, '@local/dsh-mys-checkin')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  // The host needs both halves declared, or the plugin silently loses its UI.
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string')
})

test('every JSON file in the package parses without a BOM', () => {
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      assertNoBom(full)
      JSON.parse(fs.readFileSync(full, 'utf8'))
    }
  }
})
