// Packs each server as dist/<name>.zip in the layout Hive's Add MCP Server from File takes: one top folder
// named after the server, holding its definition (hive-mcp.json, else hive-mcp.example.json) and the files it runs.
// Dev-only files (probes, tests) stay out. Each zip is then checked against Hive's rules, and, when every server is
// packed, dist/catalog.json lists them for a release (catalog.mjs). The zips are reproducible: the same files give the
// same bytes (zip.mjs). Node built-ins only.
//   node scripts/pack.mjs [--out <dir>] [name ...]
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zip } from './zip.mjs'
import * as catalog from './catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What each zip holds: [from, to] relative to the server's folder (or the repo, for LICENSE). */
const SERVERS = {
  // Its example needs no edits (defaults for a local Ollama), so it goes in as Hive's own definition.
  ollama: [['server.js'], ['roots.js'], ['README.md'], ['hive-mcp.example.json', 'hive-mcp.json']],
  // It goes in as the example, to be checked before it is turned on: it maps folders into the Sandbox (WSB_TOOL_DIRS).
  'windows-sandbox': [
    ['server.js'], ['wsb.js'], ['confine.js'], ['watchdog.js'], ['roots.js'], ['client.js'], ['inside'], ['scenarios'],
    ['README.md'], ['RELEASE-TESTING.md'], ['hive-mcp.example.json']
  ],
  // It goes in as the example, to be checked before it is turned on: TRILIUM_URL is the user's own Trilium.
  trilium: [['server.js'], ['README.md'], ['hive-mcp.example.json']]
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
function check(data, name) {
  const all = entries(data)
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

/** Each packed script's relative require('./…') must name a file in the zip, so a shared module can't be left out. */
function localRequires(packed) {
  const inZip = new Set(packed.map(f => f.name.toLowerCase()))
  const problems = []
  for (const f of packed) {
    if (!/\.(c?js|mjs)$/i.test(f.name)) continue
    for (const m of f.data.toString('utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(f.name), m[1]))
      if (![target, `${target}.js`, `${target}/index.js`].some(t => inZip.has(t.toLowerCase()))) problems.push(`${f.name} requires ${m[1]}, which isn't in the zip`)
    }
  }
  return problems
}

/** Text files holding a CR: the repo stores LF (.gitattributes), so the installed copy would differ from the published
 * file by its line endings. A file with a NUL byte is binary and isn't checked, as git decides. */
function crlfFiles(packed) {
  return packed.filter(f => !f.data.includes(0) && f.data.includes(13)).map(f => `CR line endings (the repo's copy is LF): ${f.name}`)
}

/** The files under path (itself, if a file), as [{ name: '<under>/<relative>', data }], in name order. */
function collect(path, under) {
  if (!statSync(path).isDirectory()) return [{ name: under, data: readFileSync(path) }]
  return readdirSync(path).sort().flatMap(n => collect(join(path, n), `${under}/${n}`))
}

/** Packs a server into out/<name>.zip, checked; returns the zip's bytes. */
function pack(name, out) {
  const src = join(ROOT, 'servers', name)
  const packed = [
    ...SERVERS[name].flatMap(([from, to = from]) => collect(join(src, from), `${name}/${to}`)),
    { name: `${name}/LICENSE`, data: readFileSync(join(ROOT, 'LICENSE')) }
  ]
  const data = zip(packed)
  const file = join(out, `${name}.zip`)
  rmSync(file, { force: true })
  const c = check(data, name)
  const def = JSON.parse(packed.find(f => f.name === `${name}/${c.def}`)?.data ?? '{}')
  const ref = references(def, name, c.files)
  const problems = [...c.problems, ...ref.problems, ...localRequires(packed), ...crlfFiles(packed)]
  console.log(`${file}\n  ${c.files.length} files, definition ${name}/${c.def}, refers to ${ref.refs.join(', ')}`)
  for (const e of c.files) console.log(`    ${e.name}`)
  if (problems.length) throw new Error(`${name}.zip is not in Hive's layout:\n  ${problems.join('\n  ')}`)
  writeFileSync(file, data)
  return data
}

function main(argv) {
  let out = join(ROOT, 'dist')
  const names = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] ?? '')
    else names.push(argv[i])
  }
  for (const n of names) if (!SERVERS[n]) { console.error(`Unknown server: ${n} (known: ${Object.keys(SERVERS).join(', ')})`); return 2 }
  mkdirSync(out, { recursive: true })
  const catalogFile = join(out, 'catalog.json')
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const servers = (names.length ? names : Object.keys(SERVERS)).map(name => {
      const meta = catalog.readMeta(join(ROOT, 'servers', name), name)
      return { name, meta, zip: pack(name, out) }
    })
    console.log('OK: each zip is in the layout Add MCP Server from File takes.')
    if (names.length) {
      rmSync(catalogFile, { force: true }) // it would no longer match the zips beside it
      console.log('No catalog.json: it is made only when every server is packed.')
      return 0
    }
    const c = catalog.build({ repo: catalog.githubRepo(pkg), version: pkg.version, servers })
    const problems = catalog.validate(c)
    if (problems.length) throw new Error(`catalog.json isn't valid:\n  ${problems.join('\n  ')}`)
    writeFileSync(catalogFile, JSON.stringify(c, null, 2) + '\n')
    console.log(`${catalogFile}\n  release ${c.release}: ${c.servers.map(s => `${s.name} ${s.version}`).join(', ')}`)
    return 0
  } catch (e) {
    rmSync(catalogFile, { force: true })
    console.error(`FAILED: ${e.message}`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
