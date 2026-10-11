/**
 * Probe 05: the user session vs the connect window, and a timeout kill inside (network off).
 *
 * `wsb connect` opens a WindowsSandboxRemoteSession window on the host desktop; the user session (ExistingLogin) only
 * exists once it has. Here: screenshot with the window shown, minimised (with Notepad opened meanwhile, so a live
 * capture differs from the first), then closed (that one process, found by its
 * command line holding this Sandbox's id); is the session still there after closing? Then a long command started with
 * its PID recorded, killed inside by that PID. Always stops the Sandbox.
 */
const { spawn, execFileSync } = require('child_process')
const { mkdirSync, existsSync, readFileSync, statSync } = require('fs')
const { join } = require('path')
const { WSB, config, exec, until, withSandbox } = require('./lib')

const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)
const ps = (script, args = '') => `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\probe\\inside\\${script} ${args}`
const hostPs = cmd => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()

// The remote-session process for this Sandbox only: matched by the Sandbox id in its command line.
const sessionPid = id => hostPs(`(Get-CimInstance Win32_Process -Filter "Name='WindowsSandboxRemoteSession.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Select-Object -First 1).ProcessId`)

const MINIMISE = pid => `Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'; $h=(Get-Process -Id ${pid}).MainWindowHandle; [P.W]::ShowWindow($h, 6)`

withSandbox('05-session', dir => {
  mkdirSync(join(dir, 'out'), { recursive: true })
  return config({
    networking: false,
    folders: [
      { host: __dirname, sandbox: 'C:\\probe', readOnly: true },
      { host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }
    ]
  })
}, async ({ id, dir, log, results }) => {
  const out = join(dir, 'out')
  const s = results.steps
  const shot = async name => {
    const r = await exec(id, ps('screenshot.ps1', `C:\\out\\${name}.png`), 'ExistingLogin')
    const p = join(out, `${name}.png`)
    return { exit: r.json?.ExitCode, err: r.stderr || undefined, bytes: existsSync(p) ? statSync(p).size : 0 }
  }
  await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000, 250)
  spawn(WSB, ['connect', '--id', id], { windowsHide: true, stdio: 'ignore' })
  s.loginReadyMs = await until(async () => (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).code === 0, 180_000)
  await new Promise(r => setTimeout(r, 4000))
  s.pid = sessionPid(id)
  s.shown = await shot('session-1-shown')
  log('session pid', s.pid, 'shown:', s.shown)

  s.minimise = hostPs(MINIMISE(s.pid))
  // Change the screen while minimised, so a live capture differs from a stale frame. The Sandbox has no Notepad: start
  // shows a modal error dialog and cmd waits on it, so this exec would block (it did for 300 s once); 20 s, then move on.
  s.notepad = await exec(id, 'cmd.exe /c start "" notepad.exe', 'ExistingLogin', undefined, 20_000)
  s.notepad = { code: s.notepad.code, ms: s.notepad.ms }
  await new Promise(r => setTimeout(r, 3000))
  s.minimised = await shot('session-2-minimised')
  log('minimised:', s.minimise, s.minimised)

  hostPs(`Stop-Process -Id ${s.pid}`)
  await new Promise(r => setTimeout(r, 5000))
  s.afterCloseLogin = (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).stderr || 'ok'
  s.closed = await shot('session-3-closed')
  log('after closing the window: ExistingLogin', s.afterCloseLogin, 'shot', s.closed)

  // Timeout kill inside, by the PID the wrapper recorded.
  await exec(id, 'powershell.exe -NoProfile -Command "$p = Start-Process ping.exe -ArgumentList \'-n\',\'120\',\'127.0.0.1\' -PassThru -WindowStyle Hidden; $p.Id | Out-File -Encoding ascii C:\\out\\run.pid"', 'System')
  const pid = read(join(out, 'run.pid'))
  const k = await exec(id, `taskkill.exe /PID ${pid} /T /F`, 'System')
  await exec(id, `cmd.exe /c tasklist /fi "PID eq ${pid}" /nh > C:\\out\\after-taskkill.txt`, 'System')
  s.killInside = { pid, taskkillExit: k.json?.ExitCode, after: read(join(out, 'after-taskkill.txt')) }
  log('kill inside by pid:', s.killInside)
})
