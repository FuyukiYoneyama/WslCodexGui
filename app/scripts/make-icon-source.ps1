# Draw the app icon source and the NSIS installer images (PowerShell 7 / Windows).
#
#   pwsh -File scripts/make-icon-source.ps1
#   npx tauri icon src-tauri/icons-src/app-icon.png   # regenerates src-tauri/icons/*
#
# Original artwork (no third-party logos): a dark navy rounded square holding
# a teal speech bubble with a white terminal prompt ">_" -- a chat window
# onto a command-line agent, which is what the app is. Deliberately not a
# plain blue square with ">_", which reads as the PowerShell icon.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'src-tauri/icons-src'
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Draw-Mark([System.Drawing.Graphics]$g, [float]$x, [float]$y, [float]$s) {
    # Body: dark navy rounded square.
    $body = New-RoundedPath $x $y $s $s ($s * 0.22)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF($x, $y)),
        (New-Object System.Drawing.PointF($x, ($y + $s))),
        [System.Drawing.Color]::FromArgb(255, 30, 41, 59),
        [System.Drawing.Color]::FromArgb(255, 15, 23, 42))
    $g.FillPath($grad, $body)

    # Speech bubble: rounded rectangle plus a tail at the lower left.
    $bx = $x + $s * 0.14; $by = $y + $s * 0.16; $bw = $s * 0.72; $bh = $s * 0.54
    $bubble = New-RoundedPath $bx $by $bw $bh ($s * 0.12)
    # The tail starts well inside the bubble so the two fills overlap and no
    # anti-aliased seam shows where they meet.
    [System.Drawing.PointF[]]$tail = @(
        (New-Object System.Drawing.PointF(($bx + $s * 0.13), ($by + $bh - $s * 0.10))),
        (New-Object System.Drawing.PointF(($bx + $s * 0.10), ($by + $bh + $s * 0.17))),
        (New-Object System.Drawing.PointF(($bx + $s * 0.34), ($by + $bh - $s * 0.10)))
    )
    $teal = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF($bx, $by)),
        (New-Object System.Drawing.PointF(($bx + $bw), ($by + $bh))),
        [System.Drawing.Color]::FromArgb(255, 45, 212, 191),
        [System.Drawing.Color]::FromArgb(255, 6, 182, 212))
    $g.FillPolygon($teal, $tail)
    $g.FillPath($teal, $bubble)

    # Prompt inside the bubble: a bold chevron and an underscore cursor.
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, ($s * 0.075))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    [System.Drawing.PointF[]]$chev = @(
        (New-Object System.Drawing.PointF(($x + $s * 0.30), ($y + $s * 0.31))),
        (New-Object System.Drawing.PointF(($x + $s * 0.44), ($y + $s * 0.43))),
        (New-Object System.Drawing.PointF(($x + $s * 0.30), ($y + $s * 0.55)))
    )
    $g.DrawLines($pen, $chev)
    $g.DrawLine($pen, ($x + $s * 0.52), ($y + $s * 0.55), ($x + $s * 0.70), ($y + $s * 0.55))
}

function New-Canvas([int]$w, [int]$h, [System.Drawing.Imaging.PixelFormat]$fmt) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, $fmt)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return @($bmp, $g)
}

# 1) Icon source, 1024x1024 with transparency (small margin like Windows icons).
$bmp, $g = New-Canvas 1024 1024 ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g.Clear([System.Drawing.Color]::Transparent)
Draw-Mark $g 48 48 928
$bmp.Save((Join-Path $outDir 'app-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 2) NSIS sidebar (welcome/finish pages): 164x314, 24-bit BMP.
$bmp, $g = New-Canvas 164 314 ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$side = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(0, 314)),
    [System.Drawing.Color]::FromArgb(255, 30, 41, 59), [System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$g.FillRectangle($side, 0, 0, 164, 314)
Draw-Mark $g 34 40 96
$font = New-Object System.Drawing.Font('Segoe UI Semibold', 13)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("WSL Codex`nGUI", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 150, 164, 60)), $fmt)
$bmp.Save((Join-Path $outDir 'nsis-sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

# 3) NSIS header (inner pages, top right): 150x57, 24-bit BMP, white background.
$bmp, $g = New-Canvas 150 57 ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g.Clear([System.Drawing.Color]::White)
Draw-Mark $g 99 7 43
$bmp.Save((Join-Path $outDir 'nsis-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $bmp.Dispose()

"wrote $outDir"
