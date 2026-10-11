// Confinement acceptance tests for host reads from the guest-written out folder.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { segments, outRoot, readFile, readLive, pinRoot, listOut, globMatcher, parsePid, hooks, PIN_NAME } = require('../confine')
const { scratch } = require('./helpers')

/** An out folder with a top-level file and a folder, and the outside secret. */
function outWith(name) {
  const s = scratch(name)
  const out = path.join(s.dir, 'out')
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(out, 'a.txt'), 'inside')
  fs.writeFileSync(path.join(out, 'logs', 'secret.txt'), 'inside-logs')
  return { s, out, secret: path.join(s.dir, 'outside', 'secret.txt'), root: outRoot(out) }
}
const attempt = fn => { try { fn(); return 'done' } catch (e) { return e.code } }
test.afterEach(() => { hooks.beforeOpen = null; hooks.afterOpen = null })

test('refused paths are rejected before any disk access', () => {
  const touched = []
  const spies = ['opendirSync', 'lstatSync', 'statSync', 'realpathSync', 'openSync', 'readdirSync', 'existsSync']
  const saved = spies.map(n => [n, fs[n]])
  for (const n of spies) fs[n] = (...a) => { touched.push(n); throw new Error('disk touched') }
  try {
    for (const p of ['..\\x', '../x', 'a/../../x', 'C:\\Users\\someone\\.codex\\auth.json', 'C:x', '\\\\server\\share\\f', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0', '/etc/passwd', 'a:stream', 'logs\\run.txt:secret', 'NUL', 'logs/con.txt', 'a/.../b', 'x.', '']) {
      const r = readFile('Z:\\never-used', p, 100)
      assert.ok(r.error && !/disk touched/.test(r.error), `${JSON.stringify(p)} → ${r.error}`)
      assert.throws(() => segments(p), `${p} accepted`)
    }
    for (const g of ['../**', '**/../x', 'C:\\**', '\\\\server\\*', 'a:*']) assert.throws(() => globMatcher(g), `glob ${g} accepted`)
  } finally {
    for (const [n, f] of saved) fs[n] = f
  }
  assert.deepStrictEqual(touched, [])
})

test('globs match a listing: * within a folder, ** across, case-insensitive', () => {
  const m = globMatcher('**/*.png')
  assert.ok(m('a.png') && m('shots/x/A.PNG') && !m('a.png.txt'))
  const n = globMatcher('logs/*.txt')
  assert.ok(n('logs/a.txt') && !n('logs/sub/a.txt') && !n('a.txt'))
  assert.ok(globMatcher('logs/**')('logs/a/b/c.txt'))
  assert.ok(globMatcher('r?n.log')('run.log'))
})

test('a symlink and a junction inside out pointing outside are skipped and reported, not read', () => {
  const s = scratch('confine-links')
  const out = path.join(s.dir, 'out')
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(out, 'logs', 'ok.txt'), 'fine')
  fs.symlinkSync(path.join(s.dir, 'outside', 'secret.txt'), path.join(out, 'logs', 'link.txt'), 'file')
  fs.symlinkSync(path.join(s.dir, 'home'), path.join(out, 'profile'), 'junction')
  const root = outRoot(out)

  const l = listOut(root)
  assert.deepStrictEqual(l.files, ['logs/ok.txt'])
  assert.deepStrictEqual(l.skipped.map(x => x.path).sort(), ['logs/link.txt', 'profile'])
  assert.ok(l.skipped.every(x => /link or reparse point/.test(x.reason)))

  for (const p of ['logs/link.txt', 'profile/.codex/auth.json', 'PROFILE\\.codex\\auth.json']) {
    const r = readFile(root, p, 1000)
    assert.match(r.error, /skipped: .* link or reparse point/, p)
    assert.ok(!r.buf)
  }
  assert.strictEqual(readFile(root, 'logs/ok.txt', 100).buf.toString(), 'fine')
})

test('an out folder that is itself a link is refused', () => {
  const s = scratch('confine-outlink')
  fs.symlinkSync(path.join(s.dir, 'outside'), path.join(s.dir, 'out'), 'junction')
  assert.throws(() => outRoot(path.join(s.dir, 'out')), /out folder is a link/)
})

test('a file larger than maxBytes is read only up to the cap (bytes read from disk, not just returned)', () => {
  const s = scratch('confine-cap')
  const out = path.join(s.dir, 'out')
  fs.mkdirSync(out)
  const fd = fs.openSync(path.join(out, 'big.bin'), 'w')
  fs.ftruncateSync(fd, 200 * 1024 * 1024) // 200 MB, sparse
  fs.closeSync(fd)
  let disk = 0
  const orig = fs.readSync
  fs.readSync = (...a) => { const n = orig(...a); disk += n; return n }
  try {
    const r = readFile(outRoot(out), 'big.bin', 100_000)
    assert.strictEqual(r.bytesRead, 100_000)
    assert.strictEqual(r.buf.length, 100_000)
    assert.strictEqual(r.truncated, true)
    assert.strictEqual(r.size, 200 * 1024 * 1024)
    assert.strictEqual(disk, 100_000)
  } finally {
    fs.readSync = orig
  }
})

test('listings are capped', () => {
  const s = scratch('confine-many')
  const out = path.join(s.dir, 'out')
  fs.mkdirSync(out)
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(out, `f${i}.txt`), '')
  const l = listOut(outRoot(out), { maxFiles: 10 })
  assert.strictEqual(l.files.length, 10)
  assert.strictEqual(l.truncated, true)
})

test('a PID file holding junk or an out-of-range number gives no PID', () => {
  for (const t of ['', 'abc', '12; calc', '-5', '0', '4', '1e5', '4294967296', '99999999999', '12 34', ' 1234x']) assert.strictEqual(parsePid(t), null, JSON.stringify(t))
  assert.strictEqual(parsePid('4242\r\n'), 4242)
})

// ---------- live reads (while the guest runs): top-level only, pinned, checked after open ----------

test('live: a nested path is refused without disk access (the folder could be swapped meanwhile)', () => {
  const touched = []
  const saved = ['opendirSync', 'lstatSync', 'openSync'].map(n => [n, fs[n]])
  for (const [n] of saved) fs[n] = () => { touched.push(n); throw new Error('disk touched') }
  try {
    const r = readLive('Z:\never-used', 'logs/secret.txt', 100)
    assert.match(r.error, /only files directly in the out folder .* after sandbox_stop/)
  } finally {
    for (const [n, f] of saved) fs[n] = f
  }
  assert.deepStrictEqual(touched, [])
})

test('live: a top-level file reads; links, the pin file and hard links are refused', () => {
  const { s, out, secret, root } = outWith('live-basic')
  assert.strictEqual(readLive(root, 'a.txt', 100).buf.toString(), 'inside')
  fs.symlinkSync(secret, path.join(out, 'link.txt'), 'file')
  assert.match(readLive(root, 'link.txt', 100).error, /skipped: "link.txt" is a link/)
  fs.linkSync(secret, path.join(out, 'hard.txt')) // a hard link to a file outside out
  const h = readLive(root, 'hard.txt', 100)
  assert.match(h.error, /other hard links/)
  assert.ok(!h.buf)
  fs.writeFileSync(path.join(out, PIN_NAME), '')
  assert.strictEqual(readLive(root, PIN_NAME, 100).error, 'not found')
  assert.strictEqual(readLive(root, 'nope.txt', 100).error, 'not found')
  void s
})

test('live: swapped for a link just before open → skipped, the outside file is not returned', () => {
  const { out, secret, root } = outWith('live-swap-before')
  hooks.beforeOpen = full => { fs.rmSync(full); fs.symlinkSync(secret, full, 'file') }
  const r = readLive(root, 'a.txt', 100)
  assert.match(r.error, /skipped: "a.txt" is a link/)
  assert.ok(!r.buf)
  void out
})

test('live: swapped to a link for the open and back to a plain file after it → refused (different file)', () => {
  const { secret, root } = outWith('live-swap-flip')
  hooks.beforeOpen = full => { fs.rmSync(full); fs.symlinkSync(secret, full, 'file') }
  hooks.afterOpen = full => { fs.rmSync(full); fs.writeFileSync(full, 'decoy') } // the link itself isn't pinned, so this works
  const r = readLive(root, 'a.txt', 100)
  assert.match(r.error, /skipped: the file changed while it was being opened/)
  assert.ok(!r.buf)
})

test('live: once open, the file can\'t be renamed, replaced or deleted (pinned)', () => {
  const { out, root } = outWith('live-pinned')
  const tries = {}
  hooks.afterOpen = full => {
    tries.rename = attempt(() => fs.renameSync(full, full + '.moved'))
    tries.delete = attempt(() => fs.rmSync(full))
    tries.write = attempt(() => fs.writeFileSync(full, 'changed'))
  }
  const r = readLive(root, 'a.txt', 100)
  assert.strictEqual(r.buf.toString(), 'inside')
  for (const [k, v] of Object.entries(tries)) assert.ok(['EBUSY', 'EPERM'].includes(v), `${k}: ${v}`)
  void out
})

test('live: a top-level folder swapped for a junction is listed as a skipped link, never descended into', () => {
  const { s, out, root } = outWith('live-list')
  fs.rmSync(path.join(out, 'logs'), { recursive: true })
  fs.symlinkSync(path.join(s.dir, 'home'), path.join(out, 'logs'), 'junction')
  const l = listOut(root, { depth: 0 })
  assert.deepStrictEqual(l.files, ['a.txt'])
  assert.deepStrictEqual(l.skipped.map(x => x.path), ['logs'])
  assert.ok(!JSON.stringify(l).includes('.codex'))
})

test('the out root pin: held open, the root can\'t be emptied, renamed or removed', () => {
  const { out } = outWith('pin-root')
  const fd = pinRoot(out)
  try {
    assert.ok(['EPERM', 'EBUSY'].includes(attempt(() => fs.rmSync(path.join(out, PIN_NAME)))))
    assert.ok(['EPERM', 'EBUSY', 'EACCES'].includes(attempt(() => fs.renameSync(out, out + '2'))))
    assert.ok(!listOut(outRoot(out), { depth: 0 }).files.includes(PIN_NAME))
  } finally {
    fs.closeSync(fd)
  }
})
