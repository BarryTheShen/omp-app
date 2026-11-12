#!/usr/bin/env bash
# The Firefox and Zen extension's content, apart from its version: `zen-fingerprint.sh <folder>` prints one SHA-256 over
# every file of the extension built or unpacked in <folder>, its manifest without `version`, and nothing of Mozilla's
# signature (META-INF/). Two releases whose extensions print the same are the same extension: the release signs only
# a new one, since Mozilla signs a limited number of versions a day.
set -euo pipefail
folder=${1:?usage: zen-fingerprint.sh <folder>}
cd "$folder"
find . -type f ! -path './META-INF/*' | LC_ALL=C sort | while IFS= read -r file; do
  if [ "$file" = ./manifest.json ]; then
    printf '%s  %s\n' "$(jq -S -c 'del(.version)' manifest.json | sha256sum | cut -d' ' -f1)" "$file"
  else
    sha256sum "$file"
  fi
done | sha256sum | cut -d' ' -f1
