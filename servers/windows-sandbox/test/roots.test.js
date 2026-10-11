// server.js with MCP roots, over stdio with wsb.exe stubbed: build folders come from the client's roots (or the cwd
// opt-in), WSB_ALLOWED_ROOTS narrows them or stands in when there are none, and the profile rules always hold.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createInterface } = require('readline')
const { scratch, server } = require('./helpers')
const { SERVER } = require('../client')

/** The scratch env without WSB_ALLOWED_ROOTS, two projects (a, b) each with a build, and a junction out of a. */
function projects(name) {
  const s = scratch(name)
  for (const p of ['a', 'b']) {
    fs.mkdirSync(path.join(s.dir, p, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(s.dir, p, 'dist', 'App-Setup.exe'), 'MZ')
  }
  fs.symlinkSync(path.join(s.dir, 'outside'), path.join(s.dir, 'a', 'escape'), 'junction')
  return { ...s, env: { ...s.env, WSB_ALLOWED_ROOTS: '' }, a: path.join(s.dir, 'a'), b: path.join(s.dir, 'b') }
}
const startStop = async (srv, build) => {
  const r = await srv.call('sandbox_start', { build })
  if (!r.isError) assert.match((await srv.call('sandbox_stop')).text, /Stopped/)
  return r
}

test('a build under one of the client\'s roots is mapped; outside them, through a junction or in the profile it is refused', async () => {
  const s = projects('roots-given')
  const srv = server(s.env, { roots: [s.a] })
  let r = await startStop(srv, path.join(s.a, 'dist'))
  assert.ok(!r.isError, r.text)
  assert.ok(srv.rootsAsked() >= 1)
  r = await startStop(srv, path.join(s.b, 'dist'))
  assert.ok(r.isError && /is not under an allowed folder \(the client's roots: .*[\\/]a\)/.test(r.text), r.text)
  r = await startStop(srv, path.join(s.a, 'escape'))
  assert.ok(r.isError && /not under an allowed folder/.test(r.text), r.text)
  await srv.close()
  const starts = s.read().calls.filter(c => c[0] === 'start').length
  assert.strictEqual(starts, 1, 'only the build under the root started a Sandbox')
})

test('sandbox_status says where the allowed folders come from', async () => {
  const s = projects('roots-status')
  let srv = server(s.env, { roots: [s.a, s.b] })
  assert.match((await srv.call('sandbox_status')).text, /Build folders allowed: the client's roots: .*[\\/]a; .*[\\/]b\./)
  await srv.close()
  srv = server(s.env)
  assert.match((await srv.call('sandbox_status')).text, /Build folders allowed: none \(This client sent no MCP roots/)
  await srv.close()
})

test('no roots and no WSB_ALLOWED_ROOTS: a clear refusal; WSB_ALLOWED_ROOTS alone is the fallback', async () => {
  const s = projects('roots-none')
  let srv = server(s.env)
  let r = await srv.call('sandbox_start', { build: path.join(s.a, 'dist') })
  assert.ok(r.isError && /This client sent no MCP roots, so no folder is allowed\. Set WSB_ALLOWED_ROOTS to the folders to allow, or WSB_ROOTS_FROM_CWD=1/.test(r.text), r.text)
  await srv.close()
  srv = server({ ...s.env, WSB_ALLOWED_ROOTS: s.b })
  r = await startStop(srv, path.join(s.b, 'dist'))
  assert.ok(!r.isError, r.text)
  r = await startStop(srv, path.join(s.a, 'dist'))
  assert.ok(r.isError && /not under an allowed folder \(WSB_ALLOWED_ROOTS: /.test(r.text), r.text)
  await srv.close()
  assert.strictEqual(s.read().calls.filter(c => c[0] === 'start').length, 1)
})

test('WSB_ALLOWED_ROOTS with client roots narrows them: a build must be under both', async () => {
  const s = projects('roots-narrow')
  const srv = server({ ...s.env, WSB_ALLOWED_ROOTS: `${path.join(s.a, 'dist')};${s.b}` }, { roots: [s.a] })
  let r = await startStop(srv, path.join(s.a, 'dist'))
  assert.ok(!r.isError, r.text)
  r = await startStop(srv, s.a)
  assert.ok(r.isError && /narrowed by WSB_ALLOWED_ROOTS/.test(r.text), r.text)
  r = await startStop(srv, path.join(s.b, 'dist'))
  assert.ok(r.isError && /not under an allowed folder/.test(r.text), 'the env list never widens the client roots')
  await srv.close()
})

test('roots changed between starts count: the next start asks again', async () => {
  const s = projects('roots-changed')
  const srv = server(s.env, { roots: [s.a] })
  assert.ok(!(await startStop(srv, path.join(s.a, 'dist'))).isError)
  srv.setRoots([s.b])
  let r = await startStop(srv, path.join(s.a, 'dist'))
  assert.ok(r.isError && /not under an allowed folder/.test(r.text), r.text)
  r = await startStop(srv, path.join(s.b, 'dist'))
  assert.ok(!r.isError, r.text)
  assert.ok(srv.rootsAsked() >= 3)
  await srv.close()
})

test('a root that is the profile is dropped, and the refusal says so', async () => {
  const s = projects('roots-profile')
  const srv = server(s.env, { roots: [path.join(s.dir, 'home')] })
  const r = await srv.call('sandbox_start', { build: path.join(s.dir, 'home') })
  assert.ok(r.isError && /None of the client's roots can be used \(the client's root ".*home" is refused: it is the user profile or contains it\)/.test(r.text), r.text)
  await srv.close()
})

test('WSB_ROOTS_FROM_CWD=1: a client without roots gets the folder it started the server in', async () => {
  const s = projects('roots-cwd')
  const srv = server({ ...s.env, WSB_ROOTS_FROM_CWD: '1' }, { cwd: s.a })
  let r = await startStop(srv, path.join(s.a, 'dist'))
  assert.ok(!r.isError, r.text)
  r = await startStop(srv, path.join(s.b, 'dist'))
  assert.ok(r.isError && /the server's folder, by WSB_ROOTS_FROM_CWD=1/.test(r.text), r.text)
  await srv.close()
  const withRoots = server({ ...s.env, WSB_ROOTS_FROM_CWD: '1' }, { cwd: s.a, roots: [s.b] })
  r = await startStop(withRoots, path.join(s.a, 'dist'))
  assert.ok(r.isError, 'client roots win over the cwd')
  await withRoots.close()
})

test('a client that declares roots but answers roots/list with an error is refused, never given the fallback', async () => {
  const s = projects('roots-error')
  const child = spawn(process.execPath, [SERVER], { env: { ...s.env, WSB_ALLOWED_ROOTS: s.a }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const write = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  const answers = new Map()
  createInterface({ input: child.stdout }).on('line', l => {
    const m = JSON.parse(l)
    if (m.method === 'roots/list') return write({ id: m.id, error: { code: -32603, message: 'boom' } })
    answers.get(m.id)?.(m)
  })
  const request = (id, method, params) => new Promise(res => { answers.set(id, res); write({ id, method, params }) })
  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 't', version: '0' } })
  write({ method: 'notifications/initialized' })
  const r = await request(2, 'tools/call', { name: 'sandbox_start', arguments: { build: path.join(s.a, 'dist') } })
  assert.ok(r.result.isError && /declared MCP roots but didn't give them \(roots\/list failed: boom\)/.test(r.result.content[0].text), JSON.stringify(r))
  child.stdin.end()
  await new Promise(res => child.on('exit', res))
  assert.ok(!(s.read().calls || []).some(c => c[0] === 'start'))
})
