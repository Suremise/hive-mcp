/**
 * Probe 04: network ON (needed: the question is whether CDP works across the Sandbox network boundary, and whether
 * outbound access works for scenarios like installing a CLI). Nothing secret is inside: a fresh Sandbox, the installer
 * read-only, no profile data.
 *
 * Installs Hive, starts it with --remote-debugging-port=9222 in the user session, then reads /json/version from inside
 * (127.0.0.1) and from the host (Sandbox IP), first directly and then through a portproxy plus firewall rule inside.
 * Always stops the Sandbox.
 */
const { spawn } = require('child_process')
const { mkdirSync, existsSync, readFileSync, readdirSync, statSync } = require('fs')
const { join } = require('path')
const { WSB, wsb, config, exec, until, withSandbox } = require('./lib')

const HIVE = process.env.HIVE_REPO
if (!HIVE) { console.error('Set HIVE_REPO to a built checkout of the Hive repo (its dist, node_modules and tests are mapped read-only).'); process.exit(2) }
const DIST = join(HIVE, 'dist')
const INSTALLER = process.env.INSTALLER ||
  readdirSync(DIST).filter(f => /^Hive-Setup-[\d.]+\.exe$/.test(f)).sort((a, b) => statSync(join(DIST, a)).mtimeMs - statSync(join(DIST, b)).mtimeMs).pop()
const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)

async function hostGet(url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 300), ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.cause?.message || e.message, ms: Date.now() - t0 }
  }
}

withSandbox('04-network-cdp', dir => {
  mkdirSync(join(dir, 'out'), { recursive: true })
  return config({
    networking: true,
    folders: [
      { host: DIST, sandbox: 'C:\\build', readOnly: true },
      { host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }
    ]
  })
}, async ({ id, dir, log, results }) => {
  const out = join(dir, 'out')
  const s = results.steps
  await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000, 250)

  s.ipMs = await until(async () => (await wsb(['ip', '--id', id])).code === 0, 60_000, 1000)
  s.ip = (await wsb(['ip', '--id', id])).json
  const ip = s.ip?.Networks?.[0]?.IpV4Address
  log('ip after ms', s.ipMs, s.ip)

  const ob = await exec(id, 'cmd.exe /c curl.exe -s -m 15 -o NUL -w "%{http_code}" https://www.microsoft.com > C:\\out\\outbound.txt 2>&1', 'System')
  s.outbound = { exit: ob.json?.ExitCode, http: read(join(out, 'outbound.txt')) }
  log('outbound:', s.outbound)

  const conn = spawn(WSB, ['connect', '--id', id], { windowsHide: true, stdio: 'ignore' })
  s.connectPid = conn.pid
  s.loginReadyMs = await until(async () => (await exec(id, 'cmd.exe /c ver', 'ExistingLogin')).code === 0, 180_000)
  s.install = (await exec(id, `C:\\build\\${INSTALLER} /S`, 'ExistingLogin')).json
  await exec(id, 'cmd.exe /c start "" "%LOCALAPPDATA%\\Programs\\Hive\\Hive.exe" --remote-debugging-port=9222', 'ExistingLogin')
  s.cdpInsideMs = await until(async () => {
    await exec(id, 'cmd.exe /c curl.exe -s -m 3 http://127.0.0.1:9222/json/version > C:\\out\\cdp-inside.txt 2>&1', 'System')
    return /webSocketDebuggerUrl/.test(read(join(out, 'cdp-inside.txt')) || '')
  }, 60_000, 1000)
  s.cdpInside = read(join(out, 'cdp-inside.txt'))
  log('CDP from inside after ms', s.cdpInsideMs, s.cdpInside)
  await exec(id, 'cmd.exe /c netstat -ano | findstr :9222 > C:\\out\\netstat.txt', 'System')
  s.listening = read(join(out, 'netstat.txt'))
  log('listening:', s.listening)

  s.hostDirect = ip ? await hostGet(`http://${ip}:9222/json/version`) : 'no ip'
  log('host -> sandbox:9222 directly:', s.hostDirect)

  // Expose it deliberately: portproxy 0.0.0.0:9322 -> 127.0.0.1:9222 plus an inbound firewall rule, inside.
  const pp = await exec(id, 'cmd.exe /c netsh interface portproxy add v4tov4 listenport=9322 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1 > C:\\out\\portproxy.txt 2>&1 & netsh advfirewall firewall add rule name=probe-cdp dir=in action=allow protocol=TCP localport=9322 >> C:\\out\\portproxy.txt 2>&1', 'System')
  s.portproxy = { exit: pp.json?.ExitCode, out: read(join(out, 'portproxy.txt')) }
  await new Promise(r => setTimeout(r, 2000))
  s.hostProxied = ip ? await hostGet(`http://${ip}:9322/json/version`) : 'no ip'
  log('portproxy:', s.portproxy, 'host -> sandbox:9322:', s.hostProxied)
})
