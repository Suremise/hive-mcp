// Fail-closed list and stop (like the probes' fault-check.js), and the config XML. wsb.exe is the stub.
const test = require('node:test')
const assert = require('assert')
const { scratch } = require('./helpers')

// wsb.js reads WSB_STUB per call; the state file is switched per test.
process.env.WSB_STUB = require('./helpers').STUB
process.env.WSB_STOP_RETRY_MS = '10'
const wsb = require('../wsb')
const use = s => { process.env.WSB_STUB_STATE = s.state; return s }
const ID = '11111111-2222-4333-8444-555555555555'

test('list fails closed: a failed or malformed list throws, never "none"', async () => {
  for (const mode of ['exit', 'garbage', 'noarray', 'badid']) {
    use(scratch('list-' + mode, { list: mode }))
    await assert.rejects(wsb.list(), /wsb list failed or replied unexpectedly/, mode)
  }
  use(scratch('list-ok'))
  assert.deepStrictEqual(await wsb.list(), [])
})

test('stop failing every time: 3 bounded attempts, not ok', async () => {
  const s = use(scratch('stop-fails', { stop: -1 }))
  s.patch(x => { x.sandboxes = [ID] })
  const r = await wsb.stopConfirmed(ID)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.attempts.length, 3)
  assert.strictEqual(s.read().calls.filter(c => c[0] === 'stop').length, 3)
})

test('stop failing once, then succeeding: retried, ok', async () => {
  const s = use(scratch('stop-retry', { stop: 1 }))
  s.patch(x => { x.sandboxes = [ID] })
  const r = await wsb.stopConfirmed(ID)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.attempts.length, 2)
})

test('stop exit 0 while still listed is not trusted', async () => {
  const s = use(scratch('stop-lies', { stopLies: true }))
  s.patch(x => { x.sandboxes = [ID] })
  const r = await wsb.stopConfirmed(ID)
  assert.strictEqual(r.ok, false)
  assert.ok(r.attempts.every(a => a.code === 0 && !a.gone))
})

test('list failing after stop: not ok, with the list error', async () => {
  const s = use(scratch('stop-listfail', { listAfterStop: 'exit' }))
  s.patch(x => { x.sandboxes = [ID] })
  const r = await wsb.stopConfirmed(ID)
  assert.strictEqual(r.ok, false)
  assert.match(r.attempts[0].listError, /Access denied/)
})

test('config XML: read-only by default, one writable folder, network off, devices off, escaped', () => {
  const x = wsb.configXml({ folders: [{ host: 'D:\\a&b<c>', sandbox: 'C:\\build' }, { host: 'D:\\out', sandbox: 'C:\\out', readOnly: false }] })
  assert.match(x, /<Networking>Disable<\/Networking>/)
  for (const d of ['ClipboardRedirection', 'AudioInput', 'VideoInput', 'PrinterRedirection']) assert.match(x, new RegExp(`<${d}>Disable</${d}>`))
  assert.match(x, /<HostFolder>D:\\a&amp;b&lt;c&gt;<\/HostFolder><SandboxFolder>C:\\build<\/SandboxFolder><ReadOnly>true<\/ReadOnly>/)
  assert.match(x, /<SandboxFolder>C:\\out<\/SandboxFolder><ReadOnly>false<\/ReadOnly>/)
  assert.strictEqual(x.match(/<ReadOnly>false/g).length, 1)
  assert.match(wsb.configXml({ network: true }), /<Networking>Enable<\/Networking>/)
})

test('window operations refuse an id that is not a GUID (it goes into a command line)', async () => {
  const r = await wsb.windowOp("x'; Stop-Process -Name explorer; '", 'close')
  assert.strictEqual(r.ok, false)
})
