// The Hive checks' report: which collected facts pass or fail each check, that only full coverage passes, and
// the Markdown it writes.
const test = require('node:test')
const assert = require('assert')
const { evaluate, markdown, verdict, REQUIRED } = require('../scenarios/report')

const HOME = 'C:\\Users\\WDAGUtilityAccount'
const lnk = (name, folder) => ({ name, folder: `${HOME}\\${folder}`, target: `${HOME}\\AppData\\Local\\Programs\\Hive\\Hive.exe` })
const DESKTOP = 'Desktop'
const START = 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs'
const state = (over = {}) => ({
  uninstallEntries: [{ displayName: 'Hive Desktop 0.6.0' }],
  installDir: { exists: true, hiveExe: true, uninstaller: true, appAsarSha256: 'bbbb' },
  profileDir: { exists: true },
  shortcuts: [lnk('Hive Desktop', DESKTOP), lnk('Hive Desktop', START)],
  git: false,
  ...over
})
/** A finished driver record with all its required checks passing. */
const driverOk = (kind, key) => {
  const req = REQUIRED[kind].drivers[key]
  return { completed: true, checks: req.ids.map(id => ({ id, scenario: Number(id.split('.')[0]), name: `check ${id}`, ok: true })), facts: { version: '0.6.0', gitMissing: true, hive: ['workspace.json'], views: {} } }
}
const allShots = [...REQUIRED.fresh.shots, ...REQUIRED.upgrade.shots]
const meta = (over = {}) => ({ installer: 'Hive-Setup-0.6.0.exe', installerVersion: '0.6.0', previousVersion: '0.5.1', ran: ['fresh', 'upgrade'], date: 'd', hostBuild: '10.0.26200', minutes: '3.0', shots: allShots, steps: [{ scenario: 1, what: '1. install', ok: true }], ...over })
const good = () => ({
  's1-run': { exitCode: 0, seconds: 10 },
  's1-state': state(),
  s1: driverOk('fresh', 's1'),
  s3: driverOk('fresh', 's3'),
  s6: driverOk('fresh', 's6'),
  's5-run': { exitCode: 0, seconds: 5 },
  's5-state': state({ uninstallEntries: [], installDir: { exists: false }, shortcuts: [] }),
  's4-prev-run': { exitCode: 0, seconds: 10 },
  's4-prev-state': state({ uninstallEntries: [{ displayName: 'Hive 0.4.1' }], shortcuts: [lnk('Hive', DESKTOP), lnk('Hive', START)], installDir: { exists: true, hiveExe: true, appAsarSha256: 'aaaa' } }),
  's4-mark': driverOk('upgrade', 's4-mark'),
  's4-new-run': { exitCode: 0, seconds: 20, hiveRunning: true },
  's4-new-state': state(),
  's4-after': driverOk('upgrade', 's4-after')
})
const failedNames = r => r.checks.filter(c => !c.ok).map(c => c.name)

test('all facts as expected: every check passes, and the report says so', () => {
  const r = evaluate(meta(), good())
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(r.checks.length >= 36)
  const md = markdown(r)
  assert.match(md, /\*\*PASSED: all \d+ checks\*\*/)
  assert.match(md, /## 4\. Upgrade[\s\S]*Shortcuts renamed or kept: only "Hive Desktop".*\(before: Hive \(Desktop\), Hive \(Start menu\)\)/)
  assert.match(md, /No Git/)
  assert.ok(!/both say/.test(md))
})

test('each wrong fact fails its check, named in "Failed checks"', () => {
  const f = good()
  f['s1-state'] = state({ uninstallEntries: [{ displayName: 'Hive Desktop 0.6.0' }, { displayName: 'Hive 0.4.1' }] })
  f['s4-new-state'] = state({ shortcuts: [lnk('Hive Desktop', DESKTOP), lnk('Hive', START)], installDir: { exists: true, hiveExe: true, appAsarSha256: 'aaaa' } })
  f['s4-new-run'].hiveRunning = false
  f['s5-state'] = state({ uninstallEntries: [], installDir: { exists: false }, shortcuts: [], profileDir: { exists: false } })
  f.s3.checks[4].ok = false
  f.s3.checks[4].detail = 'not found'
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  for (const re of [/One Installed-apps entry: "Hive Desktop 0.6.0"/, /only "Hive Desktop"/, /--force-run starts Hive/, /profile .* is kept/, /check 3\.check-again-finds/, /app code changed/]) {
    assert.ok(failed.some(n => re.test(n)), `${re} not among ${JSON.stringify(failed)}`)
  }
  const md = markdown(r)
  assert.match(md, /\*\*FAILED: \d+ of \d+ checks\*\*/)
  assert.match(md, /## Failed checks[\s\S]*- \*\*3\. check 3\.check-again-finds\*\*: not found/)
})

test('a driver interrupted after a passing check fails: not finished, and its other required checks missing', () => {
  const f = good()
  f.s3 = { checks: [f.s3.checks[0]], facts: {} } // saved as it went, then stopped: no completed
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  assert.ok(failed.includes('s3: the driver finished its step'), JSON.stringify(failed))
  assert.ok(failed.includes('s3: check "3.check-again-finds" ran'))
  assert.strictEqual(failed.filter(n => /^s3: check ".*" ran$/.test(n)).length, REQUIRED.fresh.drivers.s3.ids.length - 1)
  assert.match(markdown(r), /FAILED/)
})

test('empty driver records fail every required check and fact', () => {
  const f = good()
  for (const k of ['s1', 's3', 's6', 's4-mark', 's4-after']) f[k] = {}
  const r = evaluate(meta(), f)
  const failed = failedNames(r)
  const required = Object.values(REQUIRED.fresh.drivers).concat(Object.values(REQUIRED.upgrade.drivers)).reduce((n, d) => n + d.ids.length, 0)
  assert.strictEqual(failed.filter(n => /: check ".*" ran$/.test(n)).length, required)
  assert.ok(failed.includes('s1: fact "version" recorded'))
  assert.ok(failed.includes('s4-after: the driver finished its step'))
  // A completed flag that isn't exactly true doesn't count either.
  const g = good()
  g.s1.completed = 'yes'
  assert.ok(failedNames(evaluate(meta(), g)).includes('s1: the driver finished its step'))
})

test('a failed command, a missing screenshot or an unconfirmed cleanup fails the report', () => {
  const steps = [{ scenario: 3, what: '3. CLI appears', ok: false, detail: 'TIMED OUT after 420 s' }]
  const r = evaluate(meta({ steps, shots: allShots.filter(s => s !== 's3-found-light.png'), leftRunning: ['abc'] }), good())
  const failed = failedNames(r)
  assert.ok(failed.includes('Step: 3. CLI appears'))
  assert.ok(failed.includes('Screenshot s3-found-light.png collected'))
  assert.ok(failed.includes('CLEANUP: Sandbox abc confirmed stopped'))
  assert.match(markdown(r), /TIMED OUT after 420 s/)
})

test('no coverage never passes: no scenario, an unknown one, or no checks at all', () => {
  for (const ran of [[], ['frseh'], undefined]) {
    const r = evaluate(meta({ ran, steps: [] }), {})
    assert.ok(r.failed > 0, JSON.stringify(ran))
    assert.match(markdown(r), /FAILED/)
  }
})

test('same version before and after: the report says the updater would not offer it', () => {
  const r = evaluate(meta({ previousVersion: '0.6.0' }), good())
  assert.match(markdown(r), /both say \*\*0\.6\.0\*\*: the in-app updater .* would not offer this build/)
})

test('only the scenarios that ran are checked', () => {
  const f = good()
  for (const k of Object.keys(f)) if (k.startsWith('s4')) delete f[k]
  const r = evaluate(meta({ ran: ['fresh'], shots: REQUIRED.fresh.shots }), f)
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(!r.checks.some(c => c.scenario === 4))
})

const SAC = { reason: 'Smart App Control in the Sandbox blocks unsigned installers (VerifiedAndReputablePolicyState = 1): sign the installer, or check on a machine without Smart App Control.' }

test('both kinds not run: NOT RUN with the reason once, no checks, no failure (#611)', () => {
  const r = evaluate(meta({ shots: [], steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' }, upgrade: { ...SAC, installer: 'Hive-Setup-0.5.1.exe' } } }), {})
  assert.strictEqual(r.failed, 0)
  assert.strictEqual(r.checks.length, 0)
  assert.strictEqual(verdict(r), `NOT RUN: ${SAC.reason}`)
  const md = markdown(r)
  assert.match(md, /- Scenarios run: none\./)
  assert.strictEqual(md.split(SAC.reason).length - 1, 2) // the verdict and the Not run section
})

test('one kind not run and the other passing: NOT RUN, saying the other checks passed', () => {
  const f = good()
  for (const k of Object.keys(f)) if (!k.startsWith('s4')) delete f[k]
  const r = evaluate(meta({ shots: REQUIRED.upgrade.shots, steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' } } }), f)
  assert.strictEqual(r.failed, 0, JSON.stringify(failedNames(r)))
  assert.ok(r.checks.length && r.checks.every(c => c.scenario === 4))
  assert.strictEqual(verdict(r), `NOT RUN: ${SAC.reason} (not run: fresh; the other ${r.checks.length} checks passed)`)
})

test('one kind not run and the other failing: FAILED, naming what was not run', () => {
  const f = good()
  for (const k of Object.keys(f)) if (!k.startsWith('s4')) delete f[k]
  f['s4-new-run'].exitCode = 2
  const r = evaluate(meta({ shots: REQUIRED.upgrade.shots, steps: [], notRun: { fresh: { ...SAC, installer: 'Hive-Setup-0.6.0.exe' } } }), f)
  assert.ok(r.failed > 0)
  assert.match(verdict(r), /^FAILED: \d+ of \d+ checks; not run: fresh$/)
})
