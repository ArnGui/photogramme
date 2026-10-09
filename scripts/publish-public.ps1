# Photogramme - public release (GPL-3.0)
#
#  1. Checks the tools and that prepare-release.ps1 has already been run.
#  2. LICENSE (GNU GPL v3), license field in package.json and Cargo.toml.
#  3. THIRD_PARTY_LICENSES.txt: licenses of every Rust crate (cargo-about) and
#     JavaScript package (license-checker) compiled into the app.
#  4. Ships LICENSE.txt and THIRD_PARTY_LICENSES.txt with the installer, updates
#     the license line in the app (copyright, no warranty, where the licenses are).
#  5. README.md (license section, link to the latest release, screenshot if present).
#  6. Type check, build of the installer, SHA-256.
#  7. Commit and push.
#  8. GitHub release with the installer and the FFmpeg source archive.
#  9. Repository description and topics, then PUBLIC after you type PUBLIC.
#
# Usage, from the project folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-public.ps1
#   ... -Version 0.3.0 -Notes "What changed, in English."   publish an update
#   ... -SkipRelease                                        README, licenses, commit and push only
#                                                           (e.g. after adding screenshots)
# The project folder is found on its own when the script sits in <project>\scripts.
# Re-running it is safe: every step checks what is already done.

param([string]$Root = 'D:\photogramme', [switch]$SkipRelease, [string]$Version, [string]$Notes)

if (-not $PSBoundParameters.ContainsKey('Root') -and $PSScriptRoot) {
  $cand = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $cand 'src-tauri\tauri.conf.json')) { $Root = $cand }
}

$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sep  = '=' * 78
$spdx = 'GPL-3.0-or-later'

function Fail([string]$m) { Write-Host $m -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Info([string]$m) { Write-Host "   $m" }
function Warn([string]$m) { Write-Host "   $m" -ForegroundColor Yellow }
function Save([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n"), $utf8) }
function Load([string]$path) { return [IO.File]::ReadAllText($path) }
function IsJson([string]$text) { try { $null = $text | ConvertFrom-Json; return $true } catch { return $false } }

if (-not (Test-Path $Root)) { Fail "Project folder not found: $Root" }
Set-Location $Root
$extras = Join-Path $Root 'release-extras'
New-Item -ItemType Directory -Force -Path $extras | Out-Null

# ---------------------------------------------------------------------------
Step '1. Checks'
foreach ($t in @('git', 'gh', 'cargo', 'npm', 'npx')) {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { Fail "$t not found in PATH." }
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Not logged in to GitHub: run   gh auth login' }
$noticesPath = Join-Path $Root 'THIRD_PARTY_NOTICES.txt'
if (-not (Test-Path $noticesPath)) { Fail 'THIRD_PARTY_NOTICES.txt is missing: run prepare-release.ps1 first.' }
$lgpl = '2.1'
if ((Load $noticesPath) -match 'under the LGPLv(3|2\.1)') { $lgpl = $Matches[1] }
$repoUrl = (gh repo view --json url --jq .url).Trim()
if (-not $repoUrl) { Fail 'No GitHub repository found for this folder: run publish-github.ps1 first.' }
$conf = Join-Path $Root 'src-tauri\tauri.conf.json'

# -Version: the same number in the four files that carry it.
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "The version must look like 0.3.0 (got '$Version')." }
  $targets = @(
    @{ Path = $conf;                                      Re = '("version"\s*:\s*")[^"]+(")';     Json = $true  },
    @{ Path = (Join-Path $Root 'package.json');           Re = '("version"\s*:\s*")[^"]+(")';     Json = $true  },
    @{ Path = (Join-Path $Root 'src-tauri\Cargo.toml');      Re = '(?m)^(version\s*=\s*")[^"]+(")'; Json = $false },
    @{ Path = (Join-Path $Root 'src-tauri\core\Cargo.toml'); Re = '(?m)^(version\s*=\s*")[^"]+(")'; Json = $false }
  )
  foreach ($f in $targets) {
    if (-not (Test-Path $f.Path)) { continue }
    $t = Load $f.Path
    $t2 = ([regex]$f.Re).Replace($t, ('${1}' + $Version + '${2}'), 1)
    if ($f.Json -and -not (IsJson $t2)) { Fail "$($f.Path): the version change would break the file, nothing written." }
    if ($t2 -ne $t) { Save $f.Path $t2; Info "$(Split-Path $f.Path -Leaf): version $Version" }
  }
}

$confObj = (Load $conf) | ConvertFrom-Json
$ver = $confObj.version
if (-not $ver -or "$ver" -like '*.json') { $ver = ((Load (Join-Path $Root 'package.json')) | ConvertFrom-Json).version }
if (-not $ver) { Fail 'No version found in tauri.conf.json or package.json.' }
$tag = "v$ver"
Info "Repository: $repoUrl"
Info "Version:    $ver (release $tag)"
Info "FFmpeg:     LGPL v$lgpl"

# Release notes and existing releases, checked now rather than after a 10-minute build.
$allTags = @(gh release list --limit 100 --json tagName --jq '.[].tagName' 2>$null | Where-Object { $_ })
$others = @($allTags | Where-Object { $_ -ne $tag })
$intro = $null
if ($Notes) { $intro = $Notes.Trim() }
elseif ($others.Count -eq 0) { $intro = 'First public release.' }
elseif (-not $SkipRelease) {
  Fail ('This is an update: say what changed, in English, with -Notes. Example:' + "`n" + '   ... -Version 0.3.0 -Notes "Faster shot detection. PNG export."')
}
if (-not $SkipRelease -and ($allTags -contains $tag)) {
  $ans = Read-Host "Release $tag already exists. Replace its files with this build? (y/N)"
  if ($ans -notmatch '^[yYoO]') { Fail 'Stopped. For an update, give a new number: -Version 0.3.0 (or 0.2.1 for a bug fix).' }
}

# ---------------------------------------------------------------------------
Step '2. GPL v3 license'
$licPath = Join-Path $Root 'LICENSE'
if ((Test-Path $licPath) -and ((Load $licPath) -match 'GNU GENERAL PUBLIC LICENSE')) { Info 'LICENSE already present.' }
else {
  $gpl = $null
  try { $gpl = (Invoke-WebRequest -Uri 'https://www.gnu.org/licenses/gpl-3.0.txt' -UseBasicParsing -TimeoutSec 60).Content }
  catch {
    $err = $_.Exception.Message
    $gpl = (gh api licenses/gpl-3.0 --jq .body) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $gpl.Length -lt 1000) { Fail "Could not get the GPL text (gnu.org: $err)." }
    Warn 'gnu.org unreachable: GPL text taken from GitHub instead.'
  }
  Save $licPath ($gpl.Trim() + "`n")
  Info 'LICENSE written (GNU GPL v3, from gnu.org).'
}

$pkg = Join-Path $Root 'package.json'
$p = Load $pkg
if ($p -notmatch '"license"\s*:') {
  $p2 = ([regex]'("name"\s*:\s*"[^"]*",)').Replace($p, ('$1' + "`n  " + '"license": "' + $spdx + '",'), 1)
  if ($p2 -ne $p -and (IsJson $p2)) { Save $pkg $p2; Info "package.json: license $spdx" } else { Warn 'package.json: license field not added (add it by hand).' }
}
foreach ($toml in @('src-tauri\Cargo.toml', 'src-tauri\core\Cargo.toml')) {
  $f = Join-Path $Root $toml
  if (-not (Test-Path $f)) { continue }
  $c = Load $f
  if ($c -match '(?m)^license\s*=') { continue }
  $c2 = ([regex]'(?m)^version\s*=.*$').Replace($c, ('$0' + "`n" + 'license = "' + $spdx + '"'), 1)
  if ($c2 -ne $c) { Save $f $c2; Info "${toml}: license $spdx" } else { Warn "${toml}: no plain version line, license field not added." }
}

# ---------------------------------------------------------------------------
Step '3. Licenses of the libraries compiled into the app'
cargo about --version *> $null
if ($LASTEXITCODE -ne 0) {
  Info 'Installing cargo-about (one time, a few minutes of compilation)...'
  # Recent cargo-about versions only install their command with the "cli" feature.
  cargo install --locked cargo-about --features cli
  cargo about --version *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'cargo-about is still not available after installation (messages above).' }
}

$aboutToml = Join-Path $Root 'about.toml'
if (-not (Test-Path $aboutToml)) {
  Save $aboutToml @"
# cargo-about configuration: licenses accepted for the crates compiled into Photogramme.
# All of them are compatible with the GPL v3. If cargo-about reports a crate whose
# license is not listed, check it is GPL-compatible before adding it here.
accepted = [
    "MIT",
    "IJG",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Zlib",
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "MPL-2.0",
    "CC0-1.0",
    "BSL-1.0",
    "0BSD",
    "CDLA-Permissive-2.0",
    "$spdx",
]
targets = ["x86_64-pc-windows-msvc"]
ignore-build-dependencies = true
ignore-dev-dependencies = true
"@
  Info 'about.toml written.'
}
# IJG (Independent JPEG Group, used by the jpeg-encoder crate): permissive and GPL-compatible,
# asks binary distributions to say the software is based in part on the IJG's work (done below).
$at = Load $aboutToml
if (-not $at.Contains('"IJG"')) {
  if ($at.Contains('"MIT",')) { Save $aboutToml ($at.Replace('"MIT",', '"MIT",' + "`n    " + '"IJG",')); Info 'about.toml: IJG license accepted.' }
  else { Fail 'about.toml: add "IJG" to the accepted list by hand, then run the script again.' }
}
$aboutHbs = Join-Path $Root 'about.hbs'
if (-not (Test-Path $aboutHbs)) {
  Save $aboutHbs @'
{{#each licenses}}
==============================================================================
{{name}} ({{id}})
Used by:
{{#each used_by}}
  {{crate.name}} {{crate.version}}
{{/each}}
------------------------------------------------------------------------------
{{{text}}}

{{/each}}
'@
  Info 'about.hbs written (plain text template).'
}

$rustOut = Join-Path $extras 'rust-licenses.txt'
if (Test-Path $rustOut) { Remove-Item $rustOut }
cargo about generate -c $aboutToml --manifest-path (Join-Path $Root 'src-tauri\Cargo.toml') $aboutHbs -o $rustOut
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $rustOut) -or (Get-Item $rustOut).Length -lt 1000) {
  Fail 'cargo-about failed (messages above). Nothing was committed: send the red lines to Claude.'
}
$rustText = (Load $rustOut).Trim()
$rustCount = ([regex]::Matches($rustText, '(?m)^  \S+ \d')).Count
Info "Rust: $rustCount crate entries."

$npmJson = Join-Path $extras 'npm-licenses.json'
if (Test-Path $npmJson) { Remove-Item $npmJson }
npx --yes license-checker-rseidelsohn --production --excludePrivatePackages --json --out $npmJson
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $npmJson)) { Fail 'license-checker failed (messages above). Nothing was committed.' }
$npm = Get-Content $npmJson -Raw -Encoding UTF8 | ConvertFrom-Json
$sb = New-Object System.Text.StringBuilder
$npmCount = 0
foreach ($prop in ($npm.PSObject.Properties | Sort-Object Name)) {
  if ($prop.Name -like 'photogramme@*') { continue }
  $e = $prop.Value
  $lic = (@($e.licenses) -join ' OR ')
  [void]$sb.AppendLine($sep)
  [void]$sb.AppendLine("$($prop.Name)  ($lic)")
  if ($e.repository) { [void]$sb.AppendLine($e.repository) }
  [void]$sb.AppendLine(('-' * 78))
  $lf = $e.licenseFile
  if ($lf -and (Test-Path -LiteralPath $lf) -and ((Split-Path $lf -Leaf) -match '^(licen[cs]e|copying|notice)')) {
    [void]$sb.AppendLine((Get-Content -LiteralPath $lf -Raw -Encoding UTF8).Trim())
  } else {
    $pkgName = $prop.Name.Substring(0, $prop.Name.LastIndexOf('@'))
    [void]$sb.AppendLine("No license file in the package. License: $lic. Package page: https://www.npmjs.com/package/$pkgName")
  }
  [void]$sb.AppendLine('')
  $npmCount++
}
Info "JavaScript: $npmCount packages."

Save (Join-Path $Root 'THIRD_PARTY_LICENSES.txt') @"
Photogramme - licenses of the libraries compiled into the application
$sep

Photogramme is built with the Rust crates and JavaScript packages listed
below. Their licenses require their notices to travel with the program, so
here they are. FFmpeg, which ships as separate programs, is covered in
THIRD_PARTY_NOTICES.txt.

This software is based in part on the work of the Independent JPEG Group
(through the jpeg-encoder crate, which writes the JPEG files).

The source code of every Rust crate is available at
https://crates.io/crates/<name>, and of every JavaScript package at
https://www.npmjs.com/package/<name>.

$sep
PART 1 - Rust crates (generated with cargo-about)
$sep

$rustText

$sep
PART 2 - JavaScript packages (generated with license-checker)
$sep

$($sb.ToString().Trim())
"@
Info 'THIRD_PARTY_LICENSES.txt written.'

# ---------------------------------------------------------------------------
Step '4. Installer resources and license line in the app'
$j = Load $conf
if ($j.Contains('"../THIRD_PARTY_LICENSES.txt"')) { Info 'Installer resources already complete.' }
else {
  $old = '"../THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt"'
  if (-not $j.Contains($old)) { Fail "tauri.conf.json: entry $old not found (prepare-release.ps1 step 3 was not applied)." }
  $j2 = $j.Replace($old, $old + ', "../THIRD_PARTY_LICENSES.txt": "THIRD_PARTY_LICENSES.txt", "../LICENSE": "LICENSE.txt"')
  if (-not (IsJson $j2)) { Fail 'tauri.conf.json would not be valid JSON: left unchanged.' }
  Save $conf $j2
  Info 'LICENSE.txt and THIRD_PARTY_LICENSES.txt added to the installer.'
}

# Since v0.7 the license line is in Preferences > About & licenses (src\PrefsDialog.tsx).
$app = Join-Path $Root 'src\PrefsDialog.tsx'
$a = Load $app
$legalText = "Photogramme, copyright (c) 2026 Arnaud Guillard. Free software under the GNU GPL v3, provided without any warranty. It uses libraries from the FFmpeg project under the LGPLv$lgpl, and the Barlow, Instrument Sans, Archivo, Space Mono and IBM Plex fonts under the SIL Open Font License 1.1. Full licenses: LICENSE.txt, THIRD_PARTY_NOTICES.txt and THIRD_PARTY_LICENSES.txt " + '{IS_MAC ? "inside the app (Photogramme.app/Contents/Resources)" : "in the installation folder"}.'
$re = [regex]'<p className="legal">[^<]*</p>'
if ($re.Matches($a).Count -ne 1) { Fail 'PrefsDialog.tsx: the license line (Preferences > About & licenses) was not found.' }
$a2 = $re.Replace($a, ('<p className="legal">' + $legalText + '</p>'), 1)
if ($a2 -ne $a) { Save $app $a2; Info 'License line updated.' } else { Info 'License line already up to date.' }

# ---------------------------------------------------------------------------
Step '5. README.md'
$readmePath = Join-Path $Root 'README.md'
$keepReadme = (Test-Path $readmePath) -and ((Load $readmePath) -match 'publish-public\.ps1 leaves it alone')
if ($keepReadme) { Info 'Hand-written README found: left as it is.' } else {
$repoDir = ($repoUrl -split '/')[-1]
$readme = @'
# Photogramme

Photogramme pulls stills out of finished films. Open an H.264 file and it finds the cuts, keeps one frame per shot (or as many as you want), and saves them as JPEG, with the dominant colors of each frame laid out underneath if you ask for them.

I built it for my own work as a documentary filmmaker: contact sheets for clients, stills for festivals and press kits, color references before a grade. It runs on Windows and puts an NVIDIA graphics card to work when there is one.

{{SCREENSHOT}}

**[Download the latest version]({{REPO}}/releases/latest)** for Windows 10 and 11.

## What it does

**Single frames.** Frame-accurate playback and stepping. Press `C` and the frame on screen is saved at full resolution. Existing files are never overwritten.

**One still per shot.** A single pass over the film detects every cut, using FFmpeg's `scdet` filter. The detection threshold can be changed afterwards and the shots are re-cut instantly, without a second pass. Shots can be unchecked or merged with the next one. For each shot, keep the first, middle or last frame, or several frames spread across it.

**Other batch modes.** One frame every X seconds, or N frames spread evenly over the whole film. Batch exports show their progress and the time left, can be cancelled at any point, and can write a CSV list next to the images.

**Color.** A palette of 1 to 16 dominant colors per frame, computed with k-means in the CIELAB color space so the swatches match what the eye sees. Letterbox bars are left out. There is also a color barcode of the entire film, which can be exported as an image.

**Overlay.** Margins, background, palette band and as many lines of text as needed: title, timecode, frame and shot numbers, resolution, date. Each line has its own font, size, color, position and background box. Settings are saved as presets, and the preview is drawn by the same code as the export, so the file matches the screen.

{{GALLERY}}

## Requirements

- Windows 10 or 11, 64-bit.
- H.264 video. Photogramme is made for finished, delivered films, not camera rushes.
- An NVIDIA graphics card is optional, but it makes the analysis much faster.

### Graphics card

The analysis pass (cut detection, thumbnails, barcode) can be decoded by the video engine built into NVIDIA cards, called NVDEC, instead of the processor. On a feature-length film, that is the difference between a coffee break and no break at all.

Any GeForce from the GTX 10 series onward will do: GTX 16, RTX 20, 30, 40 and 50 series. Most older GTX 900 cards work too. Keep the driver up to date, as recent FFmpeg builds need a recent driver.

With an AMD or Intel card, or no dedicated card at all, everything still works and decoding simply runs on the processor. In Auto mode, Photogramme tries the GPU first and switches to the processor on its own when the card or the file doesn't allow it (some 10-bit or 4:2:2 H.264 files, for instance). It says so when that happens.

## Installation

Download `Photogramme_..._x64-setup.exe` from the [latest release]({{REPO}}/releases/latest) and run it. Since the installer is not code-signed, Windows SmartScreen may warn you about it: click *More info*, then *Run anyway*. The release notes give the SHA-256 of the installer if you want to check the file first.

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

Bug reports and suggestions are welcome in the [issues]({{REPO}}/issues).

## License

Photogramme is free software, released under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE). Copyright (c) 2026 Arnaud Guillard.

It ships FFmpeg (`ffmpeg.exe` and `ffprobe.exe`), which it runs as separate programs, under the LGPL v{{LGPL}}. The exact version, the build options and a link to the matching source code are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). The licenses of the Rust and JavaScript libraries compiled into the app are collected in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt). All three files are also installed with the application. FFmpeg is a trademark of Fabrice Bellard. This software is based in part on the work of the Independent JPEG Group.

## Author

Arnaud Guillard, director and cinematographer. [arnaudguillard.com](https://arnaudguillard.com)
'@
$shot = $null
foreach ($n in @('docs\screenshot.jpg', 'docs\screenshot.png')) { if (Test-Path (Join-Path $Root $n)) { $shot = $n.Replace('\', '/'); break } }
$shotLine = if ($shot) { "![Photogramme]($shot)" } else { '' }

# Gallery: every image in docs\screenshots, sorted by file name. The name gives the caption:
# "02-overlay-preview.jpg" -> order 02, caption "Overlay preview".
$gallery = ''
$galDir = Join-Path $Root 'docs\screenshots'
if (Test-Path $galDir) {
  $imgs = @(Get-ChildItem -Path $galDir -File | Where-Object { $_.Extension -match '^\.(jpe?g|png|gif|webp)$' } | Sort-Object Name)
  if ($imgs.Count) {
    $parts = foreach ($i in $imgs) {
      $cap = ([IO.Path]::GetFileNameWithoutExtension($i.Name) -replace '^\d+[-_ ]*', '' -replace '[-_]+', ' ').Trim()
      if ($cap) { $cap = $cap.Substring(0, 1).ToUpper() + $cap.Substring(1) }
      $url = 'docs/screenshots/' + [Uri]::EscapeDataString($i.Name)
      if ($cap) { "![$cap]($url)`n*$cap*" } else { "![]($url)" }
    }
    $gallery = "## Screenshots`n`n" + ($parts -join "`n`n")
  }
}
$readme = $readme.Replace('{{SCREENSHOT}}', $shotLine).Replace('{{GALLERY}}', $gallery).Replace('{{REPO}}', $repoUrl).Replace('{{REPODIR}}', $repoDir).Replace('{{LGPL}}', $lgpl)
$readme = [regex]::Replace($readme.Replace("`r`n", "`n"), "\n{3,}", "`n`n")
Save (Join-Path $Root 'README.md') $readme
if ($shot) { Info "Written, with $shot." } else { Warn 'Written without a screenshot (no docs\screenshot.jpg).' }
if ($gallery) { Info "Gallery: $($imgs.Count) image(s) from docs\screenshots." }
}

# ---------------------------------------------------------------------------
Step '6. Type check and installer'
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { Fail 'TypeScript reports an error (above). Nothing was committed: send it to Claude.' }
Info 'TypeScript OK.'

$setup = $null
if (-not $SkipRelease) {
  Info 'Building the installer (several minutes)...'
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { Fail 'npm run tauri build failed (messages above). Nothing was committed.' }
  $nsis = Join-Path $Root 'src-tauri\target\release\bundle\nsis'
  $setup = Get-ChildItem -Path $nsis -Filter "*_${ver}_*setup.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) { Fail "No installer for version $ver found in $nsis." }
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup.FullName).Hash.ToLower()
  Info "Installer: $($setup.Name) ($([math]::Round($setup.Length / 1MB)) MB)"
  Info "SHA-256:   $sha"
}

# ---------------------------------------------------------------------------
Step '7. Commit and push'
git add -A
$staged = @(git diff --cached --name-only)
$big = @($staged | Where-Object { (Test-Path -LiteralPath $_) -and (Get-Item -LiteralPath $_ -Force).Length -gt 50MB })
if ($big.Count) { git reset -q; Fail "Files over 50 MB, nothing committed: $($big -join ', ')" }
if ($staged.Count) {
  git commit -q -m "License under GPL-3.0, third-party licenses, README for the public release"
  if ($LASTEXITCODE -ne 0) { Fail 'git commit failed.' }
  Info "Committed: $($staged -join ', ')"
} else { Info 'Nothing new to commit.' }
git push -q
if ($LASTEXITCODE -ne 0) { Fail 'git push failed.' }
Info 'Pushed.'

if ($SkipRelease) { Write-Host "`nDone (-SkipRelease: no build, no release, visibility unchanged)." -ForegroundColor Green; exit 0 }

# ---------------------------------------------------------------------------
Step "8. GitHub release $tag"
$assets = @($setup.FullName)
$tar = Get-ChildItem -Path $extras -Filter 'ffmpeg-source-*.tar.gz' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($tar) { $assets += $tar.FullName } else { Warn 'No FFmpeg source archive in release-extras (run prepare-release.ps1 again). The link in THIRD_PARTY_NOTICES.txt remains.' }

$notes = @'
{{INTRO}}

Photogramme pulls stills out of finished films: one frame per shot, at a fixed interval or spread over the film, with dominant-color palettes and a customizable overlay. The README has the details.

**Download** `{{SETUP}}` below. Windows 10 or 11, 64-bit.

The installer is not code-signed, so Windows SmartScreen will warn you the first time: click *More info*, then *Run anyway*. To check the file before running it, its SHA-256 is

`{{SHA}}`

and `Get-FileHash .\{{SETUP}}` in PowerShell should print the same value.

An NVIDIA card (GTX 10 series or newer) speeds up the analysis. Without one, everything runs on the processor.

The FFmpeg archive attached to this release is the exact source code of the `ffmpeg.exe` and `ffprobe.exe` bundled in the installer (LGPL).
'@
$notes = $notes.Replace('{{INTRO}}', $intro).Replace('{{SETUP}}', $setup.Name).Replace('{{SHA}}', $sha)
$notesFile = Join-Path $extras "release-notes-$tag.md"
Save $notesFile $notes

gh release view $tag *> $null
if ($LASTEXITCODE -eq 0) {
  gh release upload $tag @assets --clobber
  if ($LASTEXITCODE -ne 0) { Fail 'gh release upload failed.' }
  gh release edit $tag --notes-file $notesFile *> $null
  Info "Release $tag updated."
} else {
  gh release create $tag @assets --title "Photogramme $ver" --notes-file $notesFile
  if ($LASTEXITCODE -ne 0) { Fail 'gh release create failed.' }
  Info "Release $tag created."
}

# ---------------------------------------------------------------------------
Step '9. Repository page and visibility'
gh repo edit --description "Pull stills out of finished films: one frame per shot, dominant-color palettes, custom overlays. Windows, NVIDIA GPU accelerated." --homepage "https://arnaudguillard.com" --add-topic film --add-topic filmmaking --add-topic stills --add-topic ffmpeg --add-topic color-palette --add-topic tauri --add-topic windows *> $null
Info 'Description, website and topics set.'

$vis = (gh repo view --json visibility --jq .visibility).Trim()
if ($vis -eq 'PUBLIC') { Write-Host "`nDone. The repository is already public: $repoUrl" -ForegroundColor Green; exit 0 }

Write-Host "`nLast check before going public:" -ForegroundColor Cyan
Info "$(@(git ls-files).Count) files will become visible, along with the whole commit history."
$sus = @(git grep -nIiE '(api[_-]?key|secret|passw(or)?d|token)[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9_+/=-]{16,}' -- . ':!package-lock.json' 2>$null)
if ($sus.Count) { Warn 'Lines that look like secrets, check them first:'; $sus | Select-Object -First 15 | ForEach-Object { Warn "  $_" } }
else { Info 'No line looks like a password or API key.' }
if (-not $keepReadme -and -not $shot) { Warn 'The README has no screenshot yet (docs\screenshot.jpg). You can add one later with -SkipRelease.' }
Info "Release page: $repoUrl/releases/tag/$tag"
$answer = Read-Host "`nType PUBLIC to make the repository public (anything else keeps it private)"
if ($answer -cne 'PUBLIC') { Write-Host "`nKept private. Run the script again when ready: everything else is done." -ForegroundColor Yellow; exit 0 }

gh repo edit --visibility public --accept-visibility-change-consequences
if ($LASTEXITCODE -ne 0) { Fail 'Could not change the visibility.' }
Write-Host "`nDone. Photogramme is public: $repoUrl" -ForegroundColor Green
Write-Host "Link to share: $repoUrl/releases/latest" -ForegroundColor Green
