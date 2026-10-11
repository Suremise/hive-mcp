// No tracked text file has mixed line endings in the working tree (.gitattributes keeps them LF), and the check finds
// a mixed one: proved on a scratch repo, which each test removes after.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.join(__dirname, '..')
const ROOT = process.env.EOL_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'line-endings-tests')

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.error}`)
  return r.stdout
}

/** The kinds of line ending in data ('crlf', 'lf', 'cr'), each once. */
function endings(data) {
  const kinds = new Set()
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0d) { if (data[i + 1] === 0x0a) { kinds.add('crlf'); i++ } else kinds.add('cr') } else if (data[i] === 0x0a) kinds.add('lf')
  }
  return [...kinds]
}

/** The tracked text files in repo's working tree with more than one kind of line ending, as "path (crlf, lf)". */
function mixedFiles(repo) {
  const out = []
  for (const entry of git(repo, 'ls-files', '-z', '--eol').split('\0').filter(Boolean)) {
    const [info, file] = entry.split('\t')
    if (/[\s/]-text\b/.test(info)) continue // binary: git saw it as binary (i/-text) or .gitattributes says so (attr/-text)
    let data
    try { data = fs.readFileSync(path.join(repo, file)) } catch (e) { if (e.code === 'ENOENT') continue; throw e } // deleted, not yet committed
    const kinds = endings(data)
    if (kinds.length > 1) out.push(`${file} (${kinds.sort().join(', ')})`)
  }
  return out
}

test('endings: each kind once, a lone CR counts', () => {
  assert.deepStrictEqual(endings(Buffer.from('a\nb\n')), ['lf'])
  assert.deepStrictEqual(endings(Buffer.from('a\r\nb\r\n')), ['crlf'])
  assert.deepStrictEqual(endings(Buffer.from('a\r\nb\nc\rd')).sort(), ['cr', 'crlf', 'lf'])
  assert.deepStrictEqual(endings(Buffer.from('no ending')), [])
})

test('no tracked text file has mixed line endings', t => {
  if (spawnSync('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree']).status !== 0) return t.skip('not a git checkout')
  const mixed = mixedFiles(REPO)
  assert.deepStrictEqual(mixed, [], `mixed line endings (make each file LF):\n  ${mixed.join('\n  ')}`)
})

test('the check lists a mixed file, and not an LF, a CRLF, a binary or an untracked one', t => {
  const dir = path.join(ROOT, `${process.pid}-mixed`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q')
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(dir, '.gitattributes'))
  fs.writeFileSync(path.join(dir, 'lf.js'), 'a\nb\n')
  fs.writeFileSync(path.join(dir, 'crlf.md'), 'a\r\nb\r\n')
  fs.writeFileSync(path.join(dir, 'mixed.js'), 'a\r\nb\nc\r\n')
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0a]))
  git(dir, '-c', 'core.safecrlf=false', 'add', '.')
  fs.writeFileSync(path.join(dir, 'untracked.js'), 'a\r\nb\n')
  assert.deepStrictEqual(mixedFiles(dir), ['mixed.js (crlf, lf)'])
})
