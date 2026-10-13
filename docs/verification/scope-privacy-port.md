# Scope privacy implementation port

- The public scope, hidden configuration, and GitHub repository method signatures are unchanged.
- The built-in policy digest version advances from `scope-policy/2` to `scope-policy/3` because protected-path classification is stricter. Engine state that stores a scope digest should treat this as a policy transition under its existing checkpoint rules.
- `compileScope`, `scopeForTree`, and `freezeTransactionScope` raise `ScopeError` for embedded NUL or any UTF-8 BOM after the initial character in root `.gitignore` text. The original root-ignore bytes and OID are retained for accepted policies.
- GitHub read and prepare reject case or Unicode aliases that touch included paths or their ancestors, including aliases to excluded paths. Excluded-only aliases remain readable and preservable.

## R2 delta for native and engine integration

- The policy digest advances again from `scope-policy/3` to `scope-policy/4`. The scope, hidden-port, and repository method signatures remain unchanged.
- Under `config/1`, canonical aliases of nested `.gitignore` are unsupported and raise `UnsupportedNestedGitignoreError` even in denied directories. Canonical aliases of the root `.gitignore` name raise `ScopeError`; only exact `.gitignore` is the root control file. The hidden port now lists vault root names before capture to catch a root alias that `exists(".gitignore")` could resolve on a case-insensitive adapter. Native inventory or root-ignore readers outside this port should apply the same canonical control-name rule before reading or uploading configuration bytes.
- Candidate-scope collisions, including paths newly unignored by a candidate `.gitignore`, are now checked before every POST. Removed parent directories no longer count as proposed paths; parent empty trees that remain are still checked.
