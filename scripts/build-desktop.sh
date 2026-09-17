#!/usr/bin/env bash
# Build the OpenAFW desktop bundles for the host platform.
#   macOS   → .app + .dmg      (target/release/bundle/{macos,dmg})
#   Windows → .msi + .exe      (target/release/bundle/{msi,nsis})
#   Linux   → .deb + .AppImage (target/release/bundle/{deb,appimage})
#
# Linux needs WebKitGTK and libappindicator; see the Tauri prerequisites.
# The bundles are ad-hoc signed only: distribution needs a real identity
# (macOS: APPLE_SIGNING_IDENTITY; Windows: a code-signing certificate).
set -euo pipefail
cd "$(dirname "$0")/../crates/openafw-desktop"
exec npx --yes @tauri-apps/cli@2 build "$@"
