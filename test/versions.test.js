// Each server reports its catalogue version, its meta.json's, as serverInfo.version: from the repo and from its packed
// zip, for every server pack.mjs packs. Without a readable meta.json version it reports "unknown", never a guess.
// Scratch (the packed and unpacked copies) goes under VERSION_TEST_SCRATCH, else %LOCALAPPDATA%\combwork-mcp-tests\version-tests
// (clean-scratch.js's SCRATCH), removed after.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawn, spawnSync } = require('child_process')
const { createInterface } = require('readline')
const { pathToFileURL } = require('url')

const REPO = path.join(__dirname, '..')
const ROOT = process.env.VERSION_TEST_SCRATCH || path.join(require('./clean-scratch').SCRATCH, 'version-tests')
const REPLY_MS = 15_000

const packed = () => import(pathToFileURL(path.join(REPO, 'scripts', 'pack.mjs')).href).then(m => Object.keys(m.SERVERS))
const metaVersion = dir => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).version

/** A fresh scratch folder, removed after the test. */
function scratch(t, label) {
  const dir = path.join(ROOT, `${process.pid}-${label}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Each file of a zip, from its local headers (pack's zips: no data descriptors), as { name, data }. */
function unzip(data) {
  const out = []
  for (let at = 0; data.readUInt32LE(at) === 0x04034b50;) {
    const method = data.readUInt16LE(at + 8)
    const size = data.readUInt32LE(at + 18)
    const nameLength = data.readUInt16LE(at + 26)
    const start = at + 30 + nameLength + data.readUInt16LE(at + 28)
    const body = data.subarray(start, start + size)
    out.push({ name: data.toString('utf8', at + 30, at + 30 + nameLength), data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body) })
    at = start + size
  }
  return out
}

/** Packs every server into dir/zips and unpacks each zip into dir/unpacked; returns dir/unpacked. */
function packAndUnpack(dir) {
  const zips = path.join(dir, 'zips')
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'pack.mjs'), '--out', zips], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, `pack failed:\n${r.stdout}\n${r.stderr}`)
  const unpacked = path.join(dir, 'unpacked')
  for (const z of fs.readdirSync(zips).filter(f => f.endsWith('.zip'))) {
    for (const e of unzip(fs.readFileSync(path.join(zips, z)))) {
      const file = path.join(unpacked, ...e.name.split('/'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, e.data)
    }
  }
  return unpacked
}

/** Starts a server.js with nothing it would reach (no Ollama, no Trilium, the Sandbox server off), and initializes it.
 * Returns the initialize result; the child is always ended. */
async function initialize(t, serverJs, scratchDir) {
  const child = spawn(process.execPath, [serverJs], {
    env: {
      ...process.env,
      OLLAMA_HOST: 'http://127.0.0.1:9', // nothing listens there: refused at once
      TRILIUM_URL: '',
      TRILIUM_ETAPI_TOKEN: '',
      WSB_MCP_ENABLED: '',
      WSB_SANDBOX_ROOT: path.join(scratchDir, 'sandbox-root')
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exited = new Promise(r => child.on('exit', r))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no initialize reply from ${serverJs} within ${REPLY_MS} ms\n${stderr}`)), REPLY_MS)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`${serverJs} exited (${code}) before replying\n${stderr}`)) })
    createInterface({ input: child.stdout }).on('line', l => {
      let m
      try { m = JSON.parse(l) } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      if (m.error) reject(new Error(`initialize failed: ${JSON.stringify(m.error)}`))
      else resolve(m.result)
    })
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'version-test', version: '0' } } }) + '\n')
  try {
    return await reply
  } finally {
    child.stdin.end()
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000).unref())])
  }
}

test('pack.mjs packs every server folder that has a meta.json, so none escapes these tests', async () => {
  const folders = fs.readdirSync(path.join(REPO, 'servers')).filter(n => fs.existsSync(path.join(REPO, 'servers', n, 'meta.json')))
  assert.deepStrictEqual((await packed()).sort(), folders.sort())
  assert.ok(folders.length >= 3, `found only ${folders.join(', ')}`)
})

test('no server.js or README carries a version of its own', async () => {
  for (const name of await packed()) {
    const src = fs.readFileSync(path.join(REPO, 'servers', name, 'server.js'), 'utf8')
    assert.doesNotMatch(src, /['"`]\d+\.\d+\.\d+['"`]/, `${name}/server.js has a hard-coded x.y.z`)
    const readme = fs.readFileSync(path.join(REPO, 'servers', name, 'README.md'), 'utf8')
    assert.doesNotMatch(readme, /\bversion\s+v?\d+\.\d+\.\d+/i, `${name}/README.md states a version: point to meta.json instead`)
  }
})

test('each server, run from the repo, reports its meta.json version', async t => {
  const dir = scratch(t, 'repo')
  for (const name of await packed()) {
    const result = await initialize(t, path.join(REPO, 'servers', name, 'server.js'), dir)
    assert.strictEqual(result.serverInfo.name, name)
    assert.strictEqual(result.serverInfo.version, metaVersion(path.join(REPO, 'servers', name)), name)
  }
})

test('each server, unpacked from its zip, reports the version its zip\'s meta.json and the catalogue give', async t => {
  const dir = scratch(t, 'packed')
  const unpacked = packAndUnpack(dir)
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'zips', 'catalog.json'), 'utf8'))
  for (const name of await packed()) {
    const inZip = path.join(unpacked, name)
    assert.ok(fs.existsSync(path.join(inZip, 'meta.json')), `${name}.zip has no meta.json`)
    const want = metaVersion(path.join(REPO, 'servers', name))
    assert.strictEqual(metaVersion(inZip), want, name)
    assert.strictEqual(catalog.servers.find(s => s.name === name).version, want, name)
    const result = await initialize(t, path.join(inZip, 'server.js'), dir)
    assert.strictEqual(result.serverInfo.version, want, name)
  }
})

test('without a readable version in meta.json, each server reports "unknown"', async t => {
  const dir = scratch(t, 'unknown')
  const unpacked = packAndUnpack(dir)
  const cases = {
    missing: null,
    'not-json': '{ "version": "1.2.3",',
    'no-version': JSON.stringify({ description: 'x' }),
    'number-version': JSON.stringify({ version: 1.2 }),
    'blank-version': JSON.stringify({ version: '  ' })
  }
  for (const name of await packed()) {
    for (const [label, content] of Object.entries(cases)) {
      // A copy of the whole unpacked server, so its other files (roots.js, wsb.js, …) are still beside server.js.
      const copy = path.join(dir, 'cases', label, name)
      fs.cpSync(path.join(unpacked, name), copy, { recursive: true })
      if (content === null) fs.rmSync(path.join(copy, 'meta.json'))
      else fs.writeFileSync(path.join(copy, 'meta.json'), content)
      const result = await initialize(t, path.join(copy, 'server.js'), dir)
      assert.strictEqual(result.serverInfo.version, 'unknown', `${name}, meta.json ${label}`)
    }
  }
})
