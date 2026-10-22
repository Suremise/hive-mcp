# trilium

An MCP server that lets agents search, read and add to your notes in [Trilium Notes](https://github.com/TriliumNext/Trilium)
(TriliumNext) through its ETAPI. It is built to be **lean on tokens**: an agent finds its way with a compact index of
titles, reads long notes outline first, and gets plain compact text back, never JSON or raw HTML. It runs over stdio
(`node server.js`) and works with Hive or any other MCP client.

It uses only Node built-ins: no dependencies, no `npm install`. Version 1.0.0. MIT licence ([LICENSE](../../LICENSE)).

## Requirements

- A Trilium Notes (TriliumNext) server the machine can reach, and an **ETAPI token** for it: in Trilium, **Options →
  ETAPI → Create new ETAPI token**.
- Node 18+ on `PATH`. The server is plain Node, with nothing Windows-specific in it; it has been tested on Windows only.

## Setup

**1. Keep the token in an environment variable,** never in a config file. On Windows, as a user environment variable:

```powershell
[Environment]::SetEnvironmentVariable('TRILIUM_ETAPI_TOKEN', '<your token>', 'User')
```

(or **Settings → System → About → Advanced system settings → Environment Variables**, under "User variables").
Programs started afterwards see it: restart your MCP client (and Hive) once it is set. On macOS or Linux, export it
from your shell profile.

**2. Register the server.** In any MCP client (Claude Code, Codex, Copilot, Claude Desktop, …), add an entry that runs
`node <this folder>/server.js` with `TRILIUM_URL` set to your Trilium's address (the server adds `/etapi` itself):

```json
{
  "mcpServers": {
    "trilium": {
      "command": "node",
      "args": ["C:\\path\\to\\hive-mcp\\servers\\trilium\\server.js"],
      "env": {
        "TRILIUM_URL": "http://localhost:8080",
        "TRILIUM_ETAPI_TOKEN": "${TRILIUM_ETAPI_TOKEN}"
      }
    }
  }
}
```

`${TRILIUM_ETAPI_TOKEN}` is a reference to the environment variable, not the token: Claude Code expands it when it
starts the server. A client that doesn't expand references in `env` would pass the text `${TRILIUM_ETAPI_TOKEN}`
itself; the server spots that and says so. For such a client, leave `TRILIUM_ETAPI_TOKEN` out of `env`: a server
started by the client inherits the client's environment, user variables included. The
[top-level README](../../README.md#install) shows the same kind of entry for each client's config format.

**In Hive:** pack it (`node scripts\pack.mjs trilium` at the repo root) and add `dist\trilium.zip` with **Add MCP
Server from File** in the MCP view. Its definition, `hive-mcp.example.json`, is added turned off: set `TRILIUM_URL` to
your Trilium, keep the token as the `${TRILIUM_ETAPI_TOKEN}` reference (Hive warns about a literal secret in a
definition), then turn it on.

**What the server needs to run:** `server.js` alone.

## Tools

Notes are named by **id** or by a **title path** from the top of the tree, such as `Projects/Ideas`, which must match
exactly one note (an exact title first, else one that differs only in case). An id is tried first.

Reading:
- `trilium_index(note?, depth?, limit?)`: a compact tree of titles and ids, from the top of the tree by default, 2
  levels deep by default. A note whose children are beyond the depth shows `+N`. Trilium's own system notes (ids that
  start with `_`, such as `_hidden`) are left out. Cut at 200 lines by default, with a note saying so.
- `trilium_search(query, limit?, detail?)`: Trilium's search syntax (words, `#label`, `#label=value`, `note.title *= "x"`…). One line per note: title, id, where it is (its parents'
  titles) and labels. `detail` adds when it last changed. 20 results by default, at most 100.
- `trilium_read_note(note, section?, offset?, maxChars?, detail?)`: the note as readable text (headings `#`, lists,
  to-dos `[x]`, links `[text](href)`, code blocks and tables kept), with its parents, labels and up to 20 children.
  - A note over 4,000 characters with headings comes back as its **outline** (each heading with its number and size)
    and its first 600 characters. `section` (a heading, part of one, or its number) reads that part with its
    subheadings.
  - The outline keeps within `maxChars` too: a note with more headings than fit says which it shows, and
    `outlineFrom` (a heading number) shows the next ones.
  - `offset` (0 for the start) reads in order, skipping the outline. Content is cut at 8,000 characters by default
    (`maxChars`, at most 200,000), with a line saying where and which offset reads on.
  - `detail` adds the note's type, MIME type and its created and changed dates.
- `trilium_list_children(note?, limit?)`: a note's children (the top of the tree by default): title, id, the type when
  it isn't text, and `+N` children.

Writing (left out with `TRILIUM_READ_ONLY=1`):
- `trilium_create_note(parent, title, content?, format?, code?, labels?)`: a text note under `parent`.
  - `content` is plain text by default, escaped into HTML: a blank line starts a paragraph, a line break stays one.
    With `format: "html"` it is sent as given.
  - `code` adds a code block after it, `<pre><code class="language-text-plain">`, kept exactly: backslashes
    (`\\server\share`, a regex such as `y: \+2[0-9]%`), `<` and `&`, trailing spaces and tabs, and blank lines
    round-trip unchanged. A read shows a code block fenced with more backticks than any run inside it, so lines of
    ```` ``` ```` in the code don't end it; only a final line break isn't shown.
  - `labels`: `["todo", "status=done"]`.
- `trilium_append_to_note(note, content?, format?, code?)`: adds to the end of a text note (reads its content, appends,
  writes it back), with the same `content`, `format` and `code` as above. Appends to the same note through this server
  take turns, so two at once both land (see Limits for edits made elsewhere).
- `trilium_add_label(note, name, value?)`.

There are no delete, move or protect tools.

## Token use

Replies are plain compact text, sized for an agent's context, and the cheap way to find something is the default:

| Reply | Typical size |
|---|---|
| `trilium_index`, depth 2 | one short line per note: about 20 characters plus the title |
| `trilium_search` | one line per note: title, id, parents' titles, labels (about 40 to 100 characters) |
| `trilium_list_children` | one line per child, as the index |
| `trilium_read_note`, a short note | the note's text plus a 2 to 5 line header |
| `trilium_read_note`, a long note | its outline and first 600 characters: under 1,000 characters for a note of any length with a few headings, and never more than `maxChars` of outline however many headings it has |
| `trilium_read_note` with `section` | that part only |

On the test fixture, a 10,000-character note with four headings comes back as an 835-character outline, and one
section as 1,240 characters. Dates, MIME types and other details come only with `detail: true`. Long titles, label
values and lists (labels, parents, children, matching headings or notes in an error) are cut, with a count of what
was left out. The tests pin each
reply's size on the fixture (`npm test` prints them), so a change that makes replies bigger is a deliberate one.

## Configuration (`env`)

| Variable | Default | Meaning |
|---|---|---|
| `TRILIUM_URL` | none | Your Trilium's address, e.g. `http://localhost:8080` or `https://notes.example.com`. The server adds `/etapi` (one given with `/etapi` works too). |
| `TRILIUM_ETAPI_TOKEN` | none | The ETAPI token: a reference to a user environment variable (see Setup), never a literal. |
| `TRILIUM_READ_ONLY` | off | `1`: only the reading tools are listed, and the writing ones are refused. |
| `TRILIUM_MAX_CHARS` | `8000` | How much of a note's content a read returns by default (at least 1000). |
| `TRILIUM_CACHE_SECONDS` | `60` | How long fetched notes are kept between calls at most (see Limits); `0` keeps none. |

## Safety notes

- **The ETAPI token gives full access to your notes**: reading, changing and deleting, through any program that holds
  it. Keep it in an environment variable, and delete it in Trilium (Options → ETAPI) if it leaks.
- **Plain HTTP sends the token unencrypted.** On a home LAN that may be acceptable; if your Trilium is reachable beyond
  it, put it behind HTTPS (a reverse proxy) and use an `https://` `TRILIUM_URL`.
- The token never appears in a reply, an error or anything else the server writes: every line it writes is scrubbed of
  it, even if Trilium were to echo it back. Errors say what failed (the HTTP status and Trilium's message).
- **Protected notes** can't be read or changed through ETAPI. The server says so plainly rather than returning
  nothing.
- Agents are told (in the server's MCP instructions) to write only when you ask them to. For reading only, set
  `TRILIUM_READ_ONLY=1`.
- Its only network calls go to `TRILIUM_URL`. It reads and writes no files.

## Limits

- Title paths can't name a note whose title holds a `/`: use its id.
- A note's path in search results follows its first parent; `trilium_read_note` lists all of a cloned note's parents.
- The index and title paths fetch each note they pass, ten at a time: the first deep index of a large tree takes a few
  seconds. The server then keeps the notes (titles, parents, children and labels, never content) for up to
  `TRILIUM_CACHE_SECONDS`, so a repeated index costs one request: a search for Trilium's most recently changed note,
  made on each call. A different answer (an edit, a new note or a rename in Trilium), or one of this server's own
  writes, drops them. A move or a delete in Trilium doesn't change that answer: a title path is still checked against
  fresh notes, one request a step, and a read that finds a kept note gone runs again afresh, but the index and lists
  can show the old place for up to `TRILIUM_CACHE_SECONDS`. So can a label changed in Trilium.
- An append reads the note and writes it back whole. Appends through this server take turns per note, but ETAPI has no
  conflict check: an edit made in Trilium (or by another program) between that read and write is overwritten.
- Only text notes can be appended to. Code notes are read as code; image and file notes aren't read.

## Tests

From the repo root, `npm test` runs them with the rest. Or from this folder: `node --test test\server.test.js`. They
run the server over stdio against a **fake ETAPI** (a local HTTP server in the test, never a real Trilium) and cover:
- the index, search, reading (HTML to text, outlines and sections, cuts and offsets) and listing children;
- creating under a title path (text escaped, code blocks round-tripping exactly: backslashes, trailing whitespace,
  blank lines, ``` lines), labels, and appending, two at once to one note included;
- long outlines (2,000 headings) and long titles and labels staying within bounds;
- read-only mode, protected notes, HTTP errors and missing or unexpanded settings;
- that nothing the server writes, on stdout or stderr, holds the token, even when Trilium echoes it back;
- each reply's size on the fixture tree;
- the cache, counting requests: a repeated index or title path fetches no note again, writes and changes made in
  Trilium show on the next call, and a moved or deleted note is never reached through a stale path or id.

They write no files.
