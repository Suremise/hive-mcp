# ollama

An MCP server that lets agents hand reading and drafting work to local [Ollama](https://ollama.com) models instead
of using cloud tokens. It runs over stdio (`node server.js`) and works with Hive or any other MCP client.

It uses only Node built-ins: no dependencies, no `npm install`. Version 1.2.0. MIT licence ([LICENSE](../../LICENSE)).

## Requirements

- [Ollama](https://ollama.com) installed and running (by default at `http://127.0.0.1:11434`).
- At least one model pulled, e.g. `ollama pull qwen3.6:35b-a3b`.
- Node 18+ on `PATH`. The server is plain Node, with nothing Windows-specific in it, so it should run on macOS and
  Linux too; it has been tested on Windows only.

## Setup

**In any MCP client** (Claude Code, Codex, Copilot, Claude Desktop, …), add an entry that runs
`node <this folder>/server.js`. No project paths are needed:

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

That's enough for a client that sends MCP roots (Claude Code). For one that doesn't (Codex and the Copilot CLI,
today), add `"OLLAMA_ROOTS_FROM_CWD": "1"`: see "Multiple projects". The
[top-level README](../../README.md#install) shows the same entry for each client's config format.

**Which model:** run `list_local_models` (or `ollama list`) and set `OLLAMA_DEFAULT_MODEL` to the one you want. Left
unset, the server uses the first model Ollama lists, and agents can always pass `model`. If the default you set isn't
pulled, the server's instructions say so, so agents pass `model` instead.

**In Hive:** pack it (`node scripts\pack.mjs ollama` at the repo root) and add `dist\ollama.zip` with **Add MCP Server
from File** in the MCP view. Its definition, `hive-mcp.json`, works unchanged for a local Ollama. It sets
`OLLAMA_ROOTS_FROM_CWD=1`, because Hive starts each agent in its project folder or worktree, and leaves the model
unset: add `OLLAMA_DEFAULT_MODEL` to pick one.

[`hive-mcp.example.json`](hive-mcp.example.json) is that definition: the same entry in Hive's format, where
`${HIVE_MCP_DIR}` is the folder Hive keeps its MCP servers in.

**What the server needs to run:** `server.js` and `roots.js` (a copy of the repo's
[`shared/roots.js`](../../shared/roots.js)).

## Tools

- `list_local_models()`: the local models, with parameter count and size, and the folders `files` can be read from.
- `ask_local_model(prompt, files?, model?, system?)`: sends a task to a local model and returns its answer.
  - With `files` (paths or folders in your project), the **server** reads the files and sends them to the model.
    Their contents never enter the calling agent's context, which is where the token saving comes from.
  - Relative paths resolve against your MCP roots: the first root that has the path, else the first root.
  - Folders are read recursively, skipping dot-folders (`.git`, …), `node_modules`, build output and binary files.
  - Lines are numbered so the model can cite them.
  - Inputs larger than the context window are split into batches, and batches that don't contain the answer are
    dropped.
  - Without `files`, it needs no roots: it just sends the prompt.

## Multiple projects (MCP roots)

One installed server serves every project: it reads only the calling project's files.

- **MCP roots.** A client that supports roots tells the server which folders it is working in. Claude Code sends its
  working folder (a project folder or a worktree) and each `--add-dir`. The server asks for the current roots at each
  call that reads files, so a changed list counts.
- **Clients that send no roots** (Codex and the Copilot CLI, as of this writing) get a clear refusal when they pass
  `files`, unless one of these is set:
  - `OLLAMA_ROOTS_FROM_CWD=1`: the folder the client started the server in is the root. Codex and the Copilot CLI
    start it in the project folder. A drive root never counts.
  - `OLLAMA_ALLOWED_ROOTS`: a fixed list of folders, the fallback on its own.
- **`OLLAMA_ALLOWED_ROOTS` with roots narrows them:** a file must then be under a root **and** under one of its
  folders. It never widens what the client gave.
- **A client that declares roots but doesn't answer** (an error, or no answer in 5 s) is refused. There's no silent
  fallback.
- `list_local_models` says where files can be read from now.

## What it can and can't read

| Can | Can't |
|---|---|
| Files and folders inside your MCP roots (or the fallback above). | Anything outside them: other projects, `..` out of the project, absolute paths elsewhere. |
| Links and junctions inside a root that lead to another place inside a root. | Links and junctions that lead outside: every file and folder must really resolve (realpath) under a root. They're skipped and listed in the reply. |
| Files in the project's own dot-files, if you name them (e.g. `.env`); a folder walk skips them. | The user profile itself, its dot-folders (`~/.ssh`, `~/.claude`, `~/.codex`, …), **all of AppData** (`%APPDATA%`, `%LOCALAPPDATA%`), or `~/Library` on macOS, whatever the roots say. A root that is one of them is dropped. |

### What the confinement guarantees

- **Guaranteed:** whatever path or link an agent passes, nothing is read outside the client's roots (or the
  configured fallback, `OLLAMA_ALLOWED_ROOTS` or `OLLAMA_ROOTS_FROM_CWD`, see "Multiple projects"), and nothing is read
  from the profile itself, its dot-folders or anywhere in AppData (`%APPDATA%`, `%LOCALAPPDATA%`; `~/Library` on
  macOS). Paths are checked by their real path, so links and junctions count where they lead.
- **Not guaranteed:** protection from a local program running as you that changes the project's folders (e.g. swaps
  a folder for a junction) at the instant between the check and the read. Such a program can already read those
  files itself.

So write logs or command output you want it to read **inside your project** (e.g. a git-ignored folder): a temp
folder under AppData can't be read.

Everything it reads goes only to the Ollama at `OLLAMA_HOST`, and the agent gets back the model's answer, not the
files. But the answer goes back to the agent, which may be a cloud model: that's why reading is confined.

## How agents know when to use it

The server's MCP `instructions` (sent when a session starts) say what it is good for:
- questions about large files and logs;
- "where is X handled" searches across many files;
- first drafts.

They also say what not to use it for: small files, exact-string search, judgement calls, and code nobody will check.
And they list the installed models and the default, or say that Ollama isn't running, so agents don't try.

## Configuration (`env`)

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama listens. On Windows, use the IP, not `localhost`: `localhost` adds a ~2 s IPv6-fallback delay per call. |
| `OLLAMA_DEFAULT_MODEL` | first local model | The model used when the agent doesn't name one. Pick one from `list_local_models`. Switching models costs a load of up to a minute, so stick to one. |
| `OLLAMA_MAX_CTX` | `65536` | The largest context window requested (at least 8192; a value that isn't a number means the default). The server sizes `num_ctx` to each input (Ollama silently truncates input beyond it); larger values need more GPU memory. |
| `OLLAMA_ROOTS_FROM_CWD` | off | `1`: for a client that sends no MCP roots, the folder it started the server in is the root (never a drive root). |
| `OLLAMA_ALLOWED_ROOTS` | none | `;`-separated folders. With MCP roots it **narrows** them; without, it is the list of folders files may come from. |

## Safety notes

- **Reading is confined** to your MCP roots, never the profile's dot-folders or app data (see "What it can and can't
  read").
- **Keep `OLLAMA_HOST` local.** If it points at another machine, every file an agent passes is sent there over plain
  HTTP.
- It runs no commands and writes no files. Its only network calls go to `OLLAMA_HOST`.

## Limits

- Files over 2 MB, and anything past 3 million characters in one call, are skipped and listed in the reply. Binary
  files are skipped too; they're listed only when named directly.
- One request may run for up to 10 minutes before it times out.
- Local models are slower than cloud ones and can be wrong: check what they cite before acting on it.
- Speed depends on your GPU and model. As a rough guide, one machine running `qwen3.6:35b-a3b` produces ~45 tokens/s,
  and reads ~180k tokens of source (3 batches) in about two minutes. A repeat question over the same files is much
  faster, because Ollama caches what it has read.

## Tests

From the repo root, `npm test` runs them with the rest. Or from this folder: `node --test test\server.test.js`. They
run the server over stdio against a fake Ollama (no models needed) and cover:
- roots given, and relative and absolute paths;
- paths outside the roots, through a junction, in the profile, its dot-folders and AppData;
- links met in a folder walk;
- no roots (the refusal, `OLLAMA_ALLOWED_ROOTS`, `OLLAMA_ROOTS_FROM_CWD`), and narrowing;
- roots changed between calls;
- the unchanged reading rules (skips, binaries, size limit, line numbers);
- the default-model messages.
