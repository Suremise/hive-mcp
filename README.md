# combwork-mcp

A collection of optional [MCP](https://modelcontextprotocol.io) servers for coding agents. Each one is a small,
self-contained Node program that speaks MCP over stdio, so **any MCP client can use it**: Claude Code, Codex,
GitHub Copilot, Claude Desktop, Cursor and others. The Combwork team develops them, and they're useful to Combwork (a
desktop app that runs coding agents in shared workspaces), but **none of them needs Combwork**.

Every server uses only Node built-ins: no dependencies, and no `npm install` to run it.

## Servers

| Server | What it does | Platform |
|---|---|---|
| [`ollama`](servers/ollama/) | Lets agents hand bulky reading and drafting work to local [Ollama](https://ollama.com) models. The server reads the files itself, so only the answer reaches the agent. | Any OS with Node and Ollama |
| [`trilium`](servers/trilium/) | Lets agents search, read and add to your [Trilium Notes](https://github.com/TriliumNext/Trilium) over its ETAPI, lean on tokens: a compact index of the note tree, outline-first reading, no delete or move. The token stays in an environment variable. | Any OS with Node and a Trilium server |
| [`windows-sandbox`](servers/windows-sandbox/) | Lets an agent test a build on a clean, throwaway Windows in Windows Sandbox: start one, run commands, take screenshots, collect files, and always stop it. | Windows 11 Pro/Enterprise |

Each server's README covers its setup, tools, configuration, safety notes and limits.

## Requirements

- **Node 18 or later** on `PATH`, for every server.
- **`ollama`:** Ollama installed and running, with at least one model pulled (e.g. `ollama pull qwen3.6:35b-a3b`).
- **`trilium`:** a Trilium Notes (TriliumNext) server you can reach, and an ETAPI token for it.
- **`windows-sandbox`:** Windows 11 **Pro, Enterprise or Education, 24H2 or later**, with virtualisation turned on in
  the firmware and the **Windows Sandbox** optional feature installed. (Windows Home has no Windows Sandbox.)

## Install

Clone the repo anywhere (or download a server's zip from a [release](https://github.com/Suremise/combwork-mcp/releases)
and unpack it). Nothing needs to be built or installed:

```powershell
git clone https://github.com/Suremise/combwork-mcp.git C:\path\to\combwork-mcp
```

Then register a server with your client. Its command is `node <repo>\servers\<name>\server.js`, plus that server's
`env` settings (listed in its README). The examples below use `ollama`; for `windows-sandbox`, see
[its README](servers/windows-sandbox/#setup) for the `env` it needs.

**Claude Code:**

```powershell
claude mcp add ollama -e OLLAMA_HOST=http://127.0.0.1:11434 -- node C:\path\to\combwork-mcp\servers\ollama\server.js
```

**Codex** (`config.toml`):

```toml
[mcp_servers.ollama]
command = "node"
args = ['C:\path\to\combwork-mcp\servers\ollama\server.js']  # a literal string: backslashes as they are
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
      "args": ["C:\\path\\to\\combwork-mcp\\servers\\ollama\\server.js"],
      "env": { "OLLAMA_HOST": "http://127.0.0.1:11434" }
    }
  }
}
```

**VS Code (GitHub Copilot)**, in `.vscode/mcp.json`: the same entry under `"servers"`, with `"type": "stdio"`.

In JSON, each `\` in a Windows path is written `\\` (or use `/`).

Where each client keeps its config, and its exact keys, are in its own documentation.

**What's been tested:**
- Both servers, from a clean clone, through a plain stdio MCP client with no Combwork environment: `initialize`,
  `tools/list` and a tool call. For `windows-sandbox`, also the real-Sandbox smoke test.
- Both servers in Claude Code, and `windows-sandbox` driven by a Codex agent with `WSB_ROOTS_FROM_CWD=1`.
- Which clients send MCP roots, measured: Claude Code does (its working folder and each `--add-dir`); Codex and the
  Copilot CLI don't, and start the server in the project folder.

They use only the core MCP methods (`initialize`, `ping`, `tools/list`, `tools/call`, plus the client's
`roots/list`), so other stdio clients should work too. If one doesn't, please open an issue.

**Multiple projects:** both servers reach only the calling project's folders, using the client's
[MCP roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots), so one install serves every
project. Each server's README has a "Multiple projects" section.

### In Combwork (Add MCP Server from File)

Combwork can also add a server from a zip:

1. Download it from a [release](https://github.com/Suremise/combwork-mcp/releases), or pack the zips yourself:
   ```powershell
   cd C:\path\to\combwork-mcp
   node scripts\pack.mjs            # every server, into dist\<name>.zip, plus dist\catalog.json
   node scripts\pack.mjs ollama     # just this one (no catalog.json)
   ```
2. In Combwork (or Hive Desktop 0.6.0 or later, as it was called before), open the **MCP** view, choose **Add MCP Server from File**, and pick the zip. Combwork unpacks
   it into the workspace's `.hive/mcp/<name>/`.
3. The server is added **turned off**. Check its definition (`env`) first, then enable it. `windows-sandbox` needs
   your paths set before it can start a Sandbox (see its README).

Each zip has one top folder named after the server, holding:
- the server's code;
- `README.md` and `LICENSE`;
- its Combwork definition: `hive-mcp.json` when it works unchanged (`ollama`), else `hive-mcp.example.json` to edit
  (`windows-sandbox`, `trilium`). In the repo it is the server's `combwork-mcp.example.json`; `pack.mjs` names it
  in the zip as the app reads it.

Combwork still reads the names it had as Hive Desktop: the definition is `hive-mcp.json` or `hive-mcp.example.json`
inside the zip, `${HIVE_MCP_DIR}` is its folder of MCP servers, and `.hive/mcp` is where a workspace keeps them. This
repo keeps those names until the app renames them.

Tests and probes stay out. `pack.mjs` checks each zip against Combwork's rules for that dialog:
- one top folder, and one definition;
- no links or unsafe paths;
- the file and size limits;
- the definition's `${HIVE_MCP_DIR}/<name>/…` references point to files in the zip.

The zips are reproducible: packing the same files gives the same bytes (entries sorted, one fixed time, no owners
or extra fields), so a zip's sha256 changes only when its files do. Packing needs nothing but Node.

## The catalogue

Each [release](https://github.com/Suremise/combwork-mcp/releases) holds every server's zip and a `catalog.json` that
lists them, for Combwork's MCP view or any client to offer the servers, download one and check it. The latest is always
at:

```
https://github.com/Suremise/combwork-mcp/releases/latest/download/catalog.json
```

A client downloads a server's `zip.url`, checks its SHA-256 against `zip.sha256` (and its size against `zip.size`),
and uses the zip only when they match. Anyone can publish a catalogue of their own servers in this format.
`npm run pack` makes ours (`dist/catalog.json`) from each server's `servers/<name>/meta.json` and its zip;
[RELEASING.md](RELEASING.md) says how a release is made.

```json
{
  "schemaVersion": 1,
  "name": "Suremise/combwork-mcp",
  "homepage": "https://github.com/Suremise/combwork-mcp",
  "release": "v1.0.0",
  "servers": [
    {
      "name": "windows-sandbox",
      "version": "1.0.0",
      "description": "Test builds on a clean, throwaway Windows in Windows Sandbox.",
      "tags": ["testing", "windows", "sandbox"],
      "requires": {
        "os": ["windows"],
        "windows": { "editions": ["Pro", "Enterprise", "Education"], "minBuild": 26100, "features": ["Windows Sandbox"] },
        "node": ">=18"
      },
      "homepage": "https://github.com/Suremise/combwork-mcp/tree/v1.0.0/servers/windows-sandbox",
      "zip": {
        "url": "https://github.com/Suremise/combwork-mcp/releases/download/v1.0.0/windows-sandbox.zip",
        "sha256": "<64 lower-case hex digits>",
        "size": 72903
      }
    }
  ]
}
```

| Field | Required | What it holds |
|---|---|---|
| `schemaVersion` | yes | `1`, this format. A reader refuses a catalogue whose `schemaVersion` it doesn't know. |
| `name` | yes | The catalogue's source, in one line (here the GitHub repo). |
| `homepage` | no | An https URL for the source. |
| `release` | no | The release the catalogue came with. |
| `servers` | yes | A list of servers, each once by `name`. |
| `servers[].name` | yes | Lower-case letters, digits and `-`; the zip's one top folder has this name. |
| `servers[].version` | yes | `x.y.z`. A changed zip always comes with a higher version. |
| `servers[].description` | yes | One line, at most 200 characters. The zip's definition has the long one. |
| `servers[].tags` | yes | Lower-case words (`a-z`, `0-9`, `-`), each once; may be empty. |
| `servers[].requires.os` | yes | Where it runs: one or more of `windows`, `macos`, `linux`. |
| `servers[].requires.windows` | no | Only with `os` `windows`: `editions` (of `Home`, `Pro`, `Enterprise`, `Education`), `minBuild` (a whole number: 26100 is 24H2) and `features` (optional Windows features it needs, by name). A field left out means any. |
| `servers[].requires.node` | no | The Node it needs on `PATH`, as a minimum: `">=18"`. |
| `servers[].requires.docker` | no | `true` when it needs Docker; left out means no. |
| `servers[].requires.apps` | no | Anything else it needs, one line each, for people to read (e.g. "Ollama, running, with a model pulled"). |
| `servers[].homepage` | no | An https URL for the server's own page. |
| `servers[].zip.url` | yes | An https URL for its zip, in the layout above. |
| `servers[].zip.sha256` | yes | The zip's SHA-256, 64 lower-case hex digits. |
| `servers[].zip.size` | yes | The zip's size in bytes. |

Within `schemaVersion` 1 fields may be added, never changed or removed, so a reader ignores fields it doesn't know.
A change a reader can't ignore raises `schemaVersion`. `scripts/catalog.mjs` (`validate`) is the reference check.

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

- `servers/<name>/`: one server per folder, holding its code, `README.md`, a `combwork-mcp.example.json` and its
  `meta.json` (its version, one-line description, tags and requirements, for the catalogue; it ships in the zip,
  and the server reports its version from it).
- `scripts/pack.mjs`: packs each server as `dist/<name>.zip`, and `dist/catalog.json` (`catalog.mjs`, `zip.mjs`).
- `scripts/release.mjs`: checks a release and, with `--publish`, makes it ([RELEASING.md](RELEASING.md)).
- `shared/roots.js`: the MCP roots rules the servers share (which project folders a server may reach). Each server
  ships its own copy, so its zip is self-contained, and `npm test` checks that the copies match.
- `servers/windows-sandbox/probes/`: the scripts that measured `wsb.exe` before that server was written, kept to
  check its behaviour again on a new Windows. They aren't in its zip.

## Issues and contributions

Report bugs and ask questions in [GitHub issues](https://github.com/Suremise/combwork-mcp/issues): say which server,
your OS and Node version, and what you ran. For a security problem (for example a way out of a server's
confinement), please **don't** open a public issue. Use GitHub's private vulnerability reporting instead: the
repository's **Security** tab, then **Report a vulnerability**. [SECURITY.md](SECURITY.md) says what's in scope.

Files are LF, in the repo and in every working tree, whatever `core.autocrlf` says (`.gitattributes`), so a server's
zip holds the same bytes as the repo. `npm test` fails on a file with mixed line endings, and `npm run pack` on one
with CRLF.

## Licence

[MIT](LICENSE).
