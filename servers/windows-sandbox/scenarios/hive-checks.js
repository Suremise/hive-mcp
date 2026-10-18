/**
 * Hive build checks in Windows Sandbox: fresh install and first run, first run with no CLIs, a CLI
 * appearing while Hive runs, the upgrade from the previous release, and uninstall. Drives server.js over stdio:
 * one Sandbox for scenarios 1, 2, 3 and 5, a second for 4. Network off throughout, fake CLIs only, nothing signed in;
 * every command has a timeout. Writes a short report (report.md, report.json) with screenshots to --report.
 *
 *   node scenarios\hive-checks.js --installer <Hive-Setup-x.y.z.exe> [--previous <older installer>]
 *        --hive <Hive repo> [--report <folder>] [--only fresh|upgrade] [--wait-min N] [--smart-app-control off]
 *
 * --hive (or HIVE_REPO) is a built checkout of the Hive repo. --previous defaults to the newest Hive-Setup-*.exe in <hive>\dist other than --installer. Both installers must sit
 * under one folder (not a drive root), which is mapped read-only at C:\build. The Hive repo gives Hive's own
 * playwright-core and its e2e fake CLIs (read-only); Node is this one's folder.
 * Exit code: 0 all checks passed, 1 a check failed (or a Sandbox's cleanup wasn't confirmed), 2 not run (also when the
 * Sandbox's App Control policy, e.g. Smart App Control, refuses an installer: see NotRun).
 * --smart-app-control off: the server turns Smart App Control off inside each Sandbox (never on the host), so unsigned
 * installers can be checked; the runner reads the state back before each install, and NOT RUN if it isn't off.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { server } = require('../client')
const { stopConfirmed, list, hostProblem, SAC_QUERY, sacState } = require('../wsb')
const { evaluate, markdown, verdict, KINDS } = require('./report')

const versionOf = f => (/Hive-Setup-(\d+\.\d+\.\d+(?:-[\w.]+)?)\.exe$/i.exec(f) || [])[1]
/**
 * Semver order: major.minor.patch, then a release above its prereleases (0.9.0 > 0.9.0-rc.1 > 0.9.0-beta.1), whose
 * dot-separated parts compare numerically when both are numbers, else as text (numbers first), the shorter first on a tie.
 */
function cmpVersion(a, b) {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  for (let i = 0; i < 3; i++) if (coreA[i] !== coreB[i]) return coreA[i] - coreB[i]
  if (!preA || !preB) return !preA - !preB
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const [x, y] = [preA[i], preB[i]]
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)]
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) - Number(y) } else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return preA.length - preB.length
}
function splitVersion(v) {
  const i = v.indexOf('-')
  return [(i < 0 ? v : v.slice(0, i)).split('.').map(Number), i < 0 ? null : v.slice(i + 1).split('.')]
}
const isInside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r) }

// Windows refusing an installer under an App Control policy: in a Sandbox where Smart App Control enforces, every
// unsigned installer. Nothing after it can be checked, so that Sandbox's scenarios are NOT RUN with one reason rather
// than dozens of failures. The runner itself only reads the policy (reg query); with --smart-app-control off it asks
// the server to turn it off inside the Sandbox (sandbox_start's smartAppControl), never on the host.
// PowerShell wraps the error at the console width, anywhere in the text (" \r\n" seen mid-sentence): match without spaces.
const blocked = text => /AnApplicationControlpolicyhasblockedthisfile/i.test(String(text).replace(/\s+/g, ''))
/** A Sandbox's scenarios that couldn't run: message is the reason (the same for every installer), installer the file. */
class NotRun extends Error {
  constructor(reason, installer) { super(reason); this.installer = installer }
}
/** Why the run can't check an installer the policy refused, in one line. */
function blockedReason(sac) {
  return sac === 1
    ? 'Smart App Control in the Sandbox blocks unsigned installers (VerifiedAndReputablePolicyState = 1): sign the installer, or run the checks with --smart-app-control off.'
    : `An Application Control policy in the Sandbox blocks the installer (Smart App Control state: ${sac ?? 'unknown'}): sign the installer, or check on a machine without that policy.`
}
/** Why the run can't check an installer when --smart-app-control off didn't take, in one line. */
const notOffReason = sac => `Smart App Control was to be turned off in the Sandbox (--smart-app-control off), but it reads ${sac ?? 'unknown'} (VerifiedAndReputablePolicyState), not 0: the installers weren't run.`
/** report.json → meta.smartAppControl: the state read in the Sandbox, and whether the option changed it. */
const sacMeta = (state, off) => ({ state, option: off ? 'off' : 'keep', note: !off ? 'left as Windows set it (read only)' : state === 0 ? 'turned off by option' : 'asked off by option, but not off' })

// Logging never throws: a full disk or a locked log must not stop a cleanup (found in review).
let logFile = null
let logSink = line => { console.log(line); if (logFile) fs.appendFileSync(logFile, line + '\n') }
const log = (...a) => { try { logSink(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`) } catch { /* the run goes on; the report is written at the end */ } }

/** The one folder, below a drive root, holding both installers (mapped read-only at C:\build). Throws why there is none. */
function buildRoot(installer, previous) {
  let root = path.dirname(path.resolve(installer))
  if (previous) {
    const prev = path.resolve(previous)
    if (path.parse(root).root.toLowerCase() !== path.parse(prev).root.toLowerCase()) throw new Error(`The installers are on different drives (${path.parse(root).root} and ${path.parse(prev).root}): put both under one folder.`)
    while (!isInside(prev, root)) {
      const up = path.dirname(root)
      if (up === root) break
      root = up
    }
  }
  if (path.parse(root).root === root) throw new Error(`The installers' only common folder is the drive root (${root}): put both under one folder, which is mapped read-only into the Sandbox.`)
  return root
}

/** Reads the options and finds the installers. Throws (before any Sandbox starts) on anything wrong. */
function plan(argv) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const only = opt('--only')
  if (only !== undefined && !KINDS.includes(only)) throw new Error(`--only is ${KINDS.join(' or ')}, not "${only}"`)
  const sac = opt('--smart-app-control')
  if (argv.includes('--smart-app-control') && sac !== 'off') throw new Error(`--smart-app-control takes only "off" (turned off inside the Sandbox; leave it out to keep Windows' setting), not ${sac === undefined ? 'nothing' : `"${sac}"`}`)
  const hiveOpt = opt('--hive', process.env.HIVE_REPO)
  if (!hiveOpt) throw new Error('--hive <Hive repo> (or HIVE_REPO) is required: it gives the previous installers, playwright-core and the fake CLIs')
  const hive = path.resolve(hiveOpt)
  const installer = opt('--installer') && path.resolve(opt('--installer'))
  if (!installer || !fs.existsSync(installer) || !versionOf(installer)) throw new Error('--installer must name an existing Hive-Setup-<version>.exe')
  const ran = only ? [only] : [...KINDS]
  let previous = opt('--previous') && path.resolve(opt('--previous'))
  if (!previous && ran.includes('upgrade')) {
    const dist = path.join(hive, 'dist')
    const cands = fs.existsSync(dist) ? fs.readdirSync(dist).filter(f => versionOf(f)).map(f => path.join(dist, f)).filter(f => f.toLowerCase() !== installer.toLowerCase()) : []
    previous = cands.sort((a, b) => cmpVersion(versionOf(b), versionOf(a)))[0]
    if (!previous) throw new Error(`No previous installer in ${dist}: pass --previous`)
  }
  if (previous && (!fs.existsSync(previous) || !versionOf(previous))) throw new Error('--previous must name an existing Hive-Setup-<version>.exe')
  const upgrade = ran.includes('upgrade')
  const root = buildRoot(installer, upgrade ? previous : null)
  const buildInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(installer), 'build-info.json'), 'utf8')) } catch { return null } })()
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const guest = f => 'C:\\build\\' + path.relative(root, f)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  return {
    hive,
    ran,
    installer,
    previous: upgrade ? previous : null,
    root,
    buildInfo,
    sameInstaller: upgrade && sha(installer) === sha(previous),
    guestInstaller: guest(installer),
    guestPrevious: upgrade ? guest(previous) : null,
    report: path.resolve(opt('--report', path.join(process.env.LOCALAPPDATA, 'hive-test', 'sandbox-reports', stamp))),
    waitMin: Number(opt('--wait-min', 0)),
    sacOff: sac === 'off'
  }
}

/**
 * Runs body(srv) in a fresh Sandbox and always stops it. The owned id is taken before anything that can fail, and
 * close plus the id's confirm-and-retry run in a finally of their own, whatever the logging or the body did.
 * Resolves { id, cleanup: 'ok' } or throws; a cleanup that can't be confirmed throws with err.leftRunning = id.
 * `roots` are the MCP roots the client gives the server: the build folder must be under one.
 */
async function inSandbox(env, label, startArgs, body, roots) {
  const srv = server(env, { roots })
  let id = null
  let bodyError = null
  try {
    const st = await srv.call('sandbox_start', startArgs)
    id = (/Started Sandbox (\S+),/.exec(st.text) || [])[1] || null
    log(`${label}: ${st.text.split('\n')[0]}`)
    if (st.isError || !id) throw new Error(`sandbox_start failed: ${st.text}`)
    if (!/User session ready/.test(st.text)) throw new Error(`no user session: ${st.text}`)
    await body(srv)
  } catch (e) {
    bodyError = e
  } finally {
    try {
      const stop = await srv.call('sandbox_stop').catch(e => ({ text: e.message, isError: true }))
      log(`${label}: ${stop.text.split('\n')[0]}`)
    } finally {
      await srv.close().catch(() => {})
      if (id) {
        let gone = false
        try { gone = !(await list()).includes(id) } catch { /* unknown: stop it */ }
        if (!gone) {
          const r = await stopConfirmed(id)
          if (!r.ok) {
            log(`${label}: CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`)
            throw Object.assign(new Error(`CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running${bodyError ? ` (after: ${bodyError.message})` : ''}`), { leftRunning: id })
          }
          log(`${label}: fallback stop of ${id} confirmed`)
        }
      }
    }
  }
  if (bodyError) throw bodyError
  return { id, cleanup: 'ok' }
}

/** The steps one Sandbox's body uses. Each records { scenario, what, ok, detail } in ctx.steps: the report needs all ok. */
function steps(srv, ctx) {
  const record = (scenario, what, ok, detail) => { ctx.steps.push({ scenario, what, ok: !!ok, detail: ok ? undefined : String(detail).slice(0, 600) }); return ok }
  const run = async (scenario, what, command, { as = 'user', timeoutSec = 300 } = {}) => {
    const r = await srv.call('sandbox_run', { command, as, timeoutSec })
    log(`${what}: ${r.text.split('\n')[0]}${r.isError ? ` (${r.text.slice(0, 300).replace(/\s+/g, ' ')})` : ''}`)
    record(scenario, what, !r.isError && /^exit 0\b/.test(r.text), r.text.slice(0, 600))
    return r
  }
  const ps = (scenario, what, script, args, o) => run(scenario, what, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\wsb-mcp\\hive\\${script} ${args}`, o)
  const drive = (scenario, what, step, prefix) => run(scenario, what, `C:\\tools\\node\\node.exe C:\\wsb-mcp\\hive\\drive.cjs ${step} ${prefix}`, { timeoutSec: 420 })
  /** Smart App Control's state in this Sandbox, read only; logged and kept for the reason if an install is blocked. */
  const readSac = async () => {
    const r = await srv.call('sandbox_run', { command: SAC_QUERY, as: 'user', timeoutSec: 30 }).catch(e => ({ text: e.message }))
    ctx.sac = sacState(r.text)
    log(`Smart App Control in the Sandbox: ${ctx.sac ?? 'not read'}${ctx.sacOff ? ' (to be off by option)' : ''}`)
  }
  /**
   * Runs an installer through install.ps1; one refused by an App Control policy ends this Sandbox's scenarios: NOT RUN.
   * With --smart-app-control off, the state is read again first and must be 0, or the installer isn't run: NOT RUN.
   */
  const install = async (scenario, what, exe, args, o) => {
    if (ctx.sacOff) {
      await readSac()
      if (ctx.sac !== 0) throw new NotRun(notOffReason(ctx.sac), exe.split('\\').pop())
    }
    const r = await ps(scenario, what, 'install.ps1', `-Exe "${exe}" ${args}`, o)
    if (blocked(r.text)) throw new NotRun(blockedReason(ctx.sac), exe.split('\\').pop())
    return r
  }
  const desktop = async (scenario, name) => {
    const r = await srv.call('sandbox_screenshot')
    const img = r.content.find(c => c.type === 'image')
    if (img) { fs.writeFileSync(path.join(ctx.report, `${name}.jpg`), Buffer.from(img.data, 'base64')); ctx.shots.push(`${name}.jpg`) }
    record(scenario, `desktop screenshot ${name}`, !!img, r.text)
  }
  /** Everything the scenarios wrote with these prefixes, from the top of C:\out: JSON into files, PNGs into the report. */
  const collect = async (scenario, prefixes) => {
    const listing = await srv.call('sandbox_collect')
    if (!record(scenario, `collect ${prefixes.join(', ')}`, !listing.isError, listing.text)) return
    const names = listing.text.split('\n').filter(l => l.startsWith('- ') && !l.endsWith(')')).map(l => l.slice(2)).filter(n => prefixes.some(p => n.startsWith(p)))
    for (const n of names) {
      const r = await srv.call('sandbox_collect', { paths: [n], maxBytes: 8 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 })
      const img = r.content.find(c => c.type === 'image')
      if (img) { fs.writeFileSync(path.join(ctx.report, n), Buffer.from(img.data, 'base64')); ctx.shots.push(n); continue }
      if (!n.endsWith('.json')) continue
      const key = n.replace(/\.json$/, '')
      try { ctx.files[key] = JSON.parse(r.text.slice(r.text.indexOf('\n') + 1).replace(/^\uFEFF/, '')) } catch (e) { ctx.files[`${key}:error`] = `unreadable: ${e.message}` }
    }
  }
  return { run, ps, drive, desktop, collect, record, readSac, install }
}

const SCENARIO_OF = { fresh: 1, upgrade: 4 }

async function main(argv) {
  const t0 = Date.now()
  let p
  try { p = plan(argv) } catch (e) { console.error(`NOT RUN: ${e.message}`); return 2 }
  fs.mkdirSync(p.report, { recursive: true })
  logFile = path.join(p.report, 'run.log')
  const problem = hostProblem()
  if (problem) { log('NOT RUN:', problem); return 2 }
  log(`installer ${p.installer} (${versionOf(p.installer)}); previous ${p.previous || '-'}; build folder ${p.root}; report ${p.report}${p.sacOff ? '; Smart App Control: off inside the Sandbox, by option' : ''}`)
  for (const t0w = Date.now(); ;) {
    let ids
    try { ids = await list() } catch (e) { log('NOT RUN:', e.message); return 2 }
    if (!ids.length) break
    if (Date.now() - t0w >= p.waitMin * 60_000) { log(`NOT RUN: another Sandbox is running (${ids.join(', ')}), not ours`); return 2 }
    log('waiting for another Sandbox to finish:', ids.join(', '))
    await new Promise(r => setTimeout(r, 30_000))
  }
  const env = {
    ...process.env,
    WSB_MCP_ENABLED: '1',
    WSB_ALLOWED_ROOTS: '', // the build folder comes as an MCP root (inSandbox), not from the config
    WSB_ROOTS_FROM_CWD: '',
    WSB_TOOL_DIRS: [`node=${path.dirname(process.execPath)}`, `playwright=${path.join(p.hive, 'node_modules', 'playwright-core')}`, `hive-tests=${path.join(p.hive, 'tests')}`].join(';'),
    WSB_SANDBOX_ROOT: path.join(p.report, 'sandbox')
  }
  const ctx = { report: p.report, files: {}, shots: [], steps: [], timings: {}, leftRunning: [], notRun: {}, sac: null, sacOff: p.sacOff }
  const start = { build: p.root, network: false, session: true, tools: ['node', 'playwright', 'hive-tests'], maxMinutes: 30, ...(p.sacOff ? { smartAppControl: 'off' } : {}) }
  const time = async (k, fn) => { const t = Date.now(); const r = await fn(); ctx.timings[k] = `${((Date.now() - t) / 1000).toFixed(1)} s`; return r }
  const bodies = {
    fresh: async srv => {
      const s = steps(srv, ctx)
      await s.readSac()
      await time('1. silent install', () => s.install(1, '1. install', p.guestInstaller, '-Arguments "/S" -Name s1', { timeoutSec: 300 }))
      await s.desktop(1, 's1-desktop')
      await s.run(1, '1. open Installed apps', 'start "" ms-settings:appsfeatures', { timeoutSec: 30 })
      await new Promise(r => setTimeout(r, 6000))
      await s.desktop(1, 's1-installed-apps')
      await s.run(1, '1. close Settings', 'powershell.exe -NoProfile -Command "Get-Process SystemSettings -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }"', { timeoutSec: 30 })
      await time('1-2. first run, Agent Setup, both themes', () => s.drive(2, '1-2. first run', 'first-run', 's1'))
      await time('3. a CLI appears while Hive runs', () => s.drive(3, '3. CLI appears', 'cli-appears', 's3'))
      await time('6. a new workspace', () => s.drive(6, '6. new workspace', 'workspace', 's6'))
      await time('5. silent uninstall', () => s.ps(5, '5. uninstall', 'install.ps1', '-Exe "%LOCALAPPDATA%\\Programs\\Hive\\Uninstall Hive.exe" -Arguments "/S" -Name s5 -Uninstall', { timeoutSec: 300 }))
      await s.desktop(5, 's5-desktop')
      await s.collect(5, ['s1', 's3', 's5', 's6'])
    },
    upgrade: async srv => {
      const s = steps(srv, ctx)
      await s.readSac()
      await time('4. previous release install', () => s.install(4, '4. install previous', p.guestPrevious, '-Arguments "/S" -Name s4-prev', { timeoutSec: 300 }))
      await s.drive(4, '4. change settings', 'mark', 's4-mark')
      await s.desktop(4, 's4-desktop-before')
      await time('4. update install (--updated /S --force-run)', () => s.install(4, '4. install new', p.guestInstaller, '-Arguments "--updated /S --force-run" -Name s4-new', { timeoutSec: 300 }))
      await s.drive(4, '4. after the upgrade', 'after-upgrade', 's4-after')
      await s.desktop(4, 's4-desktop-after')
      await s.collect(4, ['s4'])
    }
  }
  for (const kind of p.ran) {
    const before = ctx.steps.length
    try {
      await inSandbox(env, kind, start, bodies[kind], [p.root])
    } catch (e) {
      if (e instanceof NotRun) {
        // Its steps so far go too: the scenarios weren't checked, so nothing in them passed or failed.
        ctx.steps.splice(before)
        ctx.notRun[kind] = { reason: e.message, installer: e.installer }
        // Progress only: the run's one NOT RUN line, with the reason, is the verdict at the end.
        log(`${kind}: Windows refused ${e.installer}; its scenarios are skipped`)
        continue
      }
      log(`${kind}: ERROR: ${e.message}`)
      ctx.steps.push({ scenario: SCENARIO_OF[kind], what: `${kind} Sandbox`, ok: false, detail: e.message })
      if (e.leftRunning) ctx.leftRunning.push(e.leftRunning)
    }
  }

  const meta = {
    date: new Date().toISOString(),
    installer: path.basename(p.installer),
    installerPath: p.installer,
    installerVersion: versionOf(p.installer),
    buildInfo: p.buildInfo,
    previous: p.previous && path.relative(p.root, p.previous),
    previousVersion: p.previous && versionOf(p.previous),
    sameInstaller: p.sameInstaller,
    hostBuild: os.release(),
    ran: p.ran,
    minutes: ((Date.now() - t0) / 60_000).toFixed(1),
    timings: ctx.timings,
    shots: ctx.shots,
    steps: ctx.steps,
    leftRunning: ctx.leftRunning,
    notRun: ctx.notRun,
    smartAppControl: sacMeta(ctx.sac, p.sacOff)
  }
  const result = evaluate(meta, ctx.files)
  fs.writeFileSync(path.join(p.report, 'report.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(p.report, 'report.md'), markdown(result))
  log(`${verdict(result)}; ${path.join(p.report, 'report.md')}`)
  return result.failed ? 1 : result.notRun.length ? 2 : 0
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, e => { log('ERROR:', e.stack || e); process.exitCode = 2 })
}
// For tests.
module.exports = { buildRoot, plan, inSandbox, sacState, blockedReason, cmpVersion, setLogSink: fn => { logSink = fn } }
