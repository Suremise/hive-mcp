// npm run pack makes a valid catalog.json whose sha256s and sizes match the zips beside it, the same bytes on every
// run, and the catalogue's checks (validate, compare) catch what they are for. Packs into a scratch folder, removed after.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { spawnSync } = require('child_process')
const { pathToFileURL } = require('url')

const REPO = path.join(__dirname, '..')
const ROOT = process.env.CATALOG_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'catalog-tests')
const SERVERS = ['ollama', 'trilium', 'windows-sandbox']

const load = name => import(pathToFileURL(path.join(REPO, 'scripts', name)).href)

/** Packs every server into a fresh scratch folder; returns the folder. */
function pack(t, label) {
  const out = path.join(ROOT, `${process.pid}-${label}`)
  fs.rmSync(out, { recursive: true, force: true })
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pack.mjs'), '--out', out], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, `pack failed:\n${r.stdout}\n${r.stderr}`)
  return out
}

/** Each entry of a zip, read through its local headers: name, method and its data unpacked. */
function unzip(data) {
  const out = []
  for (let at = 0; data.readUInt32LE(at) === 0x04034b50;) {
    const method = data.readUInt16LE(at + 8)
    const size = data.readUInt32LE(at + 18)
    const nameLength = data.readUInt16LE(at + 26)
    const start = at + 30 + nameLength + data.readUInt16LE(at + 28)
    const body = data.subarray(start, start + size)
    out.push({
      name: data.toString('utf8', at + 30, at + 30 + nameLength),
      crc: data.readUInt32LE(at + 14),
      stamp: [data.readUInt16LE(at + 10), data.readUInt16LE(at + 12), data.readUInt16LE(at + 28)], // time, date, extra length
      data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body)
    })
    at = start + size
  }
  return out
}

test('pack makes a valid catalog.json listing every server, its sha256 and size matching its zip', async t => {
  const { validate, SCHEMA_VERSION } = await load('catalog.mjs')
  const out = pack(t, 'valid')
  const c = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'))
  assert.deepStrictEqual(validate(c), [])
  assert.strictEqual(c.schemaVersion, SCHEMA_VERSION)
  const pkg = require(path.join(REPO, 'package.json'))
  assert.strictEqual(c.release, `v${pkg.version}`)
  assert.deepStrictEqual(c.servers.map(s => s.name), SERVERS)
  for (const s of c.servers) {
    const zip = fs.readFileSync(path.join(out, `${s.name}.zip`))
    assert.strictEqual(s.zip.sha256, crypto.createHash('sha256').update(zip).digest('hex'), s.name)
    assert.strictEqual(s.zip.size, zip.length, s.name)
    assert.strictEqual(s.zip.url, `https://github.com/Suremise/hive-mcp/releases/download/v${pkg.version}/${s.name}.zip`)
    const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'servers', s.name, 'meta.json'), 'utf8'))
    assert.deepStrictEqual({ version: s.version, description: s.description, tags: s.tags, requires: s.requires }, meta, s.name)
  }
})

test('pack is reproducible: two runs give the same bytes, and no entry carries a file time or extra fields', t => {
  const [a, b] = [pack(t, 'run-a'), pack(t, 'run-b')]
  for (const f of [...SERVERS.map(s => `${s}.zip`), 'catalog.json']) {
    assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), `${f} differs between runs`)
  }
  // Two runs on one checkout share its file times, so check that none got in: a fresh clone would have others.
  const fixed = [0, ((2000 - 1980) << 9) | (1 << 5) | 1, 0]
  for (const s of SERVERS) for (const e of unzip(fs.readFileSync(path.join(a, `${s}.zip`)))) assert.deepStrictEqual(e.stamp, fixed, e.name)
})

test('a zip holds the repo files byte for byte, with sound CRCs, the server meta.json and no catalog.json', async t => {
  const { crc32 } = await load('zip.mjs')
  const out = pack(t, 'contents')
  const entries = unzip(fs.readFileSync(path.join(out, 'trilium.zip')))
  assert.deepStrictEqual(entries.map(e => e.name), ['trilium/LICENSE', 'trilium/README.md', 'trilium/hive-mcp.example.json', 'trilium/meta.json', 'trilium/server.js'])
  for (const e of entries) {
    assert.strictEqual(crc32(e.data), e.crc, e.name)
    const src = e.name === 'trilium/LICENSE' ? path.join(REPO, 'LICENSE') : path.join(REPO, 'servers', e.name)
    assert.ok(e.data.equals(fs.readFileSync(src)), `${e.name} differs from the repo`)
  }
})

test('crc32 matches the known check value', async () => {
  const { crc32 } = await load('zip.mjs')
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('pack of one server makes no catalog.json, and removes a stale one', t => {
  const out = path.join(ROOT, `${process.pid}-one`)
  fs.rmSync(out, { recursive: true, force: true })
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'catalog.json'), '{}')
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pack.mjs'), '--out', out, 'ollama'], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.deepStrictEqual(fs.readdirSync(out), ['ollama.zip'])
})

/** A valid catalogue with one server, to break a field at a time. */
function sample() {
  return {
    schemaVersion: 1,
    name: 'someone/servers',
    homepage: 'https://github.com/someone/servers',
    release: 'v2.0.0',
    servers: [{
      name: 'demo',
      version: '1.2.3',
      description: 'A demo server.',
      tags: ['demo'],
      requires: { os: ['windows'], windows: { editions: ['Pro'], minBuild: 26100, features: ['Windows Sandbox'] }, node: '>=18', docker: true, apps: ['Something'] },
      zip: { url: 'https://example.com/demo.zip', sha256: 'a'.repeat(64), size: 10 }
    }]
  }
}

test('validate takes a full catalogue and unknown fields, and names each bad field', async () => {
  const { validate } = await load('catalog.mjs')
  assert.deepStrictEqual(validate(sample()), [])
  assert.deepStrictEqual(validate({ ...sample(), later: 1, servers: [{ ...sample().servers[0], later: 1 }] }), [])
  const bad = (change, want) => {
    const c = sample()
    change(c, c.servers[0])
    const problems = validate(c)
    assert.ok(problems.some(p => p.startsWith(want)), `${want}: got ${JSON.stringify(problems)}`)
  }
  bad(c => { c.schemaVersion = 2 }, 'schemaVersion')
  bad(c => { delete c.name }, 'name')
  bad(c => { c.servers.push({ ...c.servers[0] }) }, 'servers[1].name: demo twice')
  bad((c, s) => { s.name = 'Demo' }, 'servers[0].name')
  bad((c, s) => { s.version = '1.2' }, 'servers[0].version')
  bad((c, s) => { s.description = 'two\nlines' }, 'servers[0].description')
  bad((c, s) => { s.description = 'x'.repeat(201) }, 'servers[0].description')
  bad((c, s) => { s.tags = ['Has Space'] }, 'servers[0].tags')
  bad((c, s) => { s.requires.os = [] }, 'servers[0].requires.os')
  bad((c, s) => { s.requires.os = ['dos'] }, 'servers[0].requires.os')
  bad((c, s) => { s.requires.os = ['linux'] }, 'servers[0].requires.windows: only with os windows')
  bad((c, s) => { s.requires.windows.editions = ['Ultimate'] }, 'servers[0].requires.windows.editions')
  bad((c, s) => { s.requires.windows.minBuild = '26100' }, 'servers[0].requires.windows.minBuild')
  bad((c, s) => { s.requires.node = '18' }, 'servers[0].requires.node')
  bad((c, s) => { s.requires.docker = 'yes' }, 'servers[0].requires.docker')
  bad((c, s) => { s.zip.url = 'http://example.com/demo.zip' }, 'servers[0].zip.url')
  bad((c, s) => { s.zip.sha256 = 'A'.repeat(64) }, 'servers[0].zip.sha256')
  bad((c, s) => { s.zip.size = 0 }, 'servers[0].zip.size')
  bad((c, s) => { delete s.zip }, 'servers[0].zip')
})

test('compare refuses a changed zip under the same version, and a version going down', async () => {
  const { compare } = await load('catalog.mjs')
  const previous = sample()
  const next = sample()
  assert.deepStrictEqual(compare(previous, next), [], 'unchanged')
  next.servers[0].zip.sha256 = 'b'.repeat(64)
  assert.match(compare(previous, next).join(), /demo: its zip changed but its version is still 1\.2\.3/)
  next.servers[0].version = '1.2.4'
  assert.deepStrictEqual(compare(previous, next), [], 'raised')
  next.servers[0].version = '1.10.0'
  assert.deepStrictEqual(compare(previous, next), [], 'compared as numbers, not text')
  next.servers[0].version = '1.1.9'
  assert.match(compare(previous, next).join(), /demo: version 1\.1\.9 is below the last release's 1\.2\.3/)
  assert.deepStrictEqual(compare(null, next), [], 'no earlier release')
})

test('every server packed has a valid meta.json', async () => {
  const { checkMeta } = await load('catalog.mjs')
  for (const s of fs.readdirSync(path.join(REPO, 'servers'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(REPO, 'servers', s, 'meta.json'), 'utf8'))
    assert.deepStrictEqual(checkMeta(meta, s), [], s)
  }
})
