/**
 * Shared helpers for the Windows Sandbox probes. Node built-ins only, like the servers.
 *
 * Every probe runs its body through `withSandbox`, which always stops the Sandbox it started (also
 * after a failure or Ctrl+C) and then lists running Sandboxes to confirm none is left.
 *
 * All logs and scratch go to one folder under %LOCALAPPDATA%\hive-test\scratch, never the repo.
 */
const { execFile } = require('child_process')
const { mkdirSync, writeFileSync, appendFileSync } = require('fs')
const { join } = require('path')

const WSB = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wsb.exe')

// One scratch folder per probe run: <root>\wsb-probe-<time>\<probe>. PROBE_SCRATCH overrides the root.
function scratchDir(probe) {
  const root = process.env.PROBE_SCRATCH ||
    join(process.env.LOCALAPPDATA, 'hive-test', 'scratch', 'wsb-probe-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-'))
  const dir = join(root, probe)
  mkdirSync(dir, { recursive: true })
  return dir
}

let logFile = null
function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  console.log(line)
  if (logFile) appendFileSync(logFile, line + '\n')
}

/** Runs wsb.exe with --raw; resolves { code, json, stdout, stderr, ms }. Never rejects on a non-zero exit. */
function wsb(args, timeoutMs = 300_000) {
  const t0 = Date.now()
  return new Promise(resolve => {
    execFile(WSB, [...args, '--raw'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json = null
      try { json = stdout.trim() ? JSON.parse(stdout) : null } catch { /* not JSON */ }
      const code = err ? (typeof err.code === 'number' ? err.code : err.code || 'error') : 0
      resolve({ code, json, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - t0 })
    })
  })
}

/**
 * Ids of the running Sandboxes. Fails closed: a failed `wsb list`, or a reply without the expected array of string
 * Ids, throws rather than looking like "none running" (the one-Sandbox guard and the cleanup check rely on it).
 */
async function running() {
  const r = await wsb(['list'], 60_000)
  const envs = r.json?.WindowsSandboxEnvironments
  if (r.code !== 0 || !Array.isArray(envs) || envs.some(e => typeof e?.Id !== 'string' || !e.Id)) {
    throw new Error(`wsb list failed or replied unexpectedly (exit ${r.code}): ${r.stderr || r.stdout || 'no output'}`)
  }
  return envs.map(e => e.Id)
}

/** XML config for `wsb start -c`. folders: [{ host, sandbox, readOnly }]. */
function config({ networking = false, folders = [], logon, memoryMB, vGpu, clipboard = false } = {}) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let x = '<Configuration>'
  x += `<Networking>${networking ? 'Enable' : 'Disable'}</Networking>`
  if (vGpu !== undefined) x += `<vGPU>${vGpu ? 'Enable' : 'Disable'}</vGPU>`
  x += `<ClipboardRedirection>${clipboard ? 'Enable' : 'Disable'}</ClipboardRedirection>`
  x += '<AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection>'
  if (memoryMB) x += `<MemoryInMB>${memoryMB}</MemoryInMB>`
  if (folders.length) {
    x += '<MappedFolders>'
    for (const f of folders) {
      x += `<MappedFolder><HostFolder>${esc(f.host)}</HostFolder>`
      if (f.sandbox) x += `<SandboxFolder>${esc(f.sandbox)}</SandboxFolder>`
      x += `<ReadOnly>${f.readOnly ? 'true' : 'false'}</ReadOnly></MappedFolder>`
    }
    x += '</MappedFolders>'
  }
  if (logon) x += `<LogonCommand><Command>${esc(logon)}</Command></LogonCommand>`
  return x + '</Configuration>'
}

/** exec inside; resolves the wsb result (its JSON carries ExitCode). timeoutMs kills only the host-side wsb client. */
function exec(id, command, runAs = 'System', cwd, timeoutMs) {
  const args = ['exec', '--id', id, '-c', command, '-r', runAs]
  if (cwd) args.push('-d', cwd)
  return wsb(args, timeoutMs)
}

/** Polls until fn() is truthy or timeoutMs passes; resolves ms taken or null. */
async function until(fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0
    await new Promise(r => setTimeout(r, everyMs))
  }
  return null
}

const STOP_ATTEMPTS = 3
const STOP_RETRY_MS = Number(process.env.PROBE_STOP_RETRY_MS || 3000)

/**
 * Runs body(ctx) with a freshly started Sandbox and always stops it afterwards.
 * Refuses to start when one is already running (only one Sandbox at a time) or when that can't be told.
 * Cleanup fails closed: the Sandbox's id is kept until `list` confirms it is gone (stop is retried, bounded), and
 * a failed stop, a failed list or any Sandbox still running afterwards marks the run failed (results.cleanup,
 * results.error) and sets a non-zero exit code. So does a failure in the body.
 */
async function withSandbox(probe, cfg, body) {
  const dir = scratchDir(probe)
  logFile = join(dir, 'probe.log')
  const results = { probe, startedAt: new Date().toISOString(), steps: {} }
  const save = () => writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2))
  const fail = msg => { log('FAILED:', msg); results.error = results.error ? results.error + '; ' + msg : msg; process.exitCode = 1 }
  try {
    const already = await running()
    if (already.length) throw new Error(`A Sandbox is already running (${already.join(', ')}); not starting another.`)
  } catch (e) {
    fail('not started: ' + (e.message || e))
    results.cleanup = 'not started'
    save()
    return results
  }

  let id = null
  let stopping = null
  // Stops the owned Sandbox; resolves true once list confirms it is gone. Keeps the id on failure so a later
  // call (finally after a signal, or the reverse) tries again. Concurrent calls share one attempt.
  const stop = why => {
    if (!id) return Promise.resolve(true)
    if (stopping) return stopping
    stopping = (async () => {
      results.steps.stop = { attempts: [] }
      for (let n = 1; n <= STOP_ATTEMPTS; n++) {
        const r = await wsb(['stop', '--id', id], 120_000)
        let gone = false
        let listError
        try { gone = !(await running()).includes(id) } catch (e) { listError = String(e.message || e) }
        log(`stop (${why}) attempt ${n}:`, { code: r.code, ms: r.ms, stderr: r.stderr, gone, listError })
        results.steps.stop.attempts.push({ code: r.code, ms: r.ms, gone, listError })
        results.steps.stop.code = r.code
        results.steps.stop.ms = r.ms
        if (gone) { id = null; return true }
        if (n < STOP_ATTEMPTS) await new Promise(res => setTimeout(res, STOP_RETRY_MS))
      }
      return false
    })().finally(() => { stopping = null })
    return stopping
  }
  const onSignal = async () => {
    const ok = await stop('signal')
    if (!ok) log('FAILED: Sandbox', id, 'may still be running after the signal')
    process.exit(ok ? 130 : 1)
  }
  process.on('SIGINT', onSignal)
  try {
    const xml = typeof cfg === 'function' ? cfg(dir) : cfg
    writeFileSync(join(dir, 'config.xml'), xml)
    log('start, config:', xml)
    const r = await wsb(['start', '-c', xml])
    log('start:', { code: r.code, ms: r.ms, json: r.json, stderr: r.stderr })
    results.steps.start = { code: r.code, ms: r.ms }
    id = typeof r.json?.Id === 'string' && r.json.Id ? r.json.Id : null
    if (!id) throw new Error('start returned no Id: ' + (r.stderr || r.stdout))
    results.id = id
    await body({ id, dir, log, results })
  } catch (e) {
    fail(e.stack || String(e))
  } finally {
    const stopped = await stop('finally')
    if (!stopped) fail(`stop not confirmed after ${STOP_ATTEMPTS} attempts: Sandbox ${id} may still be running`)
    try {
      const left = await running()
      results.leftRunning = left
      log('running after stop:', left)
      if (left.length) fail(`Sandboxes still running after the probe: ${left.join(', ')}`)
    } catch (e) {
      results.leftRunning = 'unknown'
      fail('could not confirm none left: ' + (e.message || e))
    }
    results.cleanup = stopped && Array.isArray(results.leftRunning) && !results.leftRunning.length ? 'ok' : 'FAILED'
    process.off('SIGINT', onSignal)
    save()
    log('results:', join(dir, 'results.json'), 'cleanup:', results.cleanup)
  }
  return results
}

module.exports = { WSB, wsb, running, config, exec, until, withSandbox, scratchDir, log }
