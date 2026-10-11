/**
 * Fault-injection check for lib.js's guard and cleanup (found in review). Launches no Sandbox: wsb.exe
 * is replaced by a scripted stub before lib.js loads. Checks that a failed or malformed `list` fails closed, that a
 * failed stop is retried (bounded) and reported as a failed run, and that a Sandbox still listed fails the run.
 *   node fault-check.js        (exits non-zero if any check fails)
 */
const cp = require('child_process')
const assert = require('assert')

process.env.PROBE_STOP_RETRY_MS = '10'
process.env.PROBE_SCRATCH = process.env.PROBE_SCRATCH ||
  require('path').join(process.env.LOCALAPPDATA, 'hive-test', 'scratch', 'wsb-probe-fault-check')

// The stub: each scenario sets `script`, a function (args) => { code, stdout, stderr }; calls are recorded.
let script = () => ({ code: 0, stdout: '', stderr: '' })
let calls = []
cp.execFile = (file, args, opts, cb) => {
  const cmd = args.filter(a => a !== '--raw')
  calls.push(cmd[0])
  const r = script(cmd)
  setImmediate(() => cb(r.code ? Object.assign(new Error('exit ' + r.code), { code: r.code }) : null, r.stdout ?? '', r.stderr ?? ''))
}
const lib = require('./lib')

const list = ids => ({ code: 0, stdout: JSON.stringify({ WindowsSandboxEnvironments: ids.map(Id => ({ Id })) }) })
const started = { code: 0, stdout: JSON.stringify({ Id: 'sb-1' }) }

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('list failing (exit 5, Access denied) throws, not []', async () => {
  script = () => ({ code: 5, stdout: '', stderr: 'Access denied' })
  await assert.rejects(lib.running(), /exit 5.*Access denied/)
})
check('list malformed (not JSON / no array / bad Id) throws', async () => {
  for (const r of [{ code: 0, stdout: 'garbage' }, { code: 0, stdout: '{}' }, { code: 0, stdout: '{"WindowsSandboxEnvironments":[{"Id":3}]}' }]) {
    script = () => r
    await assert.rejects(lib.running(), /unexpectedly/)
  }
})
check('guard: a failed list refuses to start', async () => {
  calls = []
  script = cmd => (cmd[0] === 'list' ? { code: 5, stderr: 'Access denied' } : started)
  const r = await lib.withSandbox('fault-guard', '<Configuration/>', async () => { throw new Error('body must not run') })
  assert.ok(!calls.includes('start'), 'start was called')
  assert.match(r.error, /not started/)
  assert.strictEqual(process.exitCode, 1)
})
check('stop failing every time: 3 bounded attempts, run FAILED', async () => {
  calls = []
  let up = false
  script = cmd => {
    if (cmd[0] === 'list') return list(up ? ['sb-1'] : [])
    if (cmd[0] === 'start') { up = true; return started }
    if (cmd[0] === 'stop') return { code: 1, stderr: 'stop failed' }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-stop', '<Configuration/>', async () => {})
  assert.strictEqual(calls.filter(c => c === 'stop').length, 3)
  assert.strictEqual(r.cleanup, 'FAILED')
  assert.deepStrictEqual(r.leftRunning, ['sb-1'])
  assert.match(r.error, /stop not confirmed/)
  assert.strictEqual(process.exitCode, 1)
})
check('stop failing once, then succeeding: retried, cleanup ok', async () => {
  calls = []
  let up = false
  let stops = 0
  script = cmd => {
    if (cmd[0] === 'list') return list(up ? ['sb-1'] : [])
    if (cmd[0] === 'start') { up = true; return started }
    if (cmd[0] === 'stop') { if (++stops === 1) return { code: 1, stderr: 'busy' }; up = false; return { code: 0 } }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-stop-retry', '<Configuration/>', async () => {})
  assert.strictEqual(stops, 2)
  assert.strictEqual(r.cleanup, 'ok')
  assert.ok(!r.error, r.error)
})
check('stop exit 0 but the Sandbox still listed: not trusted, run FAILED', async () => {
  let up = false
  script = cmd => {
    if (cmd[0] === 'list') return list(up ? ['sb-1'] : [])
    if (cmd[0] === 'start') { up = true; return started }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-stop-lies', '<Configuration/>', async () => {})
  assert.strictEqual(r.cleanup, 'FAILED')
})
check('list failing after stop: leftRunning unknown, run FAILED', async () => {
  let up = false
  let stopped = false
  script = cmd => {
    if (cmd[0] === 'list') return stopped ? { code: 5, stderr: 'Access denied' } : list(up ? ['sb-1'] : [])
    if (cmd[0] === 'start') { up = true; return started }
    if (cmd[0] === 'stop') { stopped = true; return { code: 0 } }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-list-after', '<Configuration/>', async () => {})
  assert.strictEqual(r.leftRunning, 'unknown')
  assert.strictEqual(r.cleanup, 'FAILED')
})
check('another Sandbox appearing (not ours) fails the run', async () => {
  let state = 'before' // before start: none; running: ours and another; after our stop: only the other
  script = cmd => {
    if (cmd[0] === 'list') return list({ before: [], running: ['sb-1', 'other'], after: ['other'] }[state])
    if (cmd[0] === 'start') { state = 'running'; return started }
    if (cmd[0] === 'stop') { state = 'after'; return { code: 0 } }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-other', '<Configuration/>', async () => {})
  assert.strictEqual(r.cleanup, 'FAILED')
  assert.match(r.error, /still running.*other/)
})
check('a failing body still stops, and the run is FAILED', async () => {
  let up = false
  script = cmd => {
    if (cmd[0] === 'list') return list(up ? ['sb-1'] : [])
    if (cmd[0] === 'start') { up = true; return started }
    if (cmd[0] === 'stop') { up = false; return { code: 0 } }
    return { code: 0 }
  }
  const r = await lib.withSandbox('fault-body', '<Configuration/>', async () => { throw new Error('boom') })
  assert.strictEqual(r.cleanup, 'ok')
  assert.match(r.error, /boom/)
})

;(async () => {
  let failed = 0
  const log = console.log
  for (const c of checks) {
    process.exitCode = 0
    console.log = () => {} // lib's own log lines; they are in each probe.log under PROBE_SCRATCH
    try { await c.fn(); console.log = log; log('PASS', c.name) } catch (e) { console.log = log; failed++; log('FAIL', c.name, '\n ', e.message) }
  }
  log(`${checks.length - failed}/${checks.length} passed`)
  process.exitCode = failed ? 1 : 0
})()
