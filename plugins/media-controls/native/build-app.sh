#!/bin/sh
set -eu
cd "$(dirname "$0")"

cargo build --release --locked

# Now Playing needs an app bundle. An ad hoc signature is enough.
app=../dist/dyad-media-controls.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp Info.plist "$app/Contents/"
cp target/release/dyad-media-controls "$app/Contents/MacOS/"
codesign --force --sign - "$app"
