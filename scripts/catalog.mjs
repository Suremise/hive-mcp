// catalog.json: the list of servers a release offers, each with its zip's URL and sha256, for Combwork's MCP view (or any
// client) to download and check. The format is documented in the README ("The catalogue"); validate() is its reference.
// Each server's entry comes from its own servers/<name>/meta.json plus its packed zip.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCHEMA_VERSION = 1

const OSES = ['windows', 'macos', 'linux']
const EDITIONS = ['Home', 'Pro', 'Enterprise', 'Education']
const NAME = /^[a-z0-9][a-z0-9-]*$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const TAG = /^[a-z0-9][a-z0-9-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_DESCRIPTION = 200

export const sha256 = data => createHash('sha256').update(data).digest('hex')

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = v => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v)
const isHttps = v => typeof v === 'string' && /^https:\/\/[^\s/]+\/\S*$/.test(v)

/** Problems with a server's requires; [] when it is valid. */
function checkRequires(r, at) {
  if (!isObject(r)) return [`${at}: an object`]
  const problems = []
  if (!Array.isArray(r.os) || !r.os.length || r.os.some(o => !OSES.includes(o)) || new Set(r.os).size !== r.os.length) problems.push(`${at}.os: a list of ${OSES.join(', ')}, each once`)
  if (r.windows !== undefined) {
    const w = r.windows
    if (!isObject(w)) problems.push(`${at}.windows: an object`)
    else {
      if (!r.os?.includes?.('windows')) problems.push(`${at}.windows: only with os windows`)
      if (w.editions !== undefined && (!Array.isArray(w.editions) || !w.editions.length || w.editions.some(e => !EDITIONS.includes(e)))) problems.push(`${at}.windows.editions: a list of ${EDITIONS.join(', ')}`)
      if (w.minBuild !== undefined && !(Number.isInteger(w.minBuild) && w.minBuild > 0)) problems.push(`${at}.windows.minBuild: a whole number`)
      if (w.features !== undefined && (!Array.isArray(w.features) || w.features.some(f => !isText(f)))) problems.push(`${at}.windows.features: a list of feature names`)
    }
  }
  if (r.node !== undefined && !(isText(r.node) && /^>=\s*\d+(\.\d+){0,2}$/.test(r.node))) problems.push(`${at}.node: a minimum, as ">=18"`)
  if (r.docker !== undefined && typeof r.docker !== 'boolean') problems.push(`${at}.docker: true or false`)
  if (r.apps !== undefined && (!Array.isArray(r.apps) || r.apps.some(a => !isText(a)))) problems.push(`${at}.apps: a list of one-line texts`)
  return problems
}

/** Problems with a server's own fields (meta.json, or an entry without its name and zip); [] when valid. */
export function checkMeta(m, at = 'meta') {
  if (!isObject(m)) return [`${at}: an object`]
  const problems = []
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) problems.push(`${at}.version: x.y.z`)
  if (!isText(m.description) || m.description.length > MAX_DESCRIPTION) problems.push(`${at}.description: one line, at most ${MAX_DESCRIPTION} characters`)
  if (!Array.isArray(m.tags) || m.tags.some(t => typeof t !== 'string' || !TAG.test(t)) || new Set(m.tags).size !== m.tags.length) problems.push(`${at}.tags: a list of lower-case words (a-z, 0-9, -), each once`)
  problems.push(...checkRequires(m.requires, `${at}.requires`))
  return problems
}

/** Problems with a whole catalogue; [] when it is valid under this schemaVersion. Unknown fields are allowed. */
export function validate(c) {
  if (!isObject(c)) return ['catalog: an object']
  if (c.schemaVersion !== SCHEMA_VERSION) return [`schemaVersion: ${JSON.stringify(c.schemaVersion)} (this reader knows ${SCHEMA_VERSION})`]
  const problems = []
  if (!isText(c.name)) problems.push('name: one line')
  if (c.homepage !== undefined && !isHttps(c.homepage)) problems.push('homepage: an https URL')
  if (!Array.isArray(c.servers)) return [...problems, 'servers: a list']
  const names = new Set()
  c.servers.forEach((s, i) => {
    const at = `servers[${i}]`
    if (!isObject(s)) return problems.push(`${at}: an object`)
    if (typeof s.name !== 'string' || !NAME.test(s.name)) problems.push(`${at}.name: lower-case letters, digits and -`)
    else if (names.has(s.name)) problems.push(`${at}.name: ${s.name} twice`)
    names.add(s.name)
    problems.push(...checkMeta(s, at))
    if (s.homepage !== undefined && !isHttps(s.homepage)) problems.push(`${at}.homepage: an https URL`)
    if (!isObject(s.zip)) problems.push(`${at}.zip: an object`)
    else {
      if (!isHttps(s.zip.url)) problems.push(`${at}.zip.url: an https URL`)
      if (typeof s.zip.sha256 !== 'string' || !SHA256.test(s.zip.sha256)) problems.push(`${at}.zip.sha256: 64 lower-case hex digits`)
      if (!Number.isInteger(s.zip.size) || s.zip.size <= 0) problems.push(`${at}.zip.size: its size in bytes`)
    }
  })
  return problems
}

/** A server's meta.json, checked. */
export function readMeta(serverDir, name) {
  const meta = JSON.parse(readFileSync(join(serverDir, 'meta.json'), 'utf8'))
  const problems = checkMeta(meta, `${name}/meta.json`)
  if (problems.length) throw new Error(problems.join('\n  '))
  return meta
}

/** The GitHub repo ("owner/name") package.json's repository names. */
export function githubRepo(pkg) {
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(\.git)?$/.exec(pkg.repository?.url || pkg.repository || '')
  if (!m) throw new Error(`package.json's repository isn't on GitHub: ${JSON.stringify(pkg.repository)}`)
  return m[1]
}

/** The release tag for a repo version: one tag for the repo, every server's zip in its release. */
export const releaseTag = version => `v${version}`

/** The catalogue for a release: servers is [{ name, meta, zip: Buffer }]. */
export function build({ repo, version, servers }) {
  const tag = releaseTag(version)
  const home = `https://github.com/${repo}`
  return {
    schemaVersion: SCHEMA_VERSION,
    name: repo,
    homepage: home,
    release: tag,
    servers: [...servers].sort((a, b) => (a.name < b.name ? -1 : 1)).map(({ name, meta, zip }) => ({
      name,
      version: meta.version,
      description: meta.description,
      tags: meta.tags,
      requires: meta.requires,
      homepage: `${home}/tree/${tag}/servers/${name}`,
      zip: { url: `${home}/releases/download/${tag}/${name}.zip`, sha256: sha256(zip), size: zip.length }
    }))
  }
}

/** Why next can't follow previous (the last release's catalogue): a server whose zip changed but not its version, or
 * whose version went down. [] when it can. */
export function compare(previous, next) {
  const problems = []
  const older = new Map((previous?.servers || []).map(s => [s.name, s]))
  const parse = v => v.split('.').map(Number)
  const below = (a, b) => { const [x, y] = [parse(a), parse(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false }
  for (const s of next.servers) {
    const old = older.get(s.name)
    if (!old) continue
    if (below(s.version, old.version)) problems.push(`${s.name}: version ${s.version} is below the last release's ${old.version}`)
    else if (s.version === old.version && s.zip.sha256 !== old.zip.sha256) problems.push(`${s.name}: its zip changed but its version is still ${s.version}: raise it in servers/${s.name}/meta.json`)
  }
  return problems
}
