/**
 * Probe 01: lifecycle, exec, folders, network off.
 *
 * Starts a Sandbox (network off) with a read-only "build" folder and a writable "out" folder, then:
 * how long until exec works (System, then ExistingLogin), what exec returns (exit code, any output),
 * whether exec blocks, writes to each folder, a folder shared after start, the IP, and that the
 * network really is off. Always stops the Sandbox.
 */
const { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } = require('fs')
const { join } = require('path')
const { wsb, config, exec, until, withSandbox } = require('./lib')

const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)

withSandbox('01-lifecycle', dir => {
  for (const d of ['build', 'out', 'later']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'build', 'marker.txt'), 'read-only build folder\n')
  writeFileSync(join(dir, 'later', 'marker.txt'), 'shared after start\n')
  return config({
    networking: false,
    folders: [
      { host: join(dir, 'build'), sandbox: 'C:\\build', readOnly: true },
      { host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }
    ]
  })
}, async ({ id, dir, log, results }) => {
  const out = join(dir, 'out')
  const s = results.steps

  s.readySystem = await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000)
  log('exec ready (System) after ms:', s.readySystem)
  const login = await exec(id, 'cmd.exe /c ver', 'ExistingLogin')
  log('ExistingLogin right after System ready:', login)
  s.readyLogin = await until(async () => (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).code === 0, 120_000, 2000)
  log('exec ready (ExistingLogin) after further ms:', s.readyLogin)

  // What does exec return? Output, exit code.
  s.echo = await exec(id, 'cmd.exe /c echo hello-from-sandbox', 'System')
  log('echo:', s.echo)
  s.exit7 = await exec(id, 'cmd.exe /c exit 7', 'System')
  log('exit 7:', s.exit7)
  s.block = await exec(id, 'cmd.exe /c ping -n 6 127.0.0.1 >nul', 'System')
  log('ping 5 s (does exec block?):', { ms: s.block.ms, json: s.block.json })

  // Output via the writable folder; identity in each context; OS inside.
  await exec(id, 'cmd.exe /c whoami > C:\\out\\whoami-system.txt 2>&1', 'System')
  await exec(id, 'cmd.exe /c whoami > C:\\out\\whoami-login.txt 2>&1', 'ExistingLogin')
  await exec(id, 'cmd.exe /c ver > C:\\out\\ver.txt', 'System')
  await exec(id, 'powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.ToString() | Out-File C:\\out\\ps.txt; (Get-Command node -ErrorAction SilentlyContinue) -ne $null | Out-File C:\\out\\node.txt"', 'System')
  s.inside = { whoamiSystem: read(join(out, 'whoami-system.txt')), whoamiLogin: read(join(out, 'whoami-login.txt')), ver: read(join(out, 'ver.txt')), ps: read(join(out, 'ps.txt')), node: read(join(out, 'node.txt')) }
  log('inside:', s.inside)

  // Read-only folder: readable, not writable.
  s.roRead = await exec(id, 'cmd.exe /c type C:\\build\\marker.txt > C:\\out\\ro-read.txt', 'System')
  s.roWrite = await exec(id, 'cmd.exe /c echo x> C:\\build\\written.txt', 'System')
  s.roResult = { read: read(join(out, 'ro-read.txt')), writeExit: s.roWrite.json?.ExitCode, hostFileCreated: existsSync(join(dir, 'build', 'written.txt')) }
  log('read-only folder:', s.roResult)

  // Share a folder after start (read-only by default).
  s.share = await wsb(['share', '--id', id, '-f', join(dir, 'later'), '-s', 'C:\\later'])
  log('share after start:', s.share)
  await exec(id, 'cmd.exe /c type C:\\later\\marker.txt > C:\\out\\later-read.txt', 'System')
  const lw = await exec(id, 'cmd.exe /c echo x> C:\\later\\written.txt', 'System')
  s.shareResult = { read: read(join(out, 'later-read.txt')), writeExit: lw.json?.ExitCode, hostFileCreated: existsSync(join(dir, 'later', 'written.txt')) }
  log('shared-later folder:', s.shareResult)

  // Network off: IP, adapters, and an outbound attempt (expected to fail).
  s.ip = await wsb(['ip', '--id', id])
  log('ip:', s.ip)
  await exec(id, 'cmd.exe /c ipconfig > C:\\out\\ipconfig.txt', 'System')
  const net = await exec(id, 'cmd.exe /c curl.exe -s -m 8 -o NUL -w "%{http_code}" https://www.microsoft.com > C:\\out\\curl.txt 2>&1', 'System')
  s.network = { curlExit: net.json?.ExitCode, curlOut: read(join(out, 'curl.txt')), ipconfig: (read(join(out, 'ipconfig.txt')) || '').split(/\r?\n/).filter(l => /adapter|IPv4/i.test(l)) }
  log('network:', s.network)
  s.outFiles = readdirSync(out)
})
