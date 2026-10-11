// clean-scratch.js: earlier runs' folders go; a running test's folder and anything scratch() didn't make stay.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch } = require('./helpers')
const { cleanScratch } = require('./clean-scratch')

test('removes earlier runs\' folders, keeps a running one and anything else', () => {
  const base = path.join(scratch('clean').dir, 'base')
  const make = (name, stub = true) => {
    fs.mkdirSync(path.join(base, name, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(base, name, 'sub', 'x.txt'), 'x')
    if (stub) fs.writeFileSync(path.join(base, name, 'stub.json'), '{}')
  }
  make('111-1-srv-off')
  make('111-2-confine-cap')
  make('222-7-roots-given')
  make('333-1-still-going')
  make('notes')
  make('2026-10-11-notes', false) // named like scratch()'s but not made by it
  fs.writeFileSync(path.join(base, '444-1-a-file'), 'x')
  const r = cleanScratch(base, pid => pid === 333)
  assert.deepStrictEqual(r, { removed: 3, running: 1, failed: [] })
  assert.deepStrictEqual(fs.readdirSync(base).sort(), ['2026-10-11-notes', '333-1-still-going', '444-1-a-file', 'notes'])
})

test('a missing folder is nothing to clean', () => {
  const base = path.join(scratch('clean-missing').dir, 'nope')
  assert.deepStrictEqual(cleanScratch(base, () => false), { removed: 0, running: 0, failed: [] })
  assert.strictEqual(fs.existsSync(base), false)
})

test('this process counts as running with the default check', () => {
  const base = path.join(scratch('clean-self').dir, 'base')
  fs.mkdirSync(path.join(base, `${process.pid}-1-mine`), { recursive: true })
  fs.writeFileSync(path.join(base, `${process.pid}-1-mine`, 'stub.json'), '{}')
  assert.deepStrictEqual(cleanScratch(base), { removed: 0, running: 1, failed: [] })
})

test('a live pid on a folder untouched for over an hour is a reused pid: the folder goes', () => {
  const base = path.join(scratch('clean-reused').dir, 'base')
  const dir = path.join(base, `${process.pid}-1-old`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stub.json'), '{}')
  const later = Date.now() + 2 * 60 * 60 * 1000
  assert.deepStrictEqual(cleanScratch(base, () => true, later), { removed: 1, running: 0, failed: [] })
  assert.strictEqual(fs.existsSync(dir), false)
})
