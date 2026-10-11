#!/usr/bin/env bash
# Writes a release's notes: how to install each of its two packages, then what changed since the last
# release (or what is in it, for the first release). The release workflow calls it.
#
#   packaging/release-notes.sh <version> <last release tag, or empty> <notes file>
set -euo pipefail

version=${1:?usage: packaging/release-notes.sh <version> <last tag, or empty> <notes file>}
last=${2-}
notes=${3:?usage: packaging/release-notes.sh <version> <last tag, or empty> <notes file>}

{
  echo "## Install"
  echo
  echo "Two packages of the same version. Take the one you want. Both need omp installed first."
  echo
  echo "**The window** (\"omp app\" in the applications menu): \`omp-app-desktop_${version}_amd64.deb\`"
  echo
  echo '```'
  echo "sudo apt install ./omp-app-desktop_${version}_amd64.deb"
  echo '```'
  echo
  echo 'Then open "omp app" from the applications menu. Remove it with `sudo apt remove omp-app-desktop`.'
  echo
  echo "**The terminal command** (\`omp-app\`, which opens the app in your browser): \`omp-app_${version}_amd64.deb\`"
  echo
  echo '```'
  echo "sudo apt install ./omp-app_${version}_amd64.deb"
  echo '```'
  echo
  echo 'Then run `omp-app`. Remove it with `sudo apt remove omp-app`.'
  echo
  echo 'SHA256SUMS lists the checksum of both packages.'
  echo
  if [[ -n $last ]]; then
    echo "## What changed since $last"
    echo
    git log --pretty='- %s' "$last^{commit}..HEAD" -- apps packages packaging | head -80
  else
    echo "## What is in it"
    echo
    git log --pretty='- %s' -40 -- apps packages packaging
  fi
} >"$notes"
