# Runs every Photogramme test with the real FFmpeg of the project.
#
# Usage, from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\run-tests.ps1
#
# 1. Rust: business logic (core) + Tauri layer, with the FFmpeg 8.1 sidecar.
#    The GPU test runs a real NVDEC analysis when an NVIDIA card is present.
# 2. TypeScript: overlay layout, shot list, binary packets (Vitest).
# 3. TypeScript type check.
# This file is saved as UTF-8 with BOM so that Windows PowerShell 5.1 reads it correctly.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$bin = Join-Path $root "src-tauri\binaries"
$env:PHOTOGRAMME_FFMPEG  = Join-Path $bin "ffmpeg-x86_64-pc-windows-msvc.exe"
$env:PHOTOGRAMME_FFPROBE = Join-Path $bin "ffprobe-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path $env:PHOTOGRAMME_FFMPEG)) {
    throw "FFmpeg not found. Run scripts\setup-ffmpeg.ps1 first."
}

function Step($title, [scriptblock]$cmd) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
    & $cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $title" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Step "Rust tests (core + Tauri layer, real FFmpeg)" { cargo test --manifest-path src-tauri/Cargo.toml --workspace }
Step "TypeScript tests (Vitest)" { npm test }
Step "TypeScript type check" { npm run typecheck }

Write-Host ""
Write-Host "All tests passed." -ForegroundColor Green
