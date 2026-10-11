# Runs inside the Sandbox (wsb exec, mapped read-only at C:\wsb-mcp): runs one command with its stdout and stderr
# redirected into files directly in C:\out (the host reads only top-level files while the Sandbox runs), writing the
# command's PID first so the host can kill it inside on a timeout (killing the host's wsb exec leaves it running).
# Files: <Name>.stdout.txt, <Name>.stderr.txt, <Name>.pid, <Name>.exit, and <Name>.error.txt if the wrapper itself
# fails. Exits with the command's exit code.
# The command comes base64-encoded (UTF-8), so no quoting survives the trip through wsb's command line.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^\.run-\d+$')][string]$Name,
  [Parameter(Mandatory = $true)][ValidateSet('cmd', 'powershell')][string]$Shell,
  [Parameter(Mandatory = $true)][string]$B64,
  [string]$Cwd = 'C:\'
)
$ErrorActionPreference = 'Stop'
$base = Join-Path 'C:\out' $Name
try {
  $command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
  if ($Shell -eq 'cmd') {
    $exe = "$env:SystemRoot\System32\cmd.exe"
    $argLine = '/d /s /c "' + $command + '"'
  } else {
    $exe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    # Run as a script file (in the guest's TEMP, UTF-8 with BOM for PowerShell 5.1): with -EncodedCommand and redirected
    # output, PowerShell 5.1 writes errors to stderr as CLIXML. No progress records either.
    $script = Join-Path $env:TEMP "wsb-mcp$Name.ps1"
    [IO.File]::WriteAllText($script, "`$ProgressPreference = 'SilentlyContinue'`r`n" + $command, (New-Object Text.UTF8Encoding $true))
    $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
  }
  if (-not (Test-Path -LiteralPath $Cwd -PathType Container)) { $Cwd = 'C:\' }
  $p = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $Cwd -NoNewWindow -PassThru `
    -RedirectStandardOutput "$base.stdout.txt" -RedirectStandardError "$base.stderr.txt"
  $null = $p.Handle # keeps the exit code available after exit
  [IO.File]::WriteAllText("$base.pid", [string]$p.Id)
  $p.WaitForExit()
  $code = $p.ExitCode
  [IO.File]::WriteAllText("$base.exit", [string]$code)
  exit $code
} catch {
  [IO.File]::WriteAllText("$base.error.txt", [string]$_)
  exit 1
}
