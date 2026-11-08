#!/usr/bin/env bash
# Builds the installable package: dist/release/omp-app_<version>_amd64.deb and SHA256SUMS.
#
#   packaging/build-deb.sh <version>      for example 0.1.451
#
# The package holds one self-contained command (/usr/bin/omp-app: Bun's runtime plus the server,
# compiled from packages/server/scripts/omp-app.ts), the chat host that runs every chat and answers omp's own commands
# (omp's own command line, built from the pinned package: /usr/lib/omp-app/chat-host), the built web app
# (/usr/share/omp-app/ui), a desktop entry, an icon, and a user service (/usr/lib/systemd/user/omp-app.service) that its
# postinst enables for every user, so the server starts at login. omp needs no separate install.
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

install -d "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/lib/omp-app" "$stage/usr/share/omp-app" \
  "$stage/usr/lib/systemd/user" "$stage/usr/share/applications" "$stage/usr/share/icons/hicolor/scalable/apps"
bun build --compile --minify --target=bun-linux-x64 \
  --define "OMP_APP_VERSION=\"$version\"" \
  packages/server/scripts/omp-app.ts --outfile "$stage/usr/bin/omp-app"
# The chat host every chat runs (packages/server/scripts/build-chat-host.ts), compiled by the Bun omp's release is built
# with: CHAT_HOST_BUN names it (release.yml installs it), else the `bun` on PATH. The script refuses any other Bun.
"${CHAT_HOST_BUN:-bun}" packages/server/scripts/build-chat-host.ts "$stage/usr/lib/omp-app/chat-host"
# The web app, served at the root (the command finds it beside itself).
cp -r apps/ui/dist "$stage/usr/share/omp-app/ui"
install -m 0644 packaging/omp-app.desktop "$stage/usr/share/applications/omp-app.desktop"
install -m 0644 packaging/omp-app.service "$stage/usr/lib/systemd/user/omp-app.service"
install -m 0644 apps/ui/public/favicon.svg "$stage/usr/share/icons/hicolor/scalable/apps/omp-app.svg"
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
Recommends: xdg-utils, tmux
Homepage: https://github.com/BarryTheShen/omp-app
Description: Browser app for the omp coding agent
 Run omp-app: it starts a local server and opens the app in your browser.
 It runs the omp release it is built for, which the package holds. omp-app tui
 opens omp's own terminal app on the same chats, in tmux.
 A user service (omp-app.service) starts the server at login, so chats keep running
 with no window or browser open.
EOF

# The user service starts at every user's next login; removing the package turns that off again. An upgrade keeps it.
cat >"$stage/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = configure ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --global enable omp-app.service >/dev/null 2>&1 || true
fi
EOF
cat >"$stage/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --global disable omp-app.service >/dev/null 2>&1 || true
fi
EOF
chmod 0755 "$stage/DEBIAN/postinst" "$stage/DEBIAN/prerm"

mkdir -p "$out"
package="omp-app_${version}_amd64.deb"
dpkg-deb --build --root-owner-group -Zxz "$stage" "$out/$package"
(cd "$out" && sha256sum "$package" >SHA256SUMS)
echo "built $out/$package ($(du -h "$out/$package" | cut -f1))"
