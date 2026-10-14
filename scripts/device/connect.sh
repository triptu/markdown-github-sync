#!/bin/sh
# Prints the DevTools WebSocket URL of Obsidian running on the connected Android phone.
# Usage: node scripts/device/cdp.mjs "$(scripts/device/connect.sh)" ./scripts/device/ver.mjs
# Set ADB_SERIAL when more than one device is attached (`adb devices`).
set -e
adb_() { adb ${ADB_SERIAL:+-s "$ADB_SERIAL"} "$@"; }
pid=$(adb_ shell pidof md.obsidian | tr -d '\r')
[ -n "$pid" ] || { echo "Obsidian isn't running on the phone." >&2; exit 1; }
adb_ forward tcp:9333 "localabstract:webview_devtools_remote_$pid" >/dev/null
curl -s http://127.0.0.1:9333/json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(p=>p.type==="page")??JSON.parse(s)[0];console.log(t.webSocketDebuggerUrl)})'
