/**
 * Probe 03: timings over three cold starts (network off, no folders but one writable out), state discarded between
 * runs, and what a killed `wsb exec` (a host-side timeout) leaves running inside. Always stops each Sandbox.
 */
const { mkdirSync, existsSync, readFileSync } = require('fs')
const { join } = require('path')
const { wsb, config, exec, until, withSandbox } = require('./lib')

const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null)

;(async () => {
  const summary = []
  for (let n = 1; n <= 3; n++) {
    const t0 = Date.now()
    const r = await withSandbox(`03-timing-${n}`, dir => {
      mkdirSync(join(dir, 'out'), { recursive: true })
      return config({ networking: false, folders: [{ host: join(dir, 'out'), sandbox: 'C:\\out', readOnly: false }] })
    }, async ({ id, dir, log, results }) => {
      const s = results.steps
      s.readyMs = await until(async () => (await exec(id, 'cmd.exe /c ver', 'System')).code === 0, 180_000, 250)
      s.startToReadyMs = Date.now() - t0
      // State from the previous run must be gone: run 1 leaves a marker on C:\, later runs look for it.
      await exec(id, 'cmd.exe /c if exist C:\\left-by-earlier-run.txt (echo FOUND) else (echo absent) > C:\\out\\marker.txt', 'System')
      s.earlierMarker = read(join(dir, 'out', 'marker.txt'))
      await exec(id, 'cmd.exe /c echo run > C:\\left-by-earlier-run.txt', 'System')
      if (n === 1) {
        // A host-side timeout: kill the wsb exec client after 3 s while a 30 s command runs inside.
        const killed = await wsb(['exec', '--id', id, '-c', 'cmd.exe /c ping -n 31 127.0.0.1 > C:\\out\\long.txt', '-r', 'System'], 3000)
        s.killedExec = { code: killed.code, ms: killed.ms }
        await new Promise(r => setTimeout(r, 2000))
        await exec(id, 'cmd.exe /c tasklist /fi "imagename eq ping.exe" /fo csv /nh > C:\\out\\after-kill.txt', 'System')
        s.afterKill = read(join(dir, 'out', 'after-kill.txt'))
        log('killed exec:', s.killedExec, 'inside afterwards:', s.afterKill)
      }
      log('run', n, { startMs: s.start?.ms, readyMs: s.readyMs, startToReadyMs: s.startToReadyMs, earlierMarker: s.earlierMarker })
    })
    summary.push({ n, start: r.steps.start?.ms, startToReady: r.steps.startToReadyMs, stop: r.steps.stop?.ms, earlierMarker: r.steps.earlierMarker, leftRunning: r.leftRunning, error: r.error })
  }
  console.log(JSON.stringify(summary, null, 2))
})()
