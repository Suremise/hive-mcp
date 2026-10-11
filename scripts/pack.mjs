// Packs each server as dist/<name>.zip in the layout Hive's Add MCP Server from File takes: one top folder
// named after the server, holding its definition (hive-mcp.json, else hive-mcp.example.json) and the files it runs.
// Dev-only files (probes, tests) stay out. Each zip is then checked against Hive's rules. Built-ins and Windows' tar.exe.
//   node scripts/pack.mjs [name ...]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

/** What each zip holds: [from, to] relative to the server's folder (or the repo, for LICENSE). */
const SERVERS = {
  // Its example needs no edits (defaults for a local Ollama), so it goes in as Hive's own definition.
  ollama: [['server.js'], ['roots.js'], ['README.md'], ['hive-mcp.example.json', 'hive-mcp.json']],
  // It goes in as the example, to be checked before it is turned on: it maps folders into the Sandbox (WSB_TOOL_DIRS).
  'windows-sandbox': [
    ['server.js'], ['wsb.js'], ['confine.js'], ['watchdog.js'], ['roots.js'], ['client.js'], ['inside'], ['scenarios'],
    ['README.md'], ['RELEASE-TESTING.md'], ['hive-mcp.example.json']
  ]
}
const DEFINITIONS = ['hive-mcp.json', 'hive-mcp.example.json']
const MAX_FILES = 5000
const MAX_BYTES = 200 * 1024 * 1024

/** The zip's central directory: each entry's name, whether it is a link (made on Unix, mode 0o120000), and its size. */
function entries(data) {
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) if (data.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('no central directory')
  const out = []
  for (let n = 0, at = data.readUInt32LE(end + 16); n < data.readUInt16LE(end + 10); n++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory')
    const nameLength = data.readUInt16LE(at + 28)
    out.push({
      name: data.toString('utf8', at + 46, at + 46 + nameLength),
      link: data[at + 5] === 3 && ((data.readUInt32LE(at + 38) >>> 16) & 0o170000) === 0o120000,
      size: data.readUInt32LE(at + 24)
    })
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32)
  }
  return out
}

const unsafePart = p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)

/** Problems with a server zip under Hive's rules; [] when Hive would add it as `name`. */
function check(zip, name) {
  const all = entries(readFileSync(zip))
  const files = all.filter(e => !e.name.replace(/\\/g, '/').endsWith('/'))
  const problems = []
  for (const e of all) if (e.link) problems.push(`link: ${e.name}`)
  if (files.length > MAX_FILES) problems.push(`${files.length} files (max ${MAX_FILES})`)
  if (files.reduce((t, e) => t + e.size, 0) > MAX_BYTES) problems.push('over 200 MB unpacked')
  for (const e of files) {
    const rel = e.name.replace(/\\/g, '/')
    if (/^[a-z]:|^\//i.test(rel) || rel.split('/').some(unsafePart)) problems.push(`unsafe path: ${e.name}`)
  }
  const tops = new Set(files.map(e => e.name.split('/')[0]))
  if (tops.size !== 1 || !tops.has(name)) problems.push(`top folders: ${[...tops].join(', ')} (want only ${name})`)
  const defs = DEFINITIONS.filter(d => files.some(e => e.name === `${name}/${d}`))
  if (defs.length !== 1) problems.push(`definitions: ${defs.join(', ') || 'none'} (want exactly one)`)
  if (files.some(e => DEFINITIONS.includes(e.name))) problems.push('a definition at the top level would win over the folder')
  if (files.some(e => /(^|\/)(probes|test)\//.test(e.name))) problems.push('dev-only files (probes/ or test/)')
  return { problems, files, def: defs[0] }
}

/** The definition's `${HIVE_MCP_DIR}/<name>/…` references, each checked to name a file in the zip. */
function references(def, name, files) {
  const refs = [def.command, def.cwd, ...(def.args || []), ...Object.values(def.env || {})].filter(v => typeof v === 'string' && v.includes('${HIVE_MCP_DIR}'))
  const problems = []
  if (!refs.length) problems.push('the definition never refers to ${HIVE_MCP_DIR}/' + name)
  for (const r of refs) {
    const m = /^\$\{HIVE_MCP_DIR\}[\\/]([^\\/]+)[\\/](.+)$/.exec(r)
    if (!m || m[1] !== name) problems.push(`reference outside ${name}/: ${r}`)
    else if (!files.some(e => e.name === `${name}/${m[2].replace(/\\/g, '/')}`)) problems.push(`reference to a file not in the zip: ${r}`)
  }
  return { refs, problems }
}

/** Each staged script's relative require('./…') must name a file in the zip, so a shared module can't be left out. */
function localRequires(dir, name, files) {
  const inZip = new Set(files.map(e => e.name.replace(/\\/g, '/').toLowerCase()))
  const problems = []
  for (const e of files) {
    if (!/\.(c?js|mjs)$/i.test(e.name)) continue
    const rel = e.name.slice(name.length + 1)
    for (const m of readFileSync(join(dir, rel), 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(e.name.replace(/\\/g, '/')), m[1]))
      if (![target, `${target}.js`, `${target}/index.js`].some(t => inZip.has(t.toLowerCase()))) problems.push(`${e.name} requires ${m[1]}, which isn't in the zip`)
    }
  }
  return problems
}

function pack(name) {
  const src = join(ROOT, 'servers', name)
  const stage = join(DIST, '.stage')
  rmSync(stage, { recursive: true, force: true })
  try {
    for (const [from, to = from] of SERVERS[name]) cpSync(join(src, from), join(stage, name, to), { recursive: true })
    cpSync(join(ROOT, 'LICENSE'), join(stage, name, 'LICENSE'))
    const zip = join(DIST, `${name}.zip`)
    rmSync(zip, { force: true })
    const r = spawnSync(TAR, ['-a', '-c', '-f', zip, '-C', stage, name], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`tar.exe failed (${r.status}): ${r.stderr || r.error}`)
    const c = check(zip, name)
    const def = JSON.parse(readFileSync(join(stage, name, c.def), 'utf8'))
    const ref = references(def, name, c.files)
    const problems = [...c.problems, ...ref.problems, ...localRequires(join(stage, name), name, c.files)]
    console.log(`${zip}\n  ${c.files.length} files, definition ${name}/${c.def}, refers to ${ref.refs.join(', ')}`)
    for (const e of c.files) console.log(`    ${e.name}`)
    if (problems.length) throw new Error(`${name}.zip is not in Hive's layout:\n  ${problems.join('\n  ')}`)
    return zip
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const names = process.argv.slice(2)
for (const n of names) if (!SERVERS[n]) { console.error(`Unknown server: ${n} (known: ${Object.keys(SERVERS).join(', ')})`); process.exit(2) }
if (!existsSync(TAR)) { console.error(`Windows' tar.exe not found at ${TAR}`); process.exit(2) }
mkdirSync(DIST, { recursive: true })
try {
  for (const n of names.length ? names : Object.keys(SERVERS)) pack(n)
  console.log('OK: each zip is in the layout Add MCP Server from File takes.')
} catch (e) {
  console.error(`FAILED: ${e.message}`)
  process.exit(1)
}
