/**
 * Trilium MCP server (stdio). Lets an agent, in any MCP client, search, read and add to the user's notes in Trilium
 * Notes (TriliumNext) through its ETAPI: search, read, list children, create, append, add a label. No delete, move or
 * protect.
 *
 * The ETAPI token comes from the environment (TRILIUM_ETAPI_TOKEN) and never appears in a reply, error or log: every
 * line the server writes is scrubbed of it. TRILIUM_READ_ONLY=1 lists only the read tools.
 *
 * Self-contained on purpose: only Node built-ins (Node 18+ for fetch), so it runs without npm install.
 */
const { createInterface } = require('readline')

const VERSION = '1.0.0'
const BASE = String(process.env.TRILIUM_URL || '').trim().replace(/\/+$/, '').replace(/\/etapi$/i, '')
const TOKEN = String(process.env.TRILIUM_ETAPI_TOKEN || '').trim()
const READ_ONLY = /^(1|true|yes)$/i.test(String(process.env.TRILIUM_READ_ONLY || '').trim())
// Replies are kept lean (the server's selling point): a note's content is cut at this many characters unless the call
// asks for more (up to MAX_CHARS_LIMIT), and a note longer than OUTLINE_OVER with headings comes back as its outline.
const MAX_CHARS = Math.max(1000, parseInt(process.env.TRILIUM_MAX_CHARS, 10) || 8_000) // not a number: the default
const MAX_CHARS_LIMIT = 200_000
const OUTLINE_OVER = 4_000
const START_CHARS = 600
const MAX_CHILDREN_SHOWN = 20
const INDEX_LINES = 200
const LABEL_NAME = /^[\p{L}\p{N}_:]+$/u

/** The text with the token replaced, so nothing the server writes can carry it. */
function scrub(s) {
  s = String(s)
  return TOKEN.length >= 4 ? s.split(TOKEN).join('[token]') : s
}

/** Why the server can't call Trilium yet, or null. */
function configProblem() {
  if (!BASE) return 'TRILIUM_URL isn\'t set: set it to your Trilium\'s address, e.g. http://localhost:8080.'
  if (!/^https?:\/\//i.test(BASE)) return 'TRILIUM_URL must start with http:// or https://.'
  if (!TOKEN) return 'TRILIUM_ETAPI_TOKEN isn\'t set: create a token in Trilium (Options → ETAPI) and set it as an environment variable.'
  // A client that doesn't expand ${VAR} in a server's env passes the reference itself.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(TOKEN)) {
    return 'TRILIUM_ETAPI_TOKEN holds an environment variable reference that your MCP client didn\'t expand. Leave it out of the server\'s env so the server inherits the variable, or use your client\'s own way to pass it.'
  }
  return null
}

class TriliumError extends Error {
  constructor(message, status) { super(message); this.status = status }
}

/** One ETAPI call. `body`: an object is sent as JSON, a string as text/plain. `as`: 'json' (default) or 'text'. */
async function etapi(method, path, { body, as = 'json', timeoutMs = 30_000 } = {}) {
  const problem = configProblem()
  if (problem) throw new TriliumError(problem)
  const headers = { Authorization: TOKEN }
  if (typeof body === 'string') headers['Content-Type'] = 'text/plain; charset=utf-8'
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(`${BASE}/etapi${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    throw new TriliumError(`Could not reach Trilium at ${BASE} (${e.cause?.message ?? e.message}). Is it running, and is TRILIUM_URL right?`)
  }
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401) throw new TriliumError('Trilium refused the ETAPI token (HTTP 401): check TRILIUM_ETAPI_TOKEN, or create a new token in Trilium (Options → ETAPI).', 401)
    let data = null
    try { data = JSON.parse(text) } catch { /* not JSON */ }
    const detail = data?.message ? `${data.code ? `${data.code}: ` : ''}${data.message}` : text.trim().slice(0, 200)
    throw new TriliumError(`Trilium couldn't ${method} ${path.split('?')[0]}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`, res.status)
  }
  if (as === 'text') return text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new TriliumError(`Trilium's reply to ${method} ${path.split('?')[0]} wasn't JSON. Is TRILIUM_URL the Trilium server?`)
  }
}

const enc = encodeURIComponent

/** Notes fetched during one call, by id, so a path or a list asks for each note once. */
function noteCache() {
  const notes = new Map()
  const get = id => {
    if (!notes.has(id)) notes.set(id, etapi('GET', `/notes/${enc(id)}`))
    return notes.get(id)
  }
  /** The notes for ids, ten requests at a time. */
  const many = async ids => {
    const out = []
    for (let i = 0; i < ids.length; i += 10) out.push(...await Promise.all(ids.slice(i, i + 10).map(get)))
    return out
  }
  return { get, many, put: n => notes.set(n.noteId, Promise.resolve(n)) }
}

/** The titles from the top of the tree down to the note's parent, through each first parent ("Gaming/PoE"). */
async function parentPath(note, cache) {
  const titles = []
  let id = note.parentNoteIds?.[0]
  for (let depth = 0; id && id !== 'root' && depth < 30; depth++) {
    const p = await cache.get(id).catch(() => null)
    if (!p) break
    titles.unshift(p.title)
    id = p.parentNoteIds?.[0]
  }
  return titles.join('/')
}

/** Child ids without Trilium's own system notes (ids starting with _, such as _hidden). */
const visible = ids => (ids ?? []).filter(id => !id.startsWith('_'))
const chars = n => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
const labelsOf = note => (note.attributes ?? []).filter(a => a.type === 'label').map(a => `#${a.name}${a.value ? `=${a.value}` : ''}`)
const when = d => String(d ?? '').slice(0, 16)
const named = n => `${n.title} (${n.noteId})`
const PROTECTED = 'It is a protected note: Trilium\'s ETAPI can\'t read or change protected notes\' content. Open it in Trilium instead.'

/**
 * A note from `ref`: a note id, or a title path from the top of the tree ("Gaming/PoE") that must match exactly one
 * note. An id is tried first; a ref with no slash that isn't an id is a one-title path.
 */
async function resolveNote(ref, cache, what = 'note') {
  ref = String(ref ?? '').trim()
  if (!ref) throw new TriliumError(`Give the ${what}: a note id, or a title path such as "Projects/Ideas".`)
  if (ref === 'root' || ref === '/') return cache.get('root')
  if (!ref.includes('/')) {
    try {
      return await cache.get(ref)
    } catch (e) {
      if (e.status !== 404) throw e
    }
  }
  const parts = ref.split('/').map(s => s.trim()).filter(Boolean)
  let current = await cache.get('root')
  const walked = []
  for (const part of parts) {
    const children = await cache.many(current.childNoteIds ?? [])
    let found = children.filter(c => c.title === part)
    if (!found.length) found = children.filter(c => c.title.toLowerCase() === part.toLowerCase())
    const where = walked.length ? `"${walked.join('/')}"` : 'the top of the tree'
    if (!found.length) throw new TriliumError(`No note titled "${part}" under ${where} (${what} "${ref}"). Use trilium_search or trilium_list_children to find it, or pass its note id.`)
    if (found.length > 1) throw new TriliumError(`${found.length} notes are titled "${part}" under ${where}: ${found.map(named).join(', ')}. Pass the note id instead.`)
    current = found[0]
    walked.push(part)
  }
  return current
}

// HTML to readable text ------------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try { return String.fromCodePoint(code) } catch { return all }
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null
}

/**
 * A note's HTML as readable text, Markdown-like: headings (#), lists (- and 1.), to-do items ([x]), links
 * ([text](href)), code blocks (```), inline code (`), tables (cells split by |) and images ([image: alt]).
 * Code blocks keep their text exactly.
 */
function htmlToText(html) {
  const blocks = []
  html = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (all, inner) => {
      const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
      blocks.push('```\n' + code.replace(/\n$/, '') + '\n```')
      return `<pre-block ${blocks.length - 1}>`
    })
  let out = ''
  const lists = []
  const links = []
  const atLineStart = () => out === '' || /\n[ ]*$/.test(out.slice(-40)) || /(^|\n)[ ]*(- |\d+\. )(\[[ x]\] )?$/.test(out.slice(-40))
  const breakLine = () => { if (out && !out.endsWith('\n')) out += '\n' }
  const breakBlock = () => { if (out) out = out.replace(/[ ]+$/, '').replace(/\n*$/, '\n\n') }
  for (const token of html.split(/(<[^>]*>)/)) {
    if (!token) continue
    if (token[0] !== '<') {
      let t = decodeEntities(token.replace(/\s+/g, ' '))
      if (atLineStart()) t = t.trimStart()
      out += t
      continue
    }
    const m = /^<(\/?)([a-z0-9-]+)/i.exec(token)
    if (!m) continue
    const close = !!m[1]
    const tag = m[2].toLowerCase()
    if (tag === 'pre-block') {
      breakBlock()
      out += blocks[Number(token.slice(11, -1))]
      breakBlock()
    } else if (/^h[1-6]$/.test(tag)) {
      breakBlock()
      if (!close) out += '#'.repeat(Number(tag[1])) + ' '
    } else if (tag === 'ul' || tag === 'ol') {
      if (close) { lists.pop(); if (!lists.length) breakBlock(); else breakLine() } else { if (!lists.length) breakBlock(); else breakLine(); lists.push({ ordered: tag === 'ol', n: 0 }) }
    } else if (tag === 'li') {
      if (close) { breakLine(); continue }
      breakLine()
      const list = lists[lists.length - 1] ?? { ordered: false, n: 0 }
      out += '  '.repeat(Math.max(0, lists.length - 1)) + (list.ordered ? `${++list.n}. ` : '- ')
    } else if (tag === 'input' && /type\s*=\s*["']?checkbox/i.test(token)) {
      out += /\schecked/i.test(token) ? '[x] ' : '[ ] '
    } else if (tag === 'br') {
      out += '\n' + (lists.length ? '  '.repeat(lists.length) : '')
    } else if (tag === 'a') {
      if (!close) { links.push({ at: out.length, href: attr(token, 'href') }); continue }
      const link = links.pop()
      if (!link || !link.href) continue
      const text = out.slice(link.at).trim()
      out = out.slice(0, link.at) + (text && text !== link.href ? `[${text}](${link.href})` : link.href)
    } else if (tag === 'code') {
      out += '`'
    } else if (tag === 'img' && !close) {
      const alt = attr(token, 'alt')
      out += `[image${alt ? `: ${alt}` : ''}]`
    } else if (tag === 'td' || tag === 'th') {
      if (!close) out += atLineStart() ? '| ' : ' | '
    } else if (tag === 'tr') {
      if (close) out += ' |'
      breakLine()
    } else if (tag === 'hr') {
      breakBlock()
      out += '---'
      breakBlock()
    } else if (['p', 'div', 'blockquote', 'table', 'figure', 'section', 'figcaption'].includes(tag)) {
      if (lists.length) { if (close) breakLine() } else breakBlock()
    }
  }
  return out.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** The headings of readable text (# lines outside code blocks): level, title, and where each one's part starts and ends. */
function outline(text) {
  const heads = []
  let at = 0
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    else if (!fenced) {
      const m = /^(#{1,6}) (.+)$/.exec(line)
      if (m) heads.push({ level: m[1].length, title: m[2].trim(), start: at })
    }
    at += line.length + 1
  }
  for (const [i, h] of heads.entries()) {
    const next = heads.slice(i + 1).find(n => n.level <= h.level)
    h.end = next ? next.start : text.length
  }
  return heads
}

/** The heading `section` names: its number in the outline, its title, or the one title that contains it. */
function findSection(heads, section) {
  if (!heads.length) throw new TriliumError('This note has no headings: read it with offset instead.')
  const s = String(section).trim()
  const list = hs => hs.map(h => `${heads.indexOf(h) + 1}. ${h.title}`).join(', ')
  if (/^\d+$/.test(s)) {
    const h = heads[Number(s) - 1]
    if (!h) throw new TriliumError(`There is no section ${s}: the note has ${heads.length}.`)
    return h
  }
  const want = s.replace(/^#+\s*/, '').toLowerCase()
  let found = heads.filter(h => h.title.toLowerCase() === want)
  if (!found.length) found = heads.filter(h => h.title.toLowerCase().includes(want))
  if (found.length === 1) return found[0]
  if (found.length) throw new TriliumError(`"${s}" matches ${found.length} headings: ${list(found)}. Pass its number.`)
  throw new TriliumError(`No heading matches "${s}". The headings: ${list(heads)}.`)
}

/** Up to maxChars of text from offset, with a line saying where it was cut and how to read on. */
function page(text, offset, maxChars, also = '') {
  const start = Math.max(0, Math.floor(Number(offset)) || 0)
  const size = Math.min(MAX_CHARS_LIMIT, Math.max(1, Math.floor(Number(maxChars)) || MAX_CHARS))
  if (start >= text.length) return `(${text.length} characters: nothing from ${start}.)`
  const part = text.slice(start, start + size)
  const end = start + part.length
  if (start === 0 && end === text.length) return part
  return `${part}\n\n[Characters ${start}–${end} of ${text.length}.${end < text.length ? ` Pass ${also}offset ${end} to read on.` : ''}]`
}

// Text to note HTML ----------------------------------------------------------------------------------------------

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Plain text as HTML paragraphs: a blank line starts a paragraph, a single line break stays one. */
function textToHtml(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`).join('')
}

/** The HTML for `content` (text, or HTML with format "html") followed by `code` as a plain-text code block. */
function contentHtml({ content, format = 'text', code }) {
  if (format !== 'text' && format !== 'html') throw new TriliumError('format is "text" or "html".')
  if (content !== undefined && typeof content !== 'string') throw new TriliumError('content is a string.')
  if (code !== undefined && typeof code !== 'string') throw new TriliumError('code is a string.')
  let html = content ? (format === 'html' ? content : textToHtml(content)) : ''
  if (code) html += `<pre><code class="language-text-plain">${escapeHtml(code.replace(/\r\n?/g, '\n'))}</code></pre>`
  return html
}

/** Labels given as "name" or "name=value" (a leading # is dropped), checked. */
function parseLabels(labels) {
  if (labels === undefined) return []
  if (!Array.isArray(labels)) throw new TriliumError('labels is a list such as ["todo", "status=done"].')
  return labels.map(l => {
    if (typeof l !== 'string') throw new TriliumError('Each label is a string such as "todo" or "status=done".')
    const s = l.trim().replace(/^#/, '')
    const at = s.indexOf('=')
    return checkLabel(at < 0 ? s : s.slice(0, at), at < 0 ? '' : s.slice(at + 1))
  })
}

function checkLabel(name, value = '') {
  name = String(name ?? '').trim().replace(/^#/, '')
  if (!LABEL_NAME.test(name)) throw new TriliumError(`"${name}" isn't a label name Trilium takes: letters, digits, _ and : only.`)
  return { name, value: String(value ?? '') }
}

const addLabel = (noteId, { name, value }) =>
  etapi('POST', '/attributes', { body: { noteId, type: 'label', name, value, isInheritable: false } })

// Tools ----------------------------------------------------------------------------------------------------------

const noteRef = what => ({ type: 'string', description: `The ${what}: a note id, or a title path from the top of the tree such as "Projects/Ideas" (it must match exactly one note).` })

const tools = [
  {
    name: 'trilium_index',
    description: 'A compact tree of note titles, to find where things live without reading notes: one line per note (indented title and id, "+N" where its children are beyond the depth). From the top of the tree by default; Trilium\'s own system notes are left out.',
    inputSchema: {
      type: 'object',
      properties: {
        note: noteRef('note to start from (default: the top of the tree)'),
        depth: { type: 'number', description: 'How many levels down (default 2, at most 6).' },
        limit: { type: 'number', description: `At most this many lines (default ${INDEX_LINES}, at most 1000).` }
      }
    },
    run: async ({ note: ref = 'root', depth = 2, limit = INDEX_LINES }) => {
      const cache = noteCache()
      const top = await resolveNote(ref, cache)
      const levels = Math.min(6, Math.max(1, Math.floor(Number(depth)) || 2))
      const max = Math.min(1000, Math.max(1, Math.floor(Number(limit)) || INDEX_LINES))
      const lines = []
      let cut = false
      const walk = async (ids, level) => {
        for (const c of await cache.many(ids)) {
          if (lines.length >= max) { cut = true; return }
          const kids = visible(c.childNoteIds)
          lines.push(`${'  '.repeat(level)}${named(c)}${kids.length && level + 1 >= levels ? ` +${kids.length}` : ''}`)
          if (kids.length && level + 1 < levels) await walk(kids, level + 1)
        }
      }
      await walk(visible(top.childNoteIds), 0)
      const where = top.noteId === 'root' ? 'The top of the tree' : named(top)
      if (!lines.length) return `${where} has no children.`
      return `${where}, ${levels} level${levels === 1 ? '' : 's'}:\n${lines.join('\n')}` +
        (cut ? `\n[Cut at ${max} lines: start lower down (note), or pass a smaller depth.]` : '')
    }
  },
  {
    name: 'trilium_search',
    description: 'Search the notes with Trilium\'s search syntax: words (full text), #label, #label=value, note.title *= "x", and combinations ("#book #year >= 2020"). One line per note: title, id, where it is (its parents\' titles) and labels; detail adds when it last changed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Trilium search, e.g. `ollama`, `#todo`, `note.title *= "release"`.' },
        limit: { type: 'number', description: 'At most this many notes (default 20, at most 100).' },
        detail: { type: 'boolean', description: 'Also say when each note last changed.' }
      },
      required: ['query']
    },
    run: async ({ query, limit = 20, detail = false }) => {
      if (typeof query !== 'string' || !query.trim()) throw new TriliumError('query is the search text.')
      const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20))
      const data = await etapi('GET', `/notes?search=${enc(query)}&limit=${n}`)
      const results = (data?.results ?? []).slice(0, n)
      if (!results.length) return `No notes match ${JSON.stringify(query)}.`
      const cache = noteCache()
      for (const r of results) cache.put(r)
      const rows = await Promise.all(results.map(async r => {
        const path = await parentPath(r, cache)
        const labels = labelsOf(r)
        return `- ${named(r)}${path ? ` in ${path}` : ''}${labels.length ? ` ${labels.join(' ')}` : ''}${r.isProtected ? ' (protected)' : ''}${detail ? ` · changed ${when(r.dateModified)}` : ''}`
      }))
      return `${results.length} note${results.length === 1 ? '' : 's'}${results.length === n ? ` (the first ${n})` : ''}:\n${rows.join('\n')}`
    }
  },
  {
    name: 'trilium_read_note',
    description: 'Read a note as readable text (headings, lists, links and code blocks kept), with its labels, parents and children. A short note comes back whole; a long one comes back as its outline of headings, with sizes, and its start: then pass section (a heading or its number) to read that part, or offset to read on in order.',
    inputSchema: {
      type: 'object',
      properties: {
        note: noteRef('note to read'),
        section: { type: 'string', description: 'A heading from the outline, or its number: reads that part (with its subheadings).' },
        offset: { type: 'number', description: 'Read the content (or the section) in order from this character, skipping the outline; 0 for the start.' },
        maxChars: { type: 'number', description: `At most this many characters of content (default ${MAX_CHARS}, at most ${MAX_CHARS_LIMIT}).` },
        detail: { type: 'boolean', description: 'Also give the note\'s type, MIME type and when it was created and changed.' }
      },
      required: ['note']
    },
    run: async ({ note: ref, section, offset, maxChars = MAX_CHARS, detail = false }) => {
      const cache = noteCache()
      const note = await resolveNote(ref, cache)
      const parents = await cache.many(note.parentNoteIds ?? []).catch(() => [])
      const childIds = note.childNoteIds ?? []
      const children = await cache.many(childIds.slice(0, MAX_CHILDREN_SHOWN))
      const labels = labelsOf(note)
      const head = [
        `# ${named(note)}${note.type !== 'text' ? ` · ${note.type}` : ''}`,
        detail ? `${note.type}${note.mime ? ` (${note.mime})` : ''} · created ${when(note.dateCreated)} · changed ${when(note.dateModified)}` : null,
        parents.length ? `In: ${parents.map(named).join(', ')}` : null,
        labels.length ? `Labels: ${labels.join(' ')}` : null,
        childIds.length ? `Children (${childIds.length}): ${children.map(named).join(', ')}${childIds.length > children.length ? `, +${childIds.length - children.length} more (trilium_list_children)` : ''}` : null
      ].filter(Boolean).join('\n')
      if (note.isProtected) return `${head}\n\n${PROTECTED}`
      if (['image', 'file'].includes(note.type)) return `${head}\n\n(A ${note.type} note: its content isn't text.)`
      const raw = await etapi('GET', `/notes/${enc(note.noteId)}/content`, { as: 'text' })
      const text = note.type === 'text' ? htmlToText(raw) : note.type === 'code' ? '```\n' + raw.replace(/\n$/, '') + '\n```' : raw
      if (!text.trim()) return `${head}\n\n(No content.)`
      const heads = outline(text)
      if (section !== undefined && section !== null && String(section).trim() !== '') {
        const h = findSection(heads, section)
        return `${head}\n\n${page(text.slice(h.start, h.end).trimEnd(), offset, maxChars, `section ${heads.indexOf(h) + 1} and `)}`
      }
      if (offset === undefined && text.length > OUTLINE_OVER && heads.length) {
        const min = Math.min(...heads.map(h => h.level))
        const lines = heads.map((h, i) => `${'  '.repeat(h.level - min)}${i + 1}. ${h.title} (${chars(h.end - h.start)})`)
        const start = text.slice(0, START_CHARS)
        return `${head}\n\n${chars(text.length)} characters, so the outline first. Pass section (a number or heading) to read a part, or offset 0 to read in order.\n` +
          `${lines.join('\n')}\n\nStart:\n${start}${start.length < text.length ? '…' : ''}`
      }
      return `${head}\n\n${page(text, offset, maxChars)}`
    }
  },
  {
    name: 'trilium_list_children',
    description: 'List a note\'s children (the top of the tree by default): title and id, the type when it isn\'t text, and "+N" for how many children each has.',
    inputSchema: {
      type: 'object',
      properties: {
        note: noteRef('note whose children to list (default: the top of the tree, "root")'),
        limit: { type: 'number', description: 'At most this many children (default 100, at most 500).' }
      }
    },
    run: async ({ note: ref = 'root', limit = 100 }) => {
      const cache = noteCache()
      const note = await resolveNote(ref, cache)
      const ids = visible(note.childNoteIds)
      const where = note.noteId === 'root' ? 'The top of the tree' : named(note)
      if (!ids.length) return `${where} has no children.`
      const n = Math.min(500, Math.max(1, Math.floor(Number(limit)) || 100))
      const children = await cache.many(ids.slice(0, n))
      const rows = children.map(c => {
        const count = c.childNoteIds?.length ?? 0
        return `- ${named(c)}${c.type !== 'text' ? ` · ${c.type}` : ''}${count ? ` +${count}` : ''}${c.isProtected ? ' (protected)' : ''}`
      })
      return `${where}: ${ids.length} child${ids.length === 1 ? '' : 'ren'}${ids.length > n ? ` (the first ${n})` : ''}\n${rows.join('\n')}`
    }
  },
  {
    name: 'trilium_create_note',
    write: true,
    description: 'Create a text note under a parent. Content is plain text (escaped; a blank line starts a paragraph) or HTML with format "html"; `code` adds a plain-text code block after it, kept exactly (backslashes included). Only when the user wants a note filed.',
    inputSchema: {
      type: 'object',
      properties: {
        parent: noteRef('parent note'),
        title: { type: 'string', description: 'The new note\'s title.' },
        content: { type: 'string', description: 'The note\'s text (or HTML with format "html").' },
        format: { type: 'string', enum: ['text', 'html'], description: 'How content is read (default "text").' },
        code: { type: 'string', description: 'Text for a code block after the content, kept exactly.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add, as "name" or "name=value".' }
      },
      required: ['parent', 'title']
    },
    run: async ({ parent: ref, title, content, format, code, labels }) => {
      if (typeof title !== 'string' || !title.trim()) throw new TriliumError('title is the new note\'s title.')
      const html = contentHtml({ content, format, code })
      const wanted = parseLabels(labels)
      const parent = await resolveNote(ref, noteCache(), 'parent')
      const created = await etapi('POST', '/create-note', { body: { parentNoteId: parent.noteId, title: title.trim(), type: 'text', content: html } })
      const note = created?.note
      if (!note?.noteId) throw new TriliumError('Trilium created the note but didn\'t say its id.')
      const added = []
      const failed = []
      for (const l of wanted) {
        try { await addLabel(note.noteId, l); added.push(`#${l.name}${l.value ? `=${l.value}` : ''}`) } catch (e) { failed.push(`#${l.name} (${e.message})`) }
      }
      return `Created ${named(note)} under ${parent.noteId === 'root' ? 'the top of the tree' : named(parent)}${added.length ? `, with ${added.join(' ')}` : ''}.` +
        (failed.length ? ` These labels failed: ${failed.join('; ')}.` : '')
    }
  },
  {
    name: 'trilium_append_to_note',
    write: true,
    description: 'Add to the end of a text note: plain text (escaped into paragraphs) or HTML with format "html", and/or `code` as a plain-text code block. Only when the user wants it added.',
    inputSchema: {
      type: 'object',
      properties: {
        note: noteRef('note to add to'),
        content: { type: 'string', description: 'Text to add (or HTML with format "html").' },
        format: { type: 'string', enum: ['text', 'html'], description: 'How content is read (default "text").' },
        code: { type: 'string', description: 'Text for a code block after the content, kept exactly.' }
      },
      required: ['note']
    },
    run: async ({ note: ref, content, format, code }) => {
      const html = contentHtml({ content, format, code })
      if (!html) throw new TriliumError('Give content or code to add.')
      const note = await resolveNote(ref, noteCache())
      if (note.isProtected) throw new TriliumError(`${named(note)}: ${PROTECTED}`)
      if (note.type !== 'text') throw new TriliumError(`${named(note)} is a ${note.type} note: only text notes can be added to.`)
      const old = await etapi('GET', `/notes/${enc(note.noteId)}/content`, { as: 'text' })
      await etapi('PUT', `/notes/${enc(note.noteId)}/content`, { body: old + html, as: 'text' })
      return `Added ${html.length} characters of HTML to the end of ${named(note)}.`
    }
  },
  {
    name: 'trilium_add_label',
    write: true,
    description: 'Add a label (#name or #name=value) to a note.',
    inputSchema: {
      type: 'object',
      properties: {
        note: noteRef('note to label'),
        name: { type: 'string', description: 'The label\'s name (letters, digits, _ and :), without #.' },
        value: { type: 'string', description: 'Its value (default none).' }
      },
      required: ['note', 'name']
    },
    run: async ({ note: ref, name, value }) => {
      const label = checkLabel(name, value)
      const note = await resolveNote(ref, noteCache())
      await addLabel(note.noteId, label)
      return `Added #${label.name}${label.value ? `=${label.value}` : ''} to ${named(note)}.`
    }
  }
]

const listed = () => tools.filter(t => !READ_ONLY || !t.write)

const GUIDANCE = [
  'Trilium Notes is the user\'s own notes app. Use trilium_search to find notes (Trilium\'s search syntax: words, #label, #label=value, note.title *= "x") and trilium_read_note to read one; notes can be named by id or by a title path such as "Projects/Ideas".',
  'Write only when the user asks for a note to be filed or added to: trilium_create_note, trilium_append_to_note and trilium_add_label change their notes. There is no delete or move. Protected notes can\'t be read or changed here.'
].join('\n')

async function instructions() {
  const problem = configProblem()
  if (problem) return `This Trilium server isn't set up yet, so don't use its tools: ${problem}`
  const mode = READ_ONLY ? '\nIt is read-only (TRILIUM_READ_ONLY): only searching and reading are available.' : ''
  try {
    const info = await etapi('GET', '/app-info', { timeoutMs: 3_000 })
    return `${GUIDANCE}${mode}\n\nConnected to Trilium ${info?.appVersion ?? ''} at ${BASE}.`
  } catch (e) {
    return `Trilium can't be used right now: ${e.message} Don't use these tools unless the user says it is fixed.`
  }
}

function send(m) {
  process.stdout.write(scrub(JSON.stringify(m)) + '\n')
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message: scrub(message) } })

async function handle(msg) {
  const { id, method, params } = msg ?? {}
  if (!method) return
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'trilium', version: VERSION },
        instructions: scrub(await instructions())
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: listed().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find(t => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      if (tool.write && READ_ONLY) return reply(id, { content: [{ type: 'text', text: `${tool.name} isn't available: this server is read-only (TRILIUM_READ_ONLY).` }], isError: true })
      try {
        const result = await tool.run(params?.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text: scrub(result) }] })
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: scrub(e.message) }], isError: true })
      }
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

if (require.main === module) {
  // Nothing the server writes may carry the token, a crash's message included.
  process.on('uncaughtException', e => { process.stderr.write(scrub(`trilium: ${e?.message ?? e}`) + '\n'); process.exit(1) })
  createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return replyError(null, -32700, 'Parse error')
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m)
  })
}

module.exports = { htmlToText, textToHtml, contentHtml }
