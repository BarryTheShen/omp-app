#!/usr/bin/env bash
# Builds the desktop app's package: dist/desktop/omp-app-desktop_<version>_amd64.deb and SHA256SUMS.
#
#   packaging/build-desktop-deb.sh <version>      for example 0.1.451
#
# The package holds the "omp app" window (/usr/bin/omp-app-desktop), the server that window starts
# (/usr/bin/omp-app-desktop-server: the omp-app command's server, compiled with Bun), the chat host that runs every
# chat and answers omp's own commands (omp's own command line, built from the pinned package:
# /usr/lib/omp-app-desktop/chat-host), the built web app (/usr/lib/omp-app-desktop/web) and an
# applications-menu entry. The server runs the omp it holds, so omp needs no separate install. The
# package shares no file with the omp-app command package (packaging/build-deb.sh), so both can be
# installed. The prerequisites are in apps/desktop/README.md.
# CARGO_TARGET_DIR, if set, must be an absolute path.
set -euo pipefail

version=${1:?usage: packaging/build-desktop-deb.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must look like 0.1.451, got: $version" >&2
  exit 1
}

root=$(git rev-parse --show-toplevel)
desktop="$root/apps/desktop"
crate="$desktop/src-tauri"
package="omp-app-desktop_${version}_amd64.deb"
out="$root/dist/desktop"
cd "$root"

# The web apps and the server come from this checkout. Tauri bundles them: the web app and the new UI as resources
# (resources/web, resources/ui), the server as the sidecar named by tauri.conf.json (binaries/...-<target triple>).
bun run build
triple=$(rustc -vV | sed -n 's/^host: //p')
rm -rf "$crate/resources" "$crate/binaries"
mkdir -p "$crate/resources" "$crate/binaries"
cp -r apps/web/dist "$crate/resources/web"
cp -r apps/ui/dist "$crate/resources/ui"
bun build --compile --minify --target=bun-linux-x64 \
  --define "OMP_APP_VERSION=\"$version\"" \
  packages/server/scripts/omp-app.ts --outfile "$crate/binaries/omp-app-desktop-server-$triple"

# The chat host every chat runs (packages/server/scripts/build-chat-host.ts) is a resource too (resources/chat-host),
# compiled by the Bun omp's release is built with: CHAT_HOST_BUN names it (desktop.yml and release.yml install it), else
# the `bun` on PATH. The script refuses any other Bun.
"${CHAT_HOST_BUN:-bun}" packages/server/scripts/build-chat-host.ts "$crate/resources/chat-host"

# Tauri builds the window and the .deb (the deb target only); the version comes from here.
(cd "$desktop" && bun run tauri build --bundles deb --config "{\"version\": \"$version\"}")

target=${CARGO_TARGET_DIR:-$crate/target}
built="$target/release/bundle/deb/$package"
[[ -f $built ]] || {
  echo "the package was not built: $built is missing" >&2
  exit 1
}
mkdir -p "$out"
cp "$built" "$out/$package"

# The package must have its own name and hold what the desktop app needs. dpkg-deb lists paths
# without a leading ./, and so does the tar stream of its control-less file system.
[[ $(dpkg-deb -f "$out/$package" Package) == omp-app-desktop ]] || {
  echo "the package is not named omp-app-desktop" >&2
  exit 1
}
[[ $(dpkg-deb -f "$out/$package" Version) == "$version" ]] || {
  echo "the package version is not $version" >&2
  exit 1
}
paths=$(dpkg-deb -c "$out/$package" | awk '{ print $NF }')
for path in usr/bin/omp-app-desktop usr/bin/omp-app-desktop-server \
  usr/lib/omp-app-desktop/web/index.html usr/lib/omp-app-desktop/chat-host \
  usr/share/applications/omp-app-desktop.desktop; do
  grep -Fxq "$path" <<<"$paths" || {
    echo "the package has no $path" >&2
    exit 1
  }
done
# The omp-app command package owns these paths; this package must not touch them. Each pattern
# ends where the file name ends, so omp-app-desktop is not mistaken for omp-app.
clash=$(grep -E '^usr/(bin/omp-app$|share/omp-app(/|$)|share/applications/omp-app\.desktop$|share/icons/hicolor/scalable/apps/omp-app\.svg$)' <<<"$paths" || true)
[[ -z $clash ]] || {
  echo "the package would overwrite files of the omp-app command package:" >&2
  echo "$clash" >&2
  exit 1
}
entry=$(dpkg-deb --fsys-tarfile "$out/$package" | tar -xOf - usr/share/applications/omp-app-desktop.desktop)
grep -Fxq 'Name=omp app' <<<"$entry" || {
  echo "the applications-menu entry is not named omp app" >&2
  exit 1
}
grep -Fxq 'Actions=new-window;' <<<"$entry" && grep -Eq '^Exec=.+ --new-window$' <<<"$entry" || {
  echo "the applications-menu entry has no New Window action" >&2
  exit 1
}

(cd "$out" && sha256sum "$package" >SHA256SUMS)
echo "built $out/$package ($(du -h "$out/$package" | cut -f1))"
