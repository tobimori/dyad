#!/bin/sh
# Usage: build.sh [target]. Without a target it builds for this computer.
set -eu
cd "$(dirname "$0")"
target=${1:-}
platform=${target:-$(uname -s)}

case "$platform" in
  *-windows-msvc) cargo xwin build --release --locked --target "$target" ;;
  *) cargo build --release --locked ${target:+--target "$target"} ;;
esac
out=target/${target:+$target/}release
mkdir -p ../dist

case "$platform" in
  *darwin* | Darwin)
    # Now Playing needs an app bundle. An ad hoc signature is enough.
    app=../dist/dyad-media-controls.app
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS"
    cp Info.plist "$app/Contents/"
    cp "$out/dyad-media-controls" "$app/Contents/MacOS/"
    codesign --force --sign - "$app"
    ;;
  *windows* | MINGW* | MSYS*) cp "$out/dyad-media-controls.exe" ../dist/ ;;
  *) cp "$out/dyad-media-controls" ../dist/ ;;
esac
