#!/usr/bin/env bash
set -euo pipefail
rg -n -B 5 -A 4 '#vault\.apply|#repository\.publish' plugin/src/git-sync/session.ts
rg -n -A 28 'interface StoredStep|type StoredStep|interface ApplyOperation|interface PublishOperation' plugin/src/git-sync/state.ts
