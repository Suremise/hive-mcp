/**
 * MCP roots for a stdio server: which folders the client says it is working in, and which host folders the server may
 * reach because of them. Shared by the servers in this repo. shared/roots.js is the canonical copy; each server ships
 * its own copy (a server's zip must be self-contained), and `npm test` fails if a copy differs. Node built-ins only.
 *
 * The rules (each server's README says them for its own settings):
 * - The client's roots, asked with roots/list each time they are needed, when its initialize declared the capability.
 *   A client that declared roots but doesn't answer is a refusal, never a silent fallback. An empty list is no roots.
 * - With no client roots and the cwd opt-in, the folder the client started the server in (not a drive root).
 * - The env list (e.g. WSB_ALLOWED_ROOTS) narrows those roots: a path must be under both. With no other roots it is the
 *   fallback on its own. It never widens.
 * - Nothing else: refused, with a message saying what to set.
 * - Whatever the roots say, the user profile itself (or anything containing it), its dot-folders and AppData are
 *   refused, and a root that is one of them is dropped. Paths must really resolve (realpath) under a root.
 *
 * These are path checks: they stop any path or link an agent passes. They can't stop a local process running as the
 * user that changes the folders between a check and the server's use of the path; such a process can already read
 * those files itself. Each server's README says so ("What the confinement guarantees").
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { fileURLToPath } = require('url')

const WIN = process.platform === 'win32'
const norm = p => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p))

/** Whether `child` is `parent` or inside it (case-insensitive on Windows). Plain path comparison: resolve links first. */
function isInside(child, parent) {
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** The real path of a folder (links and junctions resolved). Throws if it doesn't exist or isn't a folder. */
function realDir(p) {
  const r = fs.realpathSync.native(p)
  if (!fs.statSync(r).isDirectory()) throw new Error('not a folder')
  return r
}

/** Why a real host path must never be reached, whatever the roots say, or null: the profile, its dot-folders, AppData. */
function profileRefusal(real, home = os.homedir()) {
  let h
  try { h = fs.realpathSync.native(home) } catch { h = path.resolve(home) }
  if (isInside(h, real)) return 'it is the user profile or contains it'
  if (isInside(real, h)) {
    const parts = path.relative(h, real).split(path.sep)
    if (parts[0].startsWith('.')) return 'it is in a dot-folder of the user profile (sign-ins and settings)'
    if (/^appdata$/i.test(parts[0])) {
      if (parts.length === 1 || (parts.length === 2 && /^(roaming|local|locallow)$/i.test(parts[1]))) return 'it is AppData or one of its top folders'
      if (/^roaming$/i.test(parts[1])) return 'it is in AppData\\Roaming (app sign-ins)'
    }
  }
  return null
}

/** The local folders in a roots/list result: file: URIs only, decoded, de-duplicated. Anything else is ignored. */
function parseRoots(result) {
  const out = new Map()
  for (const r of Array.isArray(result?.roots) ? result.roots : []) {
    if (typeof r?.uri !== 'string' || !/^file:/i.test(r.uri)) continue
    let p
    try { p = path.resolve(fileURLToPath(r.uri)) } catch { continue } // not a path on this OS
    if (!out.has(norm(p))) out.set(norm(p), p) // the first spelling wins
  }
  return [...out.values()]
}

/**
 * The roots side of a stdio server's connection. Call `initialize(params)` with the client's initialize params, give
 * every incoming message to `handle(msg)` first (true when it was the answer to a roots request, so nothing else needs
 * it), and call `list()` for the client's current roots: { declared: false } when it never declared the capability,
 * else { declared: true, roots: [paths] } or { declared: true, error }. `send(msg)` writes one message to the client.
 */
function rootsClient(send, { timeoutMs = 5000 } = {}) {
  let declared = false
  let seq = 0
  const pending = new Map()
  return {
    initialize(params) { declared = !!params?.capabilities?.roots },
    get declared() { return declared },
    handle(msg) {
      if (!msg || msg.method !== undefined || !pending.has(msg.id)) return false
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return true
    },
    list() {
      if (!declared) return Promise.resolve({ declared: false })
      return new Promise(resolve => {
        const id = `roots-${++seq}`
        const timer = setTimeout(() => { pending.delete(id); resolve({ declared: true, error: `no answer to roots/list within ${timeoutMs / 1000} s` }) }, timeoutMs)
        pending.set(id, m => {
          clearTimeout(timer)
          resolve(m.error ? { declared: true, error: `roots/list failed: ${m.error.message || m.error.code}` } : { declared: true, roots: parseRoots(m.result) })
        })
        send({ jsonrpc: '2.0', id, method: 'roots/list', params: {} })
      })
    }
  }
}

/**
 * The folders a server may reach, by the rules at the top. In:
 * - client: the result of rootsClient().list();
 * - env: the env list's entries (e.g. WSB_ALLOWED_ROOTS, split);
 * - cwd: the server's folder when the cwd opt-in is on, else null;
 * - names: { env, cwd } setting names for messages, e.g. { env: 'WSB_ALLOWED_ROOTS', cwd: 'WSB_ROOTS_FROM_CWD=1' };
 * - refuse(real): the server's own extra refusals (a reason, or null).
 * Out: { source, roots, narrow, dropped, refusal, allows(real), describe() }. `refusal` is a message when nothing is
 * allowed; otherwise `allows(real)` says whether a real path is under the roots (and under `narrow`, if set).
 */
function allowedRoots({ client = { declared: false }, env = [], cwd = null, names, refuse = () => null }) {
  const dropped = []
  const keep = (list, from) => list.flatMap(p => {
    let real
    try { real = realDir(p) } catch (e) {
      dropped.push(`${from} "${p}" ${e.code === 'ENOENT' ? "doesn't exist" : `can't be used (${e.message})`}`)
      return []
    }
    const why = profileRefusal(real) || refuse(real)
    if (why) { dropped.push(`${from} "${p}" is refused: ${why}`); return [] }
    return [real]
  })
  const result = (source, roots, narrow, refusal = null) => ({
    source,
    roots,
    narrow,
    dropped,
    refusal: refusal && (dropped.length ? `${refusal} (${dropped.join('; ')})` : refusal),
    allows: real => !refusal && roots.some(r => isInside(real, r)) && (!narrow || narrow.some(r => isInside(real, r))),
    describe: () => refusal ? `none (${refusal})`
      : `${source}: ${roots.join('; ')}${narrow ? `, narrowed by ${names.env}: ${narrow.join('; ')}` : ''}${dropped.length ? ` (dropped: ${dropped.join('; ')})` : ''}`
  })

  if (client.error) return result('client', [], null, `The client declared MCP roots but didn't give them (${client.error}), so no folder is allowed`)
  let base = null
  let source = null
  if (client.declared && client.roots.length) {
    base = keep(client.roots, "the client's root")
    source = "the client's roots"
    if (!base.length) return result(source, [], null, "None of the client's roots can be used")
  } else if (cwd) {
    const c = path.resolve(cwd)
    if (path.parse(c).root.toLowerCase() === c.toLowerCase()) dropped.push(`the server's folder "${c}" is a drive root, so it isn't used as a root`)
    else {
      base = keep([c], "the server's folder")
      source = `the server's folder, by ${names.cwd}`
      if (!base.length) base = null
    }
  }
  const narrow = env.length ? keep(env, `${names.env} entry`) : null
  if (narrow && !narrow.length) return result(source || names.env, [], null, `None of the ${names.env} folders can be used`)
  if (base && narrow) return result(source, base, narrow)
  if (base) return result(source, base, null)
  if (narrow) return result(names.env, narrow, null)
  if (cwd) return result('none', [], null, `This client sent no MCP roots, and with ${names.cwd} the server's folder can't be used either, so no folder is allowed. Start the client in a project folder, or set ${names.env}`)
  return result('none', [], null, `This client sent no MCP roots, so no folder is allowed. Set ${names.env} to the folders to allow, or ${names.cwd} to use the folder the client starts the server in`)
}

module.exports = { isInside, realDir, profileRefusal, parseRoots, rootsClient, allowedRoots }
