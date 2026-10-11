// test/clean-scratch.js: earlier runs' folders go; a running test's folder and anything the suite's scratch() didn't
// make stay. Each test works in its own folder under the scratch root and removes it after.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { cleanScratch, TARGETS } = require('./clean-scratch')

const ROOT = process.env.CLEAN_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'clean-scratch-tests')
const WSB = TARGETS['windows-sandbox'].marker
const OLLAMA = TARGETS.ollama.marker

/** An empty base for one test, removed when it ends. */
function base(t, name) {
  const dir = path.join(ROOT, `${process.pid}-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A folder named `name` in b, holding these marker files and some output. */
function make(b, name, marker = []) {
  fs.mkdirSync(path.join(b, name, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(b, name, 'sub', 'x.txt'), 'x')
  for (const f of marker) { fs.mkdirSync(path.dirname(path.join(b, name, f)), { recursive: true }); fs.writeFileSync(path.join(b, name, f), 'x') }
}

test('windows-sandbox: removes earlier runs\' folders, keeps a running one and anything else', t => {
  const b = base(t, 'wsb')
  make(b, '111-1-srv-off', WSB)
  make(b, '111-2-confine-cap', WSB)
  make(b, '222-7-roots-given', WSB)
  make(b, '333-1-still-going', WSB)
  make(b, 'notes', WSB)
  make(b, '2026-10-11-notes') // named like scratch()'s but not made by it
  fs.writeFileSync(path.join(b, '444-1-a-file'), 'x')
  assert.deepStrictEqual(cleanScratch(b, { marker: WSB, isRunning: pid => pid === 333 }), { removed: 3, running: 1, failed: [] })
  assert.deepStrictEqual(fs.readdirSync(b).sort(), ['2026-10-11-notes', '333-1-still-going', '444-1-a-file', 'notes'])
})

test('ollama: removes earlier runs\' folders with both its markers; one with only one of them stays', t => {
  const b = base(t, 'ollama')
  make(b, '24128-1-roots', OLLAMA)
  make(b, '24128-9-models', OLLAMA)
  make(b, '555-1-still-going', OLLAMA)
  make(b, '666-1-half', [OLLAMA[0]])
  make(b, '777-1-wsb-like', WSB) // another suite's folder, if both were pointed at one place
  assert.deepStrictEqual(cleanScratch(b, { marker: OLLAMA, isRunning: pid => pid === 555 }), { removed: 2, running: 1, failed: [] })
  assert.deepStrictEqual(fs.readdirSync(b).sort(), ['555-1-still-going', '666-1-half', '777-1-wsb-like'])
})

test('a missing folder is nothing to clean', t => {
  const b = path.join(base(t, 'missing'), 'nope')
  assert.deepStrictEqual(cleanScratch(b, { marker: WSB, isRunning: () => false }), { removed: 0, running: 0, failed: [] })
  assert.strictEqual(fs.existsSync(b), false)
})

test('this process counts as running with the default check', t => {
  const b = base(t, 'self')
  make(b, `${process.pid}-1-mine`, OLLAMA)
  assert.deepStrictEqual(cleanScratch(b, { marker: OLLAMA }), { removed: 0, running: 1, failed: [] })
})

test('a live pid on a folder untouched for over an hour is a reused pid: the folder goes', t => {
  const b = base(t, 'reused')
  make(b, `${process.pid}-1-old`, WSB)
  const later = Date.now() + 2 * 60 * 60 * 1000
  assert.deepStrictEqual(cleanScratch(b, { marker: WSB, isRunning: () => true, now: later }), { removed: 1, running: 0, failed: [] })
  assert.deepStrictEqual(fs.readdirSync(b), [])
})

test('the suites\' scratch folders are the ones their tests write to', () => {
  assert.strictEqual(TARGETS['windows-sandbox'].base, require('../servers/windows-sandbox/test/helpers').BASE)
  // The ollama test takes TARGETS.ollama.base itself; its default is unchanged.
  assert.strictEqual(TARGETS.ollama.base, process.env.OLLAMA_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'ollama-tests'))
})
