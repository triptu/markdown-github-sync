#!/usr/bin/env bash
# Compatibility entry point. Quint is the sole authored formal specification.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/scripts/check-quint.py" "$@"
