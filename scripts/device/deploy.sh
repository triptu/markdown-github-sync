#!/bin/sh
# Installs the built plugin straight onto the phone and restarts Obsidian (bypasses the updater).
# Usage: npm run package && scripts/device/deploy.sh   (ADB_SERIAL selects a device)
set -e
adb_() { adb ${ADB_SERIAL:+-s "$ADB_SERIAL"} "$@"; }
dir=/sdcard/Documents/vault/.obsidian/plugins/github-vault-sync
adb_ shell am force-stop md.obsidian
for f in main.js manifest.json styles.css; do adb_ push "dist/github-vault-sync/$f" "$dir/$f" >/dev/null; done
adb_ shell monkey -p md.obsidian -c android.intent.category.LAUNCHER 1 >/dev/null
echo "Deployed $(node -p 'require("./dist/github-vault-sync/manifest.json").version') to the phone."
