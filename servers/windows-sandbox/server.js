/**
 * Windows Sandbox MCP server (stdio). Lets an agent test builds on a clean Windows: start a Sandbox with a build folder
 * mapped read-only, run commands and get their output, take desktop screenshots, collect files from one writable out
 * folder, and always stop it again. Drives wsb.exe (Windows 11 24H2+).
 *
 * Self-contained on purpose: only Node built-ins (Node 18+), plain JSON-RPC over stdio, so it runs without npm install.
 * MIT licence, like Hive.
 */
const { createInterface } = require('readline')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const { join } = require('path')
const { ID_RE, wsb, list, stopConfirmed, configXml, hostProblem, hint, connect, windowOp } = require('./wsb')
const { segments, outRoot, readLive, pinRoot, readFile, listOut, globMatcher, parsePid, inside } = require('./confine')
const { realDir, profileRefusal, rootsClient, allowedRoots } = require('./roots')

const VERSION = '1.1.0'
const ENABLED = process.env.WSB_MCP_ENABLED === '1'
const DEFAULT_ROOT = join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'sandbox')
const ROOT = process.env.WSB_SANDBOX_ROOT || DEFAULT_ROOT
const INSIDE = join(__dirname, 'inside')
const SESSION_WAIT_MS = Number(process.env.WSB_SESSION_WAIT_MS || 90_000)
const READY_WAIT_MS = 60_000
const OUTPUT_CAP = 16 * 1024
const MAX_COMMAND = 8000
const KB = n => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
const secs = ms => `${(ms / 1000).toFixed(1)} s`

let run = null // the Sandbox this server started: { id, runDir, outDir, pinFd, startedAt, deadline, network, session, windowClosed, runs, shots, watchdog, timer, unconfirmed, lastStop }
let last = null // the last run, confirmed stopped, for sandbox_collect after stop: { id, outDir, note }
let startPromise = null
const recovery = [] // what the start-up check found
// The client's MCP roots: asked with roots/list at each sandbox_start (and status), when initialize declared them.
const roots = rootsClient(m => process.stdout.write(JSON.stringify(m) + '\n'))

// ---------- helpers ----------

const until = async (fn, timeoutMs, everyMs = 1000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0
    await new Promise(r => setTimeout(r, everyMs))
  }
  return null
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const splitList = v => String(v || '').split(';').map(s => s.trim()).filter(Boolean)

/** The server's own out folders, which nothing may map, or null. */
function ownFolders(real) {
  if (!fs.existsSync(ROOT)) return null
  const root = fs.realpathSync.native(ROOT)
  return inside(real, root) || inside(root, real) ? "it overlaps the server's own out folders" : null
}
/** Why a host folder must never be mapped, or null: the profile itself, its dot-folders (sign-ins), AppData, out. */
const forbidden = real => profileRefusal(real) || ownFolders(real)

/** The folders builds may come from now: the client's roots, the cwd opt-in and WSB_ALLOWED_ROOTS (roots.js rules). */
async function buildRoots() {
  return allowedRoots({
    client: await roots.list(),
    env: splitList(process.env.WSB_ALLOWED_ROOTS),
    cwd: process.env.WSB_ROOTS_FROM_CWD === '1' ? process.cwd() : null,
    names: { env: 'WSB_ALLOWED_ROOTS', cwd: 'WSB_ROOTS_FROM_CWD=1' },
    refuse: ownFolders
  })
}

/** Resolves a host folder, refusing the profile, its dot-folders, AppData and out. Throws with the reason. */
function mappable(p, what) {
  let real
  try { real = realDir(p) } catch (e) { throw new Error(`${what} "${p}": ${e.code === 'ENOENT' ? 'not found' : e.message}`) }
  const why = forbidden(real)
  if (why) throw new Error(`${what} "${p}" can't be mapped: ${why}.`)
  return real
}

/**
 * A build folder that must really sit under the allowed roots. Throws with the reason, naming where roots came from.
 * A path check, by real path: it stops any path or link an agent passes. It can't stop a local process running as the
 * user that swaps a folder for a junction between this check and the Sandbox start; such a process can already read
 * those files itself (documented in the README, "What the confinement guarantees").
 */
function mappableBuild(p, allowed) {
  if (allowed.refusal) throw new Error(`Build folder "${p}" can't be mapped: ${allowed.refusal}.`)
  const real = mappable(p, 'Build folder')
  if (!allowed.allows(real)) throw new Error(`Build folder "${p}" is not under an allowed folder (${allowed.describe()}).`)
  return real
}

/** WSB_TOOL_DIRS: "name=path;name=path". */
function toolDirs() {
  const tools = {}
  for (const e of splitList(process.env.WSB_TOOL_DIRS)) {
    const i = e.indexOf('=')
    const name = e.slice(0, i).trim()
    if (i > 0 && /^[a-z0-9][a-z0-9-]{0,31}$/i.test(name)) tools[name.toLowerCase()] = e.slice(i + 1).trim()
  }
  return tools
}

/**
 * Settings that can't work as given, such as an example's placeholder left in, each saying what to set. Keys:
 * root (WSB_SANDBOX_ROOT), roots (WSB_ALLOWED_ROOTS entries), tools (WSB_TOOL_DIRS entries, by name).
 */
function configProblems() {
  const p = { root: null, roots: [], tools: {} }
  if (process.env.WSB_SANDBOX_ROOT && /[<>"|?*]/.test(process.env.WSB_SANDBOX_ROOT.replace(/^\\\\\?\\/, ''))) {
    p.root = `WSB_SANDBOX_ROOT "${process.env.WSB_SANDBOX_ROOT}" isn't a usable folder (a placeholder left in?): set a real folder, or remove it to use the default ${DEFAULT_ROOT}.`
  }
  const missing = e => e.code === 'ENOENT' ? "doesn't exist" : `can't be used (${e.message})`
  for (const r of splitList(process.env.WSB_ALLOWED_ROOTS)) {
    try { realDir(r) } catch (e) { p.roots.push(`WSB_ALLOWED_ROOTS entry "${r}" ${missing(e)}: set it to the folder your builds come from.`) }
  }
  for (const [n, d] of Object.entries(toolDirs())) {
    try { realDir(d) } catch (e) { p.tools[n] = `WSB_TOOL_DIRS entry "${n}=${d}" ${missing(e)}: set it to a real folder, or remove the entry.` }
  }
  return p
}

function saveState() {
  if (!run) return
  const s = { id: run.id, serverPid: process.pid, watchdogPid: run.watchdog?.pid, startedAt: run.startedAt, deadline: run.deadline, outDir: run.outDir, stopped: false, unconfirmed: !!run.unconfirmed }
  writeState(run.runDir, s)
}
function writeState(runDir, s) {
  const tmp = join(runDir, 'state.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, join(runDir, 'state.json'))
}
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

function guard() {
  if (!ENABLED) throw new Error('The Windows Sandbox server is turned off: set WSB_MCP_ENABLED=1 in its config entry to use it.')
}

function needRun() {
  if (run) {
    if (run.unconfirmed) throw new Error(`Sandbox ${run.id}'s stop is unconfirmed: it may still be running. Call sandbox_stop again.`)
    return run
  }
  throw new Error(last?.note ? last.note : 'No Sandbox is running: call sandbox_start first.')
}

/** Whether the user session is up; it can come up after sandbox_start stopped waiting for it. */
async function sessionReady(r) {
  if (!r.session.ready && r.session.wanted && (await exec(r.id, 'cmd.exe /c ver', 'user', 30_000)).json?.ExitCode === 0) r.session.ready = true
  return r.session.ready
}
const exec = (id, cmdline, as, timeoutMs) => wsb(['exec', '--id', id, '-c', cmdline, '-r', as === 'user' ? 'ExistingLogin' : 'System'], timeoutMs)
const ps = (script, args) => `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\wsb-mcp\\${script} ${args}`
const decode = buf => buf.toString('utf8').replace(/^\uFEFF/, '')

// ---------- stop, deadline, watchdog ----------

let stopping = null
/** Stops the owned Sandbox, confirmed by list. Resolves { ok, attempts }. Concurrent calls share one attempt. */
function stopRun(why) {
  if (!run) return Promise.resolve({ ok: true, attempts: [] })
  if (stopping) return stopping
  stopping = (async () => {
    const r = run
    const res = await stopConfirmed(r.id)
    if (res.ok) {
      clearTimeout(r.timer)
      try { r.watchdog?.stdin.write('done\n') } catch { /* already gone */ }
      unpin(r)
      writeState(r.runDir, { ...readJson(join(r.runDir, 'state.json')), stopped: true, unconfirmed: false, stoppedAt: new Date().toISOString(), stoppedBy: why })
      last = { id: r.id, outDir: r.outDir, note: why === 'deadline' ? `Sandbox ${r.id} was stopped at its deadline (${new Date(r.deadline).toLocaleTimeString()}). Start a new one with sandbox_start.` : null }
      run = null
    } else {
      r.unconfirmed = true
      r.lastStop = res
      saveState()
    }
    return res
  })().finally(() => { stopping = null })
  return stopping
}

/** Releases the out root's pin (confine.js), only once the Sandbox is confirmed stopped. */
function unpin(r) {
  if (r.pinFd === undefined) return
  try { fs.closeSync(r.pinFd) } catch { /* already closed */ }
  r.pinFd = undefined
}

function describeStop(id, res) {
  const t = res.attempts.at(-1) || {}
  const lastTry = t.listError ? `list failed: ${t.listError}` : `stop exit ${t.code}, still listed`
  return `CLEANUP FAILED: Sandbox ${id} may still be running (${res.attempts.length} stop attempts; last: ${lastTry}). The id is kept: call sandbox_stop again. The watchdog also keeps trying.`
}

function startWatchdog(r) {
  const wd = spawn(process.execPath, [join(__dirname, 'watchdog.js'), r.runDir], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  wd.on('error', e => { r.watchdogError = e.message })
  wd.stdin.on('error', () => {})
  wd.unref()
  r.watchdog = wd
}

function armDeadline(r) {
  clearTimeout(r.timer)
  r.timer = setTimeout(() => void stopRun('deadline'), Math.min(2 ** 31 - 1, Math.max(0, r.deadline - Date.now())))
  r.timer.unref?.()
}

/** At start-up: stops any Sandbox a previous run of this server started and didn't confirm stopped. */
async function recover() {
  if (!ENABLED || hostProblem() || !fs.existsSync(ROOT)) return
  for (const name of fs.readdirSync(ROOT)) {
    const dir = join(ROOT, name)
    const s = readJson(join(dir, 'state.json'))
    if (!s || s.stopped || typeof s.id !== 'string' || !ID_RE.test(s.id)) continue
    if (readJson(join(dir, 'watchdog.json'))?.stopped) { writeState(dir, { ...s, stopped: true, stoppedBy: 'watchdog' }); continue }
    if (s.serverPid !== process.pid && alive(s.serverPid)) { recovery.push(`Sandbox ${s.id} belongs to a server that is still running (PID ${s.serverPid}); left alone.`); continue }
    const res = await stopConfirmed(s.id)
    if (res.ok) {
      writeState(dir, { ...s, stopped: true, unconfirmed: false, stoppedAt: new Date().toISOString(), stoppedBy: 'restart' })
      recovery.push(`Stopped Sandbox ${s.id}, left by an earlier run of this server (confirmed by list).`)
    } else {
      writeState(dir, { ...s, unconfirmed: true })
      recovery.push(describeStop(s.id, res).replace('call sandbox_stop again', 'restart the server to retry, or stop it by hand'))
    }
  }
}
let recovered = Promise.resolve() // set by main()

// ---------- tools ----------

async function start({ build, network = false, session = true, closeWindow = false, tools, maxMinutes = 30 }) {
  if (run) throw new Error(run.unconfirmed ? `Sandbox ${run.id}'s stop is unconfirmed: call sandbox_stop before starting another.` : `Sandbox ${run.id} is already running: call sandbox_stop first (one at a time).`)
  const problem = hostProblem()
  if (problem) throw new Error(problem)
  if (typeof network !== 'boolean' || typeof session !== 'boolean' || typeof closeWindow !== 'boolean') throw new Error('network, session and closeWindow are true or false.')
  if (!Number.isFinite(maxMinutes) || maxMinutes < 1 || maxMinutes > 240) throw new Error('maxMinutes is 1 to 240.')

  const config = configProblems()
  if (config.root) throw new Error(config.root)
  const folders = []
  if (build !== undefined) {
    if (typeof build !== 'string' || !build) throw new Error('build is a folder path.')
    folders.push({ host: mappableBuild(build, await buildRoots()), sandbox: 'C:\\build' })
  }
  const configured = toolDirs()
  const names = tools === undefined ? Object.keys(configured) : tools
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) throw new Error('tools is a list of names.')
  for (const n of names) {
    const dir = configured[n.toLowerCase()]
    if (!dir) throw new Error(`Unknown tool "${n}". Configured (WSB_TOOL_DIRS): ${Object.keys(configured).join(', ') || 'none'}.`)
    if (config.tools[n.toLowerCase()]) throw new Error(config.tools[n.toLowerCase()])
    folders.push({ host: mappable(dir, `Tool folder "${n}"`), sandbox: `C:\\tools\\${n.toLowerCase()}` })
  }
  folders.push({ host: INSIDE, sandbox: 'C:\\wsb-mcp' })

  let ids
  try { ids = await list() } catch (e) { throw new Error(`Can't tell whether a Sandbox is running, so not starting one: ${e.message}`) }
  if (ids.length) throw new Error(`A Sandbox this server didn't start is running (${ids.join(', ')}). Only one runs at a time, and this server never stops one it didn't start: wait for it to finish.`)

  const runDir = join(ROOT, new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') + '-' + Math.random().toString(36).slice(2, 8))
  const outDir = join(runDir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  // Before the guest exists: a file held open exclusively keeps the out root from ever being empty (see confine.js).
  const pinFd = pinRoot(outDir)
  folders.push({ host: outDir, sandbox: 'C:\\out', readOnly: false })
  const xml = configXml({ network, folders })
  fs.writeFileSync(join(runDir, 'config.xml'), xml)

  const t0 = Date.now()
  const r = await wsb(['start', '-c', xml], 180_000)
  const id = r.json?.Id
  if (r.code !== 0 || typeof id !== 'string' || !ID_RE.test(id)) {
    fs.closeSync(pinFd)
    let after = ''
    try { const now = await list(); if (now.length) after = ` A Sandbox is now listed (${now.join(', ')}) but wasn't confirmed as this one: check \`wsb list\`.` } catch (e) { after = ` Can't tell whether one started: ${e.message}` }
    throw new Error(`wsb start failed (exit ${r.code}): ${(r.stderr || r.stdout || 'no output').slice(0, 400)}${hint(r.stderr)}${after}`)
  }
  const startedAt = Date.now()
  run = { id, runDir, outDir, pinFd, startedAt, deadline: startedAt + maxMinutes * 60_000, network, folders, session: { wanted: session, ready: false }, windowClosed: false, runs: 0, shots: 0 }
  saveState()
  startWatchdog(run)
  saveState()
  armDeadline(run)
  const timings = { startMs: r.ms }

  const ready = await until(async () => { const e = await exec(id, 'cmd.exe /c ver', 'system', 30_000); return e.code === 0 && e.json?.ExitCode === 0 }, READY_WAIT_MS, 250)
  if (ready === null) {
    const res = await stopRun('not ready')
    throw new Error(`Sandbox ${id} didn't run commands within ${READY_WAIT_MS / 1000} s. ${res.ok ? 'Stopped it (confirmed).' : describeStop(id, res)}`)
  }
  timings.readyMs = Date.now() - t0

  let sessionLine = 'No user session (session=false): run commands as system; screenshots need a session.'
  if (session) {
    const tc = Date.now()
    run.connect = connect(id)
    const min = await windowOp(id, 'minimise')
    const ms = await until(async () => (await exec(id, 'cmd.exe /c ver', 'user', 30_000)).json?.ExitCode === 0, SESSION_WAIT_MS)
    try { fs.appendFileSync(join(ROOT, 'session-times.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, connectToReadyMs: ms, ok: ms !== null }) + '\n') } catch { /* timing log only */ }
    if (ms === null) {
      sessionLine = `User session NOT ready ${SESSION_WAIT_MS / 1000} s after connect: user commands and screenshots will fail until it is (it has taken 3–46 s). sandbox_stop if it doesn't come.`
    } else {
      run.session = { wanted: true, ready: true, ms }
      timings.sessionMs = ms
      sessionLine = `User session ready ${secs(ms)} after connect; window ${min.ok ? 'minimised' : `shown (couldn't minimise: ${min.detail})`}.`
      if (closeWindow) {
        const c = await windowOp(id, 'close')
        run.windowClosed = c.ok
        sessionLine += c.ok ? ' Window closed (closeWindow): desktop screenshots would be blank; window shots from a script still work.' : ` Couldn't close the window: ${c.detail}.`
      }
    }
  }
  saveState()
  const mapped = folders.filter(f => f.readOnly !== false).map(f => `${f.sandbox} ← ${f.host}`).join('; ')
  return [
    `Started Sandbox ${id}, network ${network ? 'ON (outbound access from the Sandbox)' : 'off'}. Commands ready ${secs(timings.readyMs)} after start.`,
    sessionLine,
    `Read-only: ${mapped}. Writable: C:\\out ← ${outDir}.`,
    `Stops by ${new Date(run.deadline).toLocaleTimeString()} (${maxMinutes} min) at the latest; call sandbox_stop when done.`
  ].join('\n')
}

async function runCommand({ command, shell = 'cmd', as = 'user', timeoutSec = 120, cwd }) {
  const r = needRun()
  if (typeof command !== 'string' || !command.trim()) throw new Error('command is required.')
  if (command.length > MAX_COMMAND) throw new Error(`command is longer than ${MAX_COMMAND} characters: put it in a script in the build folder.`)
  if (!['cmd', 'powershell'].includes(shell)) throw new Error('shell is cmd or powershell.')
  if (!['user', 'system'].includes(as)) throw new Error('as is user or system.')
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new Error('timeoutSec is 1 to 3600.')
  if (cwd !== undefined && (typeof cwd !== 'string' || !/^[A-Za-z]:\\[^"\r\n]*$/.test(cwd))) throw new Error('cwd is a folder inside the Sandbox, like C:\\build.')
  if (as === 'user' && !(await sessionReady(r))) throw new Error(r.session.wanted ? 'The user session isn\'t ready yet: try again shortly, or run as system.' : 'Started without a user session (session=false): run as system.')

  // No trailing backslash: before the closing quote it would escape it ("C:\" arrives as C:").
  const dir = (cwd ?? (r.folders.some(f => f.sandbox === 'C:\\build') ? 'C:\\build' : 'C:\\')).replace(/\\+$/, '')
  const cwdArg = /^[A-Za-z]:$/.test(dir) ? `${dir}\\.` : dir
  // The wrapper writes directly into C:\out: while the Sandbox runs, the host reads only top-level files (confine.js).
  const n = ++r.runs
  const name = `.run-${n}`
  const cmdline = ps('run.ps1', `-Name ${name} -Shell ${shell} -B64 ${Buffer.from(command, 'utf8').toString('base64')} -Cwd "${cwdArg}"`)
  const t0 = Date.now()
  const e = await exec(r.id, cmdline, as, timeoutSec * 1000 + 5000)
  const ms = Date.now() - t0
  const outReal = outRoot(r.outDir)
  const lines = []
  let isError = false

  if (e.timedOut) {
    isError = true
    const p = readLive(outReal, `${name}.pid`, 64)
    const pid = p.error ? null : parsePid(decode(p.buf))
    if (pid) {
      const k = await exec(r.id, `taskkill.exe /PID ${pid} /T /F`, 'system', 30_000)
      lines.push(`TIMED OUT after ${timeoutSec} s: killed PID ${pid} inside (taskkill exit ${k.json?.ExitCode ?? k.code}).`)
    } else {
      lines.push(`TIMED OUT after ${timeoutSec} s, and no PID (${p.error || 'the PID file is not a valid number'}): the command may still be running inside. sandbox_stop is the fallback.`)
    }
  } else if (e.code !== 0 || typeof e.json?.ExitCode !== 'number') {
    throw new Error(`wsb exec failed (exit ${e.code}): ${(e.stderr || e.stdout || 'no output').slice(0, 400)}${hint(e.stderr)}`)
  } else {
    const w = readLive(outReal, `${name}.error.txt`, 2000)
    if (!w.error) throw new Error(`The run wrapper failed inside the Sandbox, so the command didn't run: ${decode(w.buf).trim()}`)
    if (readLive(outReal, `${name}.pid`, 64).error === 'not found') throw new Error(`The run wrapper didn't start the command (exit ${e.json.ExitCode}, no PID file).`)
    lines.push(`exit ${e.json.ExitCode} (${secs(ms)})`)
  }
  for (const stream of ['stdout', 'stderr']) {
    const f = readLive(outReal, `${name}.${stream}.txt`, OUTPUT_CAP)
    if (f.error) { if (f.error !== 'not found') lines.push(`[${stream}: ${f.error}]`); continue }
    if (!f.size) continue
    lines.push(`--- ${stream} ---`, decode(f.buf).replace(/\s+$/, ''))
    if (f.truncated) lines.push(`[${stream} cut at ${KB(f.bytesRead)} of ${KB(f.size)}: sandbox_collect "${name}.${stream}.txt" for more]`)
  }
  return { text: lines.join('\n'), isError }
}

async function screenshot({ maxWidth = 1280 }) {
  const r = needRun()
  if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 3840) throw new Error('maxWidth is 320 to 3840.')
  if (!(await sessionReady(r))) throw new Error('No user session, so no desktop to capture: start with session=true.')
  if (r.windowClosed) throw new Error('The connect window was closed (closeWindow), so a desktop shot would be blank. Take window shots from a script inside, or start again without closeWindow.')
  const n = ++r.shots
  const rel = `.shot-${n}.jpg`
  const e = await exec(r.id, ps('screenshot.ps1', `-Path C:\\out\\${rel} -MaxWidth ${maxWidth}`), 'user', 60_000)
  if (e.code !== 0 || e.json?.ExitCode !== 0) throw new Error(`Screenshot failed (${e.timedOut ? 'timed out' : `exit ${e.json?.ExitCode ?? e.code}`}): ${(e.stderr || 'no output').slice(0, 300)}${hint(e.stderr)}`)
  const f = readLive(outRoot(r.outDir), rel, 8 * 1024 * 1024)
  if (f.error) throw new Error(`Screenshot not readable: ${f.error}`)
  if (f.truncated) return { text: `Desktop screenshot too large to return (${KB(f.size)}): ${join(r.outDir, rel)}` }
  return {
    content: [
      { type: 'text', text: `Desktop screenshot ${rel} (${KB(f.size)}): ${join(r.outDir, rel)}` },
      { type: 'image', data: f.buf.toString('base64'), mimeType: 'image/jpeg' }
    ]
  }
}

const imageType = buf =>
  buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : null

async function collect({ paths, glob, maxBytes = 256 * 1024, maxTotalBytes = 1024 * 1024, base64 = false }) {
  const target = run || last
  if (!target) throw new Error('No Sandbox run to collect from: call sandbox_start first.')
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('maxBytes is 1 to 8388608.')
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 16 * 1024 * 1024) throw new Error('maxTotalBytes is 1 to 16777216.')
  if (paths !== undefined && (!Array.isArray(paths) || paths.some(p => typeof p !== 'string') || paths.length > 200)) throw new Error('paths is a list of up to 200 paths.')
  if (glob !== undefined && typeof glob !== 'string') throw new Error('glob is a pattern like "logs/**/*.txt".')

  // Every path and the glob are checked before the out folder is touched at all.
  const lines = []
  const content = []
  let selected = []
  if (paths) {
    for (const p of paths) {
      try { segments(p); selected.push(p) } catch (e) { lines.push(`REFUSED ${JSON.stringify(p)}: ${e.message}`) }
    }
  }
  let match = null
  if (glob !== undefined) {
    try { match = globMatcher(glob) } catch (e) { throw new Error(`Glob refused: ${e.message}`) }
  }
  // While the Sandbox runs (or its stop is unconfirmed) the guest can still change out: only top-level files then.
  const live = target === run
  const AFTER_STOP = 'only files directly in the out folder can be read while the Sandbox runs: collect folders after sandbox_stop'
  if (live) {
    for (const p of selected.filter(p => segments(p).length > 1)) lines.push(`NOT READ ${p}: ${AFTER_STOP}`)
    selected = selected.filter(p => segments(p).length === 1)
  }

  if (paths && !match && !selected.length) return lines.join('\n') || 'No paths given.'
  const outReal = outRoot(target.outDir)
  const read = live ? readLive : readFile
  if (match || !paths) {
    const l = listOut(outReal, live ? { depth: 0 } : {})
    if (!match && !paths) {
      lines.push(`${l.files.length} file${l.files.length === 1 ? '' : 's'} in ${target.outDir}${l.truncated ? ' (listing cut: too many entries)' : ''}:`, ...l.files.map(f => `- ${f}`))
      for (const f of l.folders) lines.push(`- ${f}/ (folder: its files can be collected after sandbox_stop)`)
      for (const s of l.skipped) lines.push(`SKIPPED ${s.path}: ${s.reason}`)
      return lines.join('\n')
    }
    const hits = l.files.filter(match)
    selected.push(...hits)
    for (const s of l.skipped.filter(s => match(s.path))) lines.push(`SKIPPED ${s.path}: ${s.reason}`)
    if (l.truncated) lines.push('(listing cut: too many entries)')
    if (live && l.folders.length && (match.deep || match.depth > 1)) lines.push(`(${l.folders.length} folder${l.folders.length === 1 ? '' : 's'} not searched: ${AFTER_STOP})`)
    if (!hits.length) lines.push(`No files match ${JSON.stringify(glob)}.`)
  }
  selected = [...new Set(selected)].slice(0, 200)

  let total = 0
  for (const p of selected) {
    const room = maxTotalBytes - total
    if (room <= 0) { lines.push(`NOT READ ${p}: maxTotalBytes reached`); continue }
    const f = read(outReal, p, Math.min(maxBytes, room))
    if (f.error) { lines.push(`${/^skipped/.test(f.error) ? 'SKIPPED' : 'NOT READ'} ${p}: ${f.error.replace(/^skipped: /, '')}`); continue }
    total += f.bytesRead
    const cut = f.truncated ? `, cut at ${KB(f.bytesRead)}` : ''
    const img = !f.truncated && imageType(f.buf)
    if (img) {
      lines.push(`### ${p} (${KB(f.size)}, image below)`)
      content.push({ type: 'image', data: f.buf.toString('base64'), mimeType: img })
    } else if (f.buf.includes(0)) {
      lines.push(base64 ? `### ${p} (${KB(f.size)}, binary, base64${cut})\n${f.buf.toString('base64')}` : `### ${p} (${KB(f.size)}, binary: pass base64=true to get it)`)
    } else {
      lines.push(`### ${p} (${KB(f.size)}${cut})`, decode(f.buf))
    }
  }
  return content.length ? { content: [{ type: 'text', text: lines.join('\n') }, ...content] } : lines.join('\n')
}

async function stop() {
  if (startPromise) await startPromise.catch(() => {})
  if (!run) return last ? `No Sandbox running (the last one, ${last.id}, is stopped).` : 'No Sandbox running: none was started by this server.'
  const id = run.id
  const t0 = Date.now()
  const res = await stopRun('sandbox_stop')
  if (!res.ok) return { text: describeStop(id, res), isError: true }
  return `Stopped Sandbox ${id} (confirmed by list; ${res.attempts.length} attempt${res.attempts.length === 1 ? '' : 's'}, ${secs(Date.now() - t0)}). Its out folder stays for sandbox_collect: ${last.outDir}`
}

async function status() {
  const lines = [`Windows Sandbox server ${VERSION}: ${ENABLED ? 'enabled' : 'turned off (WSB_MCP_ENABLED is not 1)'}.`]
  const problem = hostProblem()
  if (problem) lines.push(`Host: ${problem}`)
  const config = configProblems()
  for (const c of [config.root, ...config.roots, ...Object.values(config.tools)].filter(Boolean)) lines.push(`Config: ${c}`)
  lines.push(`Build folders allowed: ${(await buildRoots()).describe()}.`)
  if (run) {
    const up = Date.now() - run.startedAt
    lines.push(`Running: ${run.id}, up ${Math.round(up / 60_000)} min, stops by ${new Date(run.deadline).toLocaleTimeString()}; network ${run.network ? 'ON' : 'off'}; user session ${run.session.ready ? 'ready' : run.session.wanted ? 'not ready' : 'not requested'}${run.windowClosed ? ', window closed' : ''}; ${run.runs} command${run.runs === 1 ? '' : 's'} run.`)
    if (run.unconfirmed) lines.push(`UNCONFIRMED STOP: ${describeStop(run.id, run.lastStop)}`)
    lines.push(`Watchdog: ${run.watchdog?.pid && alive(run.watchdog.pid) ? `running (PID ${run.watchdog.pid})` : `NOT running${run.watchdogError ? `: ${run.watchdogError}` : ''}`}.`)
    lines.push(`Out folder: ${run.outDir}`)
  } else {
    lines.push(last ? `None running from this server; the last one (${last.id}) is stopped. Its out folder: ${last.outDir}` : 'None running from this server.')
  }
  if (!problem) {
    try { const ids = await list(); lines.push(`wsb list: ${ids.length ? ids.join(', ') : 'none running'}.`) } catch (e) { lines.push(`wsb list: UNKNOWN (${e.message}).`) }
  }
  for (const r of recovery) lines.push(`At start-up: ${r}`)
  return lines.join('\n')
}

const tools = [
  {
    name: 'sandbox_start',
    description:
      'Start a fresh Windows Sandbox (one at a time) to test a build on a clean Windows. The build folder is mapped read-only at C:\\build, tool folders (e.g. node, playwright, fake-clis) read-only at C:\\tools\\<name>, and one fresh writable folder at C:\\out. Network is off unless asked. ' +
      'With session (default) it opens the Sandbox window minimised on the host and waits up to 90 s for the user session, which commands as the user and screenshots need. Refuses if any Sandbox is running or that can\'t be told. Stops by itself after maxMinutes.',
    inputSchema: {
      type: 'object',
      properties: {
        build: { type: 'string', description: 'Host folder with the build (e.g. installers), under one of your MCP roots (your project folders; sandbox_status lists them). Mapped read-only at C:\\build.' },
        network: { type: 'boolean', description: 'Give the Sandbox network access. Default false.' },
        session: { type: 'boolean', description: 'Open the user session (minimised window). Default true; false allows only commands as system.' },
        closeWindow: { type: 'boolean', description: 'Close the Sandbox window once the session is ready. Desktop screenshots are then blank; window shots from a script inside still work. Default false.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool folders to map (names from WSB_TOOL_DIRS). Default: all configured.' },
        maxMinutes: { type: 'number', description: 'Lifetime before it is stopped automatically, 1–240. Default 30.' }
      }
    },
    run: start,
    locked: true
  },
  {
    name: 'sandbox_run',
    description:
      'Run a command in the Sandbox and get its exit code, stdout and stderr (16 KB each; says when cut). It runs through a wrapper that records its PID: on a timeout the command is killed inside the Sandbox. Commands that wait on a dialog hang until the timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, e.g. "C:\\build\\Setup.exe /S" or a PowerShell script with shell=powershell.' },
        shell: { type: 'string', enum: ['cmd', 'powershell'], description: 'Default cmd.' },
        as: { type: 'string', enum: ['user', 'system'], description: 'user (default: the Sandbox user, with a desktop) or system (no desktop, works without a session).' },
        timeoutSec: { type: 'number', description: '1–3600. Default 120.' },
        cwd: { type: 'string', description: 'Working folder inside the Sandbox. Default C:\\build if a build is mapped, else C:\\.' }
      },
      required: ['command']
    },
    run: runCommand,
    locked: true
  },
  {
    name: 'sandbox_screenshot',
    description: 'A screenshot of the Sandbox desktop (as the user, scaled down, JPEG), returned as an image and saved in the out folder. Needs the user session and the window not closed.',
    inputSchema: { type: 'object', properties: { maxWidth: { type: 'number', description: 'Width to scale down to, 320–3840. Default 1280.' } } },
    run: screenshot,
    locked: true
  },
  {
    name: 'sandbox_collect',
    description:
      'Get files from the run\'s out folder (C:\\out inside) only. While the Sandbox runs, only files directly in C:\\out; files in its folders after sandbox_stop. paths are relative to out; glob is matched against a listing of out (* and ? within a folder, ** across). With neither, lists the files. Text comes back as text, PNG/JPEG as images. Links are skipped, never followed. Capped while reading.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths relative to the out folder, e.g. "logs/install.log".' },
        glob: { type: 'string', description: 'Pattern relative to the out folder, e.g. "**/*.png".' },
        maxBytes: { type: 'number', description: 'Per file. Default 262144.' },
        maxTotalBytes: { type: 'number', description: 'For the whole call. Default 1048576.' },
        base64: { type: 'boolean', description: 'Return binary files (other than images) as base64. Default false.' }
      }
    },
    run: collect,
    locked: true
  },
  {
    name: 'sandbox_stop',
    description: 'Stop and discard the Sandbox. Says "Stopped" only once wsb list confirms it is gone; otherwise reports a failed cleanup and keeps the id so a retry, the watchdog or a restart tries again.',
    inputSchema: { type: 'object', properties: {} },
    run: stop
  },
  {
    name: 'sandbox_status',
    description: 'What is running, for how long, its deadline, the watchdog, any unconfirmed stop, and wsb list.',
    inputSchema: { type: 'object', properties: {} },
    run: status,
    open: true
  }
]

const INSTRUCTIONS = [
  'Windows Sandbox tools test a build on a clean, throwaway Windows: sandbox_start (with the build folder), sandbox_run, sandbox_screenshot, sandbox_collect, then always sandbox_stop.',
  'The build folder must be inside your project (your MCP roots); sandbox_status says which folders are allowed.',
  'One Sandbox at a time, on the whole machine: if another agent\'s is running, sandbox_start refuses; wait and retry rather than stopping it.',
  'Network is off unless you ask. Don\'t put real sign-ins, tokens or real CLIs in the Sandbox: use the fake CLIs.',
  'Write anything you want back to C:\\out inside, then sandbox_collect it: files directly in C:\\out at any time, files in its folders after sandbox_stop.'
].join('\n')

// ---------- JSON-RPC ----------

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

let chain = Promise.resolve()
const locked = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p }

async function call(tool, args) {
  if (!tool.open) guard()
  await recovered
  const go = () => tool.run(args)
  if (tool.name !== 'sandbox_start') return tool.locked ? locked(go) : go()
  return locked(() => (startPromise = go()).finally(() => { startPromise = null }))
}

async function handle(msg) {
  if (roots.handle(msg)) return // the client's answer to our roots/list
  const { id, method, params } = msg ?? {}
  if (!method) return
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      roots.initialize(params)
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'windows-sandbox', version: VERSION },
        instructions: ENABLED ? INSTRUCTIONS : 'The Windows Sandbox server is turned off (WSB_MCP_ENABLED is not 1): don\'t use its tools.'
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find(t => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      try {
        const result = await call(tool, params?.arguments ?? {})
        if (typeof result === 'string') return reply(id, { content: [{ type: 'text', text: result }] })
        return reply(id, { content: result.content ?? [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) })
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true })
      }
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

// Stop on stdin close or a signal. A hard kill skips this: the watchdog covers that.
let shuttingDown = false
async function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  await recovered
  if (startPromise) await startPromise.catch(() => {})
  let code = 0
  if (run) {
    const id = run.id
    const res = await stopRun(why)
    if (!res.ok) { process.stderr.write(describeStop(id, res) + '\n'); code = 1 }
  }
  process.exit(code)
}
function main() {
  recovered = recover().catch(e => recovery.push(`Start-up check failed: ${e.message}`))
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => void shutdown(s))
  createInterface({ input: process.stdin })
    .on('line', line => {
      if (!line.trim()) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return replyError(null, -32700, 'Parse error')
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m)
    })
    .on('close', () => void shutdown('stdin closed'))
}

if (require.main === module) main()
// In-process tests only: the tool functions, and the last stopped run to collect from.
else module.exports = { collect, setLast: l => { last = l } }
