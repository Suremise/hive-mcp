# Runs inside the Sandbox as the user: runs a Hive installer (or the uninstaller), waits for it, and records the result.
#   install.ps1 -Exe <installer> -Arguments '/S' -Name <prefix> [-Uninstall]
# Writes C:\out\<prefix>-run.json ({ exe, arguments, exitCode, seconds, hiveRunning }) and C:\out\<prefix>-state.json
# (install-state.ps1). The NSIS uninstaller returns at once and finishes from a copy of itself, so with -Uninstall it
# waits (up to 120 s) until the install folder and the Installed-apps entry are gone.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '/S',
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Hive'
$hiveExe = Join-Path $installDir 'Hive.exe'
$sw = [Diagnostics.Stopwatch]::StartNew()
# Not -Wait: it waits for the whole process tree, which includes the Hive that --force-run starts.
$p = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
$null = $p.Handle # keeps the exit code available after exit
$p.WaitForExit()
$exitCode = $p.ExitCode
if ($Uninstall) {
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\35960567-b95c-520c-a9f1-e8bb85764724'
  # A file being deleted can answer "Access is denied" for a moment: that counts as still there.
  $present = { try { (Test-Path $hiveExe) -or (Test-Path $uninstallKey) } catch { $true } }
  while ($sw.Elapsed.TotalSeconds -lt 120 -and (& $present)) { Start-Sleep -Milliseconds 500 }
}
$seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
# --force-run starts Hive after the install: give it a moment, then see whether it runs.
$running = $false
if (-not $Uninstall) {
  for ($i = 0; $i -lt 20 -and -not $running; $i++) {
    $running = [bool](Get-CimInstance Win32_Process -Filter "Name='Hive.exe'" | Where-Object { $_.ExecutablePath -eq $hiveExe })
    if (-not $running) { Start-Sleep -Milliseconds 500 }
  }
}
$run = [ordered]@{ exe = $Exe; arguments = $Arguments; exitCode = $exitCode; seconds = $seconds; hiveRunning = $running }
[IO.File]::WriteAllText("C:\out\$Name-run.json", ($run | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
& (Join-Path $PSScriptRoot 'install-state.ps1') -Out "C:\out\$Name-state.json"
"exit $exitCode in $seconds s"
