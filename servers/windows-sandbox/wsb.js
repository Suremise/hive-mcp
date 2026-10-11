/**
 * wsb.exe driver shared by the server and its watchdog. Node built-ins only.
 *
 * Everything that decides whether a Sandbox is running fails closed: `list` counts only with exit 0 and valid JSON
 * holding an array of string Ids, and a stop counts only once `list` confirms the id is gone (design note §3).
 *
 * WSB_STUB (tests only): path of a Node script run instead of wsb.exe, with the same arguments.
 */
const { execFile, spawn } = require('child_process')
const { lstatSync } = require('fs')
const { join } = require('path')
const os = require('os')

const WSB = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wsb.exe')
const STOP_ATTEMPTS = 3
const STOP_RETRY_MS = Number(process.env.WSB_STOP_RETRY_MS || 3000)
// Ids are GUIDs; checked before an id goes into a command line.
const ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const command = () => (process.env.WSB_STUB ? { file: process.execPath, pre: [process.env.WSB_STUB] } : { file: WSB, pre: [] })

/** Runs wsb with --raw; resolves { code, json, stdout, stderr, ms, timedOut }. Never rejects. */
function wsb(args, timeoutMs = 120_000) {
  const t0 = Date.now()
  const { file, pre } = command()
  return new Promise(resolve => {
    execFile(file, [...pre, ...args, '--raw'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json = null
      try { json = stdout.trim() ? JSON.parse(stdout) : null } catch { /* not JSON */ }
      const timedOut = !!err?.killed
      const code = err ? (typeof err.code === 'number' ? err.code : timedOut ? 'timeout' : err.code || 'error') : 0
      resolve({ code, json, stdout: String(stdout).trim(), stderr: String(stderr).trim(), ms: Date.now() - t0, timedOut })
    })
  })
}

/** Ids of the running Sandboxes. Throws unless list succeeded with the expected shape: unknown is never "none". */
async function list() {
  const r = await wsb(['list'], 60_000)
  const envs = r.json?.WindowsSandboxEnvironments
  if (r.code !== 0 || !Array.isArray(envs) || envs.some(e => typeof e?.Id !== 'string' || !e.Id)) {
    throw new Error(`wsb list failed or replied unexpectedly (exit ${r.code}): ${(r.stderr || r.stdout || 'no output').slice(0, 300)}`)
  }
  return envs.map(e => e.Id)
}

/**
 * Stops `id` and confirms with `list`, retrying a bounded number of times. Resolves { ok, attempts }: ok only when
 * `list` succeeded and no longer holds the id. `stop` exiting 0 is not enough on its own.
 */
async function stopConfirmed(id, { attempts = STOP_ATTEMPTS, retryMs = STOP_RETRY_MS } = {}) {
  const tries = []
  for (let n = 1; n <= attempts; n++) {
    const r = await wsb(['stop', '--id', id], 120_000)
    const t = { code: r.code, ms: r.ms, stderr: r.stderr ? r.stderr.slice(0, 300) : undefined, gone: false }
    try { t.gone = !(await list()).includes(id) } catch (e) { t.listError = e.message }
    tries.push(t)
    if (t.gone) return { ok: true, attempts: tries }
    if (n < attempts) await new Promise(res => setTimeout(res, retryMs))
  }
  return { ok: false, attempts: tries }
}

/** XML config for `wsb start -c`. folders: [{ host, sandbox, readOnly }]. Clipboard, audio, video and printer always off. */
function configXml({ network = false, folders = [], logon } = {}) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  let x = '<Configuration>'
  x += `<Networking>${network ? 'Enable' : 'Disable'}</Networking>`
  x += '<ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection>'
  if (folders.length) {
    x += '<MappedFolders>'
    for (const f of folders) {
      x += `<MappedFolder><HostFolder>${esc(f.host)}</HostFolder><SandboxFolder>${esc(f.sandbox)}</SandboxFolder>`
      x += `<ReadOnly>${f.readOnly === false ? 'false' : 'true'}</ReadOnly></MappedFolder>`
    }
    x += '</MappedFolders>'
  }
  if (logon) x += `<LogonCommand><Command>${esc(logon)}</Command></LogonCommand>`
  return x + '</Configuration>'
}

/** Why this host can't run Sandboxes, or null. */
function hostProblem() {
  if (process.env.WSB_STUB) return null
  if (process.platform !== 'win32') return 'Windows Sandbox needs Windows.'
  const build = Number(os.release().split('.')[2])
  if (!(build >= 26100)) return `Windows build ${os.release()} is older than 24H2 (26100), which wsb.exe needs.`
  // wsb.exe is an app execution alias: existsSync (which follows it) says no, lstat sees it.
  try { lstatSync(WSB) } catch {
    return `wsb.exe not found (${WSB}): turn on the "Windows Sandbox" optional feature (Windows 11 Pro or Enterprise) and make sure its app is installed.`
  }
  return null
}

/** A plain-language hint for a wsb error message, or ''. */
function hint(stderr = '') {
  if (/0x80070520/i.test(stderr)) return ' (No user session: start with session=true, or run as system.)'
  if (/0x803B0001/i.test(stderr)) return ' (The Sandbox has no network: it was started with network=false.)'
  if (/virtuali[sz]|hypervisor|0x80070422|0x800706d9/i.test(stderr)) return ' (Check that virtualisation is on in the firmware and the Windows Sandbox feature is enabled.)'
  return ''
}

/** `wsb connect`: opens the Sandbox window on the host desktop, which creates the user session. */
function connect(id) {
  const { file, pre } = command()
  const child = spawn(file, [...pre, 'connect', '--id', id], { windowsHide: true, stdio: 'ignore', detached: false })
  child.on('error', () => {})
  return child
}

/**
 * Minimises or closes this Sandbox's own connect window: the WindowsSandboxRemoteSession.exe whose command line holds
 * its id, never one found by name alone. The only host command besides wsb.exe. Resolves { ok, detail }.
 */
function windowOp(id, op) {
  if (!ID_RE.test(id)) return Promise.resolve({ ok: false, detail: 'bad id' })
  const find = `$p = Get-CimInstance Win32_Process -Filter "Name='WindowsSandboxRemoteSession.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Select-Object -First 1; if (-not $p) { 'none'; exit 3 }`
  const ops = {
    minimise: `${find}; Add-Type -Name W -Namespace WsbMcp -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'; for ($i = 0; $i -lt 20; $i++) { $h = (Get-Process -Id $p.ProcessId).MainWindowHandle; if ($h -ne 0) { [void][WsbMcp.W]::ShowWindow($h, 6); 'minimised'; exit 0 }; Start-Sleep -Milliseconds 500 }; 'no window'; exit 4`,
    close: `${find}; Stop-Process -Id $p.ProcessId; 'closed'`
  }
  const [file, args] = process.env.WSB_STUB
    ? [process.execPath, [process.env.WSB_STUB, '__window', op, id]]
    : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ops[op]]]
  return new Promise(resolve => {
    execFile(file, args, { timeout: 30_000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, detail: String(stdout).trim() || String(err?.message || '') }))
  })
}

module.exports = { WSB, ID_RE, wsb, list, stopConfirmed, configXml, hostProblem, hint, connect, windowOp }
