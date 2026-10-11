# Runs inside the Sandbox in the user session (wsb exec -r ExistingLogin): saves the whole desktop as a JPEG, scaled
# down to at most MaxWidth pixels wide (a full PNG is ~5 MB). Prints the captured and saved sizes. As System, or once
# the connect window is closed, the desktop comes back blank.
param([Parameter(Mandatory = $true)][string]$Path, [int]$MaxWidth = 1280)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$w = [Math]::Min($MaxWidth, $b.Width)
$h = [int]($b.Height * $w / $b.Width)
$small = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($small)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($bmp, 0, 0, $w, $h)
$g.Dispose()
$jpeg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
$small.Save($Path, $jpeg, $params)
$small.Dispose(); $bmp.Dispose()
"$($b.Width)x$($b.Height) -> ${w}x${h}"
