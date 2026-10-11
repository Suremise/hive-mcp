/**
 * Detached watchdog for one Sandbox:  node watchdog.js <runDir>
 *
 * Started by the server right after `wsb start`, with a pipe on its stdin. It stops the Sandbox named in
 * <runDir>\state.json, under the same confirm-and-retry rule as the server, when:
 * - the server is gone: its pipe closes (also when it is killed hard and no exit handler ran) or its PID is no longer
 *   alive; or
 * - the deadline passes.
 * The server writes "done" once it has confirmed the stop itself, and "deadline <ms>" to move the deadline.
 * The outcome goes to <runDir>\watchdog.json ({ stopped, at, reason, attempts, error }) and watchdog.log; it exits 0
 * after a confirmed stop and 1 if it gave up (the Sandbox may still be running: the next server start retries).
 */
const { readFileSync, writeFileSync, appendFileSync, renameSync } = require('fs')
const { join } = require('path')
const { stopConfirmed } = require('./wsb')

const runDir = process.argv[2]
const state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'))
const CHECK_MS = Number(process.env.WSB_WATCHDOG_CHECK_MS || 2000)
const GIVE_UP_AFTER = 20 // rounds of 3 attempts, CHECK_MS * 15 apart
let deadline = state.deadline
let serverGone = false
let stopping = false

const log = (...a) => { try { appendFileSync(join(runDir, 'watchdog.log'), `[${new Date().toISOString()}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`) } catch { /* nothing to do */ } }
const report = r => {
  const tmp = join(runDir, 'watchdog.json.tmp')
  writeFileSync(tmp, JSON.stringify({ id: state.id, at: new Date().toISOString(), ...r }, null, 2))
  renameSync(tmp, join(runDir, 'watchdog.json'))
}
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', d => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === 'done') { log('server confirmed the stop; exiting'); process.exit(0) }
    const m = /^deadline (\d+)$/.exec(line)
    if (m) { deadline = Number(m[1]); log('deadline now', new Date(deadline).toISOString()) }
  }
})
const gone = why => { if (!serverGone) { serverGone = true; log('server gone:', why) } }
process.stdin.on('end', () => gone('pipe closed'))
process.stdin.on('error', () => gone('pipe error'))

async function stop(reason) {
  stopping = true
  log('stopping', state.id, 'because', reason)
  for (let round = 1; round <= GIVE_UP_AFTER; round++) {
    const r = await stopConfirmed(state.id)
    log('round', round, r)
    if (r.ok) { report({ stopped: true, reason, attempts: r.attempts }); process.exit(0) }
    report({ stopped: false, reason, attempts: r.attempts, error: `stop not confirmed (round ${round} of ${GIVE_UP_AFTER})` })
    await new Promise(res => setTimeout(res, CHECK_MS * 15))
  }
  report({ stopped: false, reason, error: `gave up after ${GIVE_UP_AFTER} rounds: Sandbox ${state.id} may still be running` })
  process.exit(1)
}

log('watching', state.id, 'server pid', state.serverPid, 'deadline', new Date(deadline).toISOString())
setInterval(() => {
  if (stopping) return
  if (!serverGone && !alive(state.serverPid)) gone('pid not alive')
  if (serverGone) return void stop('server gone')
  if (Date.now() >= deadline) return void stop('deadline passed')
}, CHECK_MS)
