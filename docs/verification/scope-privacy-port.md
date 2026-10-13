# Scope privacy implementation port

- The public scope, hidden configuration, and GitHub repository method signatures are unchanged.
- The built-in policy digest version advances from `scope-policy/2` to `scope-policy/3` because protected-path classification is stricter. Engine state that stores a scope digest should treat this as a policy transition under its existing checkpoint rules.
- `compileScope`, `scopeForTree`, and `freezeTransactionScope` raise `ScopeError` for embedded NUL or any UTF-8 BOM after the initial character in root `.gitignore` text. The original root-ignore bytes and OID are retained for accepted policies.
- GitHub read and prepare reject case or Unicode aliases that touch included paths or their ancestors, including aliases to excluded paths. Excluded-only aliases remain readable and preservable.
