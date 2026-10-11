/**
 * Test helpers: a scratch folder per test, the wsb stub's state, and a JSON-RPC client for server.js.
 * Scratch goes under WSB_TEST_SCRATCH (default %LOCALAPPDATA%\hive-test\scratch\wsb-mcp-tests), never the repo;
 * clean-scratch.js clears earlier runs' folders there before `npm test`.
 */
const fs = require('fs')
const path = require('path')
const { server } = require('../client')
const { BASE } = require('./clean-scratch')

const STUB = path.join(__dirname, 'stub-wsb.js')

let seq = 0
/** A fresh folder with a fake profile (home), an allowed builds root, a tool folder, the sandbox root and stub state. */
function scratch(name, fail = {}) {
  const dir = path.join(BASE, `${process.pid}-${++seq}-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const d of ['home/.codex', 'builds/hive', 'tools/node', 'sandbox', 'outside']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'home/.codex/auth.json'), 'SECRET')
  fs.writeFileSync(path.join(dir, 'outside/secret.txt'), 'SECRET')
  fs.writeFileSync(path.join(dir, 'builds/hive/Hive-Setup-0.6.0.exe'), 'MZ')
  const state = path.join(dir, 'stub.json')
  fs.writeFileSync(state, JSON.stringify({ fail }))
  return {
    dir,
    state,
    env: {
      ...process.env,
      USERPROFILE: path.join(dir, 'home'),
      WSB_STUB: STUB,
      WSB_STUB_STATE: state,
      WSB_MCP_ENABLED: '1',
      WSB_SANDBOX_ROOT: path.join(dir, 'sandbox'),
      WSB_ALLOWED_ROOTS: path.join(dir, 'builds'),
      WSB_TOOL_DIRS: `node=${path.join(dir, 'tools/node')}`,
      WSB_STOP_RETRY_MS: '10',
      WSB_WATCHDOG_CHECK_MS: '100',
      WSB_SESSION_WAIT_MS: '3000'
    },
    read: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    patch: fn => { const s = JSON.parse(fs.readFileSync(state, 'utf8')); fn(s); fs.writeFileSync(state, JSON.stringify(s)) }
  }
}

/** Polls fn until truthy (or throws after ms). */
async function waitFor(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

module.exports = { scratch, server, waitFor, STUB, BASE }
