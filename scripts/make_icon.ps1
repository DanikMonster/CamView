# Convert source image to multi-resolution ICO with smooth rounded corners and transparency
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$rootPath = Resolve-Path (Join-Path $scriptDir "..")
$srcPath = Join-Path $rootPath "icon.png"
$icoPath = Join-Path $rootPath "icon.ico"

if (-not (Test-Path $srcPath)) {
    Write-Error "Source icon not found at: $srcPath"
    exit 1
}

$src = [System.Drawing.Image]::FromFile($srcPath)
$w = $src.Width
$h = $src.Height

# 1. Generate multi-resolution ICO (256, 128, 64, 48, 32, 16)
$sizes = @(256, 128, 64, 48, 32, 16)
$imagesData = @()

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $sz, $sz)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()

    $imagesData += ,@($sz, $bytes)
}

$src.Dispose()

$numImages = $sizes.Count
$firstDataOffset = 6 + (16 * $numImages)

$fs = [System.IO.File]::Create($icoPath)
$writer = New-Object System.IO.BinaryWriter($fs)

$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$numImages)

$currentOffset = $firstDataOffset
foreach ($item in $imagesData) {
    $sz = $item[0]
    $bytes = $item[1]
    $dimByte = if ($sz -eq 256) { [byte]0 } else { [byte]$sz }
    
    $writer.Write($dimByte)
    $writer.Write($dimByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$currentOffset)
    
    $currentOffset += $bytes.Length
}

foreach ($item in $imagesData) {
    $writer.Write($item[1])
}

$writer.Close()
$fs.Close()

Write-Host "Multi-resolution rounded ICO created at: $icoPath"
