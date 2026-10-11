/**
 * The fresh-install comparison, without a model: what a fresh Hive install shows and makes
 * of a new workspace (scenarios 1, 2 and 6 of a hive-checks run), against an existing workspace on this machine, with
 * its conventions and history. Writes comparison.md and comparison.json next to the run's report.
 *
 *   node scenarios\compare-workspace.js --report <hive-checks report folder> [--workspace <Hive workspace folder>]
 *
 * --workspace defaults to the current folder.
 *
 * It claims only what was measured: the run's first-run and new-workspace evidence must be complete and passing
 * (each driver finished, its required checks passed, its facts present), and the workspace must be a readable Hive
 * workspace; otherwise it writes nothing and exits 1 saying what is missing. A folder that doesn't exist counts as
 * empty; one that can't be read is an error, never "none".
 *
 * Read-only, and names only: it lists what the workspace's .hive and its projects hold (folder and file names, counts,
 * which convention files exist), never a note's, skill's or convention file's contents. It doesn't look in any CLI's
 * home (~/.claude, ~/.codex, ~/.copilot): agent memory lives there and is out of scope (it matters only with a model).
 */
const fs = require('fs')
const path = require('path')
const { REQUIRED } = require('./report')

const CONVENTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json']
const CONVENTION_DIRS = ['.claude', '.agents', '.codex']

// A missing folder or file is empty or absent; any other failure to read it is an error, never "none".
const names = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return []; throw new Error(`can't read ${dir}: ${e.code || e.message}`) } }
const files = (dir, re = /./) => names(dir).filter(e => e.isFile() && re.test(e.name) && !e.name.endsWith('.bak')).map(e => e.name)
const dirs = dir => names(dir).filter(e => e.isDirectory()).map(e => e.name)
const readJson = (p, { optional = false } = {}) => {
  let text
  try { text = fs.readFileSync(p, 'utf8') } catch (e) { if (optional && e.code === 'ENOENT') return null; throw new Error(`can't read ${p}: ${e.code || e.message}`) }
  try { return JSON.parse(text) } catch { throw new Error(`${p} isn't valid JSON`) }
}
const exists = p => { try { fs.lstatSync(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw new Error(`can't check ${p}: ${e.code || e.message}`) } }
const onPath = exe => (process.env.PATH || '').split(';').some(d => d && fs.existsSync(path.join(d, exe)))

/** Two lists of names as sets: { same, onlyFresh, onlyHere }, ignoring order and case. */
function setDiff(fresh, here) {
  const norm = a => [...new Set(a.map(s => String(s).toLowerCase()))].sort()
  const f = norm(fresh)
  const h = norm(here)
  const onlyFresh = f.filter(x => !h.includes(x))
  const onlyHere = h.filter(x => !f.includes(x))
  return { same: !onlyFresh.length && !onlyHere.length, onlyFresh, onlyHere }
}
const describeDiff = d => (d.same ? 'same set' : `differs: ${[d.onlyFresh.length ? `only in the fresh install: ${d.onlyFresh.join(', ')}` : null, d.onlyHere.length ? `only here: ${d.onlyHere.join(', ')}` : null].filter(Boolean).join('; ')}`)

/** What a workspace holds, by name. Throws if it isn't a readable Hive workspace. */
function inventory(ws) {
  let st
  try { st = fs.statSync(ws) } catch (e) { throw new Error(`The workspace ${ws} can't be read: ${e.code || e.message}`) }
  if (!st.isDirectory()) throw new Error(`The workspace ${ws} is not a folder`)
  const h = path.join(ws, '.hive')
  if (!exists(path.join(h, 'workspace.json'))) throw new Error(`${ws} is not a Hive workspace (no .hive\\workspace.json)`)
  const workspaceJson = readJson(path.join(h, 'workspace.json'))
  const bundled = readJson(path.join(h, 'bundled.json'), { optional: true })
  const skills = dirs(path.join(h, 'skills'))
  const personas = files(path.join(h, 'personas'), /\.md$/).map(f => f.replace(/\.md$/, ''))
  const shared = Object.fromEntries(dirs(path.join(h, 'shared')).map(d => [d, files(path.join(h, 'shared', d), /\.md$/).filter(f => f !== 'README.md')]))
  const projects = dirs(ws).filter(d => !d.startsWith('.')).map(name => {
    const p = path.join(ws, name)
    return {
      name,
      conventionFiles: CONVENTION_FILES.filter(f => exists(path.join(p, f))),
      conventionDirs: CONVENTION_DIRS.filter(d => exists(path.join(p, d))),
      ownSkills: [...new Set([...dirs(path.join(p, '.claude', 'skills')), ...dirs(path.join(p, '.agents', 'skills'))])].filter(s => !s.startsWith('hive-'))
    }
  })
  // Where each skill and mode came from (Hive's bundled set, or the workspace's own): separate from the set comparison.
  const origin = (kind, list) => (bundled ? list.filter(s => !bundled[kind]?.[s]) : null)
  return {
    path: ws,
    skills,
    customSkills: origin('skills', skills),
    personas,
    customPersonas: origin('personas', personas),
    templates: files(path.join(h, 'templates'), /\.json$/).length,
    mcpServers: files(path.join(h, 'mcp'), /\.json$/).map(f => f.replace(/\.json$/, '')),
    mcpEnabled: workspaceJson?.mcp?.enabled || [],
    shared,
    cards: files(path.join(h, 'tasks'), /\.json$/).length,
    lanes: exists(path.join(h, 'lanes.json')),
    projects
  }
}

/** What the comparison needs from a run, and whether the run has it: [] when complete, else what is missing. */
function evidenceProblems(report) {
  const f = report?.files || {}
  const problems = []
  for (const key of ['s1', 's6']) {
    const req = REQUIRED.fresh.drivers[key]
    const d = f[key]
    if (!d || typeof d !== 'object') { problems.push(`${key}: no record`); continue }
    if (d.completed !== true) problems.push(`${key}: the driver didn't finish its step`)
    for (const id of req.ids) {
      const c = (d.checks || []).find(x => x.id === id)
      if (!c) problems.push(`${key}: check ${id} didn't run`)
      else if (c.ok !== true) problems.push(`${key}: check ${id} failed`)
    }
  }
  const s1 = f.s1?.facts || {}
  const s6 = f.s6?.facts || {}
  if (typeof s1.gitMissing !== 'boolean') problems.push('s1: fact gitMissing missing')
  if (typeof s1.banner !== 'string') problems.push('s1: fact banner missing')
  if (!Array.isArray(s1.setupTabs)) problems.push('s1: fact setupTabs missing')
  if (!s1.version) problems.push('s1: fact version missing')
  if (!Array.isArray(s6.hive)) problems.push('s6: fact hive (the new workspace\'s .hive) missing')
  if (!s6.views || typeof s6.views !== 'object') problems.push('s6: fact views missing')
  if (!s6.workspaceJson) problems.push('s6: fact workspaceJson missing')
  const st = f['s1-state']
  if (!st || typeof st.git !== 'boolean' || typeof st.node !== 'boolean') problems.push('s1-state: the machine facts (git, node) missing')
  return problems
}

/** The fresh side, from a hive-checks run's collected facts (scenarios 1, 2 and 6). Call after evidenceProblems is []. */
function freshSide(report) {
  const f = report.files
  const s1 = f.s1.facts
  const s6 = f.s6.facts
  const sub = name => {
    const e = s6.hive.find(x => typeof x === 'object' && x && Object.prototype.hasOwnProperty.call(x, name))
    return e && Array.isArray(e[name]) ? e[name] : []
  }
  const shared = Object.fromEntries(sub('shared').filter(x => typeof x === 'object').map(x => { const [k, v] = Object.entries(x)[0]; return [k, (Array.isArray(v) ? v : []).filter(n => n !== 'README.md')] }))
  return {
    version: s1.version,
    skills: sub('skills').map(x => (typeof x === 'object' ? Object.keys(x)[0] : x)),
    personas: sub('personas').filter(x => typeof x === 'string').map(x => x.replace(/\.md$/, '')),
    templates: sub('templates').filter(x => typeof x === 'string' && x.endsWith('.json')).length,
    mcpServers: sub('mcp').filter(x => typeof x === 'string' && x.endsWith('.json')).map(x => x.replace(/\.json$/, '')),
    mcpEnabled: s6.workspaceJson.mcp?.enabled || [],
    shared,
    projects: Array.isArray(s6.projects) ? s6.projects.map(p => p.name) : [],
    banner: s1.banner,
    setupTabs: s1.setupTabs.map(t => String(t).replace(/\s+/g, ' ').trim()),
    gitMissing: s1.gitMissing,
    git: f['s1-state'].git,
    node: f['s1-state'].node,
    views: Object.fromEntries(Object.entries(s6.views).map(([k, v]) => [k, String(v).split('\n').slice(0, 4).join(' · ')]))
  }
}

function compare(report, here) {
  const problems = evidenceProblems(report)
  if (problems.length) throw Object.assign(new Error(`The run's evidence is incomplete, so there is nothing to compare:\n- ${problems.join('\n- ')}`), { problems })
  const fresh = freshSide(report)
  const list = a => (a.length ? a.join(', ') : 'none')
  const notes = shared => Object.entries(shared).map(([k, v]) => `${k} (${v.length})`).join(', ') || 'none'
  const conventionProjects = here.projects.filter(p => p.conventionFiles.length || p.ownSkills.length)
  const origin = custom => (custom === null ? ' (origin unknown: no bundled.json)' : custom.length ? ` (its own: ${list(custom)})` : ', all bundled')
  const skills = setDiff(fresh.skills, here.skills)
  const personas = setDiff(fresh.personas, here.personas)
  const mcp = setDiff(fresh.mcpServers, here.mcpServers)
  const noteNames = shared => Object.entries(shared).flatMap(([k, v]) => v.map(n => `${k}/${n}`))
  const notesDiff = setDiff(noteNames(fresh.shared), noteNames(here.shared))
  const rows = [
    ['Hive skills', `${fresh.skills.length}: ${list(fresh.skills)}`, `${here.skills.length}${origin(here.customSkills)}`, describeDiff(skills)],
    ['Assistant modes (personas)', `${fresh.personas.length}: ${list(fresh.personas)}`, `${here.personas.length}: ${list(here.personas)}${origin(here.customPersonas)}`, describeDiff(personas)],
    ['Templates', String(fresh.templates), String(here.templates), here.templates === fresh.templates ? 'same number' : 'differs'],
    ['Workspace MCP servers', `${list(fresh.mcpServers)}; enabled: ${list(fresh.mcpEnabled)}`, `${list(here.mcpServers)}; enabled: ${list(here.mcpEnabled)}`, describeDiff(mcp)],
    ['Shared notes', notes(fresh.shared), notes(here.shared), notesDiff.same ? 'same set' : `differs: ${notesDiff.onlyFresh.length} only in the fresh install, ${notesDiff.onlyHere.length} only here`],
    ['Task board', '0 cards (a new workspace)', `${here.cards} cards${here.lanes ? ', card-loop lanes' : ''}`, here.cards ? 'only here' : 'same'],
    ['Project conventions', 'none (a new project folder)', conventionProjects.map(p => `${p.name}: ${list([...p.conventionFiles, ...p.ownSkills.map(s => `skill ${s}`)])}`).join('; ') || 'none', conventionProjects.length ? 'only here' : 'same'],
    ['Agent memory', 'none', 'in each CLI\'s home (~/.claude/projects/…), not read here by rule', 'not compared (needs a model)']
  ]
  const env = [
    ['Git', fresh.git ? 'found' : `missing${fresh.gitMissing ? ': Hive shows its Git warning (status bar "Git", Agent Setup "Git not found")' : ''}`, onPath('git.exe') ? 'on PATH' : 'not on PATH'],
    ['Node', fresh.node ? 'found' : 'missing (the checks map the host\'s, read-only)', onPath('node.exe') ? 'on PATH' : 'not on PATH'],
    ['Coding-agent CLIs', `banner: "${fresh.banner.replace(/\s+/g, ' ')}"; Agent Setup tabs: ${list(fresh.setupTabs)}`, ['claude', 'codex', 'copilot'].filter(c => ['.exe', '.cmd'].some(x => onPath(c + x))).join(', ') || 'none on PATH']
  ]
  return { fresh, here, rows, env }
}

function markdown(c, report) {
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  const m = report.meta || {}
  return [
    '# Fresh install vs this workspace (no model)',
    '',
    `Fresh side: Hive ${c.fresh.version} (\`${m.installer || '?'}\`${m.buildInfo ? `, code ${m.buildInfo.code}` : ''}) installed in Windows Sandbox, network off, fake CLIs only, a new workspace with one project folder (scenarios 1, 2 and 6 of the Sandbox checks, ${m.date || ''}). This side: \`${c.here.path}\`, by name only (no note, skill or convention file was read, and no CLI home).`,
    '',
    '## What a workspace has',
    '',
    '| | Fresh install, new workspace | This workspace | |',
    '|---|---|---|---|',
    ...c.rows.map(r => `| ${r.map(esc).join(' | ')} |`),
    '',
    '## The machine',
    '',
    '| | Fresh install (Sandbox) | This machine |',
    '|---|---|---|',
    ...c.env.map(r => `| ${r.map(esc).join(' | ')} |`),
    '',
    '## What a fresh workspace shows',
    '',
    ...Object.entries(c.fresh.views).map(([k, v]) => `- **${k}:** ${esc(v)}`),
    '',
    '## Out of scope without a model',
    '',
    '- Anything that needs an Assistant or agent turn: how the conventions, shared notes and memory change what agents do, and the first Assistant conversation.',
    '- Real CLI installs and sign-ins: they stay with the host\'s real-tier tests.',
    ''
  ].join('\n')
}

function main(argv) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }
  const dir = opt('--report')
  if (!dir) throw new Error('--report <hive-checks report folder> is required')
  const report = readJson(path.join(dir, 'report.json'))
  const c = compare(report, inventory(path.resolve(opt('--workspace', process.cwd()))))
  fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify(c, null, 2))
  fs.writeFileSync(path.join(dir, 'comparison.md'), markdown(c, report))
  console.log(path.join(dir, 'comparison.md'))
}

if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(`NOT COMPARED: ${e.message}`); process.exitCode = 1 }
}
module.exports = { inventory, freshSide, compare, markdown, setDiff, evidenceProblems }
