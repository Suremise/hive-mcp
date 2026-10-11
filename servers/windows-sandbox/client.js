/**
 * A small stdio client for server.js, for scripts that drive it (the Hive checks, the smoke test, the tests).
 * Node built-ins only.
 *   const srv = server(env); const r = await srv.call('sandbox_start', { ... }); await srv.close()
 */
const { spawn } = require('child_process')
const { createInterface } = require('readline')
const { join } = require('path')
const { pathToFileURL } = require('url')

const SERVER = join(__dirname, 'server.js')

/**
 * Starts server.js and initializes it. With `roots` (host folders), it declares the MCP roots capability and answers
 * the server's roots/list with them; `setRoots(folders)` changes them and tells the server (roots/list_changed).
 * Returns { call(name, args) → { text, isError, content }, request, setRoots, rootsAsked, child, exit (promise), close() }.
 */
function server(env, { roots, cwd } = {}) {
  const child = spawn(process.execPath, [SERVER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdin.on('error', () => {}) // a killed server's pipe
  const pending = new Map()
  let id = 0
  let current = roots
  let rootsAsked = 0
  const write = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  createInterface({ input: child.stdout }).on('line', l => {
    const m = JSON.parse(l)
    if (m.method === 'roots/list') { // the server asking us
      rootsAsked++
      return write(current ? { id: m.id, result: { roots: current.map(p => ({ uri: pathToFileURL(p).href })) } } : { id: m.id, error: { code: -32601, message: 'Method not found' } })
    }
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  // A server that exits answers nothing more: its pending and later calls fail instead of waiting forever.
  let exited = false
  const exit = new Promise(res => child.on('exit', code => {
    exited = true
    for (const p of pending.values()) p({ error: { message: `server exited (${code})` } })
    pending.clear()
    res({ code, stderr })
  }))
  const request = (method, params) => new Promise(res => {
    if (exited) return res({ error: { message: 'server exited' } })
    pending.set(++id, res)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args })
    if (m.error) throw new Error(m.error.message)
    return { text: m.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!m.result.isError, content: m.result.content }
  }
  void request('initialize', { protocolVersion: '2025-06-18', capabilities: roots ? { roots: { listChanged: true } } : {}, clientInfo: { name: 'windows-sandbox-client', version: '1.0.0' } })
    .then(() => { if (!exited) write({ method: 'notifications/initialized' }) })
  const setRoots = folders => { current = folders; write({ method: 'notifications/roots/list_changed' }) }
  return { child, call, request, setRoots, rootsAsked: () => rootsAsked, exit, close: () => { child.stdin.end(); return exit } }
}

module.exports = { server, SERVER }
