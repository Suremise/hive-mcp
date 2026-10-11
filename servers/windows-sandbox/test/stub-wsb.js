/**
 * A scripted stand-in for wsb.exe (tests only): the server runs `node stub-wsb.js <args>` when WSB_STUB points here.
 * Launches nothing. Its state is a JSON file (WSB_STUB_STATE), shared by the server and the watchdog processes:
 *   { sandboxes: [ids], out: { id: hostOutDir }, calls: [args], killed: [pids], fail: { ... } }
 * `fail` scripts faults:
 *   list: 'exit' | 'garbage' | 'noarray' | 'badid'   every list fails that way
 *   listAfterStop: same, but only once a stop was called
 *   stop: n            the first n stops fail (exit 1); -1 = always
 *   stopLies: true     stop exits 0 but the Sandbox stays listed
 *   start: true        start fails
 *   others: [ids]      Sandboxes not started here, always listed
 *   session: n         exec as ExistingLogin fails until n such calls were made
 *   guest: [{ match, exit, stdout, stderr }]   a guest command matching the regex `match` (the first that does) gets
 *                      that exit code and output instead of being simulated below
 * Guest commands given to the run wrapper (base64 in -B64) are simulated:
 *   echo <text> | exit <n> | big <bytes> | err <text> | cwd | write <rel path> <text> | link <name> <target> |
 *   hang | hang-nopid | hang-pid <text> | wrapper-fails
 * The wrapper's files go directly into the out folder (<name>.stdout.txt, .stderr.txt, .pid, .exit, .error.txt).
 */
const fs = require('fs')
const path = require('path')

const STATE = process.env.WSB_STUB_STATE
const args = process.argv.slice(2).filter(a => a !== '--raw')
const out = s => process.stdout.write(typeof s === 'string' ? s : JSON.stringify(s))

function withState(fn) {
  const lock = STATE + '.lock'
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break } catch { if (i > 400) throw new Error('stub lock'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
  }
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    s.calls ||= []; s.sandboxes ||= []; s.out ||= {}; s.killed ||= []; s.fail ||= {}; s.n ||= {}
    const r = fn(s)
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
    return r
  } finally {
    fs.rmdirSync(lock)
  }
}
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const guid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => '0123456789abcdef'[Math.floor(Math.random() * 16)])

const r = withState(s => {
  s.calls.push(args)
  const cmd = args[0]
  const count = k => (s.n[k] = (s.n[k] || 0) + 1)
  if (cmd === '__window') return { stdout: args[1] === 'close' ? 'closed' : 'minimised' }
  if (cmd === 'list') {
    const mode = s.fail.list || (s.n.stop && s.fail.listAfterStop)
    if (mode === 'exit') return { code: 5, stderr: 'Access denied' }
    if (mode === 'garbage') return { stdout: 'garbage' }
    if (mode === 'noarray') return { stdout: {} }
    if (mode === 'badid') return { stdout: { WindowsSandboxEnvironments: [{ Id: 3 }] } }
    return { stdout: { WindowsSandboxEnvironments: [...s.sandboxes, ...(s.fail.others || [])].map(Id => ({ Id })) } }
  }
  if (cmd === 'start') {
    if (s.fail.start) return { code: 1, stderr: 'start failed (0x80070422)' }
    const id = guid()
    s.sandboxes.push(id)
    const m = /<HostFolder>([^<]*)<\/HostFolder><SandboxFolder>C:\\out<\/SandboxFolder>/.exec(opt('-c'))
    if (m) s.out[id] = m[1].replace(/&amp;/g, '&')
    s.lastConfig = opt('-c')
    return { stdout: { Id: id } }
  }
  if (cmd === 'stop') {
    const n = count('stop')
    const id = opt('--id')
    if (s.fail.stop === -1 || n <= (s.fail.stop || 0)) return { code: 1, stderr: 'stop failed' }
    if (!s.fail.stopLies) s.sandboxes = s.sandboxes.filter(x => x !== id)
    return { stdout: '' }
  }
  if (cmd === 'connect') return { stdout: '' }
  if (cmd === 'exec') {
    const id = opt('--id')
    if (!s.sandboxes.includes(id)) return { code: 1, stderr: 'not found' }
    const line = opt('-c')
    if (opt('-r') === 'ExistingLogin' && count('session') <= (s.fail.session || 0)) return { code: 2147943712, stderr: 'A specified logon session does not exist. (0x80070520)' }
    const host = p => path.join(s.out[id], p.replace(/^C:\\out\\?/i, ''))
    const kill = /^taskkill\.exe \/PID (\d+) \/T \/F$/.exec(line)
    if (kill) { s.killed.push(Number(kill[1])); return { stdout: { ExitCode: 0 } } }
    if (/screenshot\.ps1/.test(line)) {
      const p = host(/-Path (\S+)/.exec(line)[1])
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]))
      return { stdout: { ExitCode: 0 } }
    }
    const run = /run\.ps1 -Name (\.run-\d+) -Shell (\w+) -B64 (\S+) -Cwd "([^"]*)"$/.exec(line)
    // Like the real wrapper: a backslash before a closing quote escapes it, and PowerShell never starts the script.
    if (/run\.ps1/.test(line) && (!run || /\\"/.test(line))) return { code: 0, stdout: { ExitCode: 1 } }
    if (run) {
      const command = Buffer.from(run[3], 'base64').toString('utf8')
      const scripted = (s.fail.guest || []).find(g => new RegExp(g.match, 'i').test(command))
      return { guest: { out: s.out[id], name: run[1], command, cwd: run[4], scripted } }
    }
    return { stdout: { ExitCode: 0 } }
  }
  return { code: 1, stderr: `stub: unknown command ${cmd}` }
})

if (r.guest) {
  // The wrapper's side of a run, outside the lock (a hang must not hold it).
  const { out: dir, name, command, cwd, scripted } = r.guest
  const w = (ext, t) => fs.writeFileSync(path.join(dir, name + ext), t)
  if (scripted) {
    w('.pid', '4242')
    if (scripted.stdout) w('.stdout.txt', scripted.stdout)
    if (scripted.stderr) w('.stderr.txt', scripted.stderr)
    w('.exit', String(scripted.exit || 0))
    out({ ExitCode: scripted.exit || 0 })
    process.exit(0)
  }
  const [verb, ...rest] = command.split(' ')
  const text = rest.join(' ')
  if (verb === 'wrapper-fails') { w('.error.txt', 'Start-Process : This command cannot be run.'); out({ ExitCode: 1 }); process.exit(0) }
  w('.pid', verb === 'hang-nopid' ? '' : verb === 'hang-pid' ? text : '4242')
  let code = 0
  if (verb === 'echo') w('.stdout.txt', text + '\r\n')
  else if (verb === 'cwd') w('.stdout.txt', cwd + '\r\n')
  else if (verb === 'err') w('.stderr.txt', text)
  else if (verb === 'exit') code = Number(text)
  else if (verb === 'big') w('.stdout.txt', Buffer.alloc(Number(text), 'a'))
  else if (verb === 'write') { fs.mkdirSync(path.dirname(path.join(dir, rest[0])), { recursive: true }); fs.writeFileSync(path.join(dir, rest[0]), rest.slice(1).join(' ')) }
  else if (verb === 'link') fs.symlinkSync(rest[1], path.join(dir, rest[0]), fs.statSync(rest[1]).isDirectory() ? 'junction' : 'file')
  else if (verb.startsWith('hang')) setInterval(() => {}, 1000)
  if (!verb.startsWith('hang')) { w('.exit', String(code)); out({ ExitCode: code }) }
} else {
  if (r.stdout !== undefined) out(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exitCode = r.code || 0
}
