/**
 * Clears earlier test runs' scratch, so the folder holds one run's output rather than growing forever.
 * `npm test` runs this first (pretest); the latest run's folders stay for debugging until the next run.
 * It removes only the folders scratch() makes (named `<pid>-<n>-<name>`, directly in BASE, holding its stub.json), and
 * skips one whose test process is still running (a run in progress elsewhere): its pid is live and the folder changed
 * within the last hour (a run takes about a minute; Windows reuses pids, so a live pid alone can be another process).
 * A folder it can't remove (a file still open) is left for the next run. Alone: `node servers\windows-sandbox\test\clean-scratch.js`.
 */
const fs = require('fs')
const path = require('path')

const BASE = process.env.WSB_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA, 'hive-test', 'scratch', 'wsb-mcp-tests')
const NAME = /^(\d+)-\d+-/
const RECENT_MS = 60 * 60 * 1000

function running(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Removes earlier runs' folders in base; returns what it removed, kept (running) and failed to remove. */
function cleanScratch(base = BASE, isRunning = running, now = Date.now()) {
  const res = { removed: 0, running: 0, failed: [] }
  let names
  try { names = fs.readdirSync(base) } catch (e) { if (e.code === 'ENOENT') return res; throw e }
  for (const name of names) {
    const m = NAME.exec(name)
    if (!m) continue
    const dir = path.join(base, name)
    let stub
    try { stub = fs.statSync(path.join(dir, 'stub.json')) } catch { continue }
    const changed = Math.max(stub.mtimeMs, fs.statSync(dir).mtimeMs)
    if (now - changed < RECENT_MS && isRunning(Number(m[1]))) { res.running++; continue }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      res.removed++
    } catch (e) {
      res.failed.push(`${name}: ${e.code || e.message}`)
    }
  }
  return res
}

if (require.main === module) {
  const r = cleanScratch()
  console.log(`wsb test scratch ${BASE}: removed ${r.removed} earlier folders` +
    (r.running ? `, kept ${r.running} of a run still going` : '') +
    (r.failed.length ? `, couldn't remove ${r.failed.length} (left for next time): ${r.failed.slice(0, 3).join('; ')}` : ''))
}

module.exports = { cleanScratch, BASE }
