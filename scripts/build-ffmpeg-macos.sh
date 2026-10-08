#!/usr/bin/env bash
# Builds the FFmpeg bundled with Photogramme on macOS (Apple Silicon) and puts
# it where Tauri expects it:
#   src-tauri/binaries/ffmpeg-aarch64-apple-darwin (+ ffprobe)
#   src-tauri/binaries/THIRD_PARTY_NOTICES-macos.txt
#
# Usage, from the project root, on a Mac with the Xcode command line tools:
#   bash scripts/build-ffmpeg-macos.sh
#
# Why build instead of download (Windows uses BtbN's LGPL build):
# - nobody publishes a pinned, LGPL-only, Apple Silicon build we could mirror;
# - building from the exact commit pinned in scripts/ffmpeg.lock gives the Mac
#   the same FFmpeg version as Windows, and the release already ships that
#   exact source code (LGPL);
# - the configure line below IS the build recipe: anyone can rebuild it.
#
# LGPL only: no --enable-gpl, no --enable-nonfree, no libx264. No external
# library either: only macOS system frameworks and libraries (VideoToolbox,
# zlib, iconv...). pkg-config is disabled so that nothing installed by Homebrew
# can slip into the build; the script checks the result with otool.
#
# Takes 5 to 10 minutes the first time. The result is cached in
# ~/.cache/photogramme-ffmpeg/<commit>-<recipe hash>, so later runs are instant.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/scripts/ffmpeg.lock"
bin_dir="$root/src-tauri/binaries"
self="$root/scripts/build-ffmpeg-macos.sh"

[[ "$(uname -s)" == "Darwin" ]] || { echo "This script runs on macOS only." >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "Apple Silicon only for now (this Mac is $(uname -m))." >&2; exit 1; }
[[ -f "$lock" ]] || { echo "scripts/ffmpeg.lock is missing." >&2; exit 1; }

triple="aarch64-apple-darwin"
min_macos="12.0"

# Commit FFmpeg épinglé (même source que la version Windows).
commit="$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$lock" | head -n 1)"
[[ -n "$commit" ]] || { echo "No commit found in scripts/ffmpeg.lock." >&2; exit 1; }

# La recette (ce script) fait partie de la clé de cache : changer une option reconstruit.
recipe="$(shasum -a 256 "$self" | cut -c1-12)"
cache_root="${PHOTOGRAMME_FFMPEG_CACHE:-$HOME/.cache/photogramme-ffmpeg}"
build="$cache_root/$commit-$recipe"
out="$build/out"

if [[ -x "$out/ffmpeg" && -x "$out/ffprobe" ]]; then
  echo "Cached build: $out"
else
  echo "Building FFmpeg $commit (LGPL, $triple, macOS $min_macos+)..."
  rm -rf "$build"
  mkdir -p "$build/src" "$out"
  cd "$build/src"
  # Récupération par empreinte de commit : le contenu est vérifié par git.
  git init -q
  git fetch -q --depth 1 https://github.com/FFmpeg/FFmpeg.git "$commit"
  git checkout -q FETCH_HEAD
  [[ "$(git rev-parse HEAD)" == "$commit" ]] || { echo "Fetched the wrong commit." >&2; exit 1; }

  export MACOSX_DEPLOYMENT_TARGET="$min_macos"
  # Aucun pkg-config : seules les bibliothèques du système sont visibles.
  export PKG_CONFIG_PATH="" PKG_CONFIG_LIBDIR="/var/empty"

  ./configure \
    --prefix="$build/prefix" \
    --cc=clang \
    --arch=arm64 \
    --enable-version3 \
    --disable-gpl --disable-nonfree \
    --enable-static --disable-shared \
    --disable-debug --disable-doc --disable-ffplay \
    --disable-network \
    --disable-sdl2 --disable-libxcb --disable-xlib \
    --enable-videotoolbox \
    --extra-cflags="-mmacosx-version-min=$min_macos" \
    --extra-ldflags="-mmacosx-version-min=$min_macos" \
    --extra-version=photogramme-macos

  make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
  cp ffmpeg ffprobe "$out/"
  cp LICENSE.md "$out/FFMPEG-LICENSE.md"
fi

# Contrôles : uniquement des bibliothèques du système, VideoToolbox présent, pas de GPL.
for tool in ffmpeg ffprobe; do
  bad="$(otool -L "$out/$tool" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/Library/)' || true)"
  if [[ -n "$bad" ]]; then
    echo "$tool links to non-system libraries:" >&2
    echo "$bad" >&2
    exit 1
  fi
done
"$out/ffmpeg" -hide_banner -hwaccels | grep -q videotoolbox || { echo "VideoToolbox missing from the build." >&2; exit 1; }
config="$("$out/ffmpeg" -hide_banner -version | sed -n 's/^configuration: //p')"
if grep -q -E -- '--enable-(gpl|nonfree)' <<<"$config"; then
  echo "GPL or non-free option in the build: not distributable with Photogramme." >&2
  exit 1
fi
version="$("$out/ffmpeg" -hide_banner -version | sed -n 's/^ffmpeg version \([^ ]*\).*/\1/p')"

mkdir -p "$bin_dir"
for tool in ffmpeg ffprobe; do
  cp -f "$out/$tool" "$bin_dir/$tool-$triple"
  chmod +x "$bin_dir/$tool-$triple"
  echo "OK  $bin_dir/$tool-$triple"
done

# Notices pour le paquet Mac : en-tête propre à ce build, puis le texte de la
# LGPL repris de THIRD_PARTY_NOTICES.txt (version Windows).
notices="$root/THIRD_PARTY_NOTICES.txt"
start="$(grep -n 'FFmpeg license (GNU Lesser General Public License' "$notices" | head -n 1 | cut -d: -f1)"
[[ -n "$start" ]] || { echo "LGPL section not found in THIRD_PARTY_NOTICES.txt." >&2; exit 1; }
{
  cat <<EOF
Photogramme - third-party software (macOS)
==============================================================================

This software uses libraries from the FFmpeg project under the LGPLv3.

Photogramme ships two FFmpeg programs, ffmpeg and ffprobe, inside the
application bundle (Photogramme.app/Contents/MacOS). They run as separate
processes; Photogramme is not linked against FFmpeg. FFmpeg was not modified.

FFmpeg version    $version
Built by          Photogramme's own script, scripts/build-ffmpeg-macos.sh
                  https://github.com/ArnGui/photogramme
Source code       https://github.com/FFmpeg/FFmpeg/archive/$commit.tar.gz
                  (the exact FFmpeg source of the bundled programs)
FFmpeg project    https://ffmpeg.org

Build options (configure line):
$config

No external library is compiled into this build: only macOS system
frameworks and libraries (VideoToolbox, zlib, iconv...).

No GPL or non-free component of FFmpeg is used (no --enable-gpl, no
--enable-nonfree, no libx264). You may replace ffmpeg and ffprobe with your
own build.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

EOF
  tail -n +"$((start - 1))" "$notices"
} > "$bin_dir/THIRD_PARTY_NOTICES-macos.txt"
echo "OK  $bin_dir/THIRD_PARTY_NOTICES-macos.txt"

"$bin_dir/ffmpeg-$triple" -hide_banner -hwaccels
echo
echo "FFmpeg $version installed. 'videotoolbox' must appear in the list above."
