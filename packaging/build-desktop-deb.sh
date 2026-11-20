#!/usr/bin/env bash
# Builds the desktop app's package: dist/desktop/omp-app-desktop_<version>_amd64.deb and SHA256SUMS.
#
#   packaging/build-desktop-deb.sh <version>      for example 0.1.451
#
# The package holds the "omp app" window (/usr/bin/omp-app-desktop) and, in /usr/lib/omp-app-desktop, the server that
# window starts (omp-app-desktop-server: the omp-app command's server, compiled with Bun), the chat host that runs every
# chat and answers omp's own commands (chat-host: omp's own command line, built from the pinned package), omp's native
# addon, one file per CPU variant, which both load from their own folder (packages/server/scripts/native-addon.ts), the
# built web app (ui), and an applications-menu entry. The server runs the omp it holds, so omp needs no separate install. The
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

# The web app, the server and the chat host come from this checkout, as Tauri resources (resources/, installed in
# /usr/lib/omp-app-desktop): each build script writes omp's native addon files next to the program it compiles.
bun run build
rm -rf "$crate/resources"
mkdir -p "$crate/resources"
cp -r apps/ui/dist "$crate/resources/ui"
bun packages/server/scripts/build-server.ts "$version" "$crate/resources/omp-app-desktop-server"

# The chat host every chat runs (packages/server/scripts/build-chat-host.ts) is a resource too (resources/chat-host),
# compiled by the Bun omp's release is built with: CHAT_HOST_BUN names it (desktop.yml and release.yml install it), else
# the `bun` on PATH. The script refuses any other Bun.
"${CHAT_HOST_BUN:-bun}" packages/server/scripts/build-chat-host.ts "$crate/resources/chat-host"

# Agent access (#20), installed idle: packaging/stage-device.sh stages the computer part in dist/device-stage, which
# tauri.conf.json's deb files carry, with the packages it needs added to the Depends.
bash packaging/stage-device.sh "$root/dist/device-stage"
depends=$(jq -R . "$root/dist/device-stage.depends" | jq -s -c '["libc6 (>= 2.39)", "pkexec"] + .')
config=$(jq -c -n --arg v "$version" --argjson d "$depends" '{version: $v, bundle: {linux: {deb: {depends: $d}}}}')

# Tauri builds the window and the .deb (the deb target only); the version comes from here.
(cd "$desktop" && bun run tauri build --bundles deb --config "$config")

target=${CARGO_TARGET_DIR:-$crate/target}
built="$target/release/bundle/deb/$package"
[[ -f $built ]] || {
  echo "the package was not built: $built is missing" >&2
  exit 1
}
mkdir -p "$out"
# Tauri compresses the package with gzip; xz makes the download smaller (2026-11-20). The contents, control files and
# scripts are kept as Tauri wrote them.
repack=$(mktemp -d)
dpkg-deb -R "$built" "$repack/root"
dpkg-deb --root-owner-group -Zxz -z6 -b "$repack/root" "$out/$package" >/dev/null
rm -rf "$repack"

# The package must have its own name and hold what the desktop app needs. The repacked package's file system lists
# its paths with a leading ./ (dpkg-deb -b), which the checks below take off.
[[ $(dpkg-deb -f "$out/$package" Package) == omp-app-desktop ]] || {
  echo "the package is not named omp-app-desktop" >&2
  exit 1
}
[[ $(dpkg-deb -f "$out/$package" Version) == "$version" ]] || {
  echo "the package version is not $version" >&2
  exit 1
}
paths=$(dpkg-deb -c "$out/$package" | awk '{ print $NF }' | sed 's#^\./##')
for path in usr/bin/omp-app-desktop usr/lib/omp-app-desktop/omp-app-desktop-server \
  usr/lib/omp-app-desktop/ui/index.html usr/lib/omp-app-desktop/chat-host \
  usr/lib/omp-app-desktop/pi_natives.linux-x64-modern.node usr/lib/omp-app-desktop/pi_natives.linux-x64-baseline.node \
  usr/share/applications/omp-app-desktop.desktop \
  usr/bin/omp-app-device usr/lib/omp-app-device/omp-app-device \
  usr/lib/omp-app-device/openssh/usr/sbin/sshd usr/lib/omp-app-device/openssh/usr/lib/openssh/sftp-server \
  usr/lib/systemd/system/omp-app-device-guard.service usr/lib/systemd/system/omp-agent-access.slice \
  usr/lib/systemd/user/omp-app-device.service usr/share/polkit-1/actions/dev.ompapp.device.policy; do
  grep -Fxq "$path" <<<"$paths" || {
    echo "the package has no $path" >&2
    exit 1
  }
done
# Agent access is installed idle (#20): nothing in /etc (no enabled unit, no account settings), the computer part's
# packages in the Depends, one copy of it per computer, and the install creating nothing.
! grep -Eq '^etc/' <<<"$paths" || {
  echo "the package writes to /etc: agent access must be installed idle" >&2
  exit 1
}
control=$(dpkg-deb -f "$out/$package" Depends Conflicts)
for need in pkexec polkitd libwrap0 'Conflicts: omp-app-device'; do
  grep -Fq "$need" <<<"$control" || {
    echo "the package's control lacks $need" >&2
    exit 1
  }
done
[[ $(grep -o 'libc6[^,]*' <<<"$control" | grep -c .) == 1 ]] || {
  echo "the package's Depends name libc6 more than once: only (>= 2.39) belongs there" >&2
  exit 1
}
scripts=$(mktemp -d)
dpkg-deb -e "$out/$package" "$scripts"
if grep -v '^#' "$scripts/postinst" 2>/dev/null | grep -Eq 'useradd|systemctl enable|omp-app-device setup'; then
  echo "the package's postinst sets up agent access: only the window's setup may" >&2
  exit 1
fi
grep -Fq 'omp-app-device remove' "$scripts/prerm" || {
  echo "the package's prerm does not remove agent access" >&2
  exit 1
}
rm -rf "$scripts"
# The omp-app command package owns these paths; this package must not touch them. Each pattern
# ends where the file name ends, so omp-app-desktop is not mistaken for omp-app.
clash=$(grep -E '^usr/(bin/omp-app$|share/omp-app(/|$)|share/applications/omp-app\.desktop$|share/icons/hicolor/scalable/apps/omp-app\.svg$)' <<<"$paths" || true)
[[ -z $clash ]] || {
  echo "the package would overwrite files of the omp-app command package:" >&2
  echo "$clash" >&2
  exit 1
}
entry=$(dpkg-deb --fsys-tarfile "$out/$package" | tar -xOf - ./usr/share/applications/omp-app-desktop.desktop)
grep -Fxq 'Name=omp app' <<<"$entry" || {
  echo "the applications-menu entry is not named omp app" >&2
  exit 1
}
grep -Fxq 'Actions=new-window;' <<<"$entry" && grep -Eq '^Exec=.+ --new-window$' <<<"$entry" || {
  echo "the applications-menu entry lacks its New Window action" >&2
  exit 1
}
# The server package's launcher is also named "omp app": without its window class, GNOME may give the desktop app's
# window to that one.
grep -Fxq 'StartupWMClass=omp-app-desktop' <<<"$entry" || {
  echo "the applications-menu entry does not name its window (StartupWMClass=omp-app-desktop)" >&2
  exit 1
}

(cd "$out" && sha256sum "$package" >SHA256SUMS)
echo "built $out/$package ($(du -h "$out/$package" | cut -f1))"
