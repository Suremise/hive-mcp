/**
 * Probe 02: the user session, screenshots and driving Hive inside (network off).
 *
 * Maps Hive's dist folder (installers), node.exe, Hive's playwright-core, the e2e fake CLIs and these probes, all
 * read-only, plus one writable out folder. Then: does the LogonCommand run, and does ExistingLogin work, before any
 * `wsb connect`? After connect, how long until they do? Desktop screenshot; silent install of the newest installer;
 * a fake CLI run with the mapped node; Hive launched and driven with Playwright inside; a final screenshot.
 * Always stops the Sandbox (which also closes the connect window).
 */
const { spawn } = require('child_process')
const { mkdirSync, existsSync, readFileSync, readdirSync, statSync } = require('fs')
const { join, dirname } = require('path')
const { WSB, config, exec, until, withSandbox } = require('./lib')

const HIVE = process.env.HIVE_REPO
if (!HIVE) { console.error('Set HIVE_REPO to a built checkout of the Hive repo (its dist, node_modules and tests are mapped read-only).'); process.exit(2) }
const DIST = join(HIVE, 'dist')
const NODE_DIR = dirname(process.execPath)
const INSTALLER = process.env.INSTALLER ||
  readdirSync(DIST).filter(f => /^Hive-Setup-[\d.]+\.exe$/.test(f)).sort((a, b) => statSync(join(DIST, a)).mtimeMs - statSync(join(DIST, b)).mtimeMs).pop()
const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)
const ps = (script, args = '') => `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\probe\\inside\\${script} ${args}`

withSandbox('02-ui', dir => {
  mkdirSync(join(dir, 'out'), { recursive: true })
  return config({
    networking: false,
    folders: [
      { host: DIST, sandbox: 'C:\\build', readOnly: true },
      { host: NODE_DIR, sandbox: 'C:\\tools\\node', readOnly: true },
      { host: join(HIVE, 'node_modules', 'playwright-core'), sandbox: 'C:\\tools\\pw\\playwright-core', readOnly: true },
      { host: join(HIVE, 'tests', 'e2e'), sandbox: 'C:\\tools\\e2e', readOnly: true },
      { host: __dirname, sandbox: 'C:\\probe', readOnly: true },
      { host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }
    ],
    logon: 'cmd.exe /c echo %DATE% %TIME% %USERNAME% > C:\\out\\logon-ran.txt'
  })
}, async ({ id, dir, log, results }) => {
  const out = join(dir, 'out')
  const s = results.steps
  results.installer = INSTALLER

  await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000)
  // 1. Without connect: wait 30 s, then look for the logon marker and try ExistingLogin.
  await new Promise(r => setTimeout(r, 30_000))
  s.beforeConnect = { logonRan: read(join(out, 'logon-ran.txt')), existingLogin: (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).stderr || 'ok' }
  log('30 s after start, no connect:', s.beforeConnect)

  // 2. connect (opens the Sandbox window on the host desktop) and time the user session.
  const t0 = Date.now()
  const conn = spawn(WSB, ['connect', '--id', id], { windowsHide: true, stdio: 'ignore' })
  s.connect = { pid: conn.pid }
  conn.on('exit', code => { s.connect.exitCode = code; s.connect.exitedAfterMs = Date.now() - t0 })
  s.loginReadyMs = await until(async () => (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).code === 0, 180_000)
  s.logonMarkerMs = await until(() => existsSync(join(out, 'logon-ran.txt')), 60_000, 500) // after login ready
  log('after connect: ExistingLogin ready ms', s.loginReadyMs, 'logon marker +ms', s.logonMarkerMs, read(join(out, 'logon-ran.txt')), s.connect)

  // 3. Desktop screenshot from inside, as the user and (expected to fail) as System.
  await new Promise(r => setTimeout(r, 5000))
  s.shotUser = await exec(id, ps('screenshot.ps1', 'C:\\out\\desktop-1-login.png'), 'ExistingLogin')
  s.shotSystem = await exec(id, ps('screenshot.ps1', 'C:\\out\\desktop-system.png'), 'System')
  log('screenshot user:', s.shotUser.json, 'system:', s.shotSystem.json, 'files:', readdirSync(out))

  // 4. Silent install of the newest installer, as the user (per-user NSIS install).
  const ti = Date.now()
  s.install = await exec(id, `C:\\build\\${INSTALLER} /S`, 'ExistingLogin')
  s.install.wallMs = Date.now() - ti
  await exec(id, 'cmd.exe /c dir /b "%LOCALAPPDATA%\\Programs\\Hive" > C:\\out\\install-dir.txt 2>&1 & reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /f "Hive" /d > C:\\out\\uninstall-reg.txt 2>&1 & dir /b "%USERPROFILE%\\Desktop" > C:\\out\\desktop-items.txt 2>&1', 'ExistingLogin')
  s.installResult = { files: (read(join(out, 'install-dir.txt')) || '').split(/\r?\n/).slice(0, 15), uninstall: (read(join(out, 'uninstall-reg.txt')) || '').split(/\r?\n/).filter(l => /DisplayName|DisplayVersion|InstallLocation/.test(l)), desktop: read(join(out, 'desktop-items.txt')) }
  log('install:', { exit: s.install.json?.ExitCode, ms: s.install.wallMs }, s.installResult)
  s.shotInstalled = await exec(id, ps('screenshot.ps1', 'C:\\out\\desktop-2-installed.png'), 'ExistingLogin')

  // 5. A fake CLI with the mapped node.
  s.fake = await exec(id, 'cmd.exe /c "set PATH=C:\\tools\\node;%PATH% && C:\\tools\\e2e\\fake-claude\\fake-claude.cmd --version > C:\\out\\fake-claude.txt 2>&1"', 'ExistingLogin')
  log('fake claude --version:', s.fake.json, read(join(out, 'fake-claude.txt')))

  // 6. Drive the installed Hive with Playwright inside.
  const td = Date.now()
  s.drive = await exec(id, 'cmd.exe /c "set PATH=C:\\tools\\node;%PATH% && node C:\\probe\\inside\\drive-hive.cjs "%LOCALAPPDATA%\\Programs\\Hive\\Hive.exe" C:\\out > C:\\out\\drive-hive.log 2>&1"', 'ExistingLogin')
  s.drive.wallMs = Date.now() - td
  log('drive hive:', s.drive.json, 'ms', s.drive.wallMs, read(join(out, 'drive-hive.log')))
  const dj = read(join(out, 'drive-hive.json'))
  s.driveResult = dj ? JSON.parse(dj) : null
  log('drive result:', s.driveResult)

  // 7. Hive started normally (no Playwright), then a desktop screenshot showing its window.
  await exec(id, 'cmd.exe /c start "" "%LOCALAPPDATA%\\Programs\\Hive\\Hive.exe"', 'ExistingLogin')
  await new Promise(r => setTimeout(r, 15_000))
  s.shotHive = await exec(id, ps('screenshot.ps1', 'C:\\out\\desktop-3-hive.png'), 'ExistingLogin')
  s.outFiles = readdirSync(out).map(f => `${f} ${statSync(join(out, f)).size}`)
  log('out:', s.outFiles)
  s.connectAlive = s.connect.exitCode === undefined
})
