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
  echo "Two packages of the same version. Take the one you want. Each brings the omp release the app runs, so omp needs no separate install. If omp has no model set up yet, run \`omp-app tui\` and choose one with /model, or sign in with /login."
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
  echo 'SHA256SUMS lists the checksum of both packages. More in the [installation guide](https://github.com/BarryTheShen/omp-app/blob/main/docs/install.md).'
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
