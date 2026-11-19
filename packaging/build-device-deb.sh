#!/usr/bin/env bash
# Builds agent access's package for computers without the desktop app (#20), servers: dist/device/
# omp-app-device_<version>_amd64.deb and SHA256SUMS. The desktop app's package carries the same files.
#
#   packaging/build-device-deb.sh <version>      for example 0.1.451
#
# Installed idle like the desktop app's copy: `sudo omp-app-device setup` makes it ready (apps/device/README.md),
# `sudo omp-app-device remove` or removing the package undoes it.
set -euo pipefail

version=${1:?usage: packaging/build-device-deb.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "version must look like 0.1.451, got: $version" >&2
  exit 1
}
root=$(git rev-parse --show-toplevel)
cd "$root"
package="omp-app-device_${version}_amd64.deb"
out="$root/dist/device"
tree="$root/dist/device-package"

bash packaging/stage-device.sh "$tree"
depends=$(paste -sd, "$tree.depends" | sed 's/,/, /g')
mkdir -p "$tree/DEBIAN"
cat >"$tree/DEBIAN/control" <<EOF
Package: omp-app-device
Version: $version
Architecture: amd64
Maintainer: Barry Shen <BarryTheShen@users.noreply.github.com>
Section: admin
Priority: optional
Depends: libc6 (>= 2.39), $depends
Conflicts: omp-app-desktop
Replaces: omp-app-desktop
Description: agent access for the omp app on this computer
 Lets the omp app's agents run commands on this computer over the app's own
 connection, only while a person turns it on with their password. Installed
 idle: sudo omp-app-device setup makes it ready.
EOF
install -m 755 apps/desktop/src-tauri/linux/postinst.sh "$tree/DEBIAN/postinst"
install -m 755 apps/desktop/src-tauri/linux/prerm.sh "$tree/DEBIAN/prerm"
install -m 755 apps/desktop/src-tauri/linux/postrm.sh "$tree/DEBIAN/postrm"
mkdir -p "$out"
dpkg-deb --root-owner-group --build "$tree" "$out/$package" >/dev/null
rm -rf "$tree" "$tree.depends"

# The package holds the computer part, sets nothing up, and removes it when it goes.
paths=$(dpkg-deb -c "$out/$package" | awk '{ print $NF }' | sed 's#^\./##')
for path in usr/bin/omp-app-device usr/lib/omp-app-device/omp-app-device \
  usr/lib/omp-app-device/openssh/usr/sbin/sshd usr/lib/omp-app-device/openssh/usr/lib/openssh/sftp-server \
  usr/lib/systemd/system/omp-app-device-guard.service usr/share/polkit-1/actions/dev.ompapp.device.policy; do
  grep -Fxq "$path" <<<"$paths" || {
    echo "the package has no $path" >&2
    exit 1
  }
done
! grep -Eq '^etc/' <<<"$paths" || {
  echo "the package writes to /etc: agent access must be installed idle" >&2
  exit 1
}
(cd "$out" && sha256sum "$package" >SHA256SUMS)
echo "built $out/$package ($(du -h "$out/$package" | cut -f1))"
