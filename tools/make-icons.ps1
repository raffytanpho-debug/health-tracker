# make-icons.ps1 — generate the PWA icon set.
#
# Draws the app mark directly with System.Drawing (no SVG rasteriser needed on
# this machine). The mark is a calm sage-green rounded square with a single
# heartbeat trace: the same "quiet, not clinical" language the dashboards use,
# and deliberately unlike the Finance Tracker's purple so the two are easy to
# tell apart on the home screen.
#
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icon'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# Palette matches index.html --accent / --accent-deep.
$bgTop    = [System.Drawing.Color]::FromArgb(255, 58, 125, 110)   # #3a7d6e
$bgBottom = [System.Drawing.Color]::FromArgb(255, 42,  95,  84)   # #2a5f54
$stroke   = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-Icon {
    param([int]$Size, [string]$Path, [bool]$Maskable = $false)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Maskable icons get a full bleed so Android's mask can crop safely;
    # "any" icons get a rounded square with a little breathing room.
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect, $bgTop, $bgBottom, [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)

    if ($Maskable) {
        $g.FillRectangle($brush, $rect)
    } else {
        $r    = [int]($Size * 0.22)
        $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d    = $r * 2
        $gp.AddArc(0, 0, $d, $d, 180, 90)
        $gp.AddArc($Size - $d, 0, $d, $d, 270, 90)
        $gp.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
        $gp.AddArc(0, $Size - $d, $d, $d, 90, 90)
        $gp.CloseFigure()
        $g.FillPath($brush, $gp)
        $gp.Dispose()
    }

    # Heartbeat trace. Coordinates are fractions of the canvas so every size
    # renders the identical mark. Maskable pulls the trace in to stay inside
    # the 80% safe zone.
    $inset = if ($Maskable) { 0.30 } else { 0.20 }
    $w = $Size * (1 - 2 * $inset)
    $x0 = $Size * $inset
    $mid = $Size * 0.5

    $pts = @(
        @(0.00, 0.00), @(0.22, 0.00), @(0.32, -0.30), @(0.45, 0.42),
        @(0.58, -0.16), @(0.68, 0.00), @(1.00, 0.00)
    ) | ForEach-Object {
        New-Object System.Drawing.PointF(
            [float]($x0 + $w * $_[0]),
            [float]($mid + $Size * $_[1] * 0.62))
    }

    $pen = New-Object System.Drawing.Pen($stroke, [float]($Size * 0.075))
    $pen.StartCap  = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap    = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    $pen.Dispose(); $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Output ("  wrote {0} ({1}x{1})" -f (Split-Path $Path -Leaf), $Size)
}

New-Icon -Size 192 -Path (Join-Path $outDir 'icon-192.png')
New-Icon -Size 512 -Path (Join-Path $outDir 'icon-512.png')
New-Icon -Size 512 -Path (Join-Path $outDir 'icon-maskable-512.png') -Maskable $true
New-Icon -Size 180 -Path (Join-Path $outDir 'apple-touch-icon-180.png')

Write-Output 'Icons written to icon/'
