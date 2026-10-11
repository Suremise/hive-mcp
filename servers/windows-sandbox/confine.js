/**
 * Confined host reads from a run's out folder. Everything there was written by the guest, so it is untrusted: a careless
 * read could follow a link the guest made and read host files. Path checks alone can't be trusted while the guest runs,
 * because it can swap a folder for a junction between one check and the next. So there are two kinds
 * of read:
 *
 * - **Live** (`readLive`, while the Sandbox runs): only files directly in the out root, never in a subfolder. The root
 *   can't be swapped: it is the share's root, and the server keeps a file in it open exclusively for the whole run, so
 *   it is never empty and can't become a junction. The file is opened exclusively (share mode 0, so nothing can rename,
 *   replace or delete it while it is open), and only then checked: the root's entry of that name must be a plain file
 *   (not a link or reparse point), with the same file id as the open handle and a single hard link. That pins what was
 *   read to an object that sits in the root, whatever the guest did before or after.
 * - **Stopped** (`readFile`, `listOut`, after `wsb list` confirmed the Sandbox gone): nested paths too. Nothing changes
 *   the folder any more, so the walk's checks hold: every component is checked as a directory entry (links and other
 *   reparse points skipped and reported, never followed), the realpath must stay inside out, and the opened file must be
 *   the one checked, with a single hard link.
 *
 * Both refuse absolute, drive, UNC and device paths, `..`, `:` streams and device names before touching the disk, and
 * cap bytes while reading (never read whole and cut).
 */
const fs = require('fs')
const { join, sep } = require('path')

const LIST_MAX_FILES = 1000
const LIST_MAX_ENTRIES = 10_000
const LIST_MAX_DEPTH = 16
// libuv's UV_FS_O_EXLOCK (Windows): open with share mode 0. Node doesn't export it; libuv honours it.
const EXLOCK = 0x10000000
const PIN_NAME = '.wsb-mcp-pin'
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i

/** Splits a guest-relative path or glob into segments, or throws why it is refused. Touches no disk. */
function segments(p, { glob = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('empty path')
  if (p.length > 400) throw new Error('path too long')
  if (/[\0-\x1f]/.test(p)) throw new Error('control characters in path')
  if (/^[\\/]/.test(p)) throw new Error('absolute, UNC or device path (paths are relative to the out folder)')
  if (/^[a-zA-Z]:/.test(p)) throw new Error('drive path (paths are relative to the out folder)')
  if (p.includes(':')) throw new Error('":" is not allowed (alternate data streams)')
  const parts = p.split(/[\\/]+/).filter(s => s && s !== '.')
  if (!parts.length) throw new Error('empty path')
  for (const s of parts) {
    if (s === '..' || /^\.\.+$/.test(s)) throw new Error('".." is not allowed')
    if (DEVICE_RE.test(s.replace(/[. ]+$/, ''))) throw new Error(`device name "${s}" is not allowed`)
    if (/[. ]$/.test(s) && !(glob && /[*?]$/.test(s))) throw new Error(`"${s}" ends with a dot or space`)
    if (/["<>|]/.test(s)) throw new Error(`"${s}" has characters Windows doesn't allow`)
    if (!glob && /[*?]/.test(s)) throw new Error(`"${s}" has wildcards: use glob`)
  }
  return parts
}

const lower = s => (process.platform === 'win32' ? s.toLowerCase() : s)
const inside = (child, parent) => lower(child) === lower(parent) || lower(child).startsWith(lower(parent.endsWith(sep) ? parent : parent + sep))

/** The directory entry `name` in `dir`, matched like the file system does (case-insensitive on Windows), or null. */
function entry(dir, name) {
  const d = fs.opendirSync(dir)
  try {
    for (let n = 0, e; (e = d.readSync()) && n < LIST_MAX_ENTRIES; n++) if (lower(e.name) === lower(name)) return e
    return null
  } finally {
    d.closeSync()
  }
}

/** realpath of the out folder, refusing an out folder that is itself a link. */
function outRoot(outDir) {
  if (fs.lstatSync(outDir).isSymbolicLink()) throw new Error('the out folder is a link')
  return fs.realpathSync.native(outDir)
}

/** Reads up to `max` bytes from an open fd, from the start. Returns { buf, bytesRead }. */
function readCapped(fd, size, max) {
  const cap = Math.max(0, Math.min(max, size))
  const buf = Buffer.alloc(cap)
  let bytesRead = 0
  while (bytesRead < cap) {
    const n = fs.readSync(fd, buf, bytesRead, Math.min(64 * 1024, cap - bytesRead), bytesRead)
    if (!n) break
    bytesRead += n
  }
  return { buf: buf.subarray(0, bytesRead), bytesRead }
}

// Test hooks: called between the steps of readLive, so tests can change the folder at exactly those points.
const hooks = { beforeOpen: null, afterOpen: null }

/**
 * Live read, while the guest runs: a file directly in the out root only. Returns
 * { path, size, bytesRead, truncated, buf } or { path, error }.
 */
function readLive(outReal, name, maxBytes) {
  let fd
  try {
    const parts = segments(name)
    if (parts.length !== 1) throw new Error('only files directly in the out folder can be read while the Sandbox runs: collect folders after sandbox_stop')
    if (lower(parts[0]) === PIN_NAME) throw new Error('not found')
    const full = join(outReal, parts[0])
    hooks.beforeOpen?.(full)
    try {
      fd = fs.openSync(full, fs.constants.O_RDONLY | EXLOCK)
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('not found')
      if (e.code === 'EBUSY') throw new Error('in use inside the Sandbox: try again')
      throw e
    }
    hooks.afterOpen?.(full)
    const f = fs.fstatSync(fd, { bigint: true })
    const l = fs.lstatSync(full, { bigint: true })
    const e = entry(outReal, parts[0])
    if (l.isSymbolicLink() || !e || e.isSymbolicLink()) throw new Error(`skipped: "${parts[0]}" is a link or reparse point (not followed)`)
    if (!f.isFile() || !l.isFile()) throw new Error('skipped: not a regular file')
    if (f.ino !== l.ino || f.dev !== l.dev) throw new Error('skipped: the file changed while it was being opened')
    if (f.nlink !== 1n) throw new Error('skipped: the file has other hard links')
    const size = Number(f.size)
    const { buf, bytesRead } = readCapped(fd, size, maxBytes)
    return { path: name, size, bytesRead, truncated: size > bytesRead, buf }
  } catch (e) {
    return { path: name, error: e.message }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Creates and holds open, exclusively, a file in the out root for the whole run, so the root is never empty and so can't
 * be turned into a junction. Call before the Sandbox starts; returns the fd (close it after a confirmed stop).
 */
function pinRoot(outDir) {
  return fs.openSync(join(outDir, PIN_NAME), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | EXLOCK)
}

/**
 * Stopped read: resolves a guest-relative path to a checked regular file. Only for a Sandbox confirmed stopped.
 * Returns { full, stat } or throws with the reason (refused, not found, link skipped, outside out).
 */
function resolveFile(outReal, rel) {
  const parts = segments(rel)
  let dir = outReal
  for (const [i, name] of parts.entries()) {
    const e = entry(dir, name)
    if (!e) throw new Error('not found')
    if (e.isSymbolicLink()) throw new Error(`skipped: "${parts.slice(0, i + 1).join('/')}" is a link or reparse point (not followed)`)
    const last = i === parts.length - 1
    if (last ? !e.isFile() : !e.isDirectory()) throw new Error(last ? 'not a regular file' : 'not found')
    dir = join(dir, e.name)
  }
  const st = fs.lstatSync(dir, { bigint: true })
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('skipped: not a regular file')
  if (!inside(fs.realpathSync.native(dir), outReal)) throw new Error('skipped: resolves outside the out folder')
  return { full: dir, stat: st }
}

/**
 * Stopped read of at most `maxBytes` of a guest-relative file, capped while reading. Only for a Sandbox confirmed
 * stopped. Returns { path, size, bytesRead, truncated, buf } or { path, error }.
 */
function readFile(outReal, rel, maxBytes) {
  let fd
  try {
    const { full, stat } = resolveFile(outReal, rel)
    fd = fs.openSync(full, 'r')
    const f = fs.fstatSync(fd, { bigint: true })
    if (!f.isFile() || f.ino !== stat.ino || f.dev !== stat.dev) throw new Error('skipped: the file changed while it was being checked')
    if (f.nlink !== 1n) throw new Error('skipped: the file has other hard links')
    const size = Number(f.size)
    const { buf, bytesRead } = readCapped(fd, size, maxBytes)
    return { path: rel, size, bytesRead, truncated: size > bytesRead, buf }
  } catch (e) {
    return { path: rel, error: e.code === 'ENOENT' ? 'not found' : e.message }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Lists regular files under out (paths with "/"), without following links. `depth: 0` lists only the root (safe while
 * the Sandbox runs: the root can't be swapped); deeper listings only for a Sandbox confirmed stopped.
 * Returns { files, folders, skipped, truncated }.
 */
function listOut(outReal, { maxFiles = LIST_MAX_FILES, depth = LIST_MAX_DEPTH } = {}) {
  const files = []
  const folders = []
  const skipped = []
  let entries = 0
  let truncated = false
  const walk = (dir, rel, level) => {
    const d = fs.opendirSync(dir)
    try {
      for (let e; (e = d.readSync());) {
        if (++entries > LIST_MAX_ENTRIES || files.length >= maxFiles) { truncated = true; return }
        const r = rel ? `${rel}/${e.name}` : e.name
        if (!rel && lower(e.name) === PIN_NAME) continue
        if (e.isSymbolicLink()) skipped.push({ path: r, reason: 'link or reparse point, not followed' })
        else if (e.isDirectory()) level < depth ? walk(join(dir, e.name), r, level + 1) : folders.push(r)
        else if (e.isFile()) files.push(r)
        else skipped.push({ path: r, reason: 'not a regular file' })
      }
    } finally {
      d.closeSync()
    }
  }
  walk(outReal, '', 0)
  return { files, folders, skipped, truncated }
}

/** A matcher for a glob against listed paths: `*` and `?` within a segment, `**` across segments. Case-insensitive. */
function globMatcher(glob) {
  const parts = segments(glob, { glob: true })
  const re = parts
    .map((s, i) => {
      const last = i === parts.length - 1
      if (s === '**') return last ? '.*' : '(?:[^/]+/)*'
      return s.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/')
    })
    .join('')
  const rx = new RegExp(`^${re}$`, 'i')
  const fn = p => rx.test(p)
  fn.depth = parts.length
  fn.deep = parts.includes('**')
  return fn
}

/** A guest-written PID: a positive integer in a sane range, else null. */
function parsePid(text) {
  const t = String(text ?? '').trim()
  if (!/^\d{1,10}$/.test(t)) return null
  const n = Number(t)
  return n > 4 && n <= 0xffffffff ? n : null
}

module.exports = { segments, outRoot, readLive, pinRoot, resolveFile, readFile, listOut, globMatcher, parsePid, inside, hooks, PIN_NAME, LIST_MAX_FILES }
