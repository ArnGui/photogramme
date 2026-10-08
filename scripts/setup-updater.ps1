# Sets up automatic updates (run ONCE).
#
#  1. Creates the update signing key pair (minisign, via the Tauri CLI):
#     - private key: %USERPROFILE%\.tauri\photogramme-updater.key (protected by a password)
#     - public key:  written into src-tauri\tauri.conf.json (plugins > updater > pubkey)
#  2. Stores the private key and its password as GitHub Actions secrets, so the
#     release build can sign the installer.
#
# Every installed copy of Photogramme checks that an update was signed by this
# key before installing it. Keep the key file AND its password in a password
# manager: if you lose them, installed copies can no longer update themselves
# (people would have to download the next version by hand).
#
# Usage, from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-updater.ps1
# This file is saved as UTF-8 with BOM so that Windows PowerShell 5.1 reads it correctly.

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
function Plain([Security.SecureString]$s) {
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

Step "1. Checks"
foreach ($t in @("gh", "npx")) { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Fail "$t not found in PATH." } }
Quiet { gh auth status } | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Not logged in to GitHub: run   gh auth login" }
$conf = Join-Path $root "src-tauri\tauri.conf.json"
$confText = [IO.File]::ReadAllText($conf)
if ($confText -notmatch '"pubkey"\s*:\s*"[^"]*"') { Fail "No plugins > updater > pubkey entry in tauri.conf.json." }
if ($confText -match '"pubkey"\s*:\s*"[^"\s]+"') {
    Write-Host "   A public key is already set in tauri.conf.json." -ForegroundColor Yellow
    Write-Host "   Replacing it means copies installed with the old key will NOT accept updates signed with the new one." -ForegroundColor Yellow
    if ((Read-Host "   Type REPLACE to create a new key anyway") -cne "REPLACE") { Write-Host "Nothing changed."; exit 0 }
}

Step "2. Key pair"
$dir = Join-Path $env:USERPROFILE ".tauri"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$key = Join-Path $dir "photogramme-updater.key"
$pw1 = Read-Host "   Choose a password for the key (12 characters or more)" -AsSecureString
$pw2 = Read-Host "   Same password again" -AsSecureString
$pw = Plain $pw1
if ($pw -ne (Plain $pw2)) { Fail "The two passwords differ." }
if ($pw.Length -lt 12) { Fail "Password too short." }
npx --yes tauri signer generate --ci -f -p $pw -w $key | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$key.pub")) { Fail "Key generation failed (messages above)." }
$pub = ([IO.File]::ReadAllText("$key.pub")).Trim()
Info "Private key: $key"

Step "3. Public key in tauri.conf.json"
$confText = [regex]::Replace($confText, '"pubkey"\s*:\s*"[^"]*"', ('"pubkey": "' + $pub + '"'), 1)
[IO.File]::WriteAllText($conf, $confText, $utf8)
Info "Written."

Step "4. GitHub secrets"
Get-Content -Raw $key | gh secret set TAURI_SIGNING_PRIVATE_KEY
if ($LASTEXITCODE -ne 0) { Fail "gh secret set failed." }
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body $pw
if ($LASTEXITCODE -ne 0) { Fail "gh secret set failed." }
Info "TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD stored in the repository's Actions secrets."

Write-Host ""
Write-Host "Done. Now SAVE in your password manager:" -ForegroundColor Green
Write-Host "  - the file $key"
Write-Host "  - its password"
Write-Host "Then commit src-tauri\tauri.conf.json (release.ps1 does it for you)."
