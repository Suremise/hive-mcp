// The detached watchdog on its own: what makes it stop the Sandbox, and that it fails closed like the server.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { scratch, waitFor } = require('./helpers')

const WATCHDOG = path.join(__dirname, '..', 'watchdog.js')
const ID = 'cccccccc-0000-4000-8000-000000000001'

function setup(name, { fail, deadline = Date.now() + 600_000, serverPid } = {}) {
  const s = scratch(name, fail)
  s.patch(x => { x.sandboxes = [ID] })
  const runDir = path.join(s.dir, 'sandbox', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const dummy = serverPid ? null : spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: ID, serverPid: serverPid || dummy.pid, deadline }))
  const wd = spawn(process.execPath, [WATCHDOG, runDir], { env: s.env, stdio: ['pipe', 'ignore', 'ignore'] })
  const exit = new Promise(res => wd.on('exit', res))
  test.after(() => { wd.kill(); dummy?.kill() })
  const report = () => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'watchdog.json'), 'utf8')) } catch { return null } }
  return { s, wd, dummy, exit, report }
}

test('the server PID dying stops the Sandbox, confirmed', async () => {
  const t = setup('wd-pid')
  t.dummy.kill('SIGKILL')
  assert.strictEqual(await t.exit, 0)
  assert.deepStrictEqual(t.s.read().sandboxes, [])
  assert.deepStrictEqual({ stopped: t.report().stopped, reason: t.report().reason }, { stopped: true, reason: 'server gone' })
  t.wd.stdin.destroy()
})

test('the pipe closing (server killed hard) stops it', async () => {
  const t = setup('wd-pipe')
  t.wd.stdin.end()
  assert.strictEqual(await t.exit, 0)
  assert.strictEqual(t.report().stopped, true)
  t.dummy.kill()
})

test('the deadline passing stops it, with the server alive', async () => {
  const t = setup('wd-deadline', { deadline: Date.now() + 500 })
  assert.strictEqual(await t.exit, 0)
  assert.strictEqual(t.report().reason, 'deadline passed')
  assert.deepStrictEqual(t.s.read().sandboxes, [])
  t.dummy.kill()
})

test('"deadline <ms>" moves the deadline; "done" exits without stopping', async () => {
  const t = setup('wd-done', { deadline: Date.now() + 800 })
  t.wd.stdin.write(`deadline ${Date.now() + 600_000}\n`)
  await new Promise(r => setTimeout(r, 1500))
  assert.deepStrictEqual(t.s.read().sandboxes, [ID])
  t.wd.stdin.write('done\n')
  assert.strictEqual(await t.exit, 0)
  assert.ok(!(t.s.read().calls || []).some(c => c[0] === 'stop'))
  t.dummy.kill()
})

test('a stop that is never confirmed is retried in bounded rounds and reported, not claimed', async () => {
  for (const fail of [{ stop: -1 }, { stopLies: true }, { listAfterStop: 'exit' }]) {
    const t = setup('wd-fail', { fail })
    t.wd.stdin.end()
    const r = await waitFor(() => { const x = t.report(); return x && x.stopped === false && x }, 10_000, 'a failure report')
    assert.match(r.error, /stop not confirmed \(round 1 of 20\)/, JSON.stringify(fail))
    assert.strictEqual(r.attempts.length, 3)
    t.wd.kill()
    t.dummy.kill()
  }
})
