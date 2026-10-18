# windows-sandbox

An MCP server that lets an agent test a build on a clean, throwaway Windows in
[Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/).
It can start a Sandbox with the build folder mapped read-only, run commands and get their output, take desktop
screenshots, get files back from one writable folder, and always stop it again. It drives `wsb.exe` and runs over
stdio (`node server.js`), with Hive or any other MCP client.

It uses only Node built-ins: no dependencies, no `npm install`. Version 1.1.0. MIT licence ([LICENSE](../../LICENSE)).

## Requirements

- Windows 11 **Pro, Enterprise or Education, 24H2 (build 26100) or later**, with virtualisation turned on in the
  firmware. Windows Home has no Windows Sandbox.
- The **Windows Sandbox** optional feature turned on, so that `wsb.exe` exists
  (`%LOCALAPPDATA%\Microsoft\WindowsApps\wsb.exe`).
- Node 18+ on `PATH`.

## Safety at a glance

| The server can | The server can't |
|---|---|
| Map the build folder you name, if it resolves under one of your **MCP roots** (the client's project folders), **read-only**. | Map a build outside your roots (and outside `WSB_ALLOWED_ROOTS`, when that is set too), or any folder not in `WSB_TOOL_DIRS`. |
| Map each folder in `WSB_TOOL_DIRS` **read-only**. | Map your user profile, its dot-folders (`~/.ssh`, `~/.claude`, …), `AppData` and its top folders, anything under `AppData\Roaming`, or its own out folders, whatever the config says. |
| Write to **one** fresh per-run folder (`C:\out` inside). | Write anywhere else on the host. |
| Turn on networking for one Sandbox, only when `sandbox_start` asks for it. | Redirect the clipboard, audio, video or printers (always off). |
| Turn **Smart App Control off inside one Sandbox**, only when `sandbox_start` asks for it (`smartAppControl: 'off'`; off by default). | Change Smart App Control or any other security setting **on the host**. |
| Read back files from that run's out folder, as untrusted data. | Follow links out of the out folder, or read files beside it. |
| Run `wsb.exe` and its own watchdog on the host. | Run any other program on the host, apart from one fixed PowerShell command that minimises or closes the Sandbox's own window. |

**Don't put real sign-ins, tokens or real CLIs in the Sandbox.** It's for testing a build on a clean machine. Use
fake CLIs and test accounts. Full details are under "Security model" below.

### What the confinement guarantees

- **Guaranteed:** whatever path or link an agent passes:
  - a **build folder** is mapped only from inside the client's roots (or the configured fallback, see "Multiple
    projects");
  - the only other folders mapped are the **tool folders you configured** in `WSB_TOOL_DIRS` and the server's own
    `inside\` scripts;
  - nothing is ever mapped from the user profile itself (or a folder containing it), its dot-folders, `AppData`
    itself or its top folders (`Local`, `LocalLow`, `Roaming`), anything under `AppData\Roaming`, or the server's out
    folders (see "Security model"). Folders deeper in `AppData\Local` aren't refused for that reason alone.

  Paths are checked by their real path, so links and junctions count where they lead.
- **Not guaranteed:** protection from a local program running as you that changes the project's folders (e.g. swaps
  a folder for a junction) at the instant between the check and the Sandbox start. Such a program can already read
  those files itself.

## Setup

1. Turn on Windows Sandbox (*Turn Windows features on or off* → **Windows Sandbox**, then restart), and check that
   `wsb.exe` exists.
2. Choose the tool folders the guest needs (`WSB_TOOL_DIRS`). The guest has no Node, so map yours as `node=…` if your
   tests need it. Build folders need no setting for a client that sends MCP roots: see "Multiple projects".
3. Add the server to your client, as below, with `WSB_MCP_ENABLED=1`.

**In any MCP client** (Claude Code, Codex, Copilot, Claude Desktop, …):

```json
{
  "mcpServers": {
    "windows-sandbox": {
      "command": "node",
      "args": ["C:\\path\\to\\hive-mcp\\servers\\windows-sandbox\\server.js"],
      "env": {
        "WSB_MCP_ENABLED": "1",
        "WSB_TOOL_DIRS": "node=C:\\Program Files\\nodejs"
      }
    }
  }
}
```

Builds then come from the client's roots (the project you are working in). For a client that sends none (Codex and
the Copilot CLI, today), add `"WSB_ROOTS_FROM_CWD": "1"` or `WSB_ALLOWED_ROOTS` (see "Multiple projects"). A setting
that names a folder that doesn't exist is reported by `sandbox_status` and `sandbox_start`. Per-run folders go to
`%LOCALAPPDATA%\hive-test\sandbox` unless you set the optional `WSB_SANDBOX_ROOT` (see "Configuration").

The [top-level README](../../README.md#install) shows the same entry for each client's config format.

**In Hive:** pack it (`node scripts\pack.mjs windows-sandbox` at the repo root) and add `dist\windows-sandbox.zip`
with **Add MCP Server from File** in the MCP view. Its definition goes in as `hive-mcp.example.json`: check `env`
(`WSB_TOOL_DIRS` names Node's usual folder), then turn it on, and only in a dedicated project (see "Who gets it"). It
sets `WSB_ROOTS_FROM_CWD=1`, because Hive starts each agent in its project folder or worktree: Claude Code agents send
that folder as their root, and Codex and Copilot agents start the server there.

[`hive-mcp.example.json`](hive-mcp.example.json) is that definition: the same entry in Hive's format, where
`${HIVE_MCP_DIR}` is the folder Hive keeps its MCP servers in.

**What the server needs to run:** `server.js`, `wsb.js`, `confine.js`, `watchdog.js`, `roots.js`, `inside\run.ps1`
and `inside\screenshot.ps1`. `roots.js` is a copy of the repo's [`shared/roots.js`](../../shared/roots.js). `client.js` is a small stdio client for scripts and the tests. Everything else in this
folder is tests, probes, or an example consumer (below).

## Multiple projects (MCP roots)

One installed server serves every project: the build folder must be inside the project of the agent calling it.

- **MCP roots.** A client that supports roots tells the server which folders it is working in. Claude Code sends its
  working folder (a project folder or a worktree) and each `--add-dir`. At each `sandbox_start`, the server asks for
  the current roots, so a changed list counts. A build must really resolve (realpath, so no junction tricks) under one
  of them.
- **Clients that send no roots** (Codex and the Copilot CLI, as of this writing) get a clear refusal, unless one of
  these is set:
  - `WSB_ROOTS_FROM_CWD=1`: the folder the client started the server in is the root. Codex and the Copilot CLI start
    it in the project folder. A drive root never counts.
  - `WSB_ALLOWED_ROOTS`: a fixed list of folders, the fallback on its own.
- **`WSB_ALLOWED_ROOTS` with roots narrows them:** a build must then be under a root **and** under one of its folders.
  It never widens what the client gave.
- **A client that declares roots but doesn't answer** (an error, or no answer in 5 s) is refused. There's no silent
  fallback.
- **Whatever the roots say**, the user profile itself (or a folder containing it), its dot-folders, `AppData` and its
  top folders, anything under `AppData\Roaming`, and the server's out folders are refused. A root that is one of them is dropped, and the reply says so.
- `sandbox_status` says where the allowed folders came from, and lists them.

## Tools

| Tool | What it does |
|---|---|
| `sandbox_start({ build?, network=false, session=true, closeWindow=false, tools?, maxMinutes=30, smartAppControl='keep' })` | Starts one Sandbox. Maps `build` read-only at `C:\build`, each tool folder read-only at `C:\tools\<name>` (default: all configured), the server's `inside\` scripts read-only at `C:\wsb-mcp`, and one fresh writable folder at `C:\out`. With `session`, opens the Sandbox window **minimised** and waits up to 90 s for the user session (commands as the user and desktop screenshots need it). `closeWindow` closes the window once the session is up: desktop shots are then blank, window shots from a script inside still work. `smartAppControl: 'off'` turns Smart App Control off inside this Sandbox (see "Smart App Control in the Sandbox"). Refuses if `wsb list` fails, if any Sandbox is running, or if a folder isn't allowed. Replies with the id, timings, mappings, network state, Smart App Control (when asked off) and deadline. |
| `sandbox_run({ command, shell='cmd'\|'powershell', as='user'\|'system', timeoutSec=120, cwd? })` | Runs a command through `inside\run.ps1`, which records its PID and redirects stdout and stderr into `C:\out\.run-<n>.stdout.txt` / `.stderr.txt` (`.pid`, `.exit`, and `.error.txt` if the wrapper itself fails). Replies with the exit code, stdout and stderr (16 KB each, read capped, saying when cut). **On a timeout it kills the command inside by that PID** (`taskkill /T /F`): killing `wsb exec` alone would leave it running, and a command waiting on a dialog blocks forever. If the PID file is missing or not a valid number, it says "no PID" and `sandbox_stop` is the fallback. |
| `sandbox_screenshot({ maxWidth=1280 })` | A desktop screenshot as the user (CopyFromScreen, scaled down, JPEG) saved as `C:\out\.shot-<n>.jpg` and returned as an image. Errors without a user session or after `closeWindow`, because the shot would be blank. |
| `sandbox_collect({ paths?, glob?, maxBytes=256 KB, maxTotalBytes=1 MB, base64=false })` | Files from the run's out folder only. **While the Sandbox runs, only files directly in `C:\out`; files in its folders after `sandbox_stop`** (see "Reading back"). `paths` are relative to out; `glob` is matched against a listing of out (`*`, `?` within a folder, `**` across). With neither, lists the files (and, while running, the folders to collect after stop). Text comes back as text, PNG/JPEG as images, other binaries with `base64`. |
| `sandbox_stop()` | Stops and discards it. Says "Stopped" only once `wsb list` confirms it's gone; otherwise reports **CLEANUP FAILED** with the id kept. |
| `sandbox_status()` | What's running, for how long, the deadline, the watchdog, any unconfirmed stop, `wsb list`, and what the start-up check found. Works with the server turned off. |

### Smart App Control in the Sandbox

A fresh Sandbox can come up with **Smart App Control enforcing**, and then Windows refuses every unsigned program
("An Application Control policy has blocked this file"): an unsigned installer, or a build you are still working on,
can't be tested there at all. `sandbox_start({ smartAppControl: 'off' })` turns it off **in that Sandbox only**, so it
can:
- **Off by default.** Without the option (`'keep'`), the server leaves Smart App Control as Windows set it.
- **Inside the Sandbox only, never the host.** The server sends the change as guest commands, through the run wrapper,
  to the Sandbox it just started (`wsb exec --id <its id>`, as System inside): set
  `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` `VerifiedAndReputablePolicyState` to 0, then
  `CiTool.exe --refresh`, which takes effect at once (no reboot). The guest's registry is its own; it goes with the
  Sandbox at `sandbox_stop`. Nothing in the server can run that change on the host.
- **Read back, said plainly.** The server reads the value back: the reply says "Smart App Control turned OFF in this
  Sandbox by option", or "NOT turned off" with why (unsigned installers will then still be blocked), and
  `sandbox_status` says the same while it runs.
- **What it costs.** The Sandbox then runs any program, signed or not, as Windows without Smart App Control would. It
  is still the throwaway, network-off Sandbox, but a test with it on says nothing about how a signed build fares: test
  the signed build as it ships when you have one.

Errors name the cause:
- `wsb.exe` missing (the feature isn't installed);
- Windows older than 24H2;
- virtualisation off (from `wsb start`'s error);
- `wsb list` failing;
- a Sandbox already running that this server didn't start;
- no user session.

## Configuration (`env`)

| Variable | Meaning |
|---|---|
| `WSB_MCP_ENABLED` | Must be `1`, or every tool refuses (status still answers). A **kill switch**, so a copied config doesn't silently turn it on; it is **not** caller authentication (see "Who gets it"). |
| `WSB_ALLOWED_ROOTS` | Optional. `;`-separated folders. With MCP roots it **narrows** them (a build must be under both); without, it is the list of folders builds may come from. See "Multiple projects". |
| `WSB_ROOTS_FROM_CWD` | Optional. `1`: for a client that sends no MCP roots, the folder it started the server in is the root (never a drive root). |
| `WSB_TOOL_DIRS` | `;`-separated `name=folder` pairs mapped read-only at `C:\tools\<name>`, e.g. `node=C:\Program Files\nodejs`. All optional: add what your tests need inside (the Hive checks below pass their own, `playwright` and `hive-tests`). |
| `WSB_SANDBOX_ROOT` | Optional. Where per-run folders go (default `%LOCALAPPDATA%\hive-test\sandbox`): `<run>\out` (the writable folder), `config.xml`, `state.json`, `watchdog.json`/`.log`. Also `session-times.jsonl` (connect → user session times). |
| `WSB_SESSION_WAIT_MS` | Optional. How long `sandbox_start` waits for the user session (default 90000). |

Test-only: `WSB_STUB` (a Node script run instead of `wsb.exe`), `WSB_STOP_RETRY_MS`, `WSB_WATCHDOG_CHECK_MS`.

## Security model

**Who gets it.** An MCP server is available to every agent its client gives it to, and it can't tell its callers
apart: a stdio server only knows that its launcher started it. Give it only to the agent that does the testing. In
Hive, MCP servers are turned on per workspace and off per project, not per agent: every agent started in a project
where this server is on gets it. So turn it on **only in a dedicated testing project that holds only the testing
agent**, and off everywhere else. Starting any other agent in that project hands it the server too.

**What goes in.**
- The build folder and tool folders are **read-only**; there is exactly **one writable folder**, a fresh per-run
  `out` created by the server.
- Only builds that resolve under the client's MCP roots (or the fallback, see "Multiple projects") and folders listed
  in `WSB_TOOL_DIRS` (tools) can be mapped. Whatever the roots or the config say, the server refuses:
  - the user profile itself, and anything containing it;
  - any dot-folder in it (`~/.claude`, `~/.codex`, `~/.copilot`, `~/.ssh`, …);
  - `AppData` and its top folders, and everything under `AppData\Roaming`;
  - its own out folders.
- **No real CLI, sign-in or credential goes into the Sandbox**: use fake CLIs.
- Network is **off** unless `sandbox_start` asks for it, and the reply says when it's on. Clipboard, audio, video and
  printer redirection are always off.
- Smart App Control is left as Windows set it unless `sandbox_start` asks for `smartAppControl: 'off'`, and then only
  inside that Sandbox (see "Smart App Control in the Sandbox"). No security setting on the host is ever changed.

**What runs on the host.** Only `wsb.exe`, and `node watchdog.js`. The one exception is the Sandbox's own connect window
(`WindowsSandboxRemoteSession.exe`): the server minimises it after `wsb connect` and closes it for `closeWindow`, finding
it by **its Sandbox id in the command line**, never by name, through one fixed PowerShell command (the id is checked to
be a GUID first).

**Reading back.** Everything in `out` was written by the guest, so the host treats it as untrusted: a careless read
could follow a link and read host files. (Measured on build 26200: the guest **can't** create junctions or symlinks in
the mapped folder, "Access is denied" as System and as the user, but it can create hard links inside it. The rules
below don't rely on that; the smoke test checks it so a Windows change is noticed.) For every host read
(`sandbox_collect`, `sandbox_run`'s output and PID files, screenshots):
- paths are relative to `out`: absolute, drive (`C:`), UNC and device paths (`\\server`, `\\?\`, `\\.\`), `..`, `:`
  (streams) and device names (`CON`, `NUL`, …) are refused **before touching the disk**; globs are matched against a
  listing, never handed to the file system;
- **while the Sandbox runs**, path checks alone can't be trusted: the guest could swap a folder for a junction between
  one check and the next. So the host then reads **only files directly in the out root**, never in a subfolder:
  - the root can't be swapped: it's the share's root, and the server holds a file in it (`.wsb-mcp-pin`) open
    exclusively for the whole run, so it is never empty and can't become a junction;
  - each file is **opened exclusively first** (share mode 0, so it can't be renamed, replaced or deleted while open),
    and only then checked: the root's entry of that name must be a plain file, not a link or any reparse point, with
    the **same file id** as the open handle and **a single hard link**;
- **after a confirmed stop**, nothing changes `out` any more, so folders can be read too:
  - each path component is checked as a directory entry. **Symlinks, junctions and other reparse points are skipped
    and reported, never followed**, in listings too;
  - the realpath must stay inside `realpath(out)`;
  - the opened file must be the one checked, with a single hard link;
- bytes are **capped while reading** (per file and per call; never read whole and cut), and listings are capped
  (1000 files, 10000 entries, depth 16);
- guest metadata is data: a PID must be a plain positive integer in range or the run says "no PID"; output is returned
  as text, never interpreted.

**Always stop, failing closed.**
- `wsb list` counts only with exit 0 and valid JSON holding an array of string Ids; anything else is "unknown", never
  "none". Start refuses when it's unknown or anything is running (one Sandbox at a time).
- A stop is retried 3 times, a few seconds apart. It counts only once `list` confirms the id is gone (`stop` exiting
  0 isn't enough). Otherwise:
  - the reply is **CLEANUP FAILED**, and the id is kept;
  - `sandbox_run` and `sandbox_start` refuse until a later `sandbox_stop` confirms it.
- Each Sandbox has a deadline (`maxMinutes`, default 30, at most 240). The server stops it when stdin closes or on a
  signal (exit code 1 if that stop isn't confirmed).
- A **detached watchdog** (`watchdog.js <runDir>`) starts right after `wsb start`, with a pipe from the server. It
  stops the Sandbox, with the same confirm-and-retry rule, when:
  - the pipe closes;
  - the server's PID dies (killed hard, so no exit handler ran);
  - or the deadline passes.

  It keeps trying in bounded rounds and records the outcome in `watchdog.json`.
- `state.json` keeps the id until a stop is confirmed. A restarted server stops any Sandbox an earlier run of it left
  unconfirmed (whose server is no longer running), and never touches one it didn't start.

## Limits

- **One Sandbox at a time, on the whole machine**: that's a Windows Sandbox limit. If another one is running (yours or
  another agent's), `sandbox_start` refuses; wait and try again, rather than stopping it.
- Inside there is PowerShell 5.1, Edge and `curl.exe`, but **no Node, Git or Notepad**: map Node as a tool folder.
  PowerShell's `Out-File` writes UTF-16 unless given `-Encoding utf8`.
- A cold start takes tens of seconds, plus up to 90 s for the user session.
- Output and collected files are capped (16 KB per stream for `sandbox_run`; 256 KB per file and 1 MB per call by
  default for `sandbox_collect`). Write big results to a file in `C:\out` and collect it after `sandbox_stop`.
- While the Sandbox runs, only files directly in `C:\out` can be read back; files in its folders are read after
  `sandbox_stop`.
- If the client kills the server's whole process tree or job, the watchdog may go with it; the state file and the
  next server start are then the fallback.

## Tests

From the repo root, `npm test` runs every automated test below (`wsb.exe` stubbed, about a minute). From this folder:

```powershell
node ..\..\test\clean-scratch.js   # npm test does this first: clears earlier runs' scratch (below)
node --test test\roots.test.js test\confine.test.js test\wsb.test.js test\server.test.js test\watchdog.test.js test\smoke-faults.test.js test\report.test.js test\hive-checks.test.js test\compare.test.js
node test\smoke.js --runs 3     # real Sandbox; skips cleanly where it's unavailable or another one is running
```

- `roots.test.js`: build folders from MCP roots: roots given, a build outside them or through a junction, no roots
  (the refusal, `WSB_ALLOWED_ROOTS` alone, `WSB_ROOTS_FROM_CWD`), the env list narrowing roots, roots changed between
  starts, a profile root dropped, a client that fails to answer. The rules themselves: `test/shared.test.js` at the
  repo root.
- `confine.test.js`: confinement acceptance:
  - paths refused without touching the disk;
  - a symlink and a junction pointing out of `out`;
  - read caps, measured in bytes read from disk;
  - junk PIDs, and globs;
  - live reads under real swaps made at the exact points between check and open: a link swapped in before the
    open, a link for the open and a plain file after it, rename/replace/delete while open, a hard link to an
    outside file, a top-level folder swapped for a junction, and the root pin.
- `wsb.test.js`: fail-closed `list` and stop (failed or malformed list, failing stop retried 3 times, stop exit 0 while
  still listed, list failing after stop), the config XML.
- `server.test.js`: every tool over stdio against `test\stub-wsb.js` (guards, folder rules, run/timeout kill, collect
  through the tool, failed cleanups, stdin close, hard kill → watchdog, restart recovery). Also `smartAppControl`: off
  by default, its commands going only to the started Sandbox as System, read back, a change that doesn't take said
  plainly, and that no other file of the server or the runner names the change.
- `watchdog.test.js`: the watchdog's triggers and its fail-closed stop.
- `smoke-faults.test.js`: `smoke.js`'s own cleanup under faults (the watchdog failing, its evidence unreadable, every
  stop failing): every Sandbox it starts is stopped, or named in `smoke.json` → `leftRunning` with a non-zero exit.
- `report.test.js`, `compare.test.js`, `hive-checks.test.js`: the example consumer below (its report, its
  comparison, and its runner's options, its pick of the previous installer, `--smart-app-control off`, and cleanup).
- `smoke.js`, against a real Sandbox:
  - start, then run as user and as system;
  - the build folder is read-only, the network is off, and PowerShell errors come back as plain text;
  - the guest can't create links in `C:\out`;
  - a timeout kill inside, a screenshot, and collect (a file in a folder refused while running, read after the stop);
  - stop confirmed;
  - `--runs N` times the user session over N starts;
  - then, with no build mapped, a hard kill of the server that the watchdog must clean up.

  Every Sandbox it starts gets a fallback stop in a `finally`. Scratch goes to `WSB_TEST_SCRATCH` (default under
  `%LOCALAPPDATA%\hive-test\scratch`).

**Where the tests' output goes.** The automated tests write only to `WSB_TEST_SCRATCH` (default
`%LOCALAPPDATA%\hive-test\scratch\wsb-mcp-tests`), never the repo: a folder per test, `<pid>-<n>-<name>`, with its
fake profile, builds, sandbox runs and stub state. Before each `npm test`, the repo's `test\clean-scratch.js` removes
earlier runs' folders (tested by `test\clean-scratch.test.js` there), so the latest run's output stays there for
debugging and the folder holds about one run's worth. It removes only folders the tests made (that name, with their
`stub.json`), skips any whose test process is still running (its pid is live and the folder changed in the last hour:
Windows reuses pids), and leaves one it can't remove (a file still open) for the next run.

## Example consumer: Hive's release checks

> **Hive-specific.** Everything in this section is how the Hive desktop app tests its own installers with this
> server. The server doesn't need any of it. It is kept here as a worked example of driving the server from a script.
> The files: `scenarios\` (`hive-checks.js`, `report.js`, `compare-workspace.js`), `inside\hive\`,
> [RELEASE-TESTING.md](RELEASE-TESTING.md), and the [`probes/`](probes/) that measured `wsb.exe` before the server
> was written.

`scenarios\hive-checks.js` checks a Hive installer the way a user meets it, on a clean Windows. It writes a short
report to attach to a release, and drives this server over stdio (`client.js`), with:
- the network **off**;
- Hive's own e2e fake CLIs only, and nothing signed in;
- a timeout on every command.

```powershell
node scenarios\hive-checks.js --installer "<Hive repo>\dist\<folder>\Hive-Setup-<v>.exe" --hive "<Hive repo>"
     [--previous <older Hive-Setup-*.exe>] [--report <folder>] [--only fresh|upgrade] [--wait-min N]
     [--smart-app-control off]
```

- **The Hive repo** (`--hive`, or `HIVE_REPO`): a built checkout. It's required, and mapped read-only for
  `node_modules\playwright-core` and `tests` (the fake CLIs). Node is the host's.
- **The installers:** `--previous` defaults to the newest `Hive-Setup-*.exe` in `<hive>\dist` other than
  `--installer`, by semver: a release is newer than its prereleases (`0.9.0` over `0.9.0-rc.1` over `0.9.0-beta.1`). Both must sit under one folder, which is mapped read-only at `C:\build`. That folder can't be a
  drive root, and the two can't be on different drives; either is refused before anything starts. The runner gives
  that folder to its own copy of the server as its MCP root, so it needs no `WSB_ALLOWED_ROOTS` or MCP registration.
- **The report** (default `%LOCALAPPDATA%\hive-test\sandbox-reports\<time>`):
  - `report.md` (pass or fail per check, versions, timings, notes);
  - `report.json` (with every fact collected);
  - the screenshots, and `run.log`.
- **Exit codes:** 0 all passed; 1 a check failed; 2 not run (bad options, the Sandbox unavailable, another one
  running (see `--wait-min`), or an installer blocked, below).
- **NOT RUN: an installer blocked.** If an App Control policy in the Sandbox refuses an installer ("An Application
  Control policy has blocked this file"), that Sandbox's scenarios are **not run**. This happens when Smart App
  Control enforces in the Sandbox, which blocks every unsigned installer. Nothing after the install could be checked,
  so the report doesn't list dozens of failures that all have this one cause. Instead it says `NOT RUN` with one
  reason, lists which installer each scenario couldn't install, and leaves those checks out; the exit code is 2.
  - **Not a pass or a failure:** NOT RUN says nothing about the build. Sign the installer, or run the checks again
    with `--smart-app-control off` (below).
  - **Mixed results:** if the other Sandbox's checks ran and all passed, the verdict is still NOT RUN. If any of them
    failed, it is FAILED (exit 1), naming what wasn't run.
  - **Its state:** the runner reads Smart App Control's state in the Sandbox (`reg query`
    `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` `VerifiedAndReputablePolicyState`: 0 off, 1 on, 2 evaluation)
    for the reason and `report.json` → `meta.smartAppControl` (`{ state, option, note }`). Without the option it only
    reads it.
- **`--smart-app-control off`** (optional; off by default): checks an **unsigned** installer. Each Sandbox is started
  with `smartAppControl: 'off'`, so the server turns Smart App Control off inside it, and never on the host (see
  "Smart App Control in the Sandbox"). Before each install the runner reads the state again: if it isn't 0, that
  Sandbox's scenarios are NOT RUN with that reason and no installer is run. The report says so plainly: the line
  "**Smart App Control in the Sandbox: turned off by option**" in `report.md`, and `meta.smartAppControl.note`
  "turned off by option" in `report.json`. Such a run says nothing about signing.
- **It passes only with full coverage:**
  - every scenario asked for ran;
  - every step (each install, driver run, screenshot and collect) succeeded;
  - each driver finished its step (`completed`), with all its required checks (by id) and facts;
  - and the required screenshots were collected.

  Anything missing, a failed command or a timeout is a failed check, never a gap.
- **Cleanup:** each Sandbox is stopped in a `finally` that doesn't depend on logging, with a confirm-and-retry
  fallback. One that can't be confirmed stopped is a failed check naming its id.
- It takes about 3 minutes for both Sandboxes.

| Scenario | Sandbox | What it checks |
|---|---|---|
| 1. Fresh install and first launch | A | `/S` install; one Installed-apps entry "Hive Desktop <version>"; `%LOCALAPPDATA%\Programs\Hive`; "Hive Desktop" shortcuts on the Desktop and in the Start menu; the first screen; the profile `%APPDATA%\Hive`; the version the app reports. Desktop and Installed-apps screenshots. |
| 2. First run with no CLIs | A | the "No coding agents are turned on… Choose providers" banner; **no** "Claude Code is not installed" warning; Agent Setup offers Claude Code, Codex and GitHub Copilot; the Agent API agrees. Window shots in both themes. |
| 3. A CLI appearing while Hive runs | A | Claude Code turned on (not found); a stand-in installer (`inside\hive\fake-claude-install.ps1`) puts the e2e fake on the user PATH in the registry; Agent Setup's "Check again" finds it (2.1.999, via PATH) **without restarting Hive**; the banner goes. |
| 4. Upgrade | B | the previous release installed and two settings changed (user name, theme); then this build with the updater's `--updated /S --force-run`; Hive started by `--force-run`; one Installed-apps entry; shortcuts renamed or kept ("Hive" → "Hive Desktop" from 0.4.x); the app code (app.asar hash) changed; settings kept. |
| 5. Uninstall | A | `"Uninstall Hive.exe" /S`; the entry, install folder and shortcuts gone; the profile kept (`deleteAppDataOnUninstall: false`). |
| 6. A new workspace | A | the fresh install opens a new workspace (one project folder): what its `.hive` holds, the Agent API's status and projects, and the workspace's views (Overview, Task Board, Shared Notes, Skills, MCP Servers, Hive Assistant) with screenshots. |

**The fresh-install comparison** (without a model) runs as:

```powershell
node scenarios\compare-workspace.js --report <a run's report folder> [--workspace <Hive workspace folder>]
```

(`--workspace` defaults to the current folder.) It writes `comparison.md` into that report folder.
- **What it compares:** the fresh install and its new workspace, against an existing workspace (its conventions
  and history) and the machine (Git, Node, CLIs). On the workspace side: skills, Assistant modes, templates, MCP
  servers, shared notes, the board, and the projects' convention files.
- **How:** lists are compared as sets of names, showing what is only on each side, not just how many.
- **It claims only what was measured.** The run's scenario 1 and 6 records must be finished and passing, with their
  facts, and the workspace must be a readable Hive workspace. Otherwise it writes nothing and exits 1
  (`NOT COMPARED: …`). A folder that doesn't exist counts as empty; one that can't be read is an error.
- **Names only:** no note, skill or convention file is read, and no CLI home (agent memory lives there, and matters
  only with a model).

How the checks fit into a Hive release: [RELEASE-TESTING.md](RELEASE-TESTING.md).

The report also makes two notes of its own:
- **No Git** on a fresh machine (Hive's Git warning).
- A previous release with the **same version** as the build. Test builds keep the last release's number, so the
  in-app updater wouldn't offer them, and the upgrade is a reinstall run with the updater's arguments.

**How it sees Hive:**
- a Playwright script inside (`inside\hive\drive.cjs`), using Hive's own playwright-core, with `_electron.launch` on
  the installed `Hive.exe` and its real profile;
- the window's `hive.invoke` IPC, for themes and settings;
- Hive's Agent API on `127.0.0.1`, for status;
- `sandbox_screenshot`, for the desktop.

`inside\hive\install.ps1` and `install-state.ps1` run the installers and record what they left: registry, folders,
shortcuts and the app.asar hash. An agent with only the MCP tools can run the same pieces itself with
`sandbox_run`, since they are mapped at `C:\wsb-mcp\hive`.
