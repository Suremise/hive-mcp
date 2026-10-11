# hive-mcp

A collection of optional [MCP](https://modelcontextprotocol.io) servers for coding agents. Each one is a small,
self-contained Node program that speaks MCP over stdio, so **any MCP client can use it**: Claude Code, Codex,
GitHub Copilot, Claude Desktop, Cursor and others. The Hive team develops them, and they're useful to Hive (a
desktop app that runs coding agents in shared workspaces), but **none of them needs Hive**.

Every server uses only Node built-ins: no dependencies, and no `npm install` to run it.

## Servers

| Server | What it does | Platform |
|---|---|---|
| [`ollama`](servers/ollama/) | Lets agents hand bulky reading and drafting work to local [Ollama](https://ollama.com) models. The server reads the files itself, so only the answer reaches the agent. | Any OS with Node and Ollama |
| [`windows-sandbox`](servers/windows-sandbox/) | Lets an agent test a build on a clean, throwaway Windows in Windows Sandbox: start one, run commands, take screenshots, collect files, and always stop it. | Windows 11 Pro/Enterprise |

Each server's README covers its setup, tools, configuration, safety notes and limits.

## Requirements

- **Node 18 or later** on `PATH`, for every server.
- **`ollama`:** Ollama installed and running, with at least one model pulled (e.g. `ollama pull qwen3.6:35b-a3b`).
- **`windows-sandbox`:** Windows 11 **Pro, Enterprise or Education, 24H2 or later**, with virtualisation turned on in
  the firmware and the **Windows Sandbox** optional feature installed. (Windows Home has no Windows Sandbox.)
- Packing the zips for Hive (below) needs Windows' built-in `tar.exe`.

## Install

Clone the repo anywhere (or download a release zip and unpack it). Nothing needs to be built or installed:

```powershell
git clone https://github.com/Suremise/hive-mcp.git C:\path\to\hive-mcp
```

Then register a server with your client. Its command is `node <repo>\servers\<name>\server.js`, plus that server's
`env` settings (listed in its README). The examples below use `ollama`; for `windows-sandbox`, see
[its README](servers/windows-sandbox/#setup) for the `env` it needs.

**Claude Code:**

```powershell
claude mcp add ollama -e OLLAMA_HOST=http://127.0.0.1:11434 -- node C:\path\to\hive-mcp\servers\ollama\server.js
```

**Codex** (`config.toml`):

```toml
[mcp_servers.ollama]
command = "node"
args = ['C:\path\to\hive-mcp\servers\ollama\server.js']  # a literal string: backslashes as they are
env = { OLLAMA_HOST = "http://127.0.0.1:11434", OLLAMA_ROOTS_FROM_CWD = "1" }
```

Codex sends no MCP roots, so `OLLAMA_ROOTS_FROM_CWD` (or `WSB_ROOTS_FROM_CWD` for `windows-sandbox`) lets the server
use the project folder Codex starts it in. The same goes for the Copilot CLI.

**Claude Desktop, Cursor, the Copilot CLI, and other clients that take an `mcpServers` JSON:**

```json
{
  "mcpServers": {
    "ollama": {
      "command": "node",
      "args": ["C:\\path\\to\\hive-mcp\\servers\\ollama\\server.js"],
      "env": { "OLLAMA_HOST": "http://127.0.0.1:11434" }
    }
  }
}
```

**VS Code (GitHub Copilot)**, in `.vscode/mcp.json`: the same entry under `"servers"`, with `"type": "stdio"`.

In JSON, each `\` in a Windows path is written `\\` (or use `/`).

Where each client keeps its config, and its exact keys, are in its own documentation.

**What's been tested:**
- Both servers, from a clean clone, through a plain stdio MCP client with no Hive environment: `initialize`,
  `tools/list` and a tool call. For `windows-sandbox`, also the real-Sandbox smoke test.
- Both servers in Claude Code, and `windows-sandbox` driven by a Codex agent with `WSB_ROOTS_FROM_CWD=1`.
- Which clients send MCP roots, measured: Claude Code does (its working folder and each `--add-dir`); Codex and the
  Copilot CLI don't, and start the server in the project folder.

They use only the core MCP methods (`initialize`, `ping`, `tools/list`, `tools/call`, plus the client's
`roots/list`), so other stdio clients should work too. If one doesn't, please open an issue.

**Multiple projects:** both servers reach only the calling project's folders, using the client's
[MCP roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots), so one install serves every
project. Each server's README has a "Multiple projects" section.

### In Hive (Add MCP Server from File)

Hive can also add a server from a zip:

1. Pack the zips:
   ```powershell
   cd C:\path\to\hive-mcp
   node scripts\pack.mjs            # every server, into dist\<name>.zip
   node scripts\pack.mjs ollama     # just this one
   ```
2. In Hive 0.6.0 or later, open the **MCP** view, choose **Add MCP Server from File**, and pick the zip. Hive unpacks
   it into the workspace's `.hive/mcp/<name>/`.
3. The server is added **turned off**. Check its definition (`env`) first, then enable it. `windows-sandbox` needs
   your paths set before it can start a Sandbox (see its README).

Each zip has one top folder named after the server, holding:
- the server's code;
- `README.md` and `LICENSE`;
- its Hive definition: `hive-mcp.json` when it works unchanged (`ollama`), else `hive-mcp.example.json` to edit
  (`windows-sandbox`).

Tests and probes stay out. `pack.mjs` checks each zip against Hive's rules for that dialog:
- one top folder, and one definition;
- no links or unsafe paths;
- the file and size limits;
- the definition's `${HIVE_MCP_DIR}/<name>/…` references point to files in the zip.

## Tests

```powershell
npm test          # the automated tests (no network, no real Sandbox: wsb.exe is stubbed), about a minute
npm run pack      # same as node scripts\pack.mjs
```

`npm test` needs no `npm install`: there are no dependencies. On a machine with Windows Sandbox,
`npm run test:smoke` runs the windows-sandbox server against a real Sandbox. It skips cleanly where Windows Sandbox
isn't available, or when another Sandbox is already running. See [servers/windows-sandbox](servers/windows-sandbox/)
for what each test covers.

## Layout

- `servers/<name>/`: one server per folder, holding its code, `README.md` and a `hive-mcp.example.json`.
- `scripts/pack.mjs`: packs each server as `dist/<name>.zip`.
- `shared/roots.js`: the MCP roots rules the servers share (which project folders a server may reach). Each server
  ships its own copy, so its zip is self-contained, and `npm test` checks that the copies match.
- `servers/windows-sandbox/scenarios/`, `inside/hive/`, `RELEASE-TESTING.md` and `probes/`: Hive's own use of the
  Sandbox server, kept as an **example consumer**. The server doesn't need them (see its README).

## Issues and contributions

Report bugs and ask questions in [GitHub issues](https://github.com/Suremise/hive-mcp/issues): say which server,
your OS and Node version, and what you ran. For a security problem (for example a way out of a server's
confinement), please **don't** open a public issue. Use GitHub's private vulnerability reporting instead: the
repository's **Security** tab, then **Report a vulnerability**. [SECURITY.md](SECURITY.md) says what's in scope.

Files are LF, in the repo and in every working tree, whatever `core.autocrlf` says (`.gitattributes`), so a server's
zip holds the same bytes as the repo. `npm test` fails on a file with mixed line endings, and `npm run pack` on one
with CRLF.

## Licence

[MIT](LICENSE).
