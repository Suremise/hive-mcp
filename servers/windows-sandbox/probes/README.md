# Windows Sandbox probes

Small scripts that measured what `wsb.exe` can do before the server was written. They are kept so the behaviour can
be checked again on a new Windows or Sandbox version. **They aren't part of the server**, and aren't packed into its
zip.

Node 18+ and built-ins only. Each probe:
- starts **one** Sandbox;
- refuses if one is already running, or if `wsb list` fails (so it can't tell);
- always stops it (also after a failure or Ctrl+C), then lists running Sandboxes to confirm none is left (`lib.js`,
  `withSandbox`).

Cleanup fails closed:
- the Sandbox's id is kept until `list` confirms it is gone, and stop is retried (three attempts);
- a failed stop, a failed or malformed `list`, or any Sandbox still running marks the run failed
  (`results.json` → `cleanup: "FAILED"`, `error`), with a non-zero exit code.

`fault-check.js` checks that behaviour with `wsb.exe` stubbed, launching nothing: `node fault-check.js`.

Folders are mapped read-only except one writable `out` folder. Logs, results and screenshots go to
`%LOCALAPPDATA%\combwork-mcp-tests\wsb-probe-<time>\<probe>\`, never the repo (`PROBE_SCRATCH` sets that root).
Earlier versions wrote them under another folder of `%LOCALAPPDATA%`; nothing moves or removes those.

| Probe | Network | What it checks |
|---|---|---|
| `01-lifecycle.js` | off | start with a config; exec as System or the user; exit codes; whether exec returns output or blocks; read-only and writable folders; `wsb share` after start; `wsb ip`; that the network is really off |
| `03-timing.js` | off | three cold starts in a row; state discarded between runs; what a killed `wsb exec` leaves running inside |
| `05-session.js` | off | desktop screenshots with the connect window shown, minimised and closed; a timeout kill inside by PID |

`inside/` holds the scripts that run inside the Sandbox, mapped read-only at `C:\probe`:
- `screenshot.ps1`: the desktop as a PNG (user session only).

```powershell
node servers\windows-sandbox\probes\01-lifecycle.js
```

Probe 05 runs `wsb connect`, which opens the Sandbox window on the desktop until the Sandbox stops. It closes it
early, choosing only the `WindowsSandboxRemoteSession.exe` whose command line holds that Sandbox's id.
