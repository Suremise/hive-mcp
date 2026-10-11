// The Hive checks' runner: the build folder, its options, and that a Sandbox it started is always cleaned up
// (wsb.exe stubbed, launching nothing).
const test = require('node:test')
const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch, STUB } = require('./helpers')

process.env.WSB_STUB = STUB
process.env.WSB_STOP_RETRY_MS = '10'
const { buildRoot, plan, inSandbox, setLogSink } = require('../scenarios/hive-checks')
const RUNNER = path.join(__dirname, '..', 'scenarios', 'hive-checks.js')

test('build folder: the common folder of both installers; different drives and the drive root refused (no endless climb)', () => {
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Hive-Setup-0.6.0.exe', 'D:\\h\\dist\\Hive-Setup-0.5.1.exe'), 'D:\\h\\dist')
  assert.strictEqual(buildRoot('D:\\h\\dist\\rc\\Hive-Setup-0.6.0.exe', null), 'D:\\h\\dist\\rc')
  assert.throws(() => buildRoot('D:\\rc\\Hive-Setup-0.6.0.exe', 'C:\\release\\Hive-Setup-0.5.1.exe'), /different drives \(D:\\ and C:\\\)/)
  assert.throws(() => buildRoot('D:\\rc\\Hive-Setup-0.6.0.exe', 'D:\\release\\Hive-Setup-0.5.1.exe'), /only common folder is the drive root \(D:\\\)/)
  assert.throws(() => buildRoot('D:\\Hive-Setup-0.6.0.exe', null), /drive root/)
})

test('--only: anything but fresh or upgrade is refused before anything runs', () => {
  assert.throws(() => plan(['--only', 'frseh', '--installer', 'x']), /--only is fresh or upgrade, not "frseh"/)
  const s = scratch('runner-only')
  const r = spawnSync(process.execPath, [RUNNER, '--only', 'frseh', '--installer', 'x', '--report', path.join(s.dir, 'report')], { env: s.env, encoding: 'utf8' })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /NOT RUN: --only is fresh or upgrade/)
  assert.ok(!s.read().calls, 'wsb was called')
})

test('--hive: without it or HIVE_REPO the run is refused before anything runs (no machine-specific default)', () => {
  const saved = process.env.HIVE_REPO
  delete process.env.HIVE_REPO
  try {
    assert.throws(() => plan(['--installer', 'x']), /--hive <Hive repo> \(or HIVE_REPO\) is required/)
  } finally {
    if (saved !== undefined) process.env.HIVE_REPO = saved
  }
  const s = scratch('runner-no-hive')
  const env = { ...s.env }
  delete env.HIVE_REPO
  const r = spawnSync(process.execPath, [RUNNER, '--installer', 'x', '--report', path.join(s.dir, 'report')], { env, encoding: 'utf8' })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /NOT RUN: --hive <Hive repo>/)
  assert.ok(!s.read().calls, 'wsb was called')
})

test('inSandbox: a body that throws still stops the Sandbox, confirmed', async () => {
  const s = scratch('runner-body-throws')
  process.env.WSB_STUB_STATE = s.state
  await assert.rejects(inSandbox(s.env, 't', {}, async () => { throw new Error('boom') }), /boom/)
  assert.deepStrictEqual(s.read().sandboxes, [])
})

test('inSandbox: logging failing and every stop failing → the server is still closed, the fallback still runs, the id is reported', async () => {
  const s = scratch('runner-cleanup-faults')
  process.env.WSB_STUB_STATE = s.state
  setLogSink(() => { throw new Error('disk full') })
  try {
    let err
    await inSandbox(s.env, 't', {}, async () => { s.patch(x => { x.fail.stop = -1 }) }).catch(e => { err = e })
    const id = s.read().sandboxes[0]
    assert.ok(err && err.leftRunning === id, String(err))
    assert.match(err.message, new RegExp(`CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`))
    // The error comes only from the fallback's own confirm-and-retry. At least 3 stop attempts each from sandbox_stop,
    // the server's shutdown when its stdin closed (so it was closed) and the fallback; the watchdog may add more.
    assert.ok(s.read().calls.filter(c => c[0] === 'stop').length >= 9)
  } finally {
    setLogSink(line => console.log(line))
    s.patch(x => { x.fail.stop = 0; x.sandboxes = [] })
  }
})

test('inSandbox: the stop failing but the fallback succeeding → cleanup confirmed', async () => {
  const s = scratch('runner-fallback-ok', { stop: 6 }) // sandbox_stop's and the server's shutdown's attempts fail
  process.env.WSB_STUB_STATE = s.state
  const r = await inSandbox(s.env, 't', {}, async () => {})
  assert.strictEqual(r.cleanup, 'ok')
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.ok(s.read().calls.filter(c => c[0] === 'stop').length >= 7) // 6 failed, then a confirmed one (fallback or watchdog)
})
