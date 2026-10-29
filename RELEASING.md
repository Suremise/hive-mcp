# Releasing

A release is one tag for the whole repo, `v<version>` from `package.json`, and a GitHub release under that tag
holding every server's zip and `catalog.json` ([README, The catalogue](README.md#the-catalogue)). Hive's MCP view
reads the latest release's `catalog.json`, so a release is what users see. Only the maintainer releases.

Each server keeps its own version in `servers/<name>/meta.json`, and the repo's version goes up with every release.
The zips are reproducible, so a server that didn't change keeps its sha256 from one release to the next; one whose
files changed must have a higher version, and the release check refuses it otherwise.

## Steps

1. **Versions.** On a branch: raise `version` in each changed server's `servers/<name>/meta.json` (x.y.z: the
   last number for a fix, the middle one for something new, the first for a change that needs its users to act),
   and raise `version` in `package.json`, the release's. Change `description`, `tags` or `requires` there too if
   they no longer hold. Merge it to `main` and push `main`.
2. **Check.** On `main`, with nothing uncommitted:
   ```powershell
   npm test
   node scripts\release.mjs
   ```
   `release.mjs` packs every zip and `catalog.json` into `dist\`, and checks that: the tree is clean and on `main`,
   `HEAD` is `origin/main`, the tag doesn't exist yet, `catalog.json` is valid, and, against the latest release's
   `catalog.json` (read with `gh`), no server's zip changed without a higher version and none went down. It changes
   nothing, and prints the commands step 3 runs.
3. **Publish.**
   ```powershell
   node scripts\release.mjs --publish
   ```
   It checks again, then runs `git tag -a v<version>`, `git push origin v<version>` and `gh release create` with the
   zips and `catalog.json` (needs `gh auth login`). The release notes are GitHub's, from the merged pull requests;
   edit them on the release's page if you like.
4. **Look.** Open `https://github.com/Suremise/hive-mcp/releases/latest/download/catalog.json` and check it is the
   new one.

## When a step fails

- **The check:** it says what to fix; fix it and run it again.
- **The tag was made but not pushed:** run `git push origin v<version>`, then the `gh release create` line it printed.
- **The tag was pushed, the release wasn't made:** run the `gh release create` line it printed.
- **A release went out wrong:** don't change its assets, since anyone may have checked their sha256 already. Raise
  the versions and release again. A broken release can be deleted on GitHub (and its tag with
  `git push origin :refs/tags/v<version>`), so `latest` goes back to the one before.

## A server's first release, or a new one

Add it to `SERVERS` in `scripts/pack.mjs` (what its zip holds) and give it a `meta.json` (see the existing ones).
`npm test` checks every `meta.json`, and the catalogue's tests list the servers they expect.
