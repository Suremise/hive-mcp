# Runs inside the Sandbox as the user: records what a Hive install left on this machine, as JSON, for the host's checks.
#   install-state.ps1 -Out C:\out\<name>.json
# Installed-apps entries (HKCU and HKLM Uninstall keys whose DisplayName starts with "Hive"), the install folder, the
# profile folder, and the Hive shortcuts on the Desktop and in the Start menu (with their targets).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Continue' # one unreadable item must not lose the whole record

$entries = @()
foreach ($root in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
  if (-not (Test-Path $root)) { continue }
  foreach ($k in Get-ChildItem $root) {
    $p = Get-ItemProperty $k.PSPath
    if ($p.DisplayName -like 'Hive*') {
      $entries += [ordered]@{ hive = $root.Split(':')[0]; key = $k.PSChildName; displayName = $p.DisplayName; displayVersion = $p.DisplayVersion; publisher = $p.Publisher; installLocation = $p.InstallLocation; uninstallString = $p.UninstallString; quietUninstallString = $p.QuietUninstallString }
    }
  }
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Hive'
$exe = Join-Path $installDir 'Hive.exe'
$exeVersion = $null
if (Test-Path $exe) { $exeVersion = (Get-Item $exe).VersionInfo.ProductVersion }
# Which build is installed: test builds carry the previous release's version number, so the app code's hash tells them apart.
$asar = Join-Path $installDir 'resources\app.asar'
$asarSha256 = $null
if (Test-Path $asar) { $asarSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $asar).Hash.ToLower() }

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @()
foreach ($dir in [Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), [Environment]::GetFolderPath('CommonDesktopDirectory'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')) {
  if (-not (Test-Path $dir)) { continue }
  foreach ($l in Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
    $t = $shell.CreateShortcut($l.FullName).TargetPath
    if ($l.BaseName -like '*Hive*' -or $t -like '*\Hive\*') { $shortcuts += [ordered]@{ name = $l.BaseName; folder = $dir; target = $t } }
  }
}

$profileDir = Join-Path $env:APPDATA 'Hive'
$state = [ordered]@{
  at = (Get-Date).ToString('o')
  user = $env:USERNAME
  uninstallEntries = $entries
  installDir = [ordered]@{ path = $installDir; exists = (Test-Path $installDir); hiveExe = (Test-Path $exe); exeVersion = $exeVersion; appAsarSha256 = $asarSha256; uninstaller = (Test-Path (Join-Path $installDir 'Uninstall Hive.exe')) }
  profileDir = [ordered]@{ path = $profileDir; exists = (Test-Path $profileDir); files = @(if (Test-Path $profileDir) { Get-ChildItem $profileDir -File | Select-Object -ExpandProperty Name }) }
  shortcuts = $shortcuts
  git = [bool](Get-Command git -ErrorAction SilentlyContinue)
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
}
[IO.File]::WriteAllText($Out, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
