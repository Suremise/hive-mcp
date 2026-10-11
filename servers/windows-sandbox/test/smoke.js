/**
 * Real smoke test: drives server.js over stdio against the real wsb.exe. Skips cleanly (exit 0, "SKIP") where Windows
 * Sandbox isn't available or another Sandbox is running (never touches one it didn't start).
 *   node test/smoke.js [--runs N] [--wait-min M]
 * --runs N repeats start/stop N times to time the user session (default 1); --wait-min waits up to M minutes for
 * another agent's Sandbox to finish first (default 0: skip). Scratch and logs go to WSB_TEST_SCRATCH
 * (default %LOCALAPPDATA%\hive-test\scratch\wsb-mcp-smoke-<time>); the summary is smoke.json there.
 * Exits non-zero if a check fails or cleanup can't be confirmed. Every Sandbox it starts gets a fallback stop in a
 * finally (ensureGone); one that can't be confirmed stopped is named in smoke.json → leftRunning.
 * For the fault tests (smoke-faults.test.js) only: with WSB_STUB set it drives the stub; SMOKE_FAULT=evidence makes
 * reading the watchdog's evidence throw; SMOKE_KILL_WAIT_MS shortens the wait for the watchdog (default 60 s).
 */
const fs = require('fs')
const path = require('path')
const { server } = require('./helpers')
const wsb = require('../wsb')

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d }
const RUNS = arg('--runs', 1)
const KILL_WAIT_MS = Number(process.env.SMOKE_KILL_WAIT_MS || 60_000)
const WAIT_MIN = arg('--wait-min', 0)
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const DIR = process.env.WSB_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA, 'hive-test', 'scratch', `wsb-mcp-smoke-${stamp}`)
const summary = { at: new Date().toISOString(), runs: [], checks: [] }
const save = () => fs.writeFileSync(path.join(DIR, 'smoke.json'), JSON.stringify(summary, null, 2))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

async function main() {
  fs.mkdirSync(path.join(DIR, 'builds', 'b1'), { recursive: true })
  fs.writeFileSync(path.join(DIR, 'builds', 'b1', 'hello.txt'), 'hello from the build folder')
  const problem = wsb.hostProblem()
  if (problem) return skip(problem)
  for (const t0 = Date.now(); ;) {
    let ids
    try { ids = await wsb.list() } catch (e) { return fail(`wsb list failed before starting: ${e.message}`) }
    if (!ids.length) break
    if (Date.now() - t0 >= WAIT_MIN * 60_000) return skip(`another Sandbox is running (${ids.join(', ')}), not ours`)
    log('waiting for another Sandbox to finish:', ids.join(', '))
    await new Promise(r => setTimeout(r, 30_000))
  }
  const env = {
    ...process.env,
    WSB_MCP_ENABLED: '1',
    WSB_SANDBOX_ROOT: path.join(DIR, 'sandbox'),
    WSB_ALLOWED_ROOTS: '', // the builds folder comes as an MCP root, as from a real client
    WSB_ROOTS_FROM_CWD: '',
    WSB_TOOL_DIRS: `node=${path.dirname(process.execPath)}`
  }
  for (let n = 1; n <= RUNS; n++) {
    const srv = server(env, { roots: [path.join(DIR, 'builds')] })
    const run = { n }
    summary.runs.push(run)
    try {
      const t0 = Date.now()
      const st = await srv.call('sandbox_start', { build: path.join(DIR, 'builds', 'b1') })
      run.id = (/Started Sandbox (\S+),/.exec(st.text) || [])[1]
      log(st.text)
      run.startMs = Date.now() - t0
      run.sessionMs = Number((/User session ready ([\d.]+) s/.exec(st.text) || [])[1] * 1000) || null
      check(`run ${n}: start`, !st.isError, st.text)
      if (st.isError) continue
      if (n > 1) continue // later runs only time the session
      const echo = await srv.call('sandbox_run', { command: 'echo hello-%USERNAME%' })
      check('echo as the user, with its output', /^exit 0/.test(echo.text) && /hello-WDAGUtilityAccount/i.test(echo.text), echo.text)
      const sys = await srv.call('sandbox_run', { command: 'whoami', as: 'system' })
      check('whoami as system', /nt authority\\system/i.test(sys.text), sys.text)
      const build = await srv.call('sandbox_run', { command: 'type C:\\build\\hello.txt' })
      check('the build folder is mapped', /hello from the build folder/.test(build.text), build.text)
      const ro = await srv.call('sandbox_run', { command: 'echo x> C:\\build\\written.txt' })
      check('the build folder is read-only', !/^exit 0/.test(ro.text) && !fs.existsSync(path.join(DIR, 'builds', 'b1', 'written.txt')), ro.text)
      const ps = await srv.call('sandbox_run', { command: 'Get-Date -Format yyyy; "a`"b" | Out-File -Encoding utf8 C:\\out\\from-ps.txt', shell: 'powershell' })
      check('powershell, writing to C:\\out', /^exit 0/.test(ps.text), ps.text)
      const psErr = await srv.call('sandbox_run', { command: 'Write-Error "plain-error"; exit 3', shell: 'powershell' })
      check('powershell errors come back as plain text', /^exit 3[\s\S]*plain-error/.test(psErr.text) && !/CLIXML/.test(psErr.text), psErr.text)
      // The guest can't make links in the mapped folder (probe, round 2): if a Windows update changes that, say so.
      const links = await srv.call('sandbox_run', { command: 'mklink /J C:\\out\\j C:\\Windows & mklink C:\\out\\s.txt C:\\Windows\\win.ini', as: 'system' })
      const outDir = /Writable: C:\\out ← (.*)\.\n/.exec(st.text)[1]
      check('the guest can\'t create links in C:\\out', /Access is denied/.test(links.text) && !['j', 's.txt'].some(n => { try { fs.lstatSync(path.join(outDir, n)); return true } catch { return false } }), links.text)
      const net = await srv.call('sandbox_run', { command: 'curl.exe -s -m 5 https://www.microsoft.com -o NUL', as: 'system' })
      check('network is off', !/^exit 0/.test(net.text), net.text)
      const node = await srv.call('sandbox_run', { command: 'C:\\tools\\node\\node.exe -e "console.log(process.version)"' })
      check('the node tool folder is mapped', /^exit 0[\s\S]*v\d+\./.test(node.text), node.text)
      const hang = await srv.call('sandbox_run', { command: 'ping -n 120 127.0.0.1', timeoutSec: 4 })
      check('a timeout kills the command inside by its PID', /TIMED OUT after 4 s: killed PID \d+ inside \(taskkill exit 0\)/.test(hang.text), hang.text)
      const after = await srv.call('sandbox_run', { command: 'tasklist /fi "IMAGENAME eq PING.EXE" /nh', as: 'system' })
      check('...and it is gone', !/PING\.EXE/i.test(after.text), after.text)
      const shot = await srv.call('sandbox_screenshot')
      const img = shot.content.find(c => c.type === 'image')
      if (img) fs.writeFileSync(path.join(DIR, 'desktop.jpg'), Buffer.from(img.data, 'base64'))
      check('a desktop screenshot', !!img && img.data.length > 10_000, shot.text)
      const got = await srv.call('sandbox_collect', { paths: ['from-ps.txt'] })
      check('collect a file from out', /a"b/.test(got.text), got.text)
      await srv.call('sandbox_run', { command: 'mkdir C:\\out\\logs & echo nested-ok> C:\\out\\logs\\nested.txt' })
      const nested = await srv.call('sandbox_collect', { paths: ['logs/nested.txt'] })
      check('while running, a file in a folder of out is not read', /NOT READ logs\/nested.txt: only files directly/.test(nested.text), nested.text)
      const status = await srv.call('sandbox_status')
      check('status shows it and the watchdog', /Running: .*\n[\s\S]*Watchdog: running/.test(status.text), status.text)
      const stopped = await srv.call('sandbox_stop')
      check('stop confirmed', /^Stopped Sandbox/.test(stopped.text), stopped.text)
      const afterStop = await srv.call('sandbox_collect', { paths: ['logs/nested.txt'] })
      check('after the stop, the file in the folder is read', /### logs\/nested.txt[^\n]*\nnested-ok/.test(afterStop.text), afterStop.text)
    } catch (e) {
      check(`run ${n}: no exception`, false, e.stack)
    } finally {
      const stop = await srv.call('sandbox_stop').catch(e => ({ text: e.message, isError: true }))
      log(stop.text)
      run.stop = stop.text
      check(`run ${n}: stop confirmed`, /^Stopped Sandbox|^No Sandbox running/.test(stop.text), stop.text)
      const ex = await srv.close()
      check(`run ${n}: server exits 0`, ex.code === 0, ex.stderr)
      if (run.id) await ensureGone(run.id, `run ${n}`)
      try { const left = await wsb.list(); check(`run ${n}: none left (wsb list)`, !left.length, left.join(', ')) } catch (e) { check(`run ${n}: none left (wsb list)`, false, e.message) }
      save()
    }
  }
  await hardKill(env)
  const times = summary.runs.map(r => r.sessionMs).filter(Boolean)
  summary.sessionMs = times
  log('user session ready after connect (ms):', times.join(', '))
  const failed = summary.checks.filter(c => !c.ok)
  log(`${summary.checks.length - failed.length}/${summary.checks.length} checks passed; ${path.join(DIR, 'smoke.json')}`)
  save()
  process.exitCode = failed.length ? 1 : 0
}

/**
 * The server killed hard (no exit handler runs): its watchdog must stop the Sandbox and confirm it. Whatever fails on
 * the way (the watchdog, reading its evidence), the finally makes sure the Sandbox this test started is stopped, or
 * reports that it may still be running.
 */
async function hardKill(env) {
  const srv = server(env)
  const hk = (summary.hardKill = {})
  try {
    const st = await srv.call('sandbox_start', { session: false })
    check('hard kill: start', !st.isError, st.text)
    if (st.isError) return
    hk.id = /Started Sandbox (\S+),/.exec(st.text)[1]
    const cd = await srv.call('sandbox_run', { command: 'cd', as: 'system' })
    check('no build mapped: commands run in C:\\', /^exit 0[\s\S]*\nC:\\$/.test(cd.text), cd.text)
    srv.child.kill('SIGKILL')
    const t0 = Date.now()
    let gone = false
    while (!gone && Date.now() - t0 < KILL_WAIT_MS) {
      await new Promise(r => setTimeout(r, 500))
      try { gone = !(await wsb.list()).includes(hk.id) } catch { /* unknown: keep waiting */ }
    }
    hk.stopMs = Date.now() - t0
    check(`hard kill: the watchdog stopped ${hk.id} (${hk.stopMs} ms)`, gone, `still listed after ${KILL_WAIT_MS / 1000} s`)
    if (process.env.SMOKE_FAULT === 'evidence') throw new Error('injected fault: reading the watchdog evidence failed')
    const runDir = fs.readdirSync(path.join(DIR, 'sandbox')).map(d => path.join(DIR, 'sandbox', d)).find(d => fs.existsSync(path.join(d, 'state.json')) && JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')).id === hk.id)
    let w = null
    for (let i = 0; i < 20 && !w; i++) { try { w = JSON.parse(fs.readFileSync(path.join(runDir, 'watchdog.json'), 'utf8')) } catch { await new Promise(r => setTimeout(r, 500)) } }
    check('hard kill: watchdog.json says stopped', w?.stopped === true && w.reason === 'server gone', JSON.stringify(w))
  } catch (e) {
    check('hard kill: no exception', false, e.stack)
  } finally {
    if (srv.child.exitCode === null && srv.child.signalCode === null) await srv.close()
    if (hk.id) await ensureGone(hk.id, 'hard kill')
    save()
  }
}

/**
 * A Sandbox this test started must be gone: confirmed by list, else stopped (confirm and retry). If it can't be
 * confirmed, the check fails, the id is kept in smoke.json (leftRunning) and the exit code is non-zero.
 */
async function ensureGone(id, label) {
  let gone = false
  try { gone = !(await wsb.list()).includes(id) } catch { /* unknown: stop it */ }
  if (gone) return check(`${label}: cleanup of ${id} confirmed`, true)
  const r = await wsb.stopConfirmed(id)
  ;(summary.fallbackStops ||= []).push({ id, label, ok: r.ok, attempts: r.attempts })
  if (!r.ok) (summary.leftRunning ||= []).push(id)
  check(`${label}: cleanup of ${id} confirmed (fallback stop)`, r.ok, `CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running: ${JSON.stringify(r.attempts.at(-1))}`)
}

function check(name, ok, detail) {
  summary.checks.push({ name, ok, detail: ok ? undefined : String(detail).slice(0, 2000) })
  log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `\n  ${String(detail).slice(0, 600)}`)
}
function skip(why) { log('SKIP:', why); summary.skipped = why; save() }
function fail(why) { log('FAIL:', why); summary.error = why; save(); process.exitCode = 1 }

main().catch(e => fail(e.stack))
