# Pins the FFmpeg build bundled with Photogramme (run once, then again only
# when you want a newer FFmpeg).
#
#  1. Downloads BtbN's latest FFmpeg 8.1 LGPL build for Windows and checks it
#     against BtbN's published SHA-256 list.
#  2. Keeps a copy in this repository's GitHub release "ffmpeg-deps" (marked
#     as a pre-release, so it never counts as the "latest" app release that the
#     updater reads).
#  3. Writes scripts\ffmpeg.lock (address + SHA-256 + exact FFmpeg commit).
#  4. Updates the FFmpeg lines of THIRD_PARTY_NOTICES.txt (version, configure
#     line, link to the exact source code).
#  5. Installs it in src-tauri\binaries (scripts\setup-ffmpeg.ps1).
#
# Usage, from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\mirror-ffmpeg.ps1
# Then commit scripts\ffmpeg.lock and THIRD_PARTY_NOTICES.txt (release.ps1 does it).
# This file is saved as UTF-8 with BOM so that Windows PowerShell 5.1 reads it correctly.

param(
    [string]$Version = "8.1"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object System.Text.UTF8Encoding($false)
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Commande externe dont on ignore les messages d'erreur. Windows PowerShell 5.1
# transforme toute sortie d'erreur REDIRIGEE en erreur fatale quand
# $ErrorActionPreference vaut "Stop" (ex. "release not found", reponse normale
# de gh). On juge le resultat sur $LASTEXITCODE, jamais sur ces messages.
function Quiet([scriptblock]$cmd) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $cmd 2>$null } finally { $ErrorActionPreference = $old }
}
function Fail([string]$m) { Write-Host $m -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }

Step "1. Checks"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail "GitHub CLI (gh) not found." }
Quiet { gh auth status } | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Not logged in to GitHub: run   gh auth login" }
$repo = (gh repo view --json nameWithOwner --jq .nameWithOwner).Trim()
if (-not $repo) { Fail "No GitHub repository for this folder." }
Info "Repository: $repo"

Step "2. Download and verify BtbN's build"
$tmp = Join-Path $env:TEMP "photogramme-ffmpeg-mirror"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$btbnName = "ffmpeg-n$Version-latest-win64-lgpl-$Version.zip"
$base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
$zip = Join-Path $tmp $btbnName
Invoke-WebRequest -Uri "$base/$btbnName" -OutFile $zip -UseBasicParsing
$sums = (Invoke-WebRequest -Uri "$base/checksums.sha256" -UseBasicParsing).Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($btbnName) } | Select-Object -First 1
if (-not $line) { Fail "$btbnName is not in BtbN's checksum list." }
$sha = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
if ($sha -ne ($line -split "\s+")[0].ToLowerInvariant()) { Fail "SHA-256 mismatch with BtbN's list: download corrupted or replaced." }
Info "SHA-256 verified: $sha"

Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "x")
$exe = Get-ChildItem -Path (Join-Path $tmp "x") -Recurse -File -Filter "ffmpeg.exe" | Select-Object -First 1
$verText = (& $exe.FullName -hide_banner -version) -join "`n"
if ($verText -notmatch "ffmpeg version (\S+)") { Fail "Cannot read the FFmpeg version." }
$ffver = $Matches[1]
if ($verText -match "--enable-gpl|--enable-nonfree") { Fail "This build is not LGPL: refusing to bundle it." }
$configure = if ($verText -match "configuration: (.+)") { $Matches[1].Trim() } else { "" }
if ($ffver -notmatch "-g([0-9a-f]{7,40})") { Fail "No git commit in the version '$ffver'." }
$short = $Matches[1]
$commit = Quiet { gh api "repos/FFmpeg/FFmpeg/commits/$short" --jq .sha }
if (-not $commit) { $commit = $short }
$commit = $commit.Trim()
$sourceUrl = "https://github.com/FFmpeg/FFmpeg/archive/$commit.tar.gz"
Info "FFmpeg $ffver (commit $commit)"

Step "3. Copy into the 'ffmpeg-deps' release of $repo"
$assetName = "ffmpeg-$ffver-win64-lgpl.zip"
$asset = Join-Path $tmp $assetName
Copy-Item $zip $asset
Quiet { gh release view ffmpeg-deps } | Out-Null
if ($LASTEXITCODE -ne 0) {
    gh release create ffmpeg-deps --prerelease --title "FFmpeg builds bundled with Photogramme" `
        --notes "Not an app release. Exact FFmpeg LGPL builds bundled with Photogramme, pinned in scripts/ffmpeg.lock. Source code of each build: see THIRD_PARTY_NOTICES.txt." | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "gh release create failed." }
}
gh release upload ffmpeg-deps $asset --clobber
if ($LASTEXITCODE -ne 0) { Fail "gh release upload failed." }
$url = "https://github.com/$repo/releases/download/ffmpeg-deps/$assetName"
Info $url

Step "4. scripts\ffmpeg.lock and THIRD_PARTY_NOTICES.txt"
$lock = [ordered]@{ version = $ffver; file = $assetName; url = $url; sha256 = $sha; commit = $commit; source = $sourceUrl }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "ffmpeg.lock"), (($lock | ConvertTo-Json) + "`n"), $utf8)
Info "ffmpeg.lock written."
$notices = Join-Path $root "THIRD_PARTY_NOTICES.txt"
if (Test-Path $notices) {
    $t = [IO.File]::ReadAllText($notices)
    $t = [regex]::Replace($t, "(?m)^FFmpeg version\s+.*$", "FFmpeg version    $ffver")
    $t = [regex]::Replace($t, "(?m)^Source code\s+https://\S+$", "Source code       $sourceUrl")
    if ($configure) {
        $t = [regex]::Replace($t, "(?m)(^Build options \(configure line\):\r?\n).*$", { param($m) $m.Groups[1].Value + $configure })
    }
    [IO.File]::WriteAllText($notices, $t, $utf8)
    Info "THIRD_PARTY_NOTICES.txt updated."
} else {
    Write-Host "   THIRD_PARTY_NOTICES.txt not found: keep the source link $sourceUrl in your notices." -ForegroundColor Yellow
}

Step "5. Install"
& (Join-Path $PSScriptRoot "setup-ffmpeg.ps1")
Write-Host "`nDone. Commit scripts\ffmpeg.lock and THIRD_PARTY_NOTICES.txt (release.ps1 does it for you)." -ForegroundColor Green
