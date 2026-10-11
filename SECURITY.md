# Security policy

## Supported versions

Security fixes go into the latest release of each server (`ollama`, `windows-sandbox`). Please check that a problem
still happens with the latest version before reporting it.

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately through GitHub's private vulnerability reporting:
open [Suremise/hive-mcp](https://github.com/Suremise/hive-mcp), go to the **Security** tab, and choose **Report a
vulnerability**. Say which server and version, your OS and Node version, and how to reproduce it.

## Scope

In scope: any way to get past a server's confinement. For example:

- **windows-sandbox:** mapping a host folder into the Sandbox that the rules don't allow: a build outside the
  client's MCP roots (or the configured fallback), or the user profile, its dot-folders, the refused AppData folders
  or the server's out folders; or the host reading files outside a run's out folder when it reads back from the
  Sandbox.
- **ollama:** reading a file outside the client's MCP roots (or the configured fallback), or from the user profile,
  its dot-folders or AppData.

Each server's README says exactly what its confinement guarantees.

Out of scope: the known limit that each README documents under "What the confinement guarantees". A local program
running as the same user can change the project's folders (e.g. swap a folder for a junction) between a check and
the server's use of the path. Such a program can already read those files itself.
