// server.js over stdio with wsb.exe stubbed: the tools, their guards, confinement through the tools, and cleanup.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, server, waitFor } = require('./helpers')

const started = async (s, args = {}) => {
  const srv = server(s.env)
  const r = await srv.call('sandbox_start', { build: path.join(s.dir, 'builds', 'hive'), ...args })
  assert.ok(!r.isError, r.text)
  return { srv, r, id: s.read().sandboxes[0] }
}

test('turned off without WSB_MCP_ENABLED=1: every tool refuses, status says so', async () => {
  const s = scratch('srv-off')
  const srv = server({ ...s.env, WSB_MCP_ENABLED: '' })
  const init = await srv.request('initialize', {})
  assert.match(init.result.instructions, /turned off/)
  for (const t of ['sandbox_start', 'sandbox_run', 'sandbox_collect', 'sandbox_stop', 'sandbox_screenshot']) {
    const r = await srv.call(t, { command: 'echo hi' })
    assert.ok(r.isError && /turned off/.test(r.text), t)
  }
  assert.match((await srv.call('sandbox_status')).text, /turned off/)
  assert.deepStrictEqual(s.read().calls.filter(c => c[0] !== 'list'), [])
  await srv.close()
})

test('start refuses when list fails, when another Sandbox runs, and never stops that one', async () => {
  for (const [fail, re] of [[{ list: 'exit' }, /Can't tell whether a Sandbox is running/], [{ list: 'garbage' }, /Can't tell/], [{ others: ['99999999-0000-4000-8000-000000000000'] }, /didn't start is running/]]) {
    const s = scratch('srv-guard', fail)
    const srv = server(s.env)
    const r = await srv.call('sandbox_start', { build: path.join(s.dir, 'builds', 'hive') })
    assert.ok(r.isError && re.test(r.text), r.text)
    await srv.close()
    const calls = s.read().calls.map(c => c[0])
    assert.ok(!calls.includes('start') && !calls.includes('stop'), calls.join())
  }
})

test('start refuses folders outside the allowed roots, the profile and its dot-folders, and unknown tools', async () => {
  const s = scratch('srv-paths')
  const home = path.join(s.dir, 'home')
  fs.symlinkSync(path.join(s.dir, 'outside'), path.join(s.dir, 'builds', 'escape'), 'junction')
  const srv = server({ ...s.env, WSB_ALLOWED_ROOTS: `${path.join(s.dir, 'builds')};${home}` })
  for (const [build, re] of [
    [path.join(s.dir, 'outside'), /not under an allowed folder/],
    [path.join(s.dir, 'builds', 'escape'), /not under an allowed folder/], // a junction under a root, resolving outside
    [path.join(home, '.codex'), /dot-folder of the user profile/], // the profile is configured as a root, but is refused
    [home, /is the user profile or contains it/],
    [s.dir, /is the user profile or contains it/],
    [path.join(s.dir, 'nope'), /not found/]
  ]) {
    const r = await srv.call('sandbox_start', { build })
    assert.ok(r.isError && re.test(r.text), `${build}: ${r.text}`)
  }
  const t = await srv.call('sandbox_start', { build: path.join(s.dir, 'builds', 'hive'), tools: ['claude-auth'] })
  assert.match(t.text, /Unknown tool "claude-auth"/)
  assert.ok(!(s.read().calls || []).some(c => c[0] === 'start'))
  await srv.close()
})

test('placeholders left in the config give a clear message saying what to set, before anything starts', async () => {
  const s = scratch('srv-placeholders')
  const builds = 'C:\\path\\to\\your\\builds-' + process.pid
  const node = 'C:\\path\\to\\nodejs-' + process.pid
  const srv = server({ ...s.env, WSB_SANDBOX_ROOT: 'C:\\Users\\<you>\\AppData\\Local\\hive-test\\sandbox', WSB_ALLOWED_ROOTS: builds, WSB_TOOL_DIRS: `node=${node}` })
  const status = (await srv.call('sandbox_status')).text
  assert.match(status, /Config: WSB_SANDBOX_ROOT ".*<you>.*" isn't a usable folder \(a placeholder left in\?\): set a real folder, or remove it to use the default/)
  assert.ok(status.includes(`Config: WSB_ALLOWED_ROOTS entry "${builds}" doesn't exist: set it to the folder your builds come from.`), status)
  assert.ok(status.includes(`Config: WSB_TOOL_DIRS entry "node=${node}" doesn't exist: set it to a real folder, or remove the entry.`), status)
  let r = await srv.call('sandbox_start', { build: path.join(s.dir, 'builds', 'hive') })
  assert.ok(r.isError && /WSB_SANDBOX_ROOT .* isn't a usable folder/.test(r.text), r.text)
  await srv.close()

  const srv2 = server({ ...s.env, WSB_ALLOWED_ROOTS: builds, WSB_TOOL_DIRS: `node=${node}` })
  r = await srv2.call('sandbox_start', { build: path.join(s.dir, 'builds', 'hive') })
  assert.ok(r.isError && r.text.includes(`can't be mapped: None of the WSB_ALLOWED_ROOTS folders can be used (WSB_ALLOWED_ROOTS entry "${builds}" doesn't exist).`), r.text)
  r = await srv2.call('sandbox_start', { build: path.join(builds, 'x') })
  assert.ok(r.isError && /None of the WSB_ALLOWED_ROOTS folders can be used/.test(r.text), r.text)
  r = await srv2.call('sandbox_start', {})
  assert.ok(r.isError && r.text.includes(`WSB_TOOL_DIRS entry "node=${node}" doesn't exist`), r.text)
  await srv2.close()
  assert.ok(!(s.read().calls || []).some(c => c[0] === 'start'))
  assert.ok(!fs.existsSync('C:\\path\\to'), 'nothing was created at the placeholder paths')
})

test('a tool folder in a dot-folder of the profile is refused', async () => {
  const s = scratch('srv-tooldot')
  const srv = server({ ...s.env, WSB_TOOL_DIRS: `codex=${path.join(s.dir, 'home', '.codex')}` })
  const r = await srv.call('sandbox_start', {})
  assert.match(r.text, /dot-folder of the user profile/)
  await srv.close()
})

test('start → run → collect → stop, with the config the design asks for', async () => {
  const s = scratch('srv-happy')
  const { srv, r, id } = await started(s)
  assert.match(r.text, new RegExp(`Started Sandbox ${id}, network off`))
  assert.match(r.text, /User session ready .* window minimised/)
  const st = s.read()
  const xml = st.lastConfig
  assert.match(xml, /<Networking>Disable/)
  assert.match(xml, /hive<\/HostFolder><SandboxFolder>C:\\build<\/SandboxFolder><ReadOnly>true/)
  assert.match(xml, /node<\/HostFolder><SandboxFolder>C:\\tools\\node<\/SandboxFolder><ReadOnly>true/)
  assert.match(xml, /inside<\/HostFolder><SandboxFolder>C:\\wsb-mcp<\/SandboxFolder><ReadOnly>true/)
  assert.strictEqual(xml.match(/<ReadOnly>false/g).length, 1)
  assert.ok(st.calls.some(c => c[0] === 'connect'))
  assert.ok(st.calls.some(c => c[0] === '__window' && c[1] === 'minimise'))

  const echo = await srv.call('sandbox_run', { command: 'echo hello "quoted" & more' })
  assert.match(echo.text, /^exit 0 /)
  assert.match(echo.text, /--- stdout ---\nhello "quoted" & more/)
  const seven = await srv.call('sandbox_run', { command: 'exit 7', as: 'system' })
  assert.match(seven.text, /^exit 7/)
  assert.ok(s.read().calls.some(c => c[0] === 'exec' && c.includes('System') && /run\.ps1/.test(c[c.indexOf('-c') + 1])))
  const err = await srv.call('sandbox_run', { command: 'err boom' })
  assert.match(err.text, /--- stderr ---\nboom/)

  const big = await srv.call('sandbox_run', { command: 'big 100000' })
  assert.match(big.text, /\[stdout cut at 16 KB of 98 KB: sandbox_collect ".run-4.stdout.txt" for more\]/)
  assert.ok(big.text.length < 17 * 1024)

  const shot = await srv.call('sandbox_screenshot')
  assert.ok(shot.content.some(c => c.type === 'image' && c.mimeType === 'image/jpeg'), shot.text)
  assert.match(shot.text, /Desktop screenshot .shot-1.jpg/)

  const list = await srv.call('sandbox_collect')
  assert.match(list.text, /- \.run-1\.stdout\.txt/)
  assert.ok(!list.text.includes('.wsb-mcp-pin'))
  const got = await srv.call('sandbox_collect', { glob: '.run-*.stdout.txt', maxBytes: 10 })
  assert.match(got.text, /### .run-1.stdout.txt \(.*, cut at 0.0 KB\)\nhello "q/)

  const status = await srv.call('sandbox_status')
  assert.match(status.text, new RegExp(`Running: ${id}`))
  assert.match(status.text, /Watchdog: running/)

  const stop = await srv.call('sandbox_stop')
  assert.match(stop.text, new RegExp(`Stopped Sandbox ${id} \\(confirmed by list`))
  assert.deepStrictEqual(s.read().sandboxes, [])
  const after = await srv.call('sandbox_collect', { paths: ['.run-1.stdout.txt'] })
  assert.match(after.text, /hello/)
  // The pin on the out root is released once the stop is confirmed.
  const runDir = path.join(s.dir, 'sandbox', fs.readdirSync(path.join(s.dir, 'sandbox')).find(d => d !== 'session-times.jsonl'))
  fs.rmSync(path.join(runDir, 'out', '.wsb-mcp-pin'))
  const runAfter = await srv.call('sandbox_run', { command: 'echo x' })
  assert.match(runAfter.text, /No Sandbox is running/)
  const close = await srv.close()
  assert.strictEqual(close.code, 0)
})

test('a timeout kills the command inside by its PID; a junk or missing PID gives "no PID"', async () => {
  const s = scratch('srv-timeout')
  const { srv } = await started(s)
  const t = await srv.call('sandbox_run', { command: 'hang', timeoutSec: 1 })
  assert.ok(t.isError)
  assert.match(t.text, /TIMED OUT after 1 s: killed PID 4242 inside/)
  assert.deepStrictEqual(s.read().killed, [4242])
  for (const cmd of ['hang-pid 12 & calc', 'hang-pid 99999999999', 'hang-nopid']) {
    const r = await srv.call('sandbox_run', { command: cmd, timeoutSec: 1 })
    assert.match(r.text, /TIMED OUT after 1 s, and no PID .* sandbox_stop is the fallback/, cmd)
  }
  assert.deepStrictEqual(s.read().killed, [4242])
  await srv.call('sandbox_stop')
  await srv.close()
})

test('collect through the tool: refused paths, links skipped and reported, top level only while running, caps', async () => {
  const s = scratch('srv-collect')
  const { srv } = await started(s)
  await srv.call('sandbox_run', { command: `link prof ${path.join(s.dir, 'home')}` })
  await srv.call('sandbox_run', { command: `link sec.txt ${path.join(s.dir, 'outside', 'secret.txt')}` })
  await srv.call('sandbox_run', { command: 'echo fine' })
  await srv.call('sandbox_run', { command: 'write logs/app.log nested-log' })
  const r = await srv.call('sandbox_collect', { paths: ['..\\outside\\secret.txt', 'C:\\Users\\x\\.codex\\auth.json', '\\\\server\\share', '\\\\?\\C:\\x', 'a:stream', 'sec.txt', 'prof/.codex/auth.json', 'logs/app.log', '.run-3.stdout.txt'] })
  assert.ok(!/SECRET/.test(r.text), r.text)
  assert.strictEqual(r.text.match(/^REFUSED/gm).length, 5)
  assert.match(r.text, /SKIPPED sec.txt: "sec.txt" is a link/)
  // While running, nothing below the root is read: not through a link, not from a real folder.
  assert.match(r.text, /NOT READ prof\/.codex\/auth.json: only files directly in the out folder/)
  assert.match(r.text, /NOT READ logs\/app.log: only files directly in the out folder .* after sandbox_stop/)
  assert.match(r.text, /### .run-3.stdout.txt[^\n]*\nfine/)
  const g = await srv.call('sandbox_collect', { glob: '**' })
  assert.ok(!/SECRET|nested-log/.test(g.text))
  assert.match(g.text, /SKIPPED prof: link or reparse point/)
  assert.match(g.text, /SKIPPED sec.txt: link or reparse point/)
  assert.match(g.text, /\(1 folder not searched: .* after sandbox_stop\)/)
  const listing = await srv.call('sandbox_collect')
  assert.match(listing.text, /- logs\/ \(folder: its files can be collected after sandbox_stop\)/)
  const bad = await srv.call('sandbox_collect', { glob: '../**' })
  assert.match(bad.text, /Glob refused: ".." is not allowed/)
  await srv.call('sandbox_run', { command: 'big 5000' })
  await srv.call('sandbox_run', { command: 'big 5000' })
  const capped = await srv.call('sandbox_collect', { paths: ['.run-5.stdout.txt', '.run-6.stdout.txt'], maxBytes: 4000, maxTotalBytes: 6000 })
  assert.match(capped.text, /### .run-5.stdout.txt \(4.9 KB, cut at 3.9 KB\)/)
  assert.match(capped.text, /### .run-6.stdout.txt \(4.9 KB, cut at 2.0 KB\)/)

  // After a confirmed stop nothing changes out any more: folders can be read, links are still skipped.
  await srv.call('sandbox_stop')
  const after = await srv.call('sandbox_collect', { paths: ['logs/app.log', 'prof/.codex/auth.json'] })
  assert.match(after.text, /### logs\/app.log[^\n]*\nnested-log/)
  assert.match(after.text, /SKIPPED prof\/.codex\/auth.json: "prof" is a link/)
  assert.ok(!/SECRET/.test(after.text))
  await srv.close()
})

test('collect checks every path and the glob before touching the out folder (the real collect, in-process)', async () => {
  const s = scratch('srv-collect-order')
  const { collect, setLast } = require('../server')
  setLast({ id: 'x', outDir: path.join(s.dir, 'sandbox', 'never-created') })
  const touched = []
  const names = ['lstatSync', 'realpathSync', 'opendirSync', 'openSync', 'statSync', 'readdirSync', 'existsSync']
  const saved = names.map(n => [n, fs[n]])
  for (const n of names) fs[n] = () => { touched.push(n); throw new Error('disk touched') }
  try {
    await assert.rejects(collect({ glob: '../**' }), /Glob refused: ".." is not allowed/)
    await assert.rejects(collect({ paths: ['ok.txt'], glob: 'C:\\**' }), /Glob refused/)
    assert.deepStrictEqual(touched, [])
    const r = await collect({ paths: ['../x', '\\\\server\\share', '\\\\?\\C:\\x', 'C:\\Users\\x', 'a:stream'] })
    assert.strictEqual(r.match(/^REFUSED/gm).length, 5)
    assert.deepStrictEqual(touched, [])
  } finally {
    for (const [n, f] of saved) fs[n] = f
  }
})

test('the command line never ends a quoted argument with a backslash; cwd defaults; a wrapper failure is reported', async () => {
  const s = scratch('srv-cwd')
  const srv = server(s.env)
  assert.ok(!(await srv.call('sandbox_start', {})).isError) // no build mapped: the default cwd is C:\
  assert.match((await srv.call('sandbox_run', { command: 'cwd' })).text, /^exit 0[\s\S]*\nC:\\\.$/)
  assert.match((await srv.call('sandbox_run', { command: 'cwd', cwd: 'D:\\' })).text, /\nD:\\\.$/)
  assert.match((await srv.call('sandbox_run', { command: 'cwd', cwd: 'C:\\tools\\node\\' })).text, /\nC:\\tools\\node$/)
  const w = await srv.call('sandbox_run', { command: 'wrapper-fails' })
  assert.ok(w.isError)
  assert.match(w.text, /The run wrapper failed inside the Sandbox, so the command didn't run: Start-Process/)
  assert.ok(!s.read().calls.some(c => c[0] === 'exec' && /\\"/.test(c[c.indexOf('-c') + 1])))
  await srv.call('sandbox_stop')
  await srv.close()

  const b = scratch('srv-cwd-build')
  const { srv: s2 } = await started(b)
  assert.match((await s2.call('sandbox_run', { command: 'cwd' })).text, /\nC:\\build$/)
  await s2.call('sandbox_stop')
  await s2.close()
})

test('a failing stop is retried and reported, the id kept; a later stop confirms it', async () => {
  const s = scratch('srv-stopfail')
  const { srv, id } = await started(s)
  s.patch(x => { x.fail.stop = -1 })
  const r = await srv.call('sandbox_stop')
  assert.ok(r.isError)
  assert.match(r.text, new RegExp(`CLEANUP FAILED: Sandbox ${id} may still be running \\(3 stop attempts; last: stop exit 1, still listed\\)`))
  assert.match((await srv.call('sandbox_status')).text, /UNCONFIRMED STOP/)
  assert.match((await srv.call('sandbox_run', { command: 'echo x' })).text, /stop is unconfirmed/)
  assert.match((await srv.call('sandbox_start', {})).text, /stop is unconfirmed: call sandbox_stop/)
  s.patch(x => { x.fail.stop = 0; x.fail.stopLies = true })
  assert.match((await srv.call('sandbox_stop')).text, /CLEANUP FAILED/) // stop exit 0 while still listed
  s.patch(x => { x.fail.stopLies = false })
  assert.match((await srv.call('sandbox_stop')).text, /Stopped Sandbox/)
  await srv.close()
})

test('a list failing after stop is a failed cleanup', async () => {
  const s = scratch('srv-listafter')
  const { srv } = await started(s)
  s.patch(x => { x.fail.listAfterStop = 'exit' })
  const r = await srv.call('sandbox_stop')
  assert.match(r.text, /CLEANUP FAILED: .*list failed: wsb list failed/)
  s.patch(x => { x.fail.listAfterStop = undefined })
  await srv.call('sandbox_stop')
  await srv.close()
})

test('stdin closing stops the Sandbox; a failed stop then exits non-zero', async () => {
  const s = scratch('srv-stdin')
  const { srv } = await started(s)
  const r = await srv.close()
  assert.strictEqual(r.code, 0)
  assert.deepStrictEqual(s.read().sandboxes, [])

  const t = scratch('srv-stdin-fail')
  const b = await started(t)
  t.patch(x => { x.fail.stop = -1 })
  const e = await b.srv.close()
  assert.strictEqual(e.code, 1)
  assert.match(e.stderr, /CLEANUP FAILED/)
  // The watchdog saw the pipe close and keeps trying: once stop works, it confirms it.
  t.patch(x => { x.fail.stop = 0 })
  await waitFor(() => !t.read().sandboxes.length, 15_000, 'the watchdog to take over the failed stop')
})

test('killed hard, the server leaves it to the watchdog, which stops it', async () => {
  const s = scratch('srv-kill')
  const { srv, id } = await started(s)
  srv.child.kill('SIGKILL')
  await waitFor(() => !s.read().sandboxes.includes(id), 15_000, 'the watchdog to stop the Sandbox')
  const runDir = path.join(s.dir, 'sandbox', fs.readdirSync(path.join(s.dir, 'sandbox')).find(d => d !== 'session-times.jsonl'))
  await waitFor(() => fs.existsSync(path.join(runDir, 'watchdog.json')), 5000, 'watchdog.json')
  const w = JSON.parse(fs.readFileSync(path.join(runDir, 'watchdog.json'), 'utf8'))
  assert.strictEqual(w.stopped, true)
  assert.strictEqual(w.reason, 'server gone')
})

test('a restarted server stops a Sandbox an earlier run left, and never one it did not start', async () => {
  const s = scratch('srv-restart')
  const mine = 'aaaaaaaa-0000-4000-8000-000000000001'
  const live = 'aaaaaaaa-0000-4000-8000-000000000002'
  const other = 'bbbbbbbb-0000-4000-8000-000000000003'
  s.patch(x => { x.sandboxes = [mine, live, other] })
  const mk = (name, id, serverPid) => {
    const d = path.join(s.dir, 'sandbox', name)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ id, serverPid, stopped: false }))
    return d
  }
  const deadDir = mk('dead', mine, 999_999_9)
  mk('live', live, process.pid) // this test process stands in for another live server
  const srv = server(s.env)
  const st = await srv.call('sandbox_status')
  assert.match(st.text, new RegExp(`At start-up: Stopped Sandbox ${mine}`))
  assert.match(st.text, new RegExp(`Sandbox ${live} belongs to a server that is still running`))
  assert.deepStrictEqual(s.read().sandboxes.sort(), [live, other].sort())
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(deadDir, 'state.json'), 'utf8')).stoppedBy, 'restart')
  assert.ok(!s.read().calls.some(c => c[0] === 'stop' && c.includes(other)))
  await srv.close()
})

test('a user session that is not ready: user commands and screenshots say so; system works', async () => {
  const s = scratch('srv-nosession', { session: 1000 })
  const { srv, r } = await started(s)
  assert.match(r.text, /User session NOT ready/)
  assert.match((await srv.call('sandbox_run', { command: 'echo x' })).text, /user session isn't ready yet/)
  assert.match((await srv.call('sandbox_screenshot')).text, /No user session/)
  assert.match((await srv.call('sandbox_run', { command: 'echo y', as: 'system' })).text, /^exit 0/)
  await srv.call('sandbox_stop')
  await srv.close()
})

test('closeWindow: closes its own window, and a screenshot then errors', async () => {
  const s = scratch('srv-closewin')
  const { srv, r } = await started(s, { closeWindow: true })
  assert.match(r.text, /Window closed/)
  assert.ok(s.read().calls.some(c => c[0] === '__window' && c[1] === 'close'))
  assert.match((await srv.call('sandbox_screenshot')).text, /connect window was closed/)
  await srv.call('sandbox_stop')
  await srv.close()
})

test('a failed start is reported with a hint and leaves nothing behind', async () => {
  const s = scratch('srv-startfail', { start: true })
  const srv = server(s.env)
  const r = await srv.call('sandbox_start', {})
  assert.match(r.text, /wsb start failed \(exit 1\): start failed \(0x80070422\) \(Check that virtualisation is on/)
  assert.match((await srv.call('sandbox_status')).text, /None running/)
  await srv.close()
})

// The guest commands a run made, decoded from the run wrapper's -B64, with the exec's id and account.
const guestRuns = s => s.read().calls.filter(c => c[0] === 'exec' && /run\.ps1/.test(c[c.indexOf('-c') + 1]))
  .map(c => ({ id: c[c.indexOf('--id') + 1], as: c[c.indexOf('-r') + 1], command: Buffer.from(/-B64 (\S+)/.exec(c[c.indexOf('-c') + 1])[1], 'base64').toString('utf8') }))
const SAC_IS = n => `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    0x${n}\r\n`

test("smartAppControl 'off': turned off inside its own Sandbox only (wsb exec --id, as System), read back, said plainly (#1092)", async () => {
  const s = scratch('srv-sac-off', { guest: [{ match: '^reg\\.exe query', stdout: SAC_IS(0) }] })
  const { srv, r, id } = await started(s, { smartAppControl: 'off' })
  assert.match(r.text, /^Smart App Control turned OFF in this Sandbox by option \(VerifiedAndReputablePolicyState 0, read back\), so unsigned installers can run\. The host is not changed\.$/m)
  assert.deepStrictEqual(guestRuns(s), [
    { id, as: 'System', command: 'reg.exe add HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f' },
    { id, as: 'System', command: 'CiTool.exe --refresh -json' },
    { id, as: 'System', command: 'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState' }
  ])
  assert.match((await srv.call('sandbox_status')).text, /Smart App Control: turned off in this Sandbox by option\./)
  await srv.call('sandbox_stop')
  await srv.close()
})

test("smartAppControl: off by default (nothing changed), only 'keep' or 'off', and 'off' not taking is said plainly", async () => {
  const s = scratch('srv-sac-default')
  const { srv, r } = await started(s)
  assert.doesNotMatch(r.text, /Smart App Control/)
  assert.deepStrictEqual(guestRuns(s), [])
  assert.doesNotMatch((await srv.call('sandbox_status')).text, /Smart App Control/)
  await srv.call('sandbox_stop')
  await srv.close()

  const b = scratch('srv-sac-bad')
  const srv2 = server(b.env)
  for (const v of ['on', 'OFF', false]) {
    const x = await srv2.call('sandbox_start', { build: path.join(b.dir, 'builds', 'hive'), smartAppControl: v })
    assert.ok(x.isError && /smartAppControl is 'keep' \(default\) or 'off'/.test(x.text), x.text)
  }
  assert.ok(!(b.read().calls || []).some(c => c[0] === 'start'))
  await srv2.close()

  const n = scratch('srv-sac-still-on', { guest: [{ match: '^reg\\.exe query', stdout: SAC_IS(1) }] })
  const t = await started(n, { smartAppControl: 'off' })
  assert.match(t.r.text, /^Smart App Control NOT turned off \(smartAppControl 'off'\): read back as 1 \(VerifiedAndReputablePolicyState\), not 0\. Unsigned installers will still be blocked\.$/m)
  assert.match((await t.srv.call('sandbox_status')).text, /Smart App Control: asked off, but NOT off \(state 1\)\./)
  await t.srv.call('sandbox_stop')
  await t.srv.close()

  const f = scratch('srv-sac-refresh-fails', { guest: [{ match: '^CiTool', exit: 5, stderr: 'refresh failed' }] })
  const u = await started(f, { smartAppControl: 'off' })
  assert.match(u.r.text, /^Smart App Control NOT turned off \(smartAppControl 'off'\): CiTool\.exe --refresh -json: exit 5 /m)
  assert.ok(!guestRuns(f).some(g => /query/.test(g.command)), 'read back after a failed step')
  await u.srv.call('sandbox_stop')
  await u.srv.close()
})

test('the Smart App Control change exists only as guest commands, sent only by the server through the run wrapper', () => {
  // No other file of the server or the runner names the change, so nothing can run it on the host; they use SAC_OFF,
  // and only server.js's smartAppControlOff does, through runCommand (wsb exec --id <its own Sandbox>).
  const root = path.join(__dirname, '..')
  const files = ['server.js', 'wsb.js', 'watchdog.js', 'confine.js', 'roots.js', 'client.js', ...fs.readdirSync(path.join(root, 'scenarios')).map(f => `scenarios/${f}`)]
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    assert.strictEqual(/reg(\.exe)? add|CiTool|\/d 0 \/f/i.test(src), f === 'wsb.js', f)
    assert.strictEqual(/\bSAC_OFF\b/.test(src), f === 'wsb.js' || f === 'server.js', f)
  }
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  const body = src.slice(src.indexOf('async function smartAppControlOff'), src.indexOf('async function start('))
  assert.match(body, /for \(const command of SAC_OFF\)[\s\S]*?runCommand\(\{ command, as: 'system'/)
  assert.strictEqual(src.split('SAC_OFF').length - 1, 2) // the import and that loop
})
