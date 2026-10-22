// server.js over stdio against a fake ETAPI (a local http server, never a real Trilium): search, read (HTML to text),
// create with a title path, append, labels, read-only mode, protected notes, HTTP errors, and that nothing the server
// writes (stdout or stderr) ever holds the token.
const test = require('node:test')
const assert = require('assert')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { createInterface } = require('readline')
const { htmlToText, textToHtml } = require('../server')

const SERVER = path.join(__dirname, '..', 'server.js')
const TOKEN = 'tok_FAKE-etapi-SECRET+9z/Q='
const WIN_SHARE = '\\\\server\\share'
const REGEX = 'y: \\+2[0-9]%'

/** Everything any server wrote in this file's tests, stdout and stderr: checked for the token at the end. */
let written = ''

/** A fake ETAPI: a small tree of notes, Trilium's endpoints and error shapes, and a log of the requests. */
function fakeTrilium() {
  const notes = new Map()
  let next = 0
  const add = (n) => {
    const note = { type: 'text', mime: 'text/html', isProtected: false, attributes: [], parentNoteIds: [], childNoteIds: [], dateModified: '2026-10-22 21:03:44.123+0200', content: '', ...n }
    notes.set(note.noteId, note)
    for (const p of note.parentNoteIds) notes.get(p)?.childNoteIds.push(note.noteId)
    return note
  }
  const label = (name, value = '') => ({ attributeId: `a${++next}`, type: 'label', name, value, isInheritable: false })
  add({ noteId: 'root', title: 'root', parentNoteIds: ['none'] })
  add({ noteId: 'gaming', title: 'Gaming', parentNoteIds: ['root'] })
  add({ noteId: 'poe', title: 'PoE', parentNoteIds: ['gaming'], attributes: [label('game', 'poe2')] })
  add({ noteId: 'builds', title: 'Builds', parentNoteIds: ['poe'], attributes: [label('todo')], content: '<p>Witch &amp; minions</p>' })
  add({ noteId: 'dup1', title: 'Ideas', parentNoteIds: ['root'] })
  add({ noteId: 'dup2', title: 'Ideas', parentNoteIds: ['root'] })
  add({ noteId: 'secret', title: '[protected]', parentNoteIds: ['root'], isProtected: true, content: 'SHOULD-NOT-BE-READ' })
  add({ noteId: 'script', title: 'Script', type: 'code', mime: 'text/x-python', parentNoteIds: ['gaming'], content: 'print("hi")\n' })
  add({ noteId: 'long', title: 'Long', parentNoteIds: ['root'], content: `<p>${'abcdefghij'.repeat(3000)}</p>` })
  add({ noteId: '_hidden', title: 'Hidden Notes', parentNoteIds: ['root'] })
  add({ noteId: '_options', title: 'Options', parentNoteIds: ['_hidden'] })
  // A long note with headings: read as an outline first. The # line in its code block isn't a heading.
  const para = (word) => `<p>${`${word} `.repeat(300).trim()}</p>`
  add({
    noteId: 'guide',
    title: 'Guide',
    parentNoteIds: ['root'],
    content: `${para('intro')}<h2>Install</h2>${para('install')}<h3>On Windows</h3>${para('windows')}<pre><code># not a heading</code></pre>` +
      `<h2>Use</h2>${para('use')}<h2>Limits</h2>${para('limits')}`
  })
  add({
    noteId: 'rich',
    title: 'Rich',
    parentNoteIds: ['root', 'gaming'],
    content: '<h2>Setup &amp; run</h2><p>See <a href="https://example.com/doc">the docs</a> and <code>npm test</code>.</p>' +
      '<ul><li>one</li><li>two<ul><li>two-a</li></ul></li></ul><ol><li>first</li><li>second</li></ol>' +
      '<ul class="todo-list"><li><label class="todo-list__label"><input type="checkbox" checked="checked" disabled="disabled"><span>done item</span></label></li>' +
      '<li><label class="todo-list__label"><input type="checkbox" disabled="disabled"><span>open item</span></label></li></ul>' +
      '<pre><code class="language-text-plain">if (a &lt; b) {\n  x = "q"\n}</code></pre><p>after&nbsp;code</p>'
  })
  const requests = []
  const json = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)) }
  const fail = (res, status, code, message) => json(res, status, { status, code, message })
  const view = ({ content, ...n }) => n
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      requests.push({ method: req.method, path: url.pathname, query: url.search, body, contentType: req.headers['content-type'] })
      if (req.headers.authorization !== TOKEN) return fail(res, 401, 'NOT_AUTHENTICATED', 'Not authenticated')
      const p = url.pathname
      if (p === '/etapi/app-info') return json(res, 200, { appVersion: '0.99.1' })
      if (p === '/etapi/notes' && req.method === 'GET') {
        const q = url.searchParams.get('search').toLowerCase()
        const limit = Number(url.searchParams.get('limit')) || 100
        const hits = [...notes.values()].filter(n => n.noteId !== 'root' && (q.startsWith('#')
          ? n.attributes.some(a => a.name === q.slice(1))
          : n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)))
        return json(res, 200, { results: hits.slice(0, limit).map(view) })
      }
      let m = /^\/etapi\/notes\/([^/]+)(\/content)?$/.exec(p)
      if (m) {
        const id = decodeURIComponent(m[1])
        if (id === 'boom') return fail(res, 500, 'INTERNAL', 'Something broke inside')
        // A server that echoes the request's headers in its error: the reply must not pass the token on.
        if (id === 'echo') return fail(res, 500, 'INTERNAL', `Bad request with Authorization: ${req.headers.authorization}`)
        const note = notes.get(id)
        if (!note) return fail(res, 404, 'NOTE_NOT_FOUND', `Note '${id}' not found.`)
        if (!m[2]) return json(res, 200, view(note))
        if (note.isProtected) return fail(res, 400, 'NOTE_IS_PROTECTED', 'Note is protected')
        if (req.method === 'GET') { res.setHeader('Content-Type', 'text/html'); return res.end(note.content) }
        if (req.method === 'PUT') { note.content = body; res.statusCode = 204; return res.end() }
      }
      if (p === '/etapi/create-note' && req.method === 'POST') {
        const b = JSON.parse(body)
        if (!notes.has(b.parentNoteId)) return fail(res, 400, 'PARENT_NOTE_NOT_FOUND', 'Parent not found')
        const note = add({ noteId: `new${++next}`, title: b.title, type: b.type, content: b.content, parentNoteIds: [b.parentNoteId] })
        return json(res, 201, { note: view(note), branch: {} })
      }
      if (p === '/etapi/attributes' && req.method === 'POST') {
        const b = JSON.parse(body)
        const note = notes.get(b.noteId)
        if (!note) return fail(res, 400, 'NOTE_NOT_FOUND', 'Note not found')
        const a = label(b.name, b.value)
        note.attributes.push(a)
        return json(res, 201, { ...a, noteId: b.noteId })
      }
      fail(res, 404, 'NOT_FOUND', `No route ${req.method} ${p}`)
    })
  })
  return {
    notes,
    requests,
    writes: () => requests.filter(r => r.method !== 'GET'),
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) })
  }
}

/** Servers still running: a test that fails before closing its server leaves it here for afterEach to stop. */
const running = new Set()

/** Starts server.js as a client would (initialize), then calls tools. */
function server(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TRILIUM_URL: '', TRILIUM_ETAPI_TOKEN: '', TRILIUM_READ_ONLY: '', TRILIUM_MAX_CHARS: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  running.add(child)
  child.on('exit', () => running.delete(child))
  child.stderr.on('data', d => { written += d })
  const pending = new Map()
  let id = 0
  createInterface({ input: child.stdout }).on('line', l => {
    written += l + '\n'
    const m = JSON.parse(l)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  const request = (method, params) => new Promise(res => { pending.set(++id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  const call = async (name, args = {}) => {
    await ready
    const r = await request('tools/call', { name, arguments: args })
    return { text: r.result.content.map(c => c.text).join('\n'), isError: !!r.result.isError }
  }
  const list = async () => { await ready; return (await request('tools/list', {})).result.tools.map(t => t.name) }
  return { ready, call, list, close: () => { child.stdin.end(); return new Promise(r => child.on('exit', r)) } }
}

let fake
let url
test.beforeEach(async () => { fake = fakeTrilium(); url = await fake.start() })
test.afterEach(() => {
  for (const child of running) child.kill()
  return fake.close()
})
const start = (env = {}) => server({ TRILIUM_URL: url, TRILIUM_ETAPI_TOKEN: TOKEN, ...env })

test('initialize: the instructions name the Trilium version and say when to write; tools/list has all seven', async () => {
  const srv = start()
  const init = await srv.ready
  assert.match(init.result.instructions, /Connected to Trilium 0\.99\.1/)
  assert.match(init.result.instructions, /Write only when the user asks/)
  assert.deepStrictEqual(await srv.list(), ['trilium_index', 'trilium_search', 'trilium_read_note', 'trilium_list_children', 'trilium_create_note', 'trilium_append_to_note', 'trilium_add_label'])
  await srv.close()
})

test('index: a compact tree of titles to a depth, "+N" where children are beyond it, system notes left out, cut with a note', async () => {
  const srv = start()
  let r = await srv.call('trilium_index', {})
  assert.strictEqual(r.text, [
    'The top of the tree, 2 levels:',
    'Gaming (gaming)',
    '  PoE (poe) +1',
    '  Script (script)',
    '  Rich (rich)',
    'Ideas (dup1)',
    'Ideas (dup2)',
    '[protected] (secret)',
    'Long (long)',
    'Guide (guide)',
    'Rich (rich)'
  ].join('\n'))
  r = await srv.call('trilium_index', { note: 'Gaming', depth: 1 })
  assert.strictEqual(r.text, 'Gaming (gaming), 1 level:\nPoE (poe) +1\nScript (script)\nRich (rich)')
  r = await srv.call('trilium_index', { depth: 3, limit: 3 })
  assert.strictEqual(r.text, 'The top of the tree, 3 levels:\nGaming (gaming)\n  PoE (poe)\n    Builds (builds)\n[Cut at 3 lines: start lower down (note), or pass a smaller depth.]')
  r = await srv.call('trilium_index', { note: 'builds' })
  assert.strictEqual(r.text, 'Builds (builds) has no children.')
  await srv.close()
})

test('search: the query and limit go to ETAPI; one line per note with id, title, path and labels; detail adds the date', async () => {
  const srv = start()
  let r = await srv.call('trilium_search', { query: '#todo', limit: 5 })
  const sent = fake.requests.find(q => q.path === '/etapi/notes')
  assert.strictEqual(sent.query, '?search=%23todo&limit=5')
  assert.strictEqual(r.text, '1 note:\n- Builds (builds) in Gaming/PoE #todo', r.text)
  r = await srv.call('trilium_search', { query: '#todo', detail: true })
  assert.strictEqual(r.text, '1 note:\n- Builds (builds) in Gaming/PoE #todo · changed 2026-10-22 21:03', r.text)
  r = await srv.call('trilium_search', { query: 'poe' })
  assert.match(r.text, /^- PoE \(poe\) in Gaming #game=poe2$/m)
  r = await srv.call('trilium_search', { query: 'nothing-like-this' })
  assert.strictEqual(r.text, 'No notes match "nothing-like-this".')
  r = await srv.call('trilium_search', { query: ' ' })
  assert.ok(r.isError, r.text)
  await srv.close()
})

test('read: HTML becomes readable text keeping headings, lists, to-dos, links and code blocks', async () => {
  const srv = start()
  const r = await srv.call('trilium_read_note', { note: 'rich' })
  assert.ok(!r.isError, r.text)
  assert.ok(r.text.startsWith('# Rich (rich)\nIn: root (root), Gaming (gaming)\n\n'), r.text)
  const body = r.text.split('\n\n').slice(1).join('\n\n')
  assert.strictEqual(body, [
    '## Setup & run',
    'See [the docs](https://example.com/doc) and `npm test`.',
    '- one\n- two\n  - two-a',
    '1. first\n2. second',
    '- [x] done item\n- [ ] open item',
    '```\nif (a < b) {\n  x = "q"\n}\n```',
    'after code'
  ].join('\n\n'))
  await srv.close()
})

test('read: a title path, labels, parents and children; a code note comes back as code; detail adds type and dates', async () => {
  const srv = start()
  let r = await srv.call('trilium_read_note', { note: 'Gaming/PoE' })
  assert.strictEqual(r.text, '# PoE (poe)\nIn: Gaming (gaming)\nLabels: #game=poe2\nChildren (1): Builds (builds)\n\n(No content.)')
  r = await srv.call('trilium_read_note', { note: 'Gaming/PoE/Builds' })
  assert.ok(r.text.endsWith('\n\nWitch & minions'), r.text)
  r = await srv.call('trilium_read_note', { note: 'script' })
  assert.strictEqual(r.text, '# Script (script) · code\nIn: Gaming (gaming)\n\n```\nprint("hi")\n```')
  r = await srv.call('trilium_read_note', { note: 'script', detail: true })
  assert.ok(r.text.startsWith('# Script (script) · code\ncode (text/x-python) · created  · changed 2026-10-22 21:03\n'), r.text)
  r = await srv.call('trilium_read_note', { note: 'gaming' }) // an id
  assert.match(r.text, /^# Gaming \(gaming\)\n/)
  r = await srv.call('trilium_read_note', { note: 'Gaming' }) // not an id: a one-title path
  assert.match(r.text, /^# Gaming \(gaming\)\n/)
  await srv.close()
})

test('read: a long note with headings comes back as its outline and start; section reads one part', async () => {
  const srv = start()
  let r = await srv.call('trilium_read_note', { note: 'guide' })
  const [head, rest] = r.text.split('\n\n')
  assert.strictEqual(head, '# Guide (guide)\nIn: root (root)')
  const lines = rest.split('\n')
  assert.match(lines[0], /^\d+\.\dk characters, so the outline first\. Pass section/)
  assert.deepStrictEqual(lines.slice(1).map(l => l.replace(/\(\d+(\.\d)?k?\)$/, '(n)')), ['1. Install (n)', '  2. On Windows (n)', '3. Use (n)', '4. Limits (n)'])
  assert.ok(r.text.includes('\n\nStart:\nintro intro') && r.text.endsWith('…'), r.text.slice(-100))
  assert.ok(r.text.length < 1000, `the outline reply is ${r.text.length} characters`)
  r = await srv.call('trilium_read_note', { note: 'guide', section: '2' })
  assert.ok(r.text.includes('\n\n### On Windows\n\nwindows windows') && r.text.endsWith('```\n# not a heading\n```'), r.text.slice(-200))
  r = await srv.call('trilium_read_note', { note: 'guide', section: 'install' })
  assert.ok(r.text.includes('\n\n## Install\n\ninstall') && r.text.includes('### On Windows') && !r.text.includes('## Use'), r.text)
  r = await srv.call('trilium_read_note', { note: 'guide', section: 'Lim', maxChars: 100 })
  assert.ok(r.text.includes('## Limits') && /\[Characters 0–100 of \d+\. Pass section 4 and offset 100 to read on\.\]$/.test(r.text), r.text)
  r = await srv.call('trilium_read_note', { note: 'guide', section: 'i' })
  assert.ok(r.isError && r.text.startsWith('"i" matches 3 headings: 1. Install, 2. On Windows, 4. Limits'), r.text)
  r = await srv.call('trilium_read_note', { note: 'guide', section: 'Nope' })
  assert.ok(r.isError && r.text.includes('The headings: 1. Install'), r.text)
  r = await srv.call('trilium_read_note', { note: 'guide', offset: 0 }) // in order, no outline
  assert.ok(r.text.includes('\n\nintro intro') && r.text.includes('## Limits') && !r.text.includes('Start:'), r.text.slice(0, 200))
  r = await srv.call('trilium_read_note', { note: 'rich', section: '9' })
  assert.ok(r.isError && r.text === 'There is no section 9: the note has 1.', r.text)
  await srv.close()
})

test('read: long content is cut with a note saying where, and offset reads on', async () => {
  const srv = start({ TRILIUM_MAX_CHARS: '1000' })
  let r = await srv.call('trilium_read_note', { note: 'long' })
  assert.ok(r.text.endsWith('[Characters 0–1000 of 30000. Pass offset 1000 to read on.]'), r.text.slice(-200))
  r = await srv.call('trilium_read_note', { note: 'long', offset: 29500, maxChars: 1000 })
  assert.ok(r.text.endsWith('[Characters 29500–30000 of 30000.]'), r.text.slice(-200))
  r = await srv.call('trilium_read_note', { note: 'long', maxChars: 50000 })
  assert.ok(!r.text.includes('[Characters'), 'the whole of it fits')
  await srv.close()
})

test('a protected note: read says plainly that ETAPI can\'t read it, and append refuses; neither asks for its content', async () => {
  const srv = start()
  let r = await srv.call('trilium_read_note', { note: 'secret' })
  assert.ok(!r.isError && r.text.includes('It is a protected note: Trilium\'s ETAPI can\'t read or change protected notes\' content.'), r.text)
  r = await srv.call('trilium_append_to_note', { note: 'secret', content: 'more' })
  assert.ok(r.isError && r.text.includes('protected'), r.text)
  assert.ok(!fake.requests.some(q => q.path === '/etapi/notes/secret/content'), 'never asked for its content')
  assert.strictEqual(fake.notes.get('secret').content, 'SHOULD-NOT-BE-READ')
  r = await srv.call('trilium_search', { query: 'protected' })
  assert.match(r.text, /^- \[protected\] \(secret\) \(protected\)$/m)
  await srv.close()
})

test('reply sizes stay lean on the fixture tree (the server\'s selling point: raise a budget only on purpose)', async (t) => {
  const srv = start()
  const sizes = {}
  for (const [label, name, args, budget] of [
    ['index, depth 2', 'trilium_index', {}, 200],
    ['search, 1 result', 'trilium_search', { query: '#todo' }, 50],
    ['search by word', 'trilium_search', { query: 'poe' }, 50],
    ['list_children of the top', 'trilium_list_children', {}, 170],
    ['read a short note', 'trilium_read_note', { note: 'rich' }, 280],
    ['read a long note (outline)', 'trilium_read_note', { note: 'guide' }, 900],
    ['read a section', 'trilium_read_note', { note: 'guide', section: 'Use' }, 1250]
  ]) {
    const r = await srv.call(name, args)
    assert.ok(!r.isError, r.text)
    sizes[label] = r.text.length
    assert.ok(r.text.length <= budget, `${label}: ${r.text.length} characters, over its budget of ${budget}`)
  }
  // The outline costs a fraction of reading the whole note.
  sizes['read a long note whole'] = (await srv.call('trilium_read_note', { note: 'guide', offset: 0, maxChars: 50000 })).text.length
  assert.ok(sizes['read a long note (outline)'] * 5 < sizes['read a long note whole'])
  t.diagnostic(`reply sizes (characters): ${JSON.stringify(sizes)}`)
  await srv.close()
})
test('create under a title path: text escaped into paragraphs, a code block whose backslashes round-trip exactly, labels', async () => {
  const srv = start()
  const code = `${WIN_SHARE}\n${REGEX}\n<tag> & "q"`
  const r = await srv.call('trilium_create_note', {
    parent: 'Gaming/PoE',
    title: 'Filter notes',
    content: 'Line <one> & two\nsame paragraph\n\nNew paragraph',
    code,
    labels: ['#todo', 'status=wip=still']
  })
  assert.ok(!r.isError, r.text)
  const id = /\((new\d+)\)/.exec(r.text)[1]
  assert.strictEqual(r.text, `Created Filter notes (${id}) under PoE (poe), with #todo #status=wip=still.`)
  const note = fake.notes.get(id)
  assert.deepStrictEqual(note.parentNoteIds, ['poe'])
  assert.strictEqual(note.content,
    '<p>Line &lt;one&gt; &amp; two<br>same paragraph</p><p>New paragraph</p>' +
    '<pre><code class="language-text-plain">\\\\server\\share\ny: \\+2[0-9]%\n&lt;tag&gt; &amp; &quot;q&quot;</code></pre>')
  assert.deepStrictEqual(note.attributes.map(a => [a.name, a.value]), [['todo', ''], ['status', 'wip=still']])
  const read = await srv.call('trilium_read_note', { note: id })
  assert.ok(read.text.includes('```\n' + code + '\n```'), read.text)
  assert.ok(read.text.includes(WIN_SHARE) && read.text.includes(REGEX))
  await srv.close()
})

test('create: format html is sent as given; a parent path that matches no note, or two, is refused with no write', async () => {
  const srv = start()
  let r = await srv.call('trilium_create_note', { parent: 'root', title: 'H', content: '<p><b>bold</b></p>', format: 'html' })
  assert.ok(!r.isError, r.text)
  assert.strictEqual(fake.notes.get(/\((new\d+)\)/.exec(r.text)[1]).content, '<p><b>bold</b></p>')
  const before = fake.writes().length
  r = await srv.call('trilium_create_note', { parent: 'Gaming/Nope', title: 'x' })
  assert.ok(r.isError && r.text.startsWith('No note titled "Nope" under "Gaming"'), r.text)
  r = await srv.call('trilium_create_note', { parent: 'Ideas', title: 'x' })
  assert.ok(r.isError && r.text.includes('2 notes are titled "Ideas" under the top of the tree: Ideas (dup1), Ideas (dup2)'), r.text)
  r = await srv.call('trilium_create_note', { parent: 'root', title: 'x', labels: ['bad name'] })
  assert.ok(r.isError && r.text.includes('isn\'t a label name'), r.text)
  r = await srv.call('trilium_create_note', { parent: 'root', title: ' ' })
  assert.ok(r.isError, r.text)
  assert.strictEqual(fake.writes().length, before, 'nothing written')
  await srv.close()
})

test('append: reads the content, adds text or code to its end, and writes it back as text/plain', async () => {
  const srv = start()
  let r = await srv.call('trilium_append_to_note', { note: 'Gaming/PoE/Builds', content: 'Next: <boss>', code: WIN_SHARE })
  assert.strictEqual(r.text, `Added ${'<p>Next: &lt;boss&gt;</p>'.length + `<pre><code class="language-text-plain">${WIN_SHARE}</code></pre>`.length} characters of HTML to the end of Builds (builds).`)
  assert.strictEqual(fake.notes.get('builds').content, `<p>Witch &amp; minions</p><p>Next: &lt;boss&gt;</p><pre><code class="language-text-plain">${WIN_SHARE}</code></pre>`)
  assert.match(fake.writes().at(-1).contentType, /^text\/plain/)
  r = await srv.call('trilium_append_to_note', { note: 'script', content: 'x' })
  assert.ok(r.isError && r.text.includes('is a code note'), r.text)
  r = await srv.call('trilium_append_to_note', { note: 'builds' })
  assert.ok(r.isError && r.text.includes('Give content or code'), r.text)
  await srv.close()
})

test('add_label and list_children', async () => {
  const srv = start()
  let r = await srv.call('trilium_add_label', { note: 'builds', name: '#priority', value: 'high' })
  assert.strictEqual(r.text, 'Added #priority=high to Builds (builds).')
  assert.deepStrictEqual(fake.notes.get('builds').attributes.at(-1), { attributeId: fake.notes.get('builds').attributes.at(-1).attributeId, type: 'label', name: 'priority', value: 'high', isInheritable: false })
  r = await srv.call('trilium_list_children', {})
  assert.strictEqual(r.text, 'The top of the tree: 7 children\n- Gaming (gaming) +3\n- Ideas (dup1)\n- Ideas (dup2)\n- [protected] (secret) (protected)\n- Long (long)\n- Guide (guide)\n- Rich (rich)')
  r = await srv.call('trilium_list_children', { note: 'Gaming' })
  assert.strictEqual(r.text, 'Gaming (gaming): 3 children\n- PoE (poe) +1\n- Script (script) · code\n- Rich (rich)')
  r = await srv.call('trilium_list_children', { note: 'builds' })
  assert.strictEqual(r.text, 'Builds (builds) has no children.')
  await srv.close()
})

test('read-only: only the read tools are listed, the write tools are refused, and nothing is written', async () => {
  const srv = start({ TRILIUM_READ_ONLY: '1' })
  assert.match((await srv.ready).result.instructions, /read-only/)
  assert.deepStrictEqual(await srv.list(), ['trilium_index', 'trilium_search', 'trilium_read_note', 'trilium_list_children'])
  for (const [name, args] of [['trilium_create_note', { parent: 'root', title: 'x' }], ['trilium_append_to_note', { note: 'builds', content: 'x' }], ['trilium_add_label', { note: 'builds', name: 'x' }]]) {
    const r = await srv.call(name, args)
    assert.ok(r.isError && r.text.includes('read-only'), r.text)
  }
  assert.ok(!(await srv.call('trilium_search', { query: 'poe' })).isError)
  assert.deepStrictEqual(fake.writes(), [])
  await srv.close()
})

test('HTTP errors say what failed (status, Trilium\'s message) without the token', async () => {
  const srv = start()
  let r = await srv.call('trilium_read_note', { note: 'boom' })
  assert.strictEqual(r.text, 'Trilium couldn\'t GET /notes/boom: HTTP 500 (INTERNAL: Something broke inside)')
  r = await srv.call('trilium_read_note', { note: 'echo' })
  assert.strictEqual(r.text, 'Trilium couldn\'t GET /notes/echo: HTTP 500 (INTERNAL: Bad request with Authorization: [token])')
  r = await srv.call('trilium_add_label', { note: 'nosuch1/x', name: 'a' })
  assert.ok(r.isError && r.text.startsWith('No note titled "nosuch1"'), r.text)
  await srv.close()
  const wrong = server({ TRILIUM_URL: url, TRILIUM_ETAPI_TOKEN: 'wrong-token-value' })
  assert.match((await wrong.ready).result.instructions, /can't be used right now: Trilium refused the ETAPI token \(HTTP 401\)/)
  r = await wrong.call('trilium_search', { query: 'poe' })
  assert.ok(r.isError && r.text.startsWith('Trilium refused the ETAPI token (HTTP 401)'), r.text)
  await wrong.close()
})

test('configuration: a URL ending in /etapi works; missing settings, an unexpanded reference and an unreachable server are explained', async () => {
  let srv = start({ TRILIUM_URL: `${url}/etapi/` })
  assert.ok(!(await srv.call('trilium_search', { query: 'poe' })).isError)
  await srv.close()
  srv = server({ TRILIUM_ETAPI_TOKEN: TOKEN })
  assert.match((await srv.ready).result.instructions, /isn't set up yet.*TRILIUM_URL isn't set/)
  assert.match((await srv.call('trilium_search', { query: 'x' })).text, /^TRILIUM_URL isn't set/)
  await srv.close()
  srv = server({ TRILIUM_URL: url })
  assert.match((await srv.call('trilium_search', { query: 'x' })).text, /^TRILIUM_ETAPI_TOKEN isn't set/)
  await srv.close()
  srv = server({ TRILIUM_URL: url, TRILIUM_ETAPI_TOKEN: '${TRILIUM_ETAPI_TOKEN}' })
  assert.match((await srv.call('trilium_search', { query: 'x' })).text, /reference that your MCP client didn't expand/)
  await srv.close()
  const before = fake.requests.length
  srv = server({ TRILIUM_URL: 'http://127.0.0.1:9', TRILIUM_ETAPI_TOKEN: TOKEN })
  assert.match((await srv.call('trilium_search', { query: 'x' })).text, /^Could not reach Trilium at http:\/\/127\.0\.0\.1:9 /)
  await srv.close()
  assert.strictEqual(fake.requests.length, before)
})

test('nothing any server wrote, on stdout or stderr, holds the token', () => {
  assert.ok(written.length > 1000, 'the servers wrote something')
  assert.ok(!written.includes(TOKEN), 'the token appears in what a server wrote')
  assert.ok(!written.includes(JSON.stringify(TOKEN).slice(1, -1)))
})

test('htmlToText and textToHtml on their own', () => {
  assert.strictEqual(textToHtml('a\r\nb\n\n\n c '), '<p>a<br>b</p><p>c</p>')
  assert.strictEqual(textToHtml(''), '')
  assert.strictEqual(htmlToText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), '| A | B |\n| 1 | 2 |')
  assert.strictEqual(htmlToText('<p>x<br>y</p><p><img src="i.png" alt="Map"> &#x41;&#66; &unknown;</p>'), 'x\ny\n\n[image: Map] AB &unknown;')
  assert.strictEqual(htmlToText('<p><a href="#root/abc">#root/abc</a></p>'), '#root/abc')
  assert.strictEqual(htmlToText('<pre><code>a<br>b\\\\c</code></pre>'), '```\na\nb\\\\c\n```')
})
