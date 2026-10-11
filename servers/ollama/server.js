/**
 * Ollama MCP server (stdio). Lets an agent, in any MCP client, delegate tasks to local Ollama models instead of
 * using cloud tokens. Proxies tool calls to Ollama's HTTP API.
 *
 * The token saving comes from `files`: the server reads files itself and sends them to the local
 * model, so only the model's short answer enters the calling agent's context. It reads only inside the client's
 * MCP roots (roots.js), never the profile's dot-folders or app data.
 *
 * Self-contained on purpose: only Node built-ins (Node 18+ for fetch), so it runs without npm install.
 */
const { createInterface } = require('readline')
const fs = require('fs')
const os = require('os')
const { readFile, readdir, stat, realpath } = require('fs/promises')
const { join, resolve, relative, isAbsolute } = require('path')
const { isInside, profileRefusal, rootsClient, allowedRoots } = require('./roots')

const VERSION = '1.2.0'
// Use the IP, not localhost: localhost resolution adds a ~2s Windows IPv6-fallback delay per call.
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '')
const DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL || ''
// Larger contexts need more GPU memory; inputs beyond this are split into batches.
const MAX_CTX = Math.max(8192, parseInt(process.env.OLLAMA_MAX_CTX, 10) || 65536) // not a number: the default
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_CHARS = 3_000_000
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', 'bin', 'obj'])
// Rough chars-per-token for code and prose; used only to size the context window.
const CHARS_PER_TOKEN = 3.2

async function ollama(path, payload, timeoutMs = 600_000) {
  let res
  try {
    res = await fetch(OLLAMA_HOST + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    throw new Error(`Could not reach Ollama at ${OLLAMA_HOST} (${e.cause?.message ?? e.message}). Is it running?`)
  }
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep null
  }
  if (data && data.error) throw new Error(`Ollama error: ${data.error}`)
  if (!res.ok) throw new Error(`Ollama error: HTTP ${res.status}`)
  return data ?? {}
}

async function models() {
  return (await ollama('/api/tags', undefined, 5_000)).models ?? []
}

async function pickModel(requested) {
  if (requested) return requested
  if (DEFAULT_MODEL) return DEFAULT_MODEL
  const list = await models()
  if (!list.length) throw new Error('No local models found. Pull one with `ollama pull <model>`.')
  return list[0].name
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

const realOr = p => { try { return fs.realpathSync.native(p) } catch { return resolve(p) } }

/** Folders never read, whatever the roots say, on top of roots.js's profile rules: all app data (sign-ins, tokens). */
function readRefusal(real) {
  const home = realOr(os.homedir())
  const appData = [join(home, 'AppData'), process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(realOr)
  if (appData.some(a => isInside(real, a))) return 'it is in AppData (app data and sign-ins)'
  if (process.platform === 'darwin' && isInside(real, join(home, 'Library'))) return 'it is in ~/Library (app data and sign-ins)'
  return null
}

/** The folders `files` may come from now: the client's roots, the cwd opt-in and OLLAMA_ALLOWED_ROOTS (roots.js rules). */
async function readRoots() {
  return allowedRoots({
    client: await roots.list(),
    env: String(process.env.OLLAMA_ALLOWED_ROOTS || '').split(/[;\n]/).map(s => s.trim()).filter(Boolean),
    cwd: process.env.OLLAMA_ROOTS_FROM_CWD === '1' ? process.cwd() : null,
    names: { env: 'OLLAMA_ALLOWED_ROOTS', cwd: 'OLLAMA_ROOTS_FROM_CWD=1' },
    refuse: readRefusal
  })
}

/**
 * Expands files and folders (recursively, skipping build and VCS folders) into readable text files, reading only
 * inside the allowed roots. Relative paths resolve against the first root that has them (else the first root). Every
 * file and folder must really resolve (realpath, so links and junctions count where they lead) under a root, and is
 * never in the profile's dot-folders or app data; anything else is skipped and reported, never read.
 */
async function collect(paths, allowed) {
  if (allowed.refusal) throw new Error(`Can't read files: ${allowed.refusal}.`)
  const roots = allowed.roots
  const shown = real => {
    if (roots.length > 1) return real.replace(/\\/g, '/')
    return relative(roots[0], real).replace(/\\/g, '/') || '.'
  }
  const files = []
  const skipped = []
  const seen = new Set()
  let total = 0
  const add = async (abs, given, depth) => {
    if (total >= MAX_TOTAL_CHARS) return skipped.push(`${given} (input limit reached)`)
    const real = await realpath(abs).catch(() => null)
    if (!real) return skipped.push(`${given} (not found)`)
    // A path check, by real path: it stops any path or link an agent passes. It can't stop a local process running as
    // the user that swaps a folder for a junction between this check and the read below; such a process can already
    // read those files itself (documented in the README, "What the confinement guarantees").
    const why = profileRefusal(real) || readRefusal(real) || (allowed.allows(real) ? null : 'outside your MCP roots')
    if (why) return skipped.push(`${given} (refused: ${why})`)
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) return
    seen.add(key)
    const s = await stat(real).catch(() => null)
    if (!s) return skipped.push(`${given} (not found)`)
    if (s.isDirectory()) {
      if (depth > 12) return
      for (const e of (await readdir(real)).sort()) {
        if (SKIP_DIRS.has(e) || e.startsWith('.')) continue
        await add(join(real, e), `${shown(real)}/${e}`, depth + 1)
      }
      return
    }
    if (s.size > MAX_FILE_BYTES) return skipped.push(`${shown(real)} (too large, ${(s.size / 1024 / 1024).toFixed(1)} MB)`)
    const buf = await readFile(real)
    if (isBinary(buf)) return depth === 0 ? skipped.push(`${shown(real)} (binary)`) : undefined
    const text = buf.toString('utf8')
    total += text.length
    files.push({ path: shown(real), text })
  }
  for (const p of paths) {
    if (typeof p !== 'string' || !p) { skipped.push(`${JSON.stringify(p)} (not a path)`); continue }
    const abs = isAbsolute(p) ? resolve(p) : (roots.map(r => resolve(r, p)).find(c => fs.existsSync(c)) ?? resolve(roots[0], p))
    await add(abs, p, 0)
  }
  return { files, skipped }
}

// Lines are numbered so the model can cite real line numbers. `start` is set for parts of split files.
const fileBlock = (f) =>
  `<file path="${f.path}">\n${f.text
    .split('\n')
    .map((l, i) => `${(f.start ?? 1) + i}: ${l}`)
    .join('\n')}\n</file>`

/** Splits files into batches that fit the context window, keeping room for the prompt and answer. */
function batches(files, budgetChars) {
  const out = []
  let cur = []
  let size = 0
  for (const f of files) {
    const block = fileBlock(f)
    if (block.length > budgetChars) {
      // One oversized file: split it into line-aligned parts.
      const lines = f.text.split('\n')
      let part = []
      let partSize = 0
      let n = 1
      let start = 1
      const flush = () => {
        if (part.length) out.push([{ path: `${f.path} (part ${n++})`, text: part.join('\n'), start }])
        start += part.length
        part = []
        partSize = 0
      }
      // +10 per line leaves room for the line-number prefix.
      for (const l of lines) {
        if (partSize + l.length + 10 > budgetChars - 200) flush()
        part.push(l)
        partSize += l.length + 10
      }
      flush()
      continue
    }
    if (size + block.length > budgetChars && cur.length) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(f)
    size += block.length
  }
  if (cur.length) out.push(cur)
  return out
}

const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()

async function chat(model, system, prompt) {
  const tokens = Math.ceil((system.length + prompt.length) / CHARS_PER_TOKEN)
  // Ollama silently truncates input beyond num_ctx, so size it to the input plus room to answer.
  const num_ctx = Math.min(MAX_CTX, Math.max(8192, 2 ** Math.ceil(Math.log2(tokens + 4096))))
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const data = await ollama('/api/chat', { model, messages, stream: false, think: false, options: { num_ctx } })
  return {
    text: stripThinking(data.message?.content ?? ''),
    inTokens: data.prompt_eval_count ?? 0,
    outTokens: data.eval_count ?? 0,
    seconds: (data.total_duration ?? 0) / 1e9
  }
}

const tools = [
  {
    name: 'list_local_models',
    description: 'List local Ollama models available on this machine, with their size and last-modified date.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const list = await models()
      const where = `\n\nFiles can be read from: ${(await readRoots()).describe()}.`
      if (!list.length) return 'No local models found. Pull one with `ollama pull <model>`.' + where
      return list
        .map((m) => `- ${m.name} (${m.details?.parameter_size ?? '?'} params, ${((m.size ?? 0) / 1024 ** 3).toFixed(1)} GB)${m.name === DEFAULT_MODEL ? ' — default' : ''}`)
        .join('\n') + where
    }
  },
  {
    name: 'ask_local_model',
    description:
      'Delegate a task to a local model running on this machine (free, private, slower and less reliable than you). ' +
      'Pass `files` (paths or folders) to have the server read them and send them to the local model: their contents never enter your context, only the answer does. ' +
      'Good for: summarising or answering questions about large files, logs or long command output saved to a file; ' +
      'searching many files for where something is handled when an exact-text search (Grep) is not enough; first drafts of boilerplate, docs or test data. ' +
      'Ask for short answers with file paths and line numbers, and verify anything you will act on.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task or question. Be specific and ask for a concise answer (e.g. "list file:line and one line of context").' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or folders to include, inside your project (your MCP roots): relative paths resolve against it. Folders are read recursively, skipping dot-folders, node_modules, build output and binary files. Anything outside your roots, in the profile\'s dot-folders or in app data is refused. Large inputs are split into batches and each batch is answered separately.'
        },
        model: { type: 'string', description: `Ollama model tag. Defaults to ${DEFAULT_MODEL ? `"${DEFAULT_MODEL}"` : 'the first local model'}.` },
        system: { type: 'string', description: "Optional system prompt to steer the model's behaviour." }
      },
      required: ['prompt']
    },
    run: async ({ model, prompt, system = '', files = [] }) => {
      if (!Array.isArray(files)) throw new Error('files is a list of paths.')
      const m = await pickModel(model)
      if (!files.length) {
        const r = await chat(m, system, prompt)
        return `${r.text}\n\n[${m} · ${r.inTokens} in / ${r.outTokens} out · ${r.seconds.toFixed(1)}s]`
      }
      const { files: read, skipped } = await collect(files, await readRoots())
      if (!read.length) return `No readable text files found.${skipped.length ? ` Skipped: ${skipped.join(', ')}` : ''}`
      const sys = system || 'You answer questions about the files provided. Be concise and precise. Cite file paths (and line numbers when you can). If the files do not contain the answer, say so plainly.'
      const budget = Math.floor((MAX_CTX - 4096) * CHARS_PER_TOKEN) - sys.length - prompt.length - 200
      const groups = batches(read, budget)
      const NOT_FOUND = 'NOT IN THESE FILES'
      const answers = []
      let inTok = 0
      let outTok = 0
      let secs = 0
      for (const [i, group] of groups.entries()) {
        // With several batches most will not hold the answer: let the model say so instead of guessing.
        const note = groups.length > 1 ? `\n\n(These files are part ${i + 1} of ${groups.length} of the input. If they do not contain what is asked for, reply only: ${NOT_FOUND})` : ''
        const r = await chat(m, sys, `${group.map(fileBlock).join('\n\n')}\n\n${prompt}${note}`)
        inTok += r.inTokens
        outTok += r.outTokens
        secs += r.seconds
        if (groups.length > 1 && r.text.toUpperCase().includes(NOT_FOUND)) continue
        answers.push(groups.length > 1 ? `### From batch ${i + 1} of ${groups.length}\n${r.text}` : r.text)
      }
      if (!answers.length) answers.push('The local model found nothing relevant in these files.')
      const footer = `[${m} · ${read.length} file${read.length === 1 ? '' : 's'} · ${inTok} in / ${outTok} out · ${secs.toFixed(1)}s${skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''}]`
      return `${answers.join('\n\n')}\n\n${footer}`
    }
  }
]

const GUIDANCE = [
  'Local Ollama models run on this machine and cost no cloud tokens. Use ask_local_model to save tokens on bulky, low-risk reading work:',
  '- Questions about large files, logs, or long command output (redirect output to a file inside your project first: `files` are read only inside your MCP roots), and summaries of them: pass the paths in `files` so the content never enters your context.',
  '- "Where is X handled / which files deal with Y" across many files when an exact-text search is not enough (for exact strings, Grep and Glob are faster and exact — prefer them). A whole source folder can take a minute or two, so narrow `files` when you can.',
  '- First drafts of boilerplate, docs, commit messages or test data that you will review.',
  'Do not use it for small files (just read them), for decisions that need judgement, or for code you will not check. Local models are slower and can be wrong: verify anything you act on, e.g. open the lines it cites.'
].join('\n')

async function instructions() {
  try {
    const list = await models()
    if (!list.length) return 'Ollama is running but has no models pulled, so these tools cannot be used yet.'
    const names = list.map((m) => `${m.name} (${m.details?.parameter_size ?? '?'})`).join(', ')
    const missing = DEFAULT_MODEL && !list.some((m) => m.name === DEFAULT_MODEL)
    const def = !DEFAULT_MODEL ? ` No default is set: omit \`model\` to use ${list[0].name}, the first one.`
      : missing ? ` The configured default, ${DEFAULT_MODEL}, isn't pulled: pass \`model\`, or pull it with \`ollama pull ${DEFAULT_MODEL}\`.`
        : ` Default: ${DEFAULT_MODEL} — omit \`model\` to use it (switching models costs a load of up to a minute).`
    return `${GUIDANCE}\n\nAvailable models: ${names}.${def}`
  } catch {
    return `Ollama is not reachable at ${OLLAMA_HOST} right now, so don't use these tools unless the user starts it.`
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// The client's MCP roots: asked with roots/list at each call that reads files, when initialize declared them.
const roots = rootsClient((m) => process.stdout.write(JSON.stringify(m) + '\n'))

async function handle(msg) {
  if (roots.handle(msg)) return // the client's answer to our roots/list
  const { id, method, params } = msg ?? {}
  if (!method) return
  const isRequest = id !== undefined && id !== null
  switch (method) {
    case 'initialize':
      roots.initialize(params)
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ollama', version: VERSION },
        instructions: await instructions()
      })
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
      try {
        const result = await tool.run(params?.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text: result }] })
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.message }], isError: true })
      }
    }
    default:
      if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return replyError(null, -32700, 'Parse error')
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m)
})
