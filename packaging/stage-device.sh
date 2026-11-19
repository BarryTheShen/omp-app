#!/usr/bin/env bash
# Stages agent access's computer part (#20) for a package: the desktop app's .deb carries it idle, and the server
# package (packaging/build-device-deb.sh) is only it.
#
#   packaging/stage-device.sh <folder>
#
# <folder> gets the package tree (usr/...), and <folder>.depends the packages it needs, one per line:
#   usr/lib/omp-app-device/omp-app-device             the program (apps/device), run as root only by its service and
#                                                     by `setup`/`remove` through pkexec or sudo
#   usr/lib/omp-app-device/openssh/usr/sbin/sshd      OpenSSH's server and sftp-server, unpacked from this Ubuntu's
#   usr/lib/omp-app-device/openssh/usr/lib/openssh/   packages (never installed: the package would listen on port 22)
#   usr/bin/omp-app-device                            the person's command
#   usr/lib/systemd/system/, usr/lib/systemd/user/    the guard and the person's agent (enabled only by `setup`)
#   usr/share/polkit-1/actions/                       the password checks
#   usr/share/doc/omp-app-device/                     OpenSSH's copyright and version
set -euo pipefail
umask 022

stage=${1:?usage: packaging/stage-device.sh <folder>}
root=$(git rev-parse --show-toplevel)
device="$root/apps/device"
# The packages are built on Ubuntu 24.04 (the release image), so they run on 24.04 and newer: the bundled OpenSSH and
# the program's libraries come from it.
version_id=$(. /etc/os-release && echo "$VERSION_ID")
[[ $version_id == 24.04 ]] || {
  echo "agent access is staged on Ubuntu 24.04 (the release image), not $version_id" >&2
  exit 1
}
rm -rf "$stage"
mkdir -p "$stage"

(cd "$device" && bun run scripts/build.ts)
install -D -m 755 "$device/dist/omp-app-device" "$stage/usr/lib/omp-app-device/omp-app-device"
install -D -m 755 /dev/stdin "$stage/usr/bin/omp-app-device" <<'EOF'
#!/bin/sh
exec /usr/lib/omp-app-device/omp-app-device "$@"
EOF
install -D -m 644 "$device/system/omp-app-device-guard.service" "$stage/usr/lib/systemd/system/omp-app-device-guard.service"
install -D -m 644 "$device/system/omp-agent-access.slice" "$stage/usr/lib/systemd/system/omp-agent-access.slice"
install -D -m 644 "$device/system/omp-app-device.service" "$stage/usr/lib/systemd/user/omp-app-device.service"
install -D -m 644 "$device/system/dev.ompapp.device.policy" "$stage/usr/share/polkit-1/actions/dev.ompapp.device.policy"

# OpenSSH's server programs from this Ubuntu's archive, the newest update (security fixes), downloaded without root.
apt=$(mktemp -d)
trap 'rm -rf "$apt"' EXIT
mkdir -p "$apt/lists/partial" "$apt/cache/archives/partial"
options=(-o "Dir::State::Lists=$apt/lists" -o "Dir::Cache=$apt/cache" -o Debug::NoLocking=1 -o "APT::Sandbox::User=$(id -un)")
apt-get "${options[@]}" update -qq
# openssh-client only for OpenSSH's copyright (the server packages' docs link to it).
# Only from Ubuntu's own archive (noble-updates or noble-security), or one of Ubuntu's own mirrors of it
# (<country>.archive.ubuntu.com, azure.archive.ubuntu.com on GitHub's runners): never a package another source offers.
(cd "$apt" && apt-get "${options[@]}" download --print-uris openssh-server openssh-sftp-server openssh-client) |
  grep -o "'[^']*'" | tr -d "'" | while read -r uri; do
  [[ $uri =~ ^https?://([a-z0-9-]+\.)?(archive|security)\.ubuntu\.com/ubuntu/pool/main/o/openssh/ ]] || {
    echo "OpenSSH would come from $uri, not Ubuntu's archive" >&2
    exit 1
  }
done
(cd "$apt" && apt-get "${options[@]}" download openssh-server openssh-sftp-server openssh-client >/dev/null)
unpacked="$apt/unpacked"
for deb in "$apt"/openssh-server_*.deb "$apt"/openssh-sftp-server_*.deb "$apt"/openssh-client_*.deb; do
  dpkg-deb -x "$deb" "$unpacked"
done
openssh="$stage/usr/lib/omp-app-device/openssh"
install -D -m 755 "$unpacked/usr/sbin/sshd" "$openssh/usr/sbin/sshd"
install -D -m 755 "$unpacked/usr/lib/openssh/sftp-server" "$openssh/usr/lib/openssh/sftp-server"
# OpenSSH 9.8 and newer run each connection in programs of their own.
for part in sshd-session sshd-auth; do
  if [[ -f "$unpacked/usr/lib/openssh/$part" ]]; then
    install -D -m 755 "$unpacked/usr/lib/openssh/$part" "$openssh/usr/lib/openssh/$part"
  fi
done
version=$(dpkg-deb -f "$apt"/openssh-server_*.deb Version)
install -D -m 644 "$unpacked/usr/share/doc/openssh-client/copyright" "$stage/usr/share/doc/omp-app-device/openssh-copyright"
echo "OpenSSH server programs from Ubuntu's openssh-server $version" > "$stage/usr/share/doc/omp-app-device/openssh-version"

# What the programs need: the libraries the OpenSSH server package names (not libc6: the packages name their own),
# polkit (the password checks), gdbus (off on lock and sleep), ssh-keygen (the host key), and the accounts tools. The
# desktop app's package adds pkexec (its window's setup); a server uses sudo.
{
  dpkg-deb -f "$apt"/openssh-server_*.deb Depends | tr ',' '\n' | sed 's/^ *//' | grep -E '^(lib|zlib)' |
    grep -v -E '^(libpam-(modules|runtime)|libc6)( |$)'
  printf '%s\n' polkitd libglib2.0-bin openssh-client passwd systemd
} > "$stage.depends"
chmod -R go-w "$stage"
echo "staged agent access in $stage (OpenSSH $version)"
