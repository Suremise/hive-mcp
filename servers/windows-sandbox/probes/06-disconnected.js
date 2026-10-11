/**
 * Probe 06: driving Hive with the connect window closed (network off). Probe 05 showed the user session survives
 * closing the window but a desktop capture is then blank. Does Playwright's own window screenshot still work?
 * Same mappings as probe 02. Always stops the Sandbox.
 */
const { spawn, execFileSync } = require('child_process')
const { mkdirSync, existsSync, readFileSync, readdirSync, statSync } = require('fs')
const { join, dirname } = require('path')
const { WSB, config, exec, until, withSandbox } = require('./lib')

const HIVE = process.env.HIVE_REPO
if (!HIVE) { console.error('Set HIVE_REPO to a built checkout of the Hive repo (its dist, node_modules and tests are mapped read-only).'); process.exit(2) }
const DIST = join(HIVE, 'dist')
const INSTALLER = process.env.INSTALLER ||
  readdirSync(DIST).filter(f => /^Hive-Setup-[\d.]+\.exe$/.test(f)).sort((a, b) => statSync(join(DIST, a)).mtimeMs - statSync(join(DIST, b)).mtimeMs).pop()
const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)
const hostPs = cmd => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const sessionPid = id => hostPs(`(Get-CimInstance Win32_Process -Filter "Name='WindowsSandboxRemoteSession.exe'" | Where-Object { $_.CommandLine -like '*${id}*' } | Select-Object -First 1).ProcessId`)

withSandbox('06-disconnected', dir => {
  mkdirSync(join(dir, 'out'), { recursive: true })
  return config({
    networking: false,
    folders: [
      { host: DIST, sandbox: 'C:\\build', readOnly: true },
      { host: dirname(process.execPath), sandbox: 'C:\\tools\\node', readOnly: true },
      { host: join(HIVE, 'node_modules', 'playwright-core'), sandbox: 'C:\\tools\\pw\\playwright-core', readOnly: true },
      { host: __dirname, sandbox: 'C:\\probe', readOnly: true },
      { host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }
    ]
  })
}, async ({ id, dir, log, results }) => {
  const out = join(dir, 'out')
  const s = results.steps
  const t0 = Date.now()
  await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000, 250)
  spawn(WSB, ['connect', '--id', id], { windowsHide: true, stdio: 'ignore' })
  await until(async () => (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).code === 0, 180_000)
  s.startToLoginMs = Date.now() - t0
  s.install = (await exec(id, `C:\\build\\${INSTALLER} /S`, 'ExistingLogin')).json
  s.sessionPid = sessionPid(id)
  hostPs(`Stop-Process -Id ${s.sessionPid}`)
  await new Promise(r => setTimeout(r, 5000))
  log('start to login ms', s.startToLoginMs, 'install', s.install, 'closed session window pid', s.sessionPid)
  s.drive = (await exec(id, 'cmd.exe /c "set PATH=C:\\tools\\node;%PATH% && node C:\\probe\\inside\\drive-hive.cjs "%LOCALAPPDATA%\\Programs\\Hive\\Hive.exe" C:\\out > C:\\out\\drive-hive.log 2>&1"', 'ExistingLogin')).json
  const dj = read(join(out, 'drive-hive.json'))
  s.driveSteps = dj ? JSON.parse(dj).steps.map(x => ({ name: x.name, ms: x.ms, button: x.button, error: x.error })) : null
  s.outFiles = readdirSync(out).map(f => `${f} ${statSync(join(out, f)).size}`)
  log('drive with window closed:', s.drive, s.driveSteps, s.outFiles)
})
