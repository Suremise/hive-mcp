# Release testing with Windows Sandbox (Hive example)

> **Hive-specific.** This file describes how the Hive desktop app uses this server in its own release process: an
> example consumer. Nothing here is needed to use the server. Paths like `<Hive repo>` are a checkout of Hive's
> source repo.

## In the release: run the checks on the release candidate

When a Hive release candidate (RC) is built, and before anyone installs and tests it by hand, the release agent
checks it on a clean Windows:

```powershell
node <this repo>\servers\windows-sandbox\scenarios\hive-checks.js `
  --installer "<Hive repo>\dist\<RC folder>\Hive-Setup-<version>.exe" `
  --hive "<Hive repo>" `
  --report "$env:LOCALAPPDATA\hive-test\sandbox-reports\<version>-rc"
```

- **What it runs:** about 3 minutes, two Sandboxes, the network off, and Hive's e2e fake CLIs only. No real CLI,
  sign-in or credential goes into the Sandbox. Whatever needs a real CLI stays with the hand-run tests.
- **One Sandbox at a time** runs on the machine. If another one is running, the run says `NOT RUN` (exit 2): wait, or
  pass `--wait-min 30`. It never stops a Sandbox it didn't start.
- **Attach the report to the release:**
  - the verdict line and any failed checks;
  - the path of the report folder (`report.md`, `report.json`, the screenshots).

  A failed check is a release finding, like a failing e2e suite. The "same version" and "No Git" notes are expected
  for an RC (test builds keep the last release's number).
- **Optionally**, `node …\scenarios\compare-workspace.js --report <that folder> --workspace <a Hive workspace>` adds
  `comparison.md`: the fresh install against that workspace, by name only.

The runner starts its own copy of the server with its own settings, so the release step needs **no** MCP
registration.

## Who gets the MCP server

The MCP tools (`sandbox_start`, `sandbox_run`, …) are for an agent working in a Sandbox by hand. Hive turns MCP
servers on per workspace and off per project, **not per agent**: every agent started in a project where the server is
on gets it.

- **Until Hive has a per-agent switch**, the server is on only in a dedicated **release-testing project** that holds
  **only the release-testing agent**:
  1. Add `windows-sandbox.zip` with **Add MCP Server from File** (or copy the server's files to
     `<workspace>\.hive\mcp\windows-sandbox\`). Its definition needs no build paths: each agent's project folder is
     its root (see the README's "Multiple projects").
  2. In the MCP view, enable `windows-sandbox` for the workspace, then turn it **off** in every other project's MCP
     tab. A project added to the workspace later gets it too, until it is turned off there.
  3. Add the release-testing project, and start only the release-testing agent in it.
- **The limitation:** any other agent started in that project gets the server too, so nobody starts other agents
  there.
- **A per-agent MCP switch in Hive is a prerequisite** for any use in a shared project.
- `WSB_MCP_ENABLED=1` is a **kill switch**, not caller authentication: the server can't tell which agent calls it.
  Remove it (or the config entry) to turn the server off everywhere.
