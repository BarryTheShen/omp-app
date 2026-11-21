#!/usr/bin/env bash
# Builds the desktop app for macOS (a .dmg) or Windows (an NSIS installer, …-setup.exe), on that system:
# dist/desktop/<bundle> and SHA256SUMS. NSIS, not an .msi: it installs for the person without administrator rights,
# and WiX 3, which Tauri's .msi needs, failed on GitHub's Windows Server 2025 runner (2026-11-21).
#
#   packaging/build-desktop-bundle.sh <version>      for example 0.3.1700
#
# The bundle holds the "omp app" window and, as its resources, what the Linux package installs in
# /usr/lib/omp-app-desktop (packaging/build-desktop-deb.sh): the server the window starts (omp-app-desktop-server), the
# chat host (chat-host), omp's native addon for this system (packages/server/scripts/native-addon.ts) and the built web
# app (ui). Agent access is Linux's alone (platforms PLAN, P4), so nothing of it is bundled here. The bundles are not
# signed yet (an Apple Developer ID and a Windows certificate are still to be decided): macOS opens it after right-click
# → Open, Windows after SmartScreen's "More info → Run anyway".
# CARGO_TARGET_DIR, if set, must be an absolute path.
set -euo pipefail

version=${1:?usage: packaging/build-desktop-bundle.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "the version must be three numbers, like 0.3.1700" >&2
  exit 2
}
case "$(uname -s)" in
Darwin) bundle=dmg built_name='*.dmg' exe= ;;
MINGW* | MSYS* | CYGWIN*) bundle=nsis built_name='*-setup.exe' exe=.exe ;;
*)
  echo "build the Linux package with packaging/build-desktop-deb.sh" >&2
  exit 2
  ;;
esac

root=$(git rev-parse --show-toplevel)
desktop="$root/apps/desktop"
crate="$desktop/src-tauri"
out="$root/dist/desktop"
cd "$root"

# The web app, the server and the chat host, as Tauri resources; each build script writes omp's native addon files for
# this system next to the program it compiles.
bun run build
rm -rf "$crate/resources"
mkdir -p "$crate/resources"
cp -r apps/ui/dist "$crate/resources/ui"
bun packages/server/scripts/build-server.ts "$version" "$crate/resources/omp-app-desktop-server"
"${CHAT_HOST_BUN:-bun}" packages/server/scripts/build-chat-host.ts "$crate/resources/chat-host"
for program in omp-app-desktop-server chat-host; do
  [[ -f "$crate/resources/$program$exe" ]] || {
    echo "the build wrote no $program$exe" >&2
    exit 1
  }
done

# The bundle's resources are the files built here: tauri.conf.json names Linux's (no .exe, Linux's native addon), which
# the merge below takes out (null) before it names these.
resources=$(
  cd "$crate/resources"
  {
    jq -n '{"resources/chat-host": null, "resources/omp-app-desktop-server": null,
      "resources/pi_natives.linux-x64-modern.node": null, "resources/pi_natives.linux-x64-baseline.node": null}'
    for name in *; do
      jq -n --arg name "$name" '{("resources/" + $name): $name}'
    done
  } | jq -s -c 'add'
)
config=$(jq -c -n --arg v "$version" --argjson r "$resources" '{version: $v, bundle: {resources: $r}}')
(cd "$desktop" && bun run tauri build --bundles "$bundle" --config "$config")

target=${CARGO_TARGET_DIR:-$crate/target}
built=$(find "$target/release/bundle/$bundle" -maxdepth 1 -type f -name "$built_name" | head -1)
[[ -n $built ]] || {
  echo "Tauri wrote no $built_name in $target/release/bundle/$bundle" >&2
  exit 1
}
mkdir -p "$out"
cp "$built" "$out/"
name=$(basename "$built")
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$name" || shasum -a 256 "$name"; } >SHA256SUMS)
echo "built $out/$name ($(du -h "$out/$name" | cut -f1))"
