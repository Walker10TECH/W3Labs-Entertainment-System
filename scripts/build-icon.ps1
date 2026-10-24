New-Item -ItemType Directory -Force -Path 'build' | Out-Null
Add-Type -AssemblyName System.Drawing
$pngPath = (Resolve-Path 'src/renderer/assets/W3Labs.png').Path
$icoPath = (Join-Path (Resolve-Path 'build').Path 'icon.ico')
$srcBmp = [System.Drawing.Bitmap]::FromFile($pngPath)

# Standard icon sizes for Windows
$sizes = @(16, 32, 48, 64, 128, 256)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)

# ICONDIR header: Reserved (0), Type (1 = ICO), Count
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)

$pngStreams = @()
foreach ($sz in $sizes) {
    $resized = New-Object System.Drawing.Bitmap($sz, $sz)
    $g = [System.Drawing.Graphics]::FromImage($resized)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($srcBmp, 0, 0, $sz, $sz)
    $g.Dispose()

    $pms = New-Object System.IO.MemoryStream
    $resized.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
    $resized.Dispose()
    $pngStreams += $pms
}

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $pms = $pngStreams[$i]
    $bytes = $pms.ToArray()
    
    # Width & Height: 0 means 256
    $wByte = if ($sz -eq 256) { [byte]0 } else { [byte]$sz }
    $hByte = if ($sz -eq 256) { [byte]0 } else { [byte]$sz }
    $bw.Write($wByte)
    $bw.Write($hByte)
    $bw.Write([byte]0) # Color count
    $bw.Write([byte]0) # Reserved
    $bw.Write([UInt16]1) # Color planes
    $bw.Write([UInt16]32) # Bit depth
    $bw.Write([UInt32]$bytes.Length) # Image size in bytes
    $bw.Write([UInt32]$offset) # File offset
    $offset += $bytes.Length
}

for ($i = 0; $i -lt $sizes.Count; $i++) {
    $bytes = $pngStreams[$i].ToArray()
    $bw.Write($bytes)
    $pngStreams[$i].Dispose()
}

$srcBmp.Dispose()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()
Write-Host "Created icon.ico: $((Get-Item $icoPath).Length) bytes"
