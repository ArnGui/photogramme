# Photogramme - adds the README screenshots
#
# Copies the 5 images from your folder into docs\screenshots under the names the
# README expects, converts them to PNG and shrinks them to 1600 px wide at most
# (larger images make the GitHub page slow), then commits and pushes.
#
# Usage, from the project folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\add-screenshots.ps1
#   ... -From "C:\other\folder"      if the images are somewhere else
#   ... -NoPush                       commit only
#
# Expected names in the folder (png, jpg or jpeg): main, shots, scopes, contact-sheet, still.

param([string]$From = "$env:USERPROFILE\Pictures\Screenshots-photogrammes", [string]$Root = 'D:\photogramme', [switch]$NoPush)

if (-not $PSBoundParameters.ContainsKey('Root') -and $PSScriptRoot) { $Root = Split-Path $PSScriptRoot -Parent }
$ErrorActionPreference = 'Stop'
function Fail([string]$m) { Write-Host $m -ForegroundColor Red; exit 1 }
function Info([string]$m) { Write-Host "   $m" }

if (-not (Test-Path $From)) { Fail "Folder not found: $From" }
Add-Type -AssemblyName System.Drawing

$names = @('main', 'shots', 'scopes', 'contact-sheet', 'still')
$found = @{}
foreach ($n in $names) {
  $f = Get-ChildItem -Path $From -File | Where-Object { $_.BaseName -ieq $n -and $_.Extension -match '^\.(png|jpe?g)$' } | Select-Object -First 1
  if ($f) { $found[$n] = $f }
}
$missing = @($names | Where-Object { -not $found.ContainsKey($_) })
if ($missing.Count) {
  Write-Host "Missing in ${From}: $($missing -join ', ')" -ForegroundColor Red
  Write-Host 'Files found there:'
  Get-ChildItem -Path $From -File | ForEach-Object { Info $_.Name }
  Fail 'Rename them (main, shots, scopes, contact-sheet, still) and run the script again.'
}

$dest = Join-Path $Root 'docs\screenshots'
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($n in $names) {
  $src = $found[$n].FullName
  $out = Join-Path $dest "$n.png"
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    $w = $img.Width; $h = $img.Height
    if ($w -gt 1600) { $h = [int][Math]::Round($h * 1600 / $w); $w = 1600 }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $w, $h)
      $g.Dispose()
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bmp.Dispose() }
  } finally { $img.Dispose() }
  Info ("{0,-18} {1} x {2}  {3:N0} KB" -f "$n.png", $w, $h, ((Get-Item $out).Length / 1KB))
}

Set-Location $Root
git add docs/screenshots README.md
git commit -q -m "README: screenshots"
if ($LASTEXITCODE -ne 0) { Fail 'Nothing was committed (the images may already be identical).' }
if ($NoPush) { Write-Host "`nCommitted. Push with: git push" -ForegroundColor Green; exit 0 }
git push -q
if ($LASTEXITCODE -ne 0) { Fail 'The push failed (message above). The commit is saved: run git push again.' }
Write-Host "`nDone. The page is online: open your repository on GitHub." -ForegroundColor Green
