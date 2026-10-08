# Publishes a new version of Photogramme in one command.
#
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.4.1 -Notes "Fixes the contact sheet titles."
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.5.0 -NotesFile notes.md
#
#  1. Checks: clean git tree, GitHub login, update key set up, FFmpeg pinned.
#  2. Sets the version everywhere (package.json, tauri.conf.json, Cargo.toml x2, Cargo.lock).
#  3. Runs every test (skip with -SkipTests).
#  4. Writes docs\release-notes\vX.Y.Z.md, commits, tags vX.Y.Z and pushes.
#  5. GitHub Actions builds the Windows installer and the macOS app, signs
#     both for the updater and prepares a DRAFT release (installer, DMG,
#     signatures, latest.json, FFmpeg source). The script follows the build.
#  6. You type PUBLISH: the release goes public and every installed copy
#     offers the update at its next start.
#
# One-time setup before the first release: scripts\setup-updater.ps1 and
# scripts\mirror-ffmpeg.ps1.
# This file is saved as UTF-8 with BOM so that Windows PowerShell 5.1 reads it correctly.

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",
    [string]$NotesFile = "",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
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
function Load([string]$p) { [IO.File]::ReadAllText((Join-Path $root $p)) }
function Save([string]$p, [string]$t) { [IO.File]::WriteAllText((Join-Path $root $p), $t, $utf8) }

if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "Version must look like 1.2.3 (got '$Version')." }
$tag = "v$Version"

Step "1. Checks"
foreach ($t in @("git", "gh", "cargo", "npm", "npx")) { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Fail "$t not found in PATH." } }
Quiet { gh auth status } | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Not logged in to GitHub: run   gh auth login" }
$dirty = @(git status --porcelain)
if ($dirty.Count) {
    Write-Host "   Uncommitted changes (they will be part of the release commit):" -ForegroundColor Yellow
    $dirty | Select-Object -First 30 | ForEach-Object { Write-Host "     $_" }
    if ((Read-Host "   Type YES to include them") -cne "YES") { Fail "Stopped: commit or discard them first." }
}
git fetch -q --tags
if (@(git tag -l $tag).Count) { Fail "Tag $tag already exists." }
if ((Load "src-tauri\tauri.conf.json") -notmatch '"pubkey"\s*:\s*"[^"\s]+"') { Fail "No update key yet: run scripts\setup-updater.ps1 first." }
if (-not (Test-Path (Join-Path $root "scripts\ffmpeg.lock"))) { Fail "FFmpeg is not pinned yet: run scripts\mirror-ffmpeg.ps1 first." }
$secrets = (gh secret list --json name --jq ".[].name") -join " "
if ($secrets -notmatch "TAURI_SIGNING_PRIVATE_KEY") { Fail "GitHub secret TAURI_SIGNING_PRIVATE_KEY missing: run scripts\setup-updater.ps1." }
$repo = (gh repo view --json nameWithOwner --jq .nameWithOwner).Trim()
Info "Repository: $repo · release $tag"

if ($NotesFile) { $Notes = [IO.File]::ReadAllText((Resolve-Path $NotesFile)) }
if (-not $Notes.Trim()) { $Notes = Read-Host "   What changed in $Version (one line, shown in the update banner)" }
if (-not $Notes.Trim()) { Fail "Release notes are required: they appear in the update banner." }

Step "2. Version $Version everywhere"
$versionFiles = @("package.json", "src-tauri\tauri.conf.json", "src-tauri\Cargo.toml", "src-tauri\core\Cargo.toml", "src-tauri\Cargo.lock")
$backup = @{}
foreach ($f in $versionFiles) { $backup[$f] = Load $f }
$p = Load "package.json"
Save "package.json" ([regex]::Replace($p, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 1))
$c = Load "src-tauri\tauri.conf.json"
Save "src-tauri\tauri.conf.json" ([regex]::Replace($c, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 1))
foreach ($toml in @("src-tauri\Cargo.toml", "src-tauri\core\Cargo.toml")) {
    $t = Load $toml
    Save $toml ([regex]::Replace($t, '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`"", 1))
}
Quiet { cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 --offline } | Out-Null
if ($LASTEXITCODE -ne 0) { Quiet { cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 } | Out-Null }
Info "package.json, tauri.conf.json, Cargo.toml, Cargo.lock"

if (-not $SkipTests) {
    Step "3. Tests"
    & (Join-Path $PSScriptRoot "setup-ffmpeg.ps1") | Out-Null
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run-tests.ps1")
    if ($LASTEXITCODE -ne 0) {
        foreach ($f in $versionFiles) { Save $f $backup[$f] }
        Fail "Tests failed: version changes undone, nothing was published."
    }
} else {
    Step "3. Tests skipped (-SkipTests)"
}

Step "4. Commit, tag, push"
New-Item -ItemType Directory -Force -Path (Join-Path $root "docs\release-notes") | Out-Null
Save "docs\release-notes\$tag.md" ($Notes.Trim() + "`n")
git add -A
git commit -q -m "Release $Version"
if ($LASTEXITCODE -ne 0) { Fail "git commit failed." }
git tag -a $tag -m "Photogramme $Version"
git push -q
git push -q origin $tag
if ($LASTEXITCODE -ne 0) { Fail "git push failed." }
Info "Pushed $tag."

Step "5. Build on GitHub (about 10 to 15 minutes)"
Start-Sleep -Seconds 8
$runId = $null
for ($i = 0; $i -lt 20 -and -not $runId; $i++) {
    $runId = Quiet { gh run list --workflow release.yml --branch $tag --limit 1 --json databaseId --jq ".[0].databaseId" }
    if (-not $runId) { Start-Sleep -Seconds 5 }
}
if (-not $runId) { Fail "The release build did not start: check the Actions tab of $repo." }
gh run watch $runId --exit-status
if ($LASTEXITCODE -ne 0) { Fail "The release build failed: open   gh run view $runId --log-failed   and send the red lines to Claude." }

Step "6. Publish"
gh release view $tag --json url,assets --jq '.url, (.assets[].name)'
$answer = Read-Host "`n   Type PUBLISH to make $tag public (installed copies will offer the update)"
if ($answer -cne "PUBLISH") { Write-Host "Kept as a draft. Publish later from the release page, or:   gh release edit $tag --draft=false --latest" -ForegroundColor Yellow; exit 0 }
gh release edit $tag --draft=false --latest
if ($LASTEXITCODE -ne 0) { Fail "Could not publish the release." }
Write-Host "`nPhotogramme $Version is out: https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
