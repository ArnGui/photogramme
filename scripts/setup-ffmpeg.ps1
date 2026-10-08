# Installs the FFmpeg build bundled with Photogramme where Tauri expects it:
# src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe (+ ffprobe).
#
# Usage, from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ffmpeg.ps1
#
# Reproducible and verified:
# - scripts\ffmpeg.lock pins ONE exact archive (address + SHA-256). Everyone,
#   including the GitHub release build, gets byte-for-byte the same ffmpeg.exe.
#   The archive is a copy kept in this project's own GitHub release
#   "ffmpeg-deps" (made by scripts\mirror-ffmpeg.ps1): BtbN's "latest" builds
#   change every day and old ones are deleted, so they cannot be pinned.
# - Without a lock file, the script falls back to BtbN's latest 8.1 LGPL build,
#   still verified against BtbN's published SHA-256 list.
#
# LGPL build: no libx264/x265 (not needed, the app only decodes), so the app
# stays distributable. NVDEC/CUDA decoders are included.
# This file is saved as UTF-8 with BOM so that Windows PowerShell 5.1 reads it correctly.

param(
    [string]$Version = "8.1"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root "src-tauri\binaries"
$triple = "x86_64-pc-windows-msvc"
$tmp = Join-Path $env:TEMP "photogramme-ffmpeg"
$lockPath = Join-Path $PSScriptRoot "ffmpeg.lock"
New-Item -ItemType Directory -Force -Path $binDir, $tmp | Out-Null

function Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant() }

if (Test-Path $lockPath) {
    $lock = Get-Content -Raw -Path $lockPath | ConvertFrom-Json
    $zipName = $lock.file
    $url = $lock.url
    $expected = $lock.sha256.ToLowerInvariant()
    Write-Host "Pinned build: $($lock.version) ($zipName)"
} else {
    $zipName = "ffmpeg-n$Version-latest-win64-lgpl-$Version.zip"
    $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$zipName"
    Write-Host "No scripts\ffmpeg.lock: using BtbN's latest $Version build (run scripts\mirror-ffmpeg.ps1 to pin one)."
    $sums = (Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256" -UseBasicParsing).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
    if (-not $line) { throw "$zipName is not in BtbN's checksum list." }
    $expected = ($line -split "\s+")[0].ToLowerInvariant()
}

$zip = Join-Path $tmp $zipName
if ((Test-Path $zip) -and ((Sha256 $zip) -eq $expected)) {
    Write-Host "Already downloaded."
} else {
    Write-Host "Downloading $zipName ..."
    $done = $false
    # Archive d'une release GitHub : on passe par gh quand il est connecté, ce qui
    # marche aussi pour un dépôt privé (un téléchargement anonyme y reçoit 404).
    if ($url -match '^https://github\.com/([^/]+/[^/]+)/releases/download/([^/]+)/(.+)$' -and (Get-Command gh -ErrorAction SilentlyContinue)) {
        $ghRepo = $Matches[1]; $ghTag = $Matches[2]; $ghFile = $Matches[3]
        $old = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try { gh release download $ghTag -R $ghRepo -p $ghFile -D $tmp --clobber 2>$null | Out-Null } finally { $ErrorActionPreference = $old }
        $done = ($LASTEXITCODE -eq 0) -and (Test-Path $zip)
    }
    if (-not $done) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        } catch {
            throw "Cannot download $url ($($_.Exception.Message)). If the repository is private, log in with   gh auth login   and run this script again."
        }
    }
}
$actual = Sha256 $zip
if ($actual -ne $expected) {
    Remove-Item -Force $zip
    throw "SHA-256 mismatch for $zipName`n  expected $expected`n  got      $actual`nThe download was corrupted or replaced: nothing was installed."
}
Write-Host "SHA-256 verified: $actual"

Write-Host "Extracting ..."
$extract = Join-Path $tmp "extract"
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -Path $zip -DestinationPath $extract

$bin = Get-ChildItem -Path $extract -Recurse -Directory -Filter "bin" | Select-Object -First 1
if (-not $bin) { throw "No bin folder found in the archive." }

foreach ($tool in @("ffmpeg", "ffprobe")) {
    $src = Join-Path $bin.FullName "$tool.exe"
    $dst = Join-Path $binDir "$tool-$triple.exe"
    Copy-Item -Force $src $dst
    Write-Host "OK  $dst"
}

# License and sources: required if you ever redistribute the application.
$license = Get-ChildItem -Path $extract -Recurse -File -Filter "LICENSE*" | Select-Object -First 1
if ($license) { Copy-Item -Force $license.FullName (Join-Path $binDir "FFMPEG-LICENSE.txt") }

& (Join-Path $binDir "ffmpeg-$triple.exe") -hide_banner -hwaccels
Write-Host ""
Write-Host "FFmpeg installed. 'cuda' must appear in the list above."
