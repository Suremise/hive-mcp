// server.js over stdio against a fake Ollama: which files reach the model (only inside the client's MCP roots, never
// the profile's dot-folders or app data), how paths resolve, the fallbacks for clients without roots, and that the
// existing reading behaviour (folders, skips, binaries, size limits, line numbers) is unchanged.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { createInterface } = require('readline')
const { pathToFileURL } = require('url')

const SERVER = path.join(__dirname, '..', 'server.js')
const BASE = process.env.OLLAMA_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-test', 'scratch', 'ollama-tests')

/** A fake Ollama: /api/tags lists one model; /api/chat answers with the prompt it was sent, so tests see the files. */
let ollama
let host
test.before(async () => {
  ollama = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake:1b', size: 1e9, details: { parameter_size: '1B' } }] }))
      if (req.url === '/api/chat') {
        const m = JSON.parse(body)
        return res.end(JSON.stringify({ message: { content: m.messages.at(-1).content }, prompt_eval_count: 1, eval_count: 1, total_duration: 1e6 }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(r => ollama.listen(0, '127.0.0.1', r))
  host = `http://127.0.0.1:${ollama.address().port}`
})
test.after(() => ollama.close())

let seq = 0
/** A fake profile (home, with .ssh and AppData), two projects (a, b), a folder outside, links out of a. */
function scratch(name) {
  const dir = path.join(BASE, `${process.pid}-${++seq}-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  const w = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t) }
  w('home/.ssh/id_ed25519', 'SECRET-KEY')
  w('home/AppData/Local/app/token.txt', 'SECRET-TOKEN')
  w('home/AppData/Roaming/app/auth.json', 'SECRET-AUTH')
  w('home/notes.txt', 'SECRET-HOME')
  w('outside/secret.txt', 'SECRET-OUTSIDE')
  w('a/src/main.js', 'console.log("A-MAIN")\nsecond line')
  w('a/src/util.js', 'A-UTIL')
  w('a/README.md', 'A-README')
  w('a/node_modules/dep/index.js', 'A-DEP')
  w('a/.git/config', 'A-GITCONFIG')
  w('a/.env', 'A-DOTENV')
  w('a/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  w('a/big.log', 'x'.repeat(2 * 1024 * 1024 + 1))
  w('b/only-b.txt', 'B-ONLY')
  w('b/src/main.js', 'B-MAIN')
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'a', 'escape'), 'junction')
  fs.symlinkSync(path.join(dir, 'home', '.ssh'), path.join(dir, 'a', 'keys'), 'junction')
  const env = {
    ...process.env,
    OLLAMA_HOST: host,
    OLLAMA_DEFAULT_MODEL: '',
    OLLAMA_ALLOWED_ROOTS: '',
    OLLAMA_ROOTS_FROM_CWD: '',
    USERPROFILE: path.join(dir, 'home'),
    HOME: path.join(dir, 'home'),
    APPDATA: path.join(dir, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(dir, 'home', 'AppData', 'Local')
  }
  return { dir, env, a: path.join(dir, 'a'), b: path.join(dir, 'b'), home: path.join(dir, 'home') }
}

/** Starts server.js as a client would: initialize (declaring roots when given), then calls. */
function server(env, { roots, cwd } = {}) {
  const child = spawn(process.execPath, [SERVER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const write = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  const pending = new Map()
  let current = roots
  let id = 0
  createInterface({ input: child.stdout }).on('line', l => {
    const m = JSON.parse(l)
    if (m.method === 'roots/list') return write({ id: m.id, result: { roots: current.map(p => ({ uri: pathToFileURL(p).href })) } })
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  const request = (method, params) => new Promise(res => { pending.set(++id, res); write({ id, method, params }) })
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: roots ? { roots: { listChanged: true } } : {}, clientInfo: { name: 't', version: '0' } })
    .then(r => { write({ method: 'notifications/initialized' }); return r })
  const call = async (name, args) => {
    await ready
    const r = await request('tools/call', { name, arguments: args })
    return { text: r.result.content.map(c => c.text).join('\n'), isError: !!r.result.isError }
  }
  return { ready, call, setRoots: r => { current = r; write({ method: 'notifications/roots/list_changed' }) }, close: () => { child.stdin.end(); return new Promise(r => child.on('exit', r)) } }
}
const ask = (srv, files) => srv.call('ask_local_model', { prompt: 'Q?', files })

test('with roots: files under a root are read; relative paths resolve against the roots', async () => {
  const s = scratch('roots')
  const srv = server(s.env, { roots: [s.a, s.b] })
  let r = await ask(srv, ['src/main.js']) // in the first root
  assert.ok(r.text.includes('1: console.log("A-MAIN")') && r.text.includes('2: second line'), r.text)
  assert.ok(!r.text.includes('B-MAIN'), 'the first root that has it wins')
  r = await ask(srv, ['only-b.txt']) // only in the second root
  assert.ok(r.text.includes('B-ONLY'), r.text)
  r = await ask(srv, [path.join(s.b, 'src', 'main.js')]) // absolute, under a root
  assert.ok(r.text.includes('B-MAIN'), r.text)
  await srv.close()
})

test('a single root: paths are shown relative to it', async () => {
  const s = scratch('one-root')
  const srv = server(s.env, { roots: [s.a] })
  const r = await ask(srv, ['src'])
  assert.ok(r.text.includes('<file path="src/main.js">') && r.text.includes('<file path="src/util.js">'), r.text)
  await srv.close()
})

test('outside the roots, through a junction, in the profile, its dot-folders or app data: refused and reported, never read', async () => {
  const s = scratch('refused')
  const srv = server(s.env, { roots: [s.a] })
  const r = await ask(srv, [
    'src/main.js',
    path.join(s.b, 'only-b.txt'),
    path.join(s.dir, 'outside', 'secret.txt'),
    '../outside/secret.txt',
    'escape/secret.txt',
    'keys/id_ed25519',
    path.join(s.home, '.ssh', 'id_ed25519'),
    path.join(s.home, 'AppData', 'Local', 'app', 'token.txt'),
    path.join(s.home, 'notes.txt')
  ])
  assert.ok(r.text.includes('A-MAIN'), r.text)
  assert.ok(!/SECRET|B-ONLY/.test(r.text), r.text)
  for (const p of ['only-b.txt (refused: outside your MCP roots)', 'secret.txt (refused: outside your MCP roots)', 'escape/secret.txt (refused: outside your MCP roots)', 'keys/id_ed25519 (refused: it is in a dot-folder of the user profile', 'token.txt (refused: it is in AppData', 'notes.txt (refused: outside your MCP roots)']) {
    assert.ok(r.text.includes(p), `${p}\n${r.text}`)
  }
  await srv.close()
})

test('a folder walk skips links that lead outside the roots, and reports them', async () => {
  const s = scratch('walk-links')
  const srv = server(s.env, { roots: [s.a] })
  const r = await ask(srv, ['.'])
  assert.ok(r.text.includes('A-MAIN') && r.text.includes('A-README'), r.text)
  assert.ok(!/SECRET/.test(r.text), r.text)
  assert.match(r.text, /escape \(refused: outside your MCP roots\)/)
  assert.match(r.text, /keys \(refused: it is in a dot-folder of the user profile/)
  await srv.close()
})

test('roots in the profile\'s dot-folders or app data are dropped, whatever the client says', async () => {
  const s = scratch('bad-roots')
  for (const root of [path.join(s.home, '.ssh'), path.join(s.home, 'AppData', 'Local', 'app'), s.home]) {
    const srv = server(s.env, { roots: [root] })
    const r = await ask(srv, [root])
    assert.ok(r.isError && /Can't read files: None of the client's roots can be used \(the client's root .* is refused: /.test(r.text), r.text)
    assert.ok(!/SECRET/.test(r.text))
    await srv.close()
  }
})

test('no roots: a clear refusal for files; OLLAMA_ALLOWED_ROOTS or OLLAMA_ROOTS_FROM_CWD=1 as the documented fallback', async () => {
  const s = scratch('no-roots')
  let srv = server(s.env)
  let r = await ask(srv, ['src/main.js'])
  assert.ok(r.isError && /Can't read files: This client sent no MCP roots, so no folder is allowed\. Set OLLAMA_ALLOWED_ROOTS to the folders to allow, or OLLAMA_ROOTS_FROM_CWD=1/.test(r.text), r.text)
  r = await srv.call('ask_local_model', { prompt: 'no files needed' }) // without files, no roots are needed
  assert.ok(!r.isError && r.text.startsWith('no files needed'), r.text)
  await srv.close()

  srv = server({ ...s.env, OLLAMA_ALLOWED_ROOTS: s.b })
  r = await ask(srv, ['only-b.txt', path.join(s.a, 'README.md')])
  assert.ok(r.text.includes('B-ONLY') && !r.text.includes('A-README'), r.text)
  await srv.close()

  srv = server({ ...s.env, OLLAMA_ROOTS_FROM_CWD: '1' }, { cwd: s.a })
  r = await ask(srv, ['README.md', path.join(s.b, 'only-b.txt')])
  assert.ok(r.text.includes('A-README') && !r.text.includes('B-ONLY'), r.text)
  await srv.close()
})

test('OLLAMA_ALLOWED_ROOTS with roots narrows them; changed roots count at the next call', async () => {
  const s = scratch('narrow')
  const srv = server({ ...s.env, OLLAMA_ALLOWED_ROOTS: `${path.join(s.a, 'src')};${s.b}` }, { roots: [s.a] })
  let r = await ask(srv, ['src/main.js', 'README.md', path.join(s.b, 'only-b.txt')])
  assert.ok(r.text.includes('A-MAIN'), r.text)
  assert.ok(!r.text.includes('A-README') && !r.text.includes('B-ONLY'), 'under both only; never widened')
  srv.setRoots([s.b])
  r = await ask(srv, ['only-b.txt', path.join(s.a, 'src', 'main.js')])
  assert.ok(r.text.includes('B-ONLY') && !r.text.includes('A-MAIN'), r.text)
  await srv.close()
})

test('reading is unchanged inside the roots: dot-folders, node_modules, binaries and big files skipped; limits reported', async () => {
  const s = scratch('unchanged')
  const srv = server(s.env, { roots: [s.a] })
  let r = await ask(srv, ['.'])
  assert.ok(!/A-DEP|A-GITCONFIG|A-DOTENV/.test(r.text), r.text)
  assert.match(r.text, /big\.log \(too large, 2\.0 MB\)/)
  assert.ok(!r.text.includes('logo.png'), 'binaries met in a folder walk are skipped silently')
  r = await ask(srv, ['logo.png', 'missing.txt'])
  assert.match(r.text, /No readable text files found\. Skipped: logo\.png \(binary\), missing\.txt \(not found\)/)
  await srv.close()
})

test('list_local_models says where files can be read from; the instructions say when no default is set', async () => {
  const s = scratch('models')
  const srv = server({ ...s.env, OLLAMA_DEFAULT_MODEL: 'not-pulled:7b' }, { roots: [s.a] })
  const init = await srv.ready
  assert.match(init.result.instructions, /The configured default, not-pulled:7b, isn't pulled: pass `model`, or pull it/)
  const r = await srv.call('list_local_models', {})
  assert.match(r.text, /- fake:1b \(1B params, 0\.9 GB\)/)
  assert.match(r.text, /Files can be read from: the client's roots: .*[\\/]a\./)
  await srv.close()
  const srv2 = server(s.env)
  assert.match((await srv2.ready).result.instructions, /No default is set: omit `model` to use fake:1b, the first one\./)
  await srv2.close()
})
