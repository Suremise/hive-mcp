// The fresh-install comparison: what it reports, that it compares real name sets, that it claims
// only what was measured, and that it reads names only.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { inventory, compare, markdown, setDiff, evidenceProblems } = require('../scenarios/compare-workspace')
const { REQUIRED } = require('../scenarios/report')
const { scratch } = require('./helpers')

const CLI = path.join(__dirname, '..', 'scenarios', 'compare-workspace.js')

function workspace(dir, { personas = ['planner'], skills = ['handover', 'my-own'] } = {}) {
  const h = path.join(dir, '.hive')
  for (const d of ['personas', 'mcp', 'shared/conventions', 'shared/handovers', 'templates', 'tasks', ...skills.map(s => `skills/${s}`)]) fs.mkdirSync(path.join(h, d), { recursive: true })
  fs.writeFileSync(path.join(h, 'bundled.json'), JSON.stringify({ skills: { handover: {} }, personas: { planner: {} } }))
  fs.writeFileSync(path.join(h, 'workspace.json'), JSON.stringify({ mcp: { enabled: ['ollama'] } }))
  for (const p of personas) fs.writeFileSync(path.join(h, 'personas', `${p}.md`), 'SECRET-PERSONA')
  fs.writeFileSync(path.join(h, 'mcp', 'ollama.json'), '{}')
  fs.writeFileSync(path.join(h, 'shared', 'conventions', 'working-with-the-owner.md'), 'SECRET-NOTE')
  fs.writeFileSync(path.join(h, 'shared', 'handovers', 'README.md'), '')
  fs.writeFileSync(path.join(h, 'templates', 'a.json'), '{}')
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(h, 'tasks', `${n}.json`), '{}')
  fs.mkdirSync(path.join(dir, 'app', '.claude', 'skills', 'release-app'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'app', '.agents', 'skills', 'hive-card-loop'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'app', 'CLAUDE.md'), 'SECRET-CONVENTION')
  fs.mkdirSync(path.join(dir, 'plain'))
  return dir
}

const finished = key => ({ completed: true, checks: REQUIRED.fresh.drivers[key].ids.map(id => ({ id, ok: true })) })
/** A complete run's evidence for the comparison; the fresh install has skills handover + other and mode planner. */
const report = () => ({
  meta: { installer: 'Hive-Setup-0.6.0.exe', date: 'd', ran: ['fresh', 'upgrade'] },
  failed: 0,
  files: {
    s1: { ...finished('s1'), facts: { version: '0.6.0', gitMissing: true, banner: 'No coding agents are turned on.\nChoose providers', setupTabs: ['Claude Code\n(off)', 'Codex\n(off)', 'GitHub Copilot\n(off)'] } },
    's1-state': { git: false, node: false },
    s6: { ...finished('s6'), facts: { hive: [{ skills: [{ handover: ['SKILL.md'] }, { 'my-own': ['SKILL.md'] }] }, { personas: ['planner.md'] }, { mcp: [] }, { shared: [{ handovers: ['README.md'] }] }, 'workspace.json'], workspaceJson: { mcp: { enabled: [] } }, projects: [{ name: 'demo' }], views: { Skills: 'SKILLS\nHIVE\n2' } } }
  }
})
const cli = (s, rep, ws) => {
  const dir = path.join(s.dir, 'run')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(rep))
  const r = spawnSync(process.execPath, [CLI, '--report', dir, '--workspace', ws], { encoding: 'utf8' })
  return { code: r.status, err: r.stderr, wrote: fs.existsSync(path.join(dir, 'comparison.md')) }
}

test('the comparison lists what only this workspace has, by name, and reads no note, skill or convention file', () => {
  const s = scratch('compare')
  const ws = workspace(path.join(s.dir, 'ws'))
  const read = []
  const orig = fs.readFileSync
  fs.readFileSync = (p, ...a) => { read.push(String(p)); return orig(p, ...a) }
  let inv
  try { inv = inventory(ws) } finally { fs.readFileSync = orig }
  assert.deepStrictEqual(read.map(p => path.relative(ws, p)).sort(), [path.join('.hive', 'bundled.json'), path.join('.hive', 'workspace.json')])
  assert.deepStrictEqual(inv.customSkills, ['my-own'])
  assert.deepStrictEqual(inv.projects.find(p => p.name === 'app'), { name: 'app', conventionFiles: ['CLAUDE.md'], conventionDirs: ['.claude', '.agents'], ownSkills: ['release-app'] })
  const r = report()
  const c = compare(r, inv)
  const md = markdown(c, r)
  assert.ok(!/SECRET/.test(md + JSON.stringify(c)))
  assert.match(md, /\| Hive skills \| 2: handover, my-own \| 2 \(its own: my-own\) \| same set \|/)
  assert.match(md, /\| Shared notes \| handovers \(0\) \| conventions \(1\), handovers \(0\) \| differs: 0 only in the fresh install, 1 only here \|/)
  assert.match(md, /\| Task board \| 0 cards .* \| 3 cards \|/)
  assert.match(md, /\| Project conventions \| .* \| app: CLAUDE.md, skill release-app \|/)
  assert.match(md, /\| Git \| missing: Hive shows its Git warning/)
  assert.match(md, /\| Node \| missing/)
  assert.match(md, /Agent Setup tabs: Claude Code \(off\), Codex \(off\), GitHub Copilot \(off\)/)
})

test('sets are compared by name: same size with different names differs, a missing mode differs, order alone doesn\'t', () => {
  assert.deepStrictEqual(setDiff(['a', 'b'], ['b', 'a']), { same: true, onlyFresh: [], onlyHere: [] })
  assert.deepStrictEqual(setDiff(['a', 'b'], ['a', 'c']), { same: false, onlyFresh: ['b'], onlyHere: ['c'] })
  const s = scratch('compare-sets')
  // Same number of skills (2) but a different one, and no Assistant modes at all.
  const inv = inventory(workspace(path.join(s.dir, 'ws'), { skills: ['handover', 'totally-different'], personas: [] }))
  const md = markdown(compare(report(), inv), report())
  assert.match(md, /\| Hive skills \| .* \| differs: only in the fresh install: my-own; only here: totally-different \|/)
  assert.match(md, /\| Assistant modes \(personas\) \| 1: planner \| 0: none, all bundled \| differs: only in the fresh install: planner \|/)
})

test('incomplete evidence is refused, never turned into claims (CLI exits 1, writes nothing)', () => {
  const s = scratch('compare-evidence')
  const ws = workspace(path.join(s.dir, 'ws'))
  const cases = {
    'interrupted s6': r => { delete r.files.s6.completed },
    'empty s6': r => { r.files.s6 = {} },
    'no s6': r => { delete r.files.s6 },
    'missing Git fact': r => { delete r.files.s1.facts.gitMissing },
    'missing machine facts': r => { delete r.files['s1-state'] },
    'a required check failed': r => { r.files.s6.checks[1].ok = false }
  }
  for (const [name, spoil] of Object.entries(cases)) {
    const r = report()
    spoil(r)
    assert.ok(evidenceProblems(r).length, name)
    assert.throws(() => compare(r, inventory(ws)), /evidence is incomplete/, name)
    const out = cli(s, r, ws)
    assert.strictEqual(out.code, 1, name)
    assert.match(out.err, /NOT COMPARED: The run's evidence is incomplete/, name)
    assert.ok(!out.wrote, name)
  }
  // Unrelated failures (the upgrade scenario) don't stop it when the fresh evidence is complete.
  const r = report()
  r.failed = 3
  r.files['s4-after'] = {}
  assert.strictEqual(cli(s, r, ws).code, 0)
})

test('a workspace that is missing, not a folder, not a Hive workspace or unreadable is an error, never "none"', () => {
  const s = scratch('compare-workspace')
  const file = path.join(s.dir, 'a-file')
  fs.writeFileSync(file, '')
  const noHive = path.join(s.dir, 'plain-folder')
  fs.mkdirSync(noHive)
  const broken = workspace(path.join(s.dir, 'broken'))
  fs.rmSync(path.join(broken, '.hive', 'skills'), { recursive: true, force: true })
  fs.writeFileSync(path.join(broken, '.hive', 'skills'), '') // a file where a folder must be: readdir fails (ENOTDIR)
  const badJson = workspace(path.join(s.dir, 'badjson'))
  fs.writeFileSync(path.join(badJson, '.hive', 'workspace.json'), '{not json')
  for (const [ws, re] of [[path.join(s.dir, 'nope'), /can't be read: ENOENT/], [file, /is not a folder/], [noHive, /not a Hive workspace/], [broken, /can't read .*skills: ENOTDIR/], [badJson, /isn't valid JSON/]]) {
    assert.throws(() => inventory(ws), re, ws)
    const out = cli(s, report(), ws)
    assert.strictEqual(out.code, 1, ws)
    assert.ok(!out.wrote)
  }
  // A folder that simply doesn't exist yet (no templates) is empty, not an error.
  const ok = workspace(path.join(s.dir, 'ok'))
  fs.rmSync(path.join(ok, '.hive', 'templates'), { recursive: true })
  assert.strictEqual(inventory(ok).templates, 0)
})
