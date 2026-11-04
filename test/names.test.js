// MC-1485: the repo is combwork-mcp and the app is Combwork (it was Hive Desktop). What still says Hive is only what the
// app reads under that name (a zip's definition names, ${HIVE_MCP_DIR}, the workspace's .hive folder) and the old
// scratch folders, named so users can find and delete them. .agents and .hive are the app's own copies, not this repo's.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO = path.join(__dirname, '..')
const KEPT = [
  /HIVE_MCP_DIR/g, // the app's variable for its MCP servers' folder, as ${HIVE_MCP_DIR} or a regex for it
  /\bhive-mcp(\.example)?\.json\b/g, // the definition names the app reads in a zip (MCP_ZIP_DEFINITIONS)
  /(^|[\s`'"(/\\])\.hive\b/g, // the workspace folder the app keeps its MCP servers in
  /\bhive-test\b/g, /\bhive-mcp-tests\b/g, // earlier scratch folders, left for users to delete
  /\bHive Desktop\b/g, /\bHive name\b/g, // the app's old name, where a file says it was renamed
  /archive/gi // not a name
]

test('no tracked file names Hive or hive-mcp, except the names the app still reads', () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
  assert.strictEqual(r.status, 0, r.stderr)
  const bad = []
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    if (/^\.(agents|hive)\//.test(f) || f === 'test/names.test.js') continue
    if (/hive/i.test(f)) bad.push(`${f}: its name`)
    const file = path.join(REPO, f)
    if (!fs.existsSync(file)) continue
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/hive/i.test(KEPT.reduce((l, re) => l.replace(re, ''), line))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`)
    })
  }
  assert.deepStrictEqual(bad, [])
})
