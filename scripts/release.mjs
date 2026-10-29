// Readies a release: one tag for the repo, v<package.json version>, whose GitHub release holds every server's zip and
// catalog.json. By default it only checks and says what it would do; --publish tags, pushes the tag and creates the
// release (git and gh). RELEASING.md has the steps around it.
//   node scripts/release.mjs [--publish] [--previous <catalog.json>]
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as catalog from './catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

function run(cmd, args, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'] })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || String(r.error || '')).trim() }
}
const git = (...args) => run('git', args, { quiet: true })

/** The last release's catalog.json: from --previous, else from GitHub (gh), else null when there is none yet. */
function previousCatalog(repo, file) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'))
  const r = run('gh', ['release', 'download', '--repo', repo, '--pattern', 'catalog.json', '--output', '-'], { quiet: true })
  if (r.ok) return JSON.parse(r.out)
  if (/release not found|no releases|not found/i.test(r.err)) return null
  throw new Error(`can't read the last release's catalog.json with gh (${r.err || 'gh failed'}): pass --previous <file>, or none if there is no release yet`)
}

function main(argv) {
  const publish = argv.includes('--publish')
  const at = argv.indexOf('--previous')
  const previousFile = at >= 0 ? argv[at + 1] : null
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const repo = catalog.githubRepo(pkg)
  const tag = catalog.releaseTag(pkg.version)
  const problems = []

  if (git('status', '--porcelain').out) problems.push('the working tree has changes: commit them first')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out
  if (branch !== 'main') problems.push(`on ${branch}, not main`)
  git('fetch', '--quiet', 'origin', 'main', '--tags')
  if (git('rev-parse', 'HEAD').out !== git('rev-parse', 'origin/main').out) problems.push('HEAD is not origin/main: push main first, so the tag names a commit on GitHub')
  if (git('rev-parse', '--verify', '--quiet', `refs/tags/${tag}`).ok) problems.push(`tag ${tag} already exists: raise "version" in package.json`)

  if (!run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--out', DIST], { quiet: true }).ok) problems.push('npm run pack failed: run it for the reason')
  const file = join(DIST, 'catalog.json')
  const next = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  if (next) {
    problems.push(...catalog.validate(next))
    if (next.release !== tag) problems.push(`catalog.json is for ${next.release}, not ${tag}`)
    const previous = previousCatalog(repo, previousFile)
    if (previous) problems.push(...catalog.compare(previous, next))
    else console.log('No earlier release: nothing to compare versions with.')
    console.log(`${tag}: ${next.servers.map(s => `${s.name} ${s.version}`).join(', ')}`)
  }

  const assets = [...(next?.servers || []).map(s => `dist/${s.name}.zip`), 'dist/catalog.json']
  const steps = [
    ['git', ['tag', '-a', tag, '-m', `hive-mcp ${tag}`]],
    ['git', ['push', 'origin', tag]],
    ['gh', ['release', 'create', tag, '--repo', repo, '--title', `hive-mcp ${tag}`, '--generate-notes', '--verify-tag', ...assets]]
  ]
  if (problems.length) {
    console.error(`Not ready to release ${tag}:\n  ${problems.join('\n  ')}`)
    return 1
  }
  console.log(`Ready to release ${tag}. ${publish ? 'Running' : 'With --publish this runs'}:\n  ${steps.map(([c, a]) => [c, ...a].join(' ')).join('\n  ')}`)
  if (!publish) return 0
  for (const [cmd, args] of steps) {
    console.log(`> ${cmd} ${args.join(' ')}`)
    if (!run(cmd, args).ok) { console.error(`FAILED: ${cmd} ${args[0]}: see RELEASING.md for carrying on from here`); return 1 }
  }
  console.log(`Released ${tag}: https://github.com/${repo}/releases/tag/${tag}`)
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  console.error(`FAILED: ${e.message}`)
  process.exitCode = 1
}
