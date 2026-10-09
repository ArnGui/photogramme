# Photogramme - license notice, in-app license line, installer resources and README
#
# What it does, in order:
#  1. Reads the FFmpeg actually bundled (version, build options). Stops if it is a GPL or non-free build.
#  2. Writes THIRD_PARTY_NOTICES.txt: version, build options, link to the exact FFmpeg source, license text.
#  3. Ships that file with the installer (tauri.conf.json > bundle > resources).
#  4. Checks the line required by FFmpeg ("uses libraries from the FFmpeg project under the LGPL")
#     in Preferences > About & licenses (src\PrefsDialog.tsx since v0.7).
#  5. Writes a new README.md (the GitHub page).
#  6. Downloads the matching FFmpeg source archive into release-extras\ (to attach to future releases).
#  7. Type-checks, then commits and pushes.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File prepare-release.ps1
#        add -NoPush to commit without pushing.

param([string]$Root = 'D:\photogramme', [switch]$NoPush)

if (-not $PSBoundParameters.ContainsKey('Root') -and $PSScriptRoot) {
  $cand = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $cand 'src-tauri\tauri.conf.json')) { $Root = $cand }
}

$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with its progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object System.Text.UTF8Encoding($false)
$manual = @()

function Fail([string]$m) { Write-Host $m -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }
function Warn([string]$m) { Write-Host "   $m" -ForegroundColor Yellow }
function Save([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $utf8) }
# License texts: gnu.org first, GitHub's copy of the same official text if gnu.org is unreachable.
function Get-Text([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60).Content }
  catch {
    $err = $_.Exception.Message
    $map = @{ 'lgpl-3.0.txt' = 'lgpl-3.0'; 'lgpl-2.1.txt' = 'lgpl-2.1'; 'gpl-3.0.txt' = 'gpl-3.0' }
    $key = Split-Path $url -Leaf
    if ($map.ContainsKey($key) -and (Get-Command gh -ErrorAction SilentlyContinue)) {
      $body = (gh api "licenses/$($map[$key])" --jq .body) -join "`n"
      if ($LASTEXITCODE -eq 0 -and $body.Length -gt 1000) { Warn "gnu.org unreachable: $key taken from GitHub instead."; return $body }
    }
    Fail "Download failed: $url ($err)"
  }
}

if (-not (Test-Path $Root)) { Fail "Project folder not found: $Root" }
Set-Location $Root

# ---------------------------------------------------------------------------
Step '1. Bundled FFmpeg'
$bin = Join-Path $Root 'src-tauri\binaries'
$ff  = Join-Path $bin 'ffmpeg-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path $ff)) { Fail "FFmpeg not found: $ff`nRun scripts\setup-ffmpeg.ps1 first." }

$verOut = & $ff -version
$first  = $verOut | Select-Object -First 1
$cfgLine = $verOut | Where-Object { $_ -like 'configuration:*' } | Select-Object -First 1
if (-not $first -or -not $cfgLine) { Fail 'Could not read the FFmpeg version.' }
if ($first -notmatch '^ffmpeg version (\S+)') { Fail "Unexpected version line: $first" }
$ffver  = $Matches[1]
$config = $cfgLine.Substring('configuration:'.Length).Trim()

if ($config -match '--enable-gpl' -or $config -match '--enable-nonfree') {
  Fail 'This FFmpeg is a GPL or non-free build: it cannot be shipped with Photogramme under the LGPL. Re-run scripts\setup-ffmpeg.ps1 (LGPL build).'
}
$lgpl = if ($config -match '--enable-version3') { '3' } else { '2.1' }
$libs = @([regex]::Matches($config, '--enable-(lib[0-9a-z_]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
Info "Version: $ffver"
Info "License: LGPL v$lgpl (no --enable-gpl, no --enable-nonfree)"

# Exact source: BtbN builds carry the git commit in the version string (-g<hash>).
if ($ffver -match '-g([0-9a-f]{7,40})') {
  $short = $Matches[1]
  $full = $null
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $r = gh api "repos/FFmpeg/FFmpeg/commits/$short" --jq .sha 2>$null
    if ($LASTEXITCODE -eq 0 -and "$r".Trim() -match '^[0-9a-f]{40}$') { $full = "$r".Trim() }
  }
  $srcRef = if ($full) { $full } else { $short }
  $srcUrl = "https://github.com/FFmpeg/FFmpeg/archive/$srcRef.tar.gz"
} elseif ($ffver -match '^n\d+(\.\d+)*$') {
  $srcRef = $ffver
  $srcUrl = "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/$ffver.tar.gz"
} else {
  Fail "Cannot work out the source code link from version '$ffver'. Send this line to Claude."
}
Info "Source: $srcUrl"

# ---------------------------------------------------------------------------
Step '2. THIRD_PARTY_NOTICES.txt'
$want = if ($lgpl -eq '3') { 'Version 3, 29 June 2007' } else { 'Version 2.1, February 1999' }
$licText = $null
$licFile = Join-Path $bin 'FFMPEG-LICENSE.txt'
if (Test-Path $licFile) {
  $t = [IO.File]::ReadAllText($licFile)
  if ($t -match 'LESSER GENERAL PUBLIC LICENSE' -and $t.Contains($want)) { $licText = $t.Trim(); Info 'License text taken from the FFmpeg build.' }
}
if (-not $licText) {
  $u = if ($lgpl -eq '3') { 'https://www.gnu.org/licenses/lgpl-3.0.txt' } else { 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt' }
  $licText = (Get-Text $u).Trim()
  Info "License text downloaded from gnu.org."
}
# The LGPL v3 is a set of permissions added to the GPL v3: both texts must be shipped.
if ($lgpl -eq '3' -and $licText -cnotmatch 'GNU GENERAL PUBLIC LICENSE\s+Version 3') {
  $licText = $licText + "`n`n" + ('=' * 78) + "`n`n" + (Get-Text 'https://www.gnu.org/licenses/gpl-3.0.txt').Trim()
  Info 'GPL v3 text added (required with the LGPL v3).'
}

$libsText = if ($libs.Count) { ($libs -join ', ') } else { '(none)' }
$sep = '=' * 78
$notice = @"
Photogramme - third-party software
$sep

This software uses libraries from the FFmpeg project under the LGPLv$lgpl.

Photogramme ships two FFmpeg programs, ffmpeg.exe and ffprobe.exe, in its
installation folder. They run as separate processes; Photogramme is not
linked against FFmpeg. FFmpeg was not modified.

FFmpeg version    $ffver
Built by          BtbN/FFmpeg-Builds, LGPL variant
                  https://github.com/BtbN/FFmpeg-Builds
Source code       $srcUrl
                  (the exact FFmpeg source of the bundled programs)
FFmpeg project    https://ffmpeg.org

Build options (configure line):
$config

External libraries compiled into this FFmpeg build, each under its own
license (see the build project above): $libsText

No GPL or non-free component of FFmpeg is used (no --enable-gpl, no
--enable-nonfree, no libx264). You may replace ffmpeg.exe and ffprobe.exe
with your own build.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

$sep
FFmpeg license (GNU Lesser General Public License, version $lgpl)
$sep

$licText
"@
Save (Join-Path $Root 'THIRD_PARTY_NOTICES.txt') ($notice.Replace("`r`n", "`n") + "`n")
Info 'Written.'

# ---------------------------------------------------------------------------
Step '3. Ship the notice with the installer (tauri.conf.json)'
$conf = Join-Path $Root 'src-tauri\tauri.conf.json'
$j = [IO.File]::ReadAllText($conf)
if ($j.Contains('THIRD_PARTY_NOTICES.txt')) {
  Info 'Already declared.'
} elseif ($j -match '"resources"\s*:') {
  Warn 'tauri.conf.json already has "resources": add this entry to it by hand:'
  Warn '  "../THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt"'
  $manual += 'tauri.conf.json resources'
} else {
  $re = [regex]'"bundle"\s*:\s*\{'
  if ($re.Matches($j).Count -ne 1) {
    Warn 'Could not find a single "bundle" section: add the resources entry by hand.'
    $manual += 'tauri.conf.json resources'
  } else {
    $j2 = $re.Replace($j, '"bundle": {' + "`n    " + '"resources": { "../THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt" },', 1)
    $ok = $true
    try { $null = $j2 | ConvertFrom-Json } catch { $ok = $false }
    if ($ok) { Save $conf $j2; Info 'Added to bundle > resources.' }
    else { Warn 'The edited file would not be valid JSON: left unchanged, add the entry by hand.'; $manual += 'tauri.conf.json resources' }
  }
}

# ---------------------------------------------------------------------------
Step '4. License line in the app (Preferences > About & licenses)'
# Since v0.7 the line lives in the Preferences dialog (src\PrefsDialog.tsx), not at the bottom of a
# SETTINGS tab (that tab no longer exists). The line is only checked here, never injected: code
# written into a component by a script would not survive the next refactor.
$app = Join-Path $Root 'src\PrefsDialog.tsx'
$a = [IO.File]::ReadAllText($app)
if (([regex]::Matches($a, '<p className="legal">[^<]*FFmpeg project under the LGPL')).Count -eq 1) {
  Info 'Present in PrefsDialog.tsx.'
} else {
  Warn 'The FFmpeg license line was not found in src\PrefsDialog.tsx (Preferences > About & licenses).'
  $manual += 'FFmpeg license line in src\PrefsDialog.tsx'
}

# ---------------------------------------------------------------------------
Step '5. README.md'
$repoUrl = $null
if (Get-Command gh -ErrorAction SilentlyContinue) { $repoUrl = gh repo view --json url --jq .url 2>$null }
if ($repoUrl) { $repoUrl = $repoUrl.Trim() } else { $repoUrl = 'https://github.com/ArnGui/photogramme' }
$repoDir = ($repoUrl -split '/')[-1]

$readme = @'
# Photogramme

Photogramme pulls stills out of finished films. Open an H.264 file and it finds the cuts, keeps one frame per shot (or as many as you want), and saves them as JPEG, with the dominant colors of each frame laid out underneath if you ask for them.

I built it for my own work as a documentary filmmaker: contact sheets for clients, stills for festivals and press kits, color references before a grade. It runs on Windows and puts an NVIDIA graphics card to work when there is one.

{{SCREENSHOT}}

## What it does

**Single frames.** Frame-accurate playback and stepping. Press `C` and the frame on screen is saved at full resolution. Existing files are never overwritten.

**One still per shot.** A single pass over the film detects every cut, using FFmpeg's `scdet` filter. The detection threshold can be changed afterwards and the shots are re-cut instantly, without a second pass. Shots can be unchecked or merged with the next one. For each shot, keep the first, middle or last frame, or several frames spread across it.

**Other batch modes.** One frame every X seconds, or N frames spread evenly over the whole film. Batch exports show their progress and the time left, can be cancelled at any point, and can write a CSV list next to the images.

**Color.** A palette of 1 to 16 dominant colors per frame, computed with k-means in the CIELAB color space so the swatches match what the eye sees. Letterbox bars are left out. There is also a color barcode of the entire film, which can be exported as an image.

**Overlay.** Margins, background, palette band and as many lines of text as needed: title, timecode, frame and shot numbers, resolution, date. Each line has its own font, size, color, position and background box. Settings are saved as presets, and the preview is drawn by the same code as the export, so the file matches the screen.

## Requirements

- Windows 10 or 11, 64-bit.
- H.264 video. Photogramme is made for finished, delivered films, not camera rushes.
- An NVIDIA graphics card is optional, but it makes the analysis much faster.

### Graphics card

The analysis pass (cut detection, thumbnails, barcode) can be decoded by the video engine built into NVIDIA cards, called NVDEC, instead of the processor. On a feature-length film, that is the difference between a coffee break and no break at all.

Any GeForce from the GTX 10 series onward will do: GTX 16, RTX 20, 30, 40 and 50 series. Most older GTX 900 cards work too. Keep the driver up to date, as recent FFmpeg builds need a recent driver.

With an AMD or Intel card, or no dedicated card at all, everything still works and decoding simply runs on the processor. In Auto mode, Photogramme tries the GPU first and switches to the processor on its own when the card or the file doesn't allow it (some 10-bit or 4:2:2 H.264 files, for instance). It says so when that happens.

## Installation

Download the installer from the Releases page and run it. Since the installer is not code-signed, Windows SmartScreen may warn you about it: click *More info*, then *Run anyway*.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `Left` / `Right` | Previous / next frame |
| `Shift + Left` / `Shift + Right` | Back / forward one second |
| `Home` / `End` | First / last frame |
| `C` | Capture the current frame |
| `P` | Export preview on / off |
| `Ctrl + O` | Open a film |

## Building from source

You need the Microsoft C++ Build Tools, Rust (installed with rustup), Node.js 22 and WebView2, which ships with Windows 11.

```powershell
git clone {{REPO}}.git
cd {{REPODIR}}
npm install
powershell -ExecutionPolicy Bypass -File scripts\setup-ffmpeg.ps1
npm run tauri dev
```

`setup-ffmpeg.ps1` downloads the LGPL build of FFmpeg into `src-tauri/binaries`. These binaries are not stored in the repository. `npm run tauri build` produces the installer, and `scripts\run-tests.ps1` runs the tests against the real FFmpeg.

The interface is written in React and TypeScript, everything else in Rust, on top of Tauri 2. The video logic lives in its own crate, `src-tauri/core`, which does not depend on Tauri. Design choices and the reasons behind them are logged in `docs/DECISIONS.md`.

## Licenses

Photogramme ships FFmpeg (`ffmpeg.exe` and `ffprobe.exe`), which it runs as separate programs, under the LGPL v{{LGPL}}. The exact version, the build options and a link to the matching source code are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), which is also installed with the application. FFmpeg is a trademark of Fabrice Bellard.

The source code of Photogramme itself is copyright (c) 2026 Arnaud Guillard. No license has been chosen yet, so all rights are reserved for now.

## Author

Arnaud Guillard, director and cinematographer. [arnaudguillard.com](https://arnaudguillard.com)
'@

$shot = $null
foreach ($n in @('docs\screenshot.jpg', 'docs\screenshot.png')) { if (Test-Path (Join-Path $Root $n)) { $shot = $n.Replace('\', '/'); break } }
$shotLine = if ($shot) { "![Photogramme]($shot)" } else { '' }
$readme = $readme.Replace('{{SCREENSHOT}}', $shotLine).Replace('{{REPO}}', $repoUrl).Replace('{{REPODIR}}', $repoDir).Replace('{{LGPL}}', $lgpl)
$readme = [regex]::Replace($readme.Replace("`r`n", "`n"), "\n{3,}", "`n`n")
$readmePath = Join-Path $Root 'README.md'
if ((Test-Path $readmePath) -and ([IO.File]::ReadAllText($readmePath) -match 'GNU General Public License')) {
  Info 'README.md is now managed by publish-public.ps1: left unchanged.'
} else {
  Save $readmePath $readme
  if ($shot) { Info "Written, with $shot." } else { Info 'Written. No docs\screenshot.jpg yet: add one and run the script again to show it.' }
}

# ---------------------------------------------------------------------------
Step '6. FFmpeg source archive for future releases'
$gi = Join-Path $Root '.gitignore'
$giText = if (Test-Path $gi) { [IO.File]::ReadAllText($gi) } else { '' }
if ($giText -notmatch '(?m)^release-extras/') { [IO.File]::AppendAllText($gi, "`n# Files attached to GitHub releases, not versioned`nrelease-extras/`n", $utf8) }
$extras = Join-Path $Root 'release-extras'
New-Item -ItemType Directory -Force -Path $extras | Out-Null
$tag = $srcRef.Substring(0, [Math]::Min(12, $srcRef.Length))
$tar = Join-Path $extras "ffmpeg-source-$tag.tar.gz"
if (Test-Path $tar) { Info 'Already downloaded.' }
else {
  try { Invoke-WebRequest -Uri $srcUrl -OutFile $tar -UseBasicParsing -TimeoutSec 600; Info "Saved: release-extras\ffmpeg-source-$tag.tar.gz ($([math]::Round((Get-Item $tar).Length / 1MB)) MB)" }
  catch { Warn "Download failed ($($_.Exception.Message)). Not blocking: the link is in THIRD_PARTY_NOTICES.txt." }
}

# ---------------------------------------------------------------------------
Step '7. Type check, commit, push'
& npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Fail 'TypeScript reports an error (above). Nothing was committed: send it to Claude.' }
Info 'TypeScript OK.'

git add -A
$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) {
  Info 'Nothing new to commit.'
} else {
  git commit -q -m "Add FFmpeg license notice, in-app license line and README"
  if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' }
  Info "Committed $($staged.Count) file(s): $($staged -join ', ')"
  if ($NoPush) { Info 'Not pushed (-NoPush).' }
  else {
    git push -q
    if ($LASTEXITCODE -ne 0) { Fail 'git push failed.' }
    Info "Pushed: $repoUrl"
  }
}

if ($manual.Count) { Write-Host "`nDone, with manual steps left: $($manual -join '; ')" -ForegroundColor Yellow }
else { Write-Host "`nDone." -ForegroundColor Green }
