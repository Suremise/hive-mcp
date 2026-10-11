# Runs inside the Sandbox as the user: a stand-in for Claude Code's installer (scenario 3), with the network
# off and no real CLI. It copies Hive's e2e fake Claude Code (mapped read-only at C:\tools\hive-tests) into the user's
# programs, adds a claude.cmd that runs it on the mapped Node, and puts that folder on the user PATH in the registry,
# as a real installer does. The fake answers --version ("2.1.999 (Claude Code)") and reports itself signed in; it
# signs in to nothing.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'FakeClaude'
$e2e = Join-Path $root 'e2e'
New-Item -ItemType Directory -Force -Path (Join-Path $e2e 'fake-claude'), (Join-Path $root 'bin') | Out-Null
Copy-Item -Path 'C:\tools\hive-tests\e2e\fake-claude\*' -Destination (Join-Path $e2e 'fake-claude') -Recurse -Force
Copy-Item -Path 'C:\tools\hive-tests\e2e\fake-bridge.cjs' -Destination $e2e -Force
$cmd = "@`"C:\tools\node\node.exe`" `"$e2e\fake-claude\fake-claude.cjs`" %*`r`n"
[IO.File]::WriteAllText((Join-Path $root 'bin\claude.cmd'), $cmd, (New-Object Text.ASCIIEncoding))
$bin = Join-Path $root 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $bin)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'User')
}
"installed $bin\claude.cmd: $(& (Join-Path $bin 'claude.cmd') --version)"
