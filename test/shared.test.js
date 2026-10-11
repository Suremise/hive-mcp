// shared/roots.js: the roots rules every server uses, and that each server's copy is the canonical one.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { isInside, parseRoots, profileRefusal, rootsClient, allowedRoots } = require('../shared/roots')

const REPO = path.join(__dirname, '..')
const names = { env: 'X_ALLOWED_ROOTS', cwd: 'X_ROOTS_FROM_CWD=1' }
const uri = p => pathToFileURL(p).href

function scratch(name) {
  const base = process.env.WSB_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'shared-tests')
  const dir = path.join(base, `${process.pid}-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const d of ['a/build', 'b/build', 'outside']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  return dir
}

test('every server ships the canonical shared/roots.js unchanged', () => {
  const canonical = fs.readFileSync(path.join(REPO, 'shared', 'roots.js'))
  const copies = fs.readdirSync(path.join(REPO, 'servers')).map(s => path.join(REPO, 'servers', s, 'roots.js')).filter(f => fs.existsSync(f))
  assert.ok(copies.length >= 1, 'no server has a copy')
  for (const f of copies) assert.ok(canonical.equals(fs.readFileSync(f)), `${path.relative(REPO, f)} differs from shared/roots.js: copy it again`)
})

test('parseRoots: file: URIs decoded (spaces, accents), others ignored, duplicates once', () => {
  const dir = path.resolve('C:\\work\\proj space é')
  const roots = parseRoots({ roots: [{ uri: uri(dir) }, { uri: 'https://example.com/x' }, { uri: 42 }, { uri: uri(dir).toUpperCase().replace('FILE:', 'file:') }, {}] })
  if (process.platform === 'win32') assert.deepStrictEqual(roots, [dir])
  assert.deepStrictEqual(parseRoots(null), [])
  assert.deepStrictEqual(parseRoots({ roots: 'nope' }), [])
})

test('isInside: the folder itself and below it, never a sibling with the same prefix', () => {
  assert.ok(isInside('C:\\a\\b', 'C:\\a'))
  assert.ok(isInside('C:\\a', 'C:\\a\\'))
  assert.ok(!isInside('C:\\ab', 'C:\\a'))
  if (process.platform === 'win32') assert.ok(isInside('c:\\A\\B', 'C:\\a'))
})

test('profileRefusal: the profile and what contains it, its dot-folders and AppData; other folders are fine', () => {
  const dir = scratch('profile')
  const home = path.join(dir, 'home')
  for (const d of ['.ssh', 'AppData/Roaming/app', 'AppData/Local/x', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true })
  assert.match(profileRefusal(home, home), /user profile or contains it/)
  assert.match(profileRefusal(dir, home), /user profile or contains it/)
  assert.match(profileRefusal(path.join(home, '.ssh'), home), /dot-folder/)
  assert.match(profileRefusal(path.join(home, 'AppData'), home), /AppData/)
  assert.match(profileRefusal(path.join(home, 'AppData', 'Local'), home), /AppData/)
  assert.match(profileRefusal(path.join(home, 'AppData', 'Roaming', 'app'), home), /Roaming/)
  assert.strictEqual(profileRefusal(path.join(home, 'AppData', 'Local', 'x'), home), null)
  assert.strictEqual(profileRefusal(path.join(home, 'work'), home), null)
  assert.strictEqual(profileRefusal(path.join(dir, 'a'), home), null)
})

test('allowedRoots: client roots; narrowed by the env list; env alone as the fallback; never widened', () => {
  const dir = scratch('allowed')
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b')
  const client = { declared: true, roots: [a] }

  let r = allowedRoots({ client, names })
  assert.strictEqual(r.refusal, null)
  assert.ok(r.allows(path.join(a, 'build')) && !r.allows(path.join(b, 'build')) && !r.allows(path.join(dir, 'outside')))
  assert.match(r.describe(), /the client's roots: .*[\\/]a$/)

  r = allowedRoots({ client, env: [path.join(a, 'build'), b], names }) // both: the intersection
  assert.ok(r.allows(path.join(a, 'build')), 'under both')
  assert.ok(!r.allows(a), 'under the client root but not the env list')
  assert.ok(!r.allows(path.join(b, 'build')), 'under the env list but not a client root: never widened')
  assert.match(r.describe(), /narrowed by X_ALLOWED_ROOTS/)

  r = allowedRoots({ client: { declared: false }, env: [b], names }) // no client roots: the env fallback
  assert.ok(r.allows(path.join(b, 'build')) && !r.allows(path.join(a, 'build')))
  assert.strictEqual(r.source, 'X_ALLOWED_ROOTS')
  r = allowedRoots({ client: { declared: true, roots: [] }, env: [b], names }) // an empty list is no roots
  assert.strictEqual(r.source, 'X_ALLOWED_ROOTS')
})

test('allowedRoots: no roots at all is a refusal saying what to set; so is a client that failed to give them', () => {
  let r = allowedRoots({ names })
  assert.match(r.refusal, /This client sent no MCP roots, so no folder is allowed\. Set X_ALLOWED_ROOTS to the folders to allow, or X_ROOTS_FROM_CWD=1/)
  assert.ok(!r.allows('C:\\anything'))
  const dir = scratch('failed')
  r = allowedRoots({ client: { declared: true, error: 'no answer to roots/list within 5 s' }, env: [path.join(dir, 'a')], names })
  assert.match(r.refusal, /declared MCP roots but didn't give them \(no answer/)
  assert.ok(!r.allows(path.join(dir, 'a', 'build')), 'no silent fallback to the env list')
})

test('allowedRoots: refused or missing roots are dropped and reported; if none is left, no fallback', () => {
  const dir = scratch('dropped')
  const a = path.join(dir, 'a')
  let r = allowedRoots({ client: { declared: true, roots: [os.homedir(), path.join(dir, 'nope'), a] }, names })
  assert.ok(r.allows(path.join(a, 'build')))
  assert.strictEqual(r.dropped.length, 2)
  assert.match(r.dropped.join('\n'), /is refused: it is the user profile or contains it/)
  assert.match(r.dropped.join('\n'), /nope" doesn't exist/)
  r = allowedRoots({ client: { declared: true, roots: [os.homedir()] }, env: [a], names })
  assert.match(r.refusal, /None of the client's roots can be used \(.*user profile/)
  assert.ok(!r.allows(path.join(a, 'build')), 'the env list never stands in for refused client roots')
  r = allowedRoots({ client: { declared: true, roots: [a] }, refuse: real => real === a ? 'it is ours' : null, names })
  assert.match(r.refusal, /None of the client's roots can be used \(.*is refused: it is ours/)
  r = allowedRoots({ env: [path.join(dir, 'nope')], names })
  assert.match(r.refusal, /None of the X_ALLOWED_ROOTS folders can be used \(X_ALLOWED_ROOTS entry .*doesn't exist\)/)
})

test('allowedRoots: the cwd opt-in only without client roots, never a drive root, and still narrowed by env', () => {
  const dir = scratch('cwd')
  const a = path.join(dir, 'a')
  let r = allowedRoots({ cwd: a, names })
  assert.ok(r.allows(path.join(a, 'build')) && !r.allows(path.join(dir, 'b')))
  assert.match(r.source, /the server's folder, by X_ROOTS_FROM_CWD=1/)
  r = allowedRoots({ client: { declared: true, roots: [path.join(dir, 'b')] }, cwd: a, names })
  assert.ok(!r.allows(path.join(a, 'build')), 'client roots win over the cwd')
  r = allowedRoots({ cwd: a, env: [path.join(a, 'build')], names })
  assert.ok(r.allows(path.join(a, 'build')) && !r.allows(a))
  r = allowedRoots({ cwd: path.parse(dir).root, names })
  assert.ok(r.refusal && /drive root/.test(r.dropped.join()), r.describe())
  assert.match(r.refusal, /with X_ROOTS_FROM_CWD=1 the server's folder can't be used either, so no folder is allowed\. Start the client in a project folder, or set X_ALLOWED_ROOTS \(the server's folder ".*" is a drive root/)
  r = allowedRoots({ cwd: os.homedir(), names })
  assert.match(r.refusal, /the server's folder can't be used either.*is refused: it is the user profile/)
})

test('rootsClient: asks only when declared, routes the answer, reports errors and timeouts', async () => {
  const sent = []
  const c = rootsClient(m => sent.push(m), { timeoutMs: 50 })
  assert.deepStrictEqual(await c.list(), { declared: false })
  assert.strictEqual(sent.length, 0)
  c.initialize({ capabilities: { roots: { listChanged: true } } })
  let p = c.list()
  assert.strictEqual(sent[0].method, 'roots/list')
  assert.ok(!c.handle({ id: 'other', result: {} }), 'not ours')
  assert.ok(!c.handle({ id: sent[0].id, method: 'x' }), 'a request, not an answer')
  assert.ok(c.handle({ id: sent[0].id, result: { roots: [{ uri: uri(path.resolve('C:\\w')) }] } }))
  assert.deepStrictEqual(await p, { declared: true, roots: [path.resolve('C:\\w')] })
  p = c.list()
  c.handle({ id: sent[1].id, error: { code: -32601, message: 'Method not found' } })
  assert.deepStrictEqual(await p, { declared: true, error: 'roots/list failed: Method not found' })
  assert.deepStrictEqual(await c.list(), { declared: true, error: 'no answer to roots/list within 0.05 s' })
  assert.ok(!c.handle({ id: sent[2].id, result: {} }), 'a late answer is ignored')
})
