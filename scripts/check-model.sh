#!/usr/bin/env bash
# Run the TLA+ protocol model (formal/VaultSync.tla) through TLC with every
# configuration under formal/models/, verify each outcome against its expected
# verdict, and write evidence to formal/evidence/.
#
#   scripts/check-model.sh            # every model (positive, liveness, negative controls)
#   scripts/check-model.sh --quick    # skip the liveness models
#   scripts/check-model.sh --deep     # also run Core at the larger environment budget
#   scripts/check-model.sh --only Core --only Neg_NoApplyGuard
#
# Requirements: Java 11+ on PATH (tested with OpenJDK 17), curl, shasum.
# The official TLA+ tools jar is downloaded once into formal/.tools/ and pinned
# by URL and SHA-256.  Nothing here touches any vault.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORMAL="$ROOT/formal"
MODELS="$FORMAL/models"
EVIDENCE="${TLC_EVIDENCE_DIR:-$FORMAL/evidence}"
TOOLS_DIR="${TLA_TOOLS_DIR:-$FORMAL/.tools}"
JAR="$TOOLS_DIR/tla2tools.jar"
META="${TLC_METADIR:-$FORMAL/.tlc}"

# Pinned official release: tlaplus/tlaplus v1.7.4 (TLC "Version 2.19 of 08 August 2024").
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"

WORKERS="${TLC_WORKERS:-8}"
HEAP="${TLC_HEAP:-4g}"
QUICK=0
DEEP=0
ONLY=()

while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --deep) DEEP=1 ;;
    --only)
      [ $# -ge 2 ] || { echo "--only requires a model name" >&2; exit 2; }
      shift; ONLY+=("$1") ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------- toolchain
if ! command -v java >/dev/null 2>&1; then
  echo "java not found on PATH; install OpenJDK 11 or newer" >&2
  exit 1
fi
JAVA_MAJOR="$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | cut -d. -f1)"
if [ "${JAVA_MAJOR:-0}" -lt 11 ]; then
  echo "java 11 or newer required, found: $(java -version 2>&1 | head -1)" >&2
  exit 1
fi

verify_jar() {
  local actual
  actual="$(shasum -a 256 "$JAR" | awk '{print $1}')"
  [ "$actual" = "$TLA_SHA256" ]
}

if [ ! -f "$JAR" ] || ! verify_jar; then
  echo "fetching pinned TLA+ tools: $TLA_URL"
  mkdir -p "$TOOLS_DIR"
  tmp="$(mktemp "$TOOLS_DIR/tla2tools.XXXXXX")"
  curl -sSL --fail -o "$tmp" "$TLA_URL"
  mv "$tmp" "$JAR"
  if ! verify_jar; then
    echo "SHA-256 mismatch for downloaded tla2tools.jar; refusing to run" >&2
    echo "  expected $TLA_SHA256" >&2
    echo "  actual   $(shasum -a 256 "$JAR" | awk '{print $1}')" >&2
    rm -f "$JAR"
    exit 1
  fi
fi

mkdir -p "$EVIDENCE" "$META"

# ---------------------------------------------------------------- model list
# name | module | expected verdict
#   PASS                -> "Model checking completed. No error has been found."
#   FAIL:<Invariant>    -> "Error: Invariant <Invariant> is violated."
declare -a RUNS=()
add() { RUNS+=("$1|$2|$3"); }

add Core                          VaultSync      PASS
add Rewind                        VaultSync      PASS
add Probe_OptimisticCheckpoint_Loss VaultSync    PASS
if [ "$QUICK" -eq 0 ]; then
  add Liveness                    VaultSync      PASS
  add Independent                 MCIndependent  PASS
  add Neg_UnfairLiveness           VaultSync      FAIL:Temporal
fi
add Neg_NoApplyGuard              VaultSync      FAIL:CapturedEditsPreserved
add Neg_NoApplyJournal            VaultSync      FAIL:NoUnauthoredChange
add Neg_PartialCheckpoint         VaultSync      FAIL:BaseCoherent
add Neg_OptimisticCheckpoint      VaultSync      FAIL:CheckpointPublished
add Neg_ReplayOnUnknown           VaultSync      FAIL:NoReplay
add Neg_ForgetSiblings            VaultSync      FAIL:NoReplay
add Neg_StaleResolution           VaultSync      FAIL:NoBlindOverwrite
add Neg_SilentNewDraft            VaultSync      FAIL:NoBlindOverwrite
add Neg_DiscardOnUseGitHub        VaultSync      FAIL:CapturedEditsPreserved
add Neg_FastForwardRef            VaultSync      FAIL:NoResurrection
add Neg_RewindUnknown             VaultSync      FAIL:NoUncertainRetry
if [ "$DEEP" -eq 1 ]; then
  add Core_Deep                   VaultSync      PASS
fi

selected() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local n; for n in "${ONLY[@]}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}

# Validate selections before overwriting evidence; a typo must not report success.
for requested in "${ONLY[@]+"${ONLY[@]}"}"; do
  found=0
  for run in "${RUNS[@]}"; do
    [ "${run%%|*}" = "$requested" ] && found=1
  done
  [ "$found" -eq 1 ] || { echo "model not enabled: $requested (Core_Deep needs --deep)" >&2; exit 2; }
done

# ---------------------------------------------------------------- run
SUMMARY="$EVIDENCE/summary.md"
{
  echo "# TLC evidence summary"
  echo
  echo "Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ') by scripts/check-model.sh"
  echo "TLC: $(java -cp "$JAR" tlc2.TLC -h 2>&1 | grep -o 'Version [^ ]* of [^\n]*' | head -1)  (tla2tools.jar sha256 ${TLA_SHA256:0:12}...)"
  echo "Model SHA-256: $(shasum -a 256 "$FORMAL/VaultSync.tla" | awk '{print $1}')"
  echo "Runner SHA-256: $(shasum -a 256 "$0" | awk '{print $1}')"
  echo "Workers: $WORKERS; heap: $HEAP; TLC seed: 1; fingerprint polynomial: 0"
  echo "Selected runs only; other evidence files may be from earlier invocations."
  echo "Java: $(java -version 2>&1 | head -1)"
  echo "Host: $(uname -sm), $(sysctl -n hw.ncpu 2>/dev/null || nproc) cpus"
  echo
  echo "| model | expected | observed | verdict | states generated | distinct | depth | wall time |"
  echo "|---|---|---|---|---|---|---|---|"
} > "$SUMMARY"

overall=0
for run in "${RUNS[@]}"; do
  IFS='|' read -r name module expected <<<"$run"
  selected "$name" || continue
  cfg="$MODELS/$name.cfg"
  [ -f "$cfg" ] || { echo "missing config $cfg" >&2; exit 1; }
  log="$EVIDENCE/$name.tlc.txt"
  rm -f "$EVIDENCE/$name.trace.txt"
  shasum -a 256 "$cfg" > "$EVIDENCE/$name.config.sha256"
  echo "== $name  (expect $expected)"
  start=$(date +%s)
  set +e
  extra=()
  [[ "$name" = Core || "$name" = Rewind || "$name" = Independent ]] && extra=(-coverage 1)   # action coverage records which steps were exercised
  ( cd "$FORMAL" && java -XX:+UseParallelGC -Xmx"$HEAP" -cp "$JAR" tlc2.TLC \
      -seed 1 -fp 0 -workers "$WORKERS" -config "$cfg" -metadir "$META/$name" -cleanup ${extra[@]+"${extra[@]}"} \
      "$module.tla" ) > "$log" 2>&1
  rc=$?
  set -e
  if [[ "$name" = Core || "$name" = Rewind || "$name" = Independent ]]; then
    # one line per action: <Action>: <distinct successor states>:<transitions>
    { echo "# $name action coverage (TLC -coverage 1): action: distinct-states:transitions"
      { grep -E '^<[A-Za-z]+ line.*: [0-9]+:[0-9]+' "$log" || true; } | sed -E 's/ line [0-9]+, col [0-9]+ to line [0-9]+, col [0-9]+ of module VaultSync//' | sort -u
    } > "$EVIDENCE/$name.coverage.txt"
    # Retain the complete raw TLC output, including expression coverage.
  fi
  secs=$(( $(date +%s) - start ))

  observed="UNKNOWN(rc=$rc)"
  if grep -q "^Model checking completed. No error has been found." "$log"; then
    observed=PASS
  elif grep -q "^Error: Invariant .* is violated." "$log"; then
    observed="FAIL:$(grep -m1 '^Error: Invariant' "$log" | sed 's/^Error: Invariant \(.*\) is violated.*/\1/')"
  elif grep -q "^Error: Temporal properties were violated." "$log"; then
    observed="FAIL:Temporal"
  elif grep -q "^Error: Deadlock reached." "$log"; then
    observed="FAIL:Deadlock"
  fi
  # TLC's final line: "<n> states generated, <m> distinct states found, <k> states left on queue."
  final=$(grep -m1 -E '^[0-9]+ states generated, [0-9]+ distinct states found' "$log" || true)
  gen=$(awk '{print $1}' <<<"$final")
  dist=$(awk '{print $4}' <<<"$final")
  depth=$( { grep -m1 -oE 'search is [0-9]+' "$log" || true; } | awk '{print $3}')

  if [ "$observed" = "$expected" ] &&
     { { [ "$observed" = PASS ] && [ "$rc" -eq 0 ]; } ||
       { [ "$observed" = FAIL:Temporal ] && [ "$rc" -eq 13 ]; } ||
       { [[ "$observed" == FAIL:* && "$observed" != FAIL:Temporal ]] && [ "$rc" -eq 12 ]; }; }; then
    verdict=OK
  else
    verdict="MISMATCH(rc=$rc)"; overall=1
  fi
  printf '   %s  observed=%s  states=%s distinct=%s depth=%s  %ss\n' "$verdict" "$observed" "${gen:-?}" "${dist:-?}" "${depth:-?}" "$secs"
  echo "| $name | $expected | $observed | $verdict | ${gen:-?} | ${dist:-?} | ${depth:-?} | ${secs}s |" >> "$SUMMARY"

  # keep the counterexample trace readable alongside the raw log
  if [[ "$observed" == FAIL:* ]]; then
    # Preserve continuation lines; dropping them silently truncated maps/trees.
    awk '
      /^State [0-9]+:/ { active=1; keep=1; print; next }
      /^[0-9]+ states generated/ { exit }
      active && /^\/\\ / { keep=($0 ~ /^\/\\ (head|live|ckpt|draft|cflag|phase|plan|cands|cur|recovery|lastSaved|removed|lost|target|done) /) }
      active && keep { print }
    ' "$log" > "$EVIDENCE/$name.trace.txt"
  fi
done

echo
echo "summary: $SUMMARY"
if [ "$overall" -ne 0 ]; then
  echo "RESULT: at least one model did not produce its expected verdict" >&2
  exit 1
fi
echo "RESULT: every model produced its expected verdict"
