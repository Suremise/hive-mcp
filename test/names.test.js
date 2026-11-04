// MC-1485, MC-1486: the repo is combwork-mcp, the app is Combwork, and the zips use only Combwork's names. No tracked
// file says Hive but .gitignore's .hive/: Combwork 1.1.0 moves a workspace's .hive to .combwork, but leaves it where it
// can't (a file open in it, or both folders there). .agents and .hive are the app's own copies, not this repo's.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.join(__dirname, '..')
const KEPT = [
  /archive/gi // not a name (trilium's tests)
]

test('no tracked file names Hive, but .gitignore ignoring .hive/', () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
  assert.strictEqual(r.status, 0, r.stderr)
  const bad = []
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    if (/^\.(agents|hive)\//.test(f) || f === 'test/names.test.js') continue
    if (/hive/i.test(f)) bad.push(`${f}: its name`)
    const file = path.join(REPO, f)
    if (!fs.existsSync(file)) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (f === '.gitignore' && line.trim() === '.hive/') return
      if (/hive/i.test(KEPT.reduce((l, re) => l.replace(re, ''), line))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`)
    })
  }
  assert.deepStrictEqual(bad, [])
})
