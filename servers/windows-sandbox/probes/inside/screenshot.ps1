# Runs inside the Sandbox, in the user session (wsb exec -r ExistingLogin): saves the whole desktop as a PNG.
# Prints the size captured. In the System context there is no desktop to capture, so it fails there.
param([Parameter(Mandatory = $true)][string]$Path)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$($b.Width)x$($b.Height)"
