Independent Quint scope review R3

Verdict: Q1 is CLOSED at e4a4f8c. Both R2 residual findings (Q1a SIGTERM swallowed during subprocess wait; Q1b stale PASS summary/logs after interruption) are fixed and independently reproduced as fixed against real Quint/TLC processes with no runner instrumentation. Q2 remains CLOSED. The 15 formal scope outcomes reproduce. No new P1/P2 defects found. Two P3 observations below (no change required for acceptance).

Reviewed snapshot: e4a4f8cf2011fc45c5ba4cc0dcf938caf3d15490, taken as an immutable git-archive into /tmp/github-v2-quint-scope-review-r3/snapshot. Root HEAD advanced to 07d835d during review (three commits: 8658ac5, 8707321, 07d835d); `git diff e4a4f8c HEAD -- formal docs/verification/quint.md` is empty, so the reviewed files are identical at the new HEAD. The task named c01cc45 as the integrated commit: c01cc45 is the same change on branch implement/quint-scope-v2; `git diff c01cc45 e4a4f8c -- formal/quint/check-scope.py formal/quint/test-check-scope.py docs/verification/quint.md` is empty (0 lines), so this review covers both.

Constraints honored: root is read-only for this review. No source, device, remote, vault edits; no subagents. All runs used scratch copies under /tmp/github-v2-quint-scope-review-r3 with QUINT_BIN=root/formal/quint/node_modules/.bin/quint (0.33.0), QUINT_HOME=root/formal/quint/.tools (apalache.jar SHA-256 880c0b2b…4739d matches JAR_HASH), JAVA_HOME from `/usr/libexec/java_home -v 21+` = OpenJDK 23.0.2. Python 3.14.4. Compiler servers on loopback only; no tool download. `git status --short formal docs` is empty after review. Unrelated concurrent working-tree edits in plugin/ and scripts/ exist in root; they were not made by this review and were not reviewed.

FINDING Q1a (R2) — CLOSED: SIGTERM during real subprocess wait now cancels

Fix at formal/quint/check-scope.py:40-41 (`class Cancelled(BaseException)`), handler at :129-133, and group cleanup in `run()` at :88-101 (`except BaseException` → `os.killpg(SIGTERM)` → 5 s `communicate` → `SIGKILL` → re-raise). Because Cancelled is not InterruptedError, `selectors.PollSelector.select` no longer retries past it.

Independent reproduction (probes/probe-signal.py, mode `term`): fresh `git archive e4a4f8c formal/quint` copy, unmodified `check-scope.py` run as the full 15-case suite, SIGTERM sent to the runner from outside once a verifier JVM was observed in the child's own process group (session leader = node quint, JVM child in same pgid), 1.8 s into the run.
  runnerExit: 1
  secondsToExit: 0.124
  groupAfter: []            (node + java both gone)
  manifest.status: FAIL
  manifest.error: "Cancelled: interrupted by SIGTERM"
  artifactDir: absent; activeArtifactDir: runs/2e9b96bb…; results: []
  active run dir contains only ScopeState.typecheck.log (no verify log)
  top-level summary.md status-neutral; .runner.lock released
Mode `term-twice` (second SIGTERM 50 ms after the first, i.e. during the cleanup path) gave the same result: exit 1, 0.009 s, group empty, FAIL/Cancelled.
R2's own repro condition (signal delivered while `communicate()` is blocked in select on a live TLC) is exactly what these probes exercise; the R2 outcome (PASS after 4.95 s) no longer occurs.

FINDING Q1b (R2) — CLOSED: no secondary artifact can present a stale PASS

Fix: top-level `summary.md` is now a static status-neutral index (committed text verified: "results.json is the sole current verdict…"). Per-generation logs and the case-row summary live in `runs/<uuid>/` (check-scope.py:134-135, :64-70). The RUNNING manifest carries only `activeArtifactDir`; `artifactDir` is set only when status is PASS (:159-161). `results.json` is the single atomic publication (:48-61, fsync + os.replace).

Independent reproduction (mode `kill`): seeded a real single-case PASS (ScopeState, 66384 distinct states, exit 0, artifactDir runs/9a4231f5…), then started a second run and sent SIGKILL while its verifier JVM was live.
  runnerExit: -9
  manifest.status: RUNNING, artifactDir absent, activeArtifactDir runs/01721513…
  old run dir runs/9a4231f5… intact with its [ok] verify log, but unreferenced by the manifest
  top-level summary.md status-neutral
  orphan verifier group (node + java) survived the SIGKILL and exited on its own after 3.8 s; manifest still RUNNING afterwards (orphan output goes to a dead pipe and cannot write evidence)
Reading any PASS now requires `results.json.status == PASS` and following its `artifactDir`; an interrupted invocation leaves no path from the canonical manifest to old success logs. This matches docs/verification/quint.md:48 ("SIGKILL can leave RUNNING, which is incomplete").

Shipped regressions (run from the snapshot copy, scratch temp dirs only):
  python3 snapshot/formal/quint/test-check-scope.py -v                → 8 fixture tests OK, 3 real tests skipped (fixture-regressions.log)
  SCOPE_REAL_TOOL_TESTS=1 … test-check-scope.py RealRunnerInterruptionTests → 3/3 OK in 19.7 s (real-regressions.log)
The committed formal/quint/evidence/scope-tlc/runner-regressions.log records the same 11/11; the doc's "8 fixture regressions and 3 real-process checks" claim is accurate. Fixture PASS_LOG numbers ("5 states generated, 3 distinct") are fixtures, not TLC evidence, as before.

Formal outcomes — reproduced

Full real rerun of the snapshot's check-scope.py (full-run.log, 64.3 s wall): status PASS, inputsUnchanged true, errors [], 15/15 expected outcomes, Java 23.0.2, sources identical to the committed manifest. Audit of both the committed run dir (runs/c6a775bb…, committed-log-audit.log) and the rerun dir (rerun-audit.json): every case's manifest states/seed/depth/verifyExit match the raw final attempt in its verify log, every typecheck log is exactly `exit=0`, every PASS log has `[ok]` + "Model checking completed. No error has been found." + "Checking temporal properties", every VIOLATION log has "Error: Invariant q_inv is violated." + "found a counterexample", one attempt each, no bind retry.
  ScopeState    PASS  66384 distinct states, depth 17   (exact match committed)
  ScopeHandoff  PASS  20 distinct states, depth 7       (exact match committed)
  13 negatives  VIOLATION, depths match committed; prefix state counts differ (e.g. NegScopeVersion 215 → 217) because TLC stops at the first counterexample under 2 workers with fresh seeds. These are search prefixes, not graph sizes, as R1/R2 already stated.

Input and historical integrity

  21/21 scope manifest source hashes match both the root working tree and the e4a4f8c snapshot.
  261/261 historical evidence files (R1 baseline old-evidence-before.json) unchanged in both root and snapshot (historical-audit.json).
  Historical TLC manifest: PASS, 70/70 source hashes match, 56 tlc + 45 simulation; Apalache manifest: PASS, 70/70, 2 apalache + 2 simulation. Audited, not rerun.
  Of R2's 388-file root baseline, exactly 35 differ, all introduced by e4a4f8c itself: 32 under evidence/scope-tlc (relocated run logs, new manifest, regression log), check-scope.py, test-check-scope.py, quint.md. No other baselined file changed.

OPEN observations (P3, informational)

O1. SIGKILL orphan window. After SIGKILL the verifier process group keeps running (observed 3.8 s) with no owner; a new invocation can start immediately because flock is released on death. Evidence is unaffected (orphan cannot write results.json; a port clash would hit the existing bind-retry path). Not fixable from inside the runner; the doc already states SIGKILL leaves RUNNING. No change requested.

O2. `runs/<uuid>` accumulation. Every invocation inside the tracked tree creates a new runs/ directory and nothing prunes old ones, so stale historical dirs will appear as untracked files and could be committed by accident. They are harmless to the verdict (unreferenced by the manifest, and each generation summary states its rows alone do not claim a PASS). Hygiene only.

Evidence limits

  Cancellation was exercised with SIGTERM (single and double) and SIGKILL during the TLC verify phase only. SIGINT/KeyboardInterrupt, a signal during the `quint --version`/`java -version` preflight, and a signal arriving inside the final `save_evidence` (where the manifest could already read PASS while the process exits 1) were reasoned about from the code, not executed.
  The summary-write OSError path was verified only via the shipped injected-failure test, not a full-disk experiment.
  Timing claims (0.124 s, 3.8 s) are single observations on this host under light concurrent load.
  No TypeScript refinement, runtime test, device, vault, remote service, or composed-model claim is made or checked here; the R2 finite-bounds and interpretation section still applies unchanged.
  The three root commits after e4a4f8c (plugin/scripts work) were not reviewed.

Reproduce (all scratch; root untouched):
  python3 -I /tmp/github-v2-quint-scope-review-r3/probes/probe-signal.py term|term-twice|kill <workdir>
  SCOPE_REAL_TOOL_TESTS=1 QUINT_BIN=… QUINT_HOME=… JAVA_HOME=… python3 snapshot/formal/quint/test-check-scope.py -v
  QUINT_BIN=… QUINT_HOME=… JAVA_HOME=… python3 snapshot/formal/quint/check-scope.py
Artifacts: /tmp/github-v2-quint-scope-review-r3/{probes/*/report.json, probes/probe-signal.log, real-regressions.log, fixture-regressions.log, full-run.log, rerun-audit.json, committed-log-audit.log, historical-audit.json, committed-scope-tlc/, snapshot/}
