/**
 * Clears earlier test runs' scratch, so each tests' scratch folder holds one run's output rather than growing forever.
 * `npm test` runs this first (pretest); the latest run's folders stay for debugging until the next run.
 * In each folder of TARGETS it removes only the folders that suite's scratch() makes: named `<pid>-<n>-<name>`, directly
 * in that folder, holding every one of its marker files. It skips one whose test process is still running (a run in
 * progress elsewhere): its pid is live and the folder changed within the last hour (a run takes about a minute;
 * Windows reuses pids, so a live pid alone can be another process). A folder it can't remove (a file still open) is left
 * for the next run. Alone: `node test\clean-scratch.js`.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRATCH = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch')
/** Each suite's scratch folder (its env setting, else the default) and the files its scratch() always writes. */
const TARGETS = {
  'windows-sandbox': { base: process.env.WSB_TEST_SCRATCH || path.join(SCRATCH, 'wsb-mcp-tests'), marker: ['stub.json'] },
  ollama: { base: process.env.OLLAMA_TEST_SCRATCH || path.join(SCRATCH, 'ollama-tests'), marker: ['home/.ssh/id_ed25519', 'outside/secret.txt'] }
}
const NAME = /^(\d+)-\d+-/
const RECENT_MS = 60 * 60 * 1000

function running(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Removes earlier runs' folders in base; returns what it removed, kept (running) and failed to remove. */
function cleanScratch(base, { marker, isRunning = running, now = Date.now() }) {
  const res = { removed: 0, running: 0, failed: [] }
  let names
  try { names = fs.readdirSync(base) } catch (e) { if (e.code === 'ENOENT') return res; throw e }
  for (const name of names) {
    const m = NAME.exec(name)
    if (!m) continue
    const dir = path.join(base, name)
    let marks
    try { marks = marker.map(f => fs.statSync(path.join(dir, f))) } catch { continue }
    const changed = Math.max(fs.statSync(dir).mtimeMs, ...marks.map(s => s.mtimeMs))
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
  for (const [suite, t] of Object.entries(TARGETS)) {
    const r = cleanScratch(t.base, t)
    console.log(`${suite} test scratch ${t.base}: removed ${r.removed} earlier folders` +
      (r.running ? `, kept ${r.running} of a run still going` : '') +
      (r.failed.length ? `, couldn't remove ${r.failed.length} (left for next time): ${r.failed.slice(0, 3).join('; ')}` : ''))
  }
}

module.exports = { cleanScratch, TARGETS }
