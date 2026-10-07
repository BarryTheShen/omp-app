#!/usr/bin/env bash
# Builds the installable package: dist/release/omp-app_<version>_amd64.deb and SHA256SUMS.
#
#   packaging/build-deb.sh <version>      for example 0.1.451
#
# The package holds one self-contained command (/usr/bin/omp-app: Bun's runtime plus the server,
# compiled from packages/server/scripts/omp-app.ts), the built web app (/usr/share/omp-app/web),
# a desktop entry and an icon. omp itself is not part of it and must be installed separately.
set -euo pipefail

version=${1:?usage: packaging/build-deb.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must look like 0.1.451, got: $version" >&2
  exit 1
}

root=$(git rev-parse --show-toplevel)
out="$root/dist/release"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cd "$root"

bun run build

install -d "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/share/omp-app" \
  "$stage/usr/share/applications" "$stage/usr/share/icons/hicolor/scalable/apps"
bun build --compile --minify --target=bun-linux-x64 \
  --define "OMP_APP_VERSION=\"$version\"" \
  packages/server/scripts/omp-app.ts --outfile "$stage/usr/bin/omp-app"
cp -r apps/web/dist "$stage/usr/share/omp-app/web"
install -m 0644 packaging/omp-app.desktop "$stage/usr/share/applications/omp-app.desktop"
install -m 0644 packaging/omp-app.svg "$stage/usr/share/icons/hicolor/scalable/apps/omp-app.svg"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage/usr/share" -type f -exec chmod 0644 {} +

size=$(du -sk "$stage" | cut -f1)
cat >"$stage/DEBIAN/control" <<EOF
Package: omp-app
Version: $version
Section: devel
Priority: optional
Architecture: amd64
Installed-Size: $size
Maintainer: Barry Shen <BarryTheShen@users.noreply.github.com>
Recommends: xdg-utils
Homepage: https://github.com/BarryTheShen/omp-app
Description: Browser app for the omp coding agent
 Run omp-app: it starts a local server and opens the app in your browser.
 omp itself must be installed separately.
EOF

mkdir -p "$out"
package="omp-app_${version}_amd64.deb"
dpkg-deb --build --root-owner-group -Zxz "$stage" "$out/$package"
(cd "$out" && sha256sum "$package" >SHA256SUMS)
echo "built $out/$package ($(du -h "$out/$package" | cut -f1))"
