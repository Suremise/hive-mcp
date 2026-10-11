// The Hive checks' runner: the build folder, its options, and that a Sandbox it started is always cleaned up
// (wsb.exe stubbed, launching nothing).
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch, STUB } = require('./helpers')

process.env.WSB_STUB = STUB
process.env.WSB_STOP_RETRY_MS = '10'
const { buildRoot, plan, inSandbox, sacState, blockedReason, setLogSink } = require('../scenarios/hive-checks')
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

// As a real Sandbox wrote it (RC2), but wrapped mid-word: PowerShell wraps at the console width wherever that falls.
const BLOCKED_ERR = 'Start-Process : This command cannot be run due to the error: An Applic \r\nation Control policy has blocked this file.\r\nAt C:\\wsb-mcp\\hive\\install.ps1:17 char:6'
const SAC_ON = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n'

/** Runs hive-checks.js on the stub with these guest commands scripted: a fake Hive repo, two installers. */
function runChecks(name, guest, extra = []) {
  const s = scratch(name, { guest })
  const hive = path.join(s.dir, 'hive')
  for (const d of ['dist', 'node_modules/playwright-core', 'tests']) fs.mkdirSync(path.join(hive, d), { recursive: true })
  // Both installers under builds\hive, the build folder (not the scratch folder, which holds the fake profile).
  const previous = path.join(s.dir, 'builds/hive/previous/Hive-Setup-0.5.1.exe')
  fs.mkdirSync(path.dirname(previous))
  fs.writeFileSync(previous, 'MZ')
  const report = path.join(s.dir, 'report')
  const r = spawnSync(process.execPath, [RUNNER, '--installer', path.join(s.dir, 'builds/hive/Hive-Setup-0.6.0.exe'), '--previous', previous, '--hive', hive, '--report', report, ...extra],
    { env: { ...s.env, WSB_ALLOWED_ROOTS: '' }, encoding: 'utf8', timeout: 120_000 })
  const guests = (s.read().calls || []).filter(c => c[0] === 'exec').map(c => /-B64 (\S+)/.exec(c[c.indexOf('-c') + 1])).filter(Boolean).map(m => Buffer.from(m[1], 'base64').toString('utf8'))
  const log = fs.readFileSync(path.join(report, 'run.log'), 'utf8')
  return { s, r, report, guests, log, json: JSON.parse(fs.readFileSync(path.join(report, 'report.json'), 'utf8')), md: fs.readFileSync(path.join(report, 'report.md'), 'utf8') }
}

const SAC_BLOCKS = [{ match: 'install\\.ps1', exit: 1, stderr: BLOCKED_ERR }, { match: '^reg\\.exe query', stdout: SAC_ON }]
const SAC_REASON = 'Smart App Control in the Sandbox blocks unsigned installers (VerifiedAndReputablePolicyState = 1): sign the installer, or check on a machine without Smart App Control.'
/** Exactly one NOT RUN line, the verdict with the reason, in both the output and run.log; no FAILED or PASSED. */
function oneNotRunLine({ r, log }) {
  for (const text of [r.stdout, log]) {
    const lines = text.split('\n').filter(l => /NOT RUN|FAILED|PASSED/.test(l))
    assert.strictEqual(lines.length, 1, lines.join('\n'))
    assert.ok(lines[0].includes(`] NOT RUN: ${SAC_REASON}; `) && /report\.md\r?$/.test(lines[0]), lines[0])
  }
}

test('Smart App Control blocking the installers → one NOT RUN line with the reason, exit 2, no failed checks (#611)', () => {
  const run = runChecks('runner-sac-blocked', SAC_BLOCKS)
  const { s, r, json, md, guests } = run
  assert.strictEqual(r.status, 2, r.stdout + r.stderr)
  oneNotRunLine(run)
  assert.deepStrictEqual(json.notRun.map(n => [n.kind, n.installer]), [['fresh', 'Hive-Setup-0.6.0.exe'], ['upgrade', 'Hive-Setup-0.5.1.exe']])
  assert.strictEqual(json.failed, 0)
  assert.strictEqual(json.checks.length, 0)
  assert.strictEqual(json.meta.smartAppControl, 1)
  assert.match(md, /^\*\*NOT RUN: Smart App Control in the Sandbox blocks unsigned installers \(VerifiedAndReputablePolicyState = 1\): sign the installer, or check on a machine without Smart App Control\.\*\* · /m)
  assert.match(md, /## Not run[\s\S]*- \*\*fresh\*\*: Windows refused `Hive-Setup-0\.6\.0\.exe`\.\n- \*\*upgrade\*\*: Windows refused `Hive-Setup-0\.5\.1\.exe`\./)
  assert.doesNotMatch(md, /FAIL/)
  // Nothing ran after the blocked install in either Sandbox, and the policy was only ever read.
  assert.strictEqual(guests.filter(g => /install\.ps1/.test(g)).length, 2)
  assert.ok(!guests.some(g => /drive\.cjs/.test(g)), guests.join('\n'))
  assert.deepStrictEqual(guests.filter(g => /CI\\Policy|SmartAppControl|VerifiedAndReputable/i.test(g)).map(g => g.split(' ').slice(0, 2).join(' ')), ['reg.exe query', 'reg.exe query'])
  assert.deepStrictEqual(s.read().sandboxes, [])
})

test('one kind asked for (--only fresh) and blocked → the same single NOT RUN line, exit 2', () => {
  const run = runChecks('runner-sac-blocked-fresh', SAC_BLOCKS, ['--only', 'fresh'])
  assert.strictEqual(run.r.status, 2, run.r.stdout + run.r.stderr)
  oneNotRunLine(run)
  assert.deepStrictEqual(run.json.notRun.map(n => n.kind), ['fresh'])
  assert.strictEqual(run.json.checks.length, 0)
})

test('an install failing any other way is still a failed check, not NOT RUN', () => {
  const { r, json } = runChecks('runner-install-fails', [{ match: 'install\\.ps1', exit: 1, stderr: 'Start-Process : The system cannot find the file specified.' }])
  assert.strictEqual(r.status, 1, r.stdout + r.stderr)
  assert.deepStrictEqual(json.notRun, [])
  assert.ok(json.checks.some(c => c.name === 'Step: 1. install' && !c.ok))
})

test('the policy state: parsed from reg query, unknown when it is not there', () => {
  assert.strictEqual(sacState(SAC_ON), 1)
  assert.strictEqual(sacState('ERROR: The system was unable to find the specified registry key or value.'), null)
  assert.match(blockedReason(null), /^An Application Control policy in the Sandbox blocks the installer \(Smart App Control state: unknown\)/)
})

test('inSandbox: the stop failing but the fallback succeeding → cleanup confirmed', async () => {
  const s = scratch('runner-fallback-ok', { stop: 6 }) // sandbox_stop's and the server's shutdown's attempts fail
  process.env.WSB_STUB_STATE = s.state
  const r = await inSandbox(s.env, 't', {}, async () => {})
  assert.strictEqual(r.cleanup, 'ok')
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.ok(s.read().calls.filter(c => c[0] === 'stop').length >= 7) // 6 failed, then a confirmed one (fallback or watchdog)
})
