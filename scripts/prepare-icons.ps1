param(
    [string]$SourcePath = (Join-Path $PSScriptRoot '..\public\icons\app-icon-source.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outputDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\public\icons'))
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$savedSource = Join-Path $outputDirectory 'app-icon-source.png'
if ($resolvedSource -ne $savedSource) {
    Copy-Item -LiteralPath $resolvedSource -Destination $savedSource
}

$source = [Drawing.Bitmap]::FromFile($savedSource)
try {
    # Fit every visible source pixel inside the maskable icon's central safe circle.
    $centerX = $source.Width / 2.0
    $centerY = $source.Height / 2.0
    $maximumRadius = 0.0
    for ($y = 0; $y -lt $source.Height; $y++) {
        for ($x = 0; $x -lt $source.Width; $x++) {
            if ($source.GetPixel($x, $y).A -gt 0) {
                $radius = [Math]::Sqrt([Math]::Pow($x + 0.5 - $centerX, 2) + [Math]::Pow($y + 0.5 - $centerY, 2))
                if ($radius -gt $maximumRadius) { $maximumRadius = $radius }
            }
        }
    }

    $variants = @(
        @{ Name = 'app-icon-192.png'; Size = 192; Opaque = $false },
        @{ Name = 'app-icon-512.png'; Size = 512; Opaque = $false },
        @{ Name = 'apple-touch-icon.png'; Size = 180; Opaque = $true },
        @{ Name = 'favicon-32.png'; Size = 32; Opaque = $false },
        @{ Name = 'maskable-512.png'; Size = 512; Opaque = $true }
    )
    foreach ($variant in $variants) {
        $size = [int]$variant.Size
        $bitmap = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $scale = [Math]::Min($size / [double]$source.Width, $size / [double]$source.Height)
            if ($variant.Opaque) {
                $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#0d1114'))
                $scale = [Math]::Min($scale * 0.70, ($size * 0.39 - 1) / $maximumRadius)
            } else {
                $graphics.Clear([Drawing.Color]::Transparent)
            }
            $width = [single]($source.Width * $scale)
            $height = [single]($source.Height * $scale)
            $destination = New-Object Drawing.RectangleF(([single](($size - $width) / 2)), ([single](($size - $height) / 2)), $width, $height)
            $graphics.DrawImage($source, $destination)
            $bitmap.Save((Join-Path $outputDirectory $variant.Name), [Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $source.Dispose()
}

Get-ChildItem -LiteralPath $outputDirectory -Filter '*.png' | ForEach-Object {
    $bitmap = [Drawing.Bitmap]::FromFile($_.FullName)
    try {
        [PSCustomObject]@{
            File = $_.Name
            Width = $bitmap.Width
            Height = $bitmap.Height
            CornerAlpha = $bitmap.GetPixel(0, 0).A
            Bytes = $_.Length
        }
    } finally { $bitmap.Dispose() }
}
