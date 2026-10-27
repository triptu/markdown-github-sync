#!/bin/bash
# Imports Phosphor icons (regular weight) as Android vector drawables.
# Usage: tools/import-phosphor-icons.sh caret-left microphone ...
# Writes app/src/main/res/drawable/ph_<name>.xml. Phosphor is MIT licensed (see licenses/).
set -euo pipefail
cd "$(dirname "$0")/.."
out=app/src/main/res/drawable
mkdir -p "$out"
for name in "$@"; do
  svg=$(curl -fsSL "https://unpkg.com/@phosphor-icons/core@2.1.1/assets/regular/$name.svg")
  paths=$(printf '%s' "$svg" | grep -oE ' d="[^"]+"' | sed -e 's/^ d="//' -e 's/"$//')
  file="$out/ph_${name//-/_}.xml"
  {
    echo '<?xml version="1.0" encoding="utf-8"?>'
    echo "<!-- Phosphor \"$name\", regular weight. -->"
    echo '<vector xmlns:android="http://schemas.android.com/apk/res/android"'
    echo '    android:width="24dp" android:height="24dp"'
    echo '    android:viewportWidth="256" android:viewportHeight="256">'
    while IFS= read -r d; do
      echo "    <path android:fillColor=\"#FF000000\" android:pathData=\"$d\" />"
    done <<< "$paths"
    echo '</vector>'
  } > "$file"
  echo "$file"
done
