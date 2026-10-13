Independent Quint scope review R2

Verdict: changes requested for the runner's interruption/evidence lifecycle.
Q2 is CLOSED. The post-review remote/checkpoint coverage gap is CLOSED within the finite domain. Q1 is PARTIALLY FIXED, with two reproducible P2 residual issues below. The formal model outcomes reproduce; neither residual issue invalidates the completed TLC graphs.

Reviewed snapshot: 780af54db4900389f3127cee74402d8cc713fe28. Read the previous R1 review and inspected the scope change itself, including 780af54. The shared root moved ahead during review, so all runs used an immutable git-archive snapshot of 780af54. Final audit found no changes to the 388 baselined scope/historical files. Review artifacts: /tmp/github-v2-quint-scope-review-r2/. No repository source or root output was written, no subagents were spawned, and no device, external service, or real vault was used. Compiler servers use loopback. Existing pinned node_modules and .tools were reused; no tool download.

FINDING Q1a — P2: real SIGTERM is swallowed while waiting for a subprocess

Location: formal/quint/check-scope.py:117-119, especially line 118; subprocess wait at line 77. The regression that misses this is formal/quint/test-check-scope.py:94-101, especially the mock at line 97. The unconditional interruption claim is docs/verification/quint.md:48.

The handler raises InterruptedError. During the normal subprocess.communicate(timeout=...) wait, Python's PollSelector.select catches InterruptedError and returns an empty event list; communicate then resumes waiting. The runner never reaches its exception cleanup, completes checking, and writes PASS. This is not a fabricated checker success: actual pinned TLC finished successfully after the requested cancellation was ignored.

Reproduced twice against real Quint/TLC with the runner restricted to the single positive ScopeState case. The first probe unexpectedly finished PASS. The repeat instrumented only subprocess launch and delivery of the existing SIGTERM handler, forwarding to that handler unchanged. Result:
  signalDelivered: true
  runningWhenSignaled: true
  secondsAfterSignal: 4.95
  exit: 0
  status: PASS
  summaryPass: true

The runtime is Python 3.14.4; subprocess._PopenSelector is selectors.PollSelector. Saved Python source shows the except InterruptedError clause at selectors.py's select implementation starting at line 385. The regression invokes os.kill inside a mocked checker.run, outside communicate/select, so its PASS does not establish the real interruption path.

Reproduce:
  python3 /tmp/github-v2-quint-scope-review-r2/probe-real-interrupt.py
Evidence:
  real-interrupt-initial.json
  real-interrupt-repeat.json
  real-interrupt-repeat/process.log
  real-interrupt-repeat/evidence/scope-tlc/results.json
  python-selector-evidence.txt

Suggested correction: use a dedicated cancellation exception that selector/EINTR handling will not swallow, and add a real subprocess regression that signals while communicate is waiting. A scratch-only control translating the handler exception to RuntimeError stopped in 0.02 seconds, exited 1, wrote FAIL, left no verify log, and terminated the verifier process group. Reproduce that control with probe-real-interrupt-sentinel.py; result in real-interrupt-sentinel.json. This control is not a source fix or a claim that all subprocess shutdown conditions are covered.

FINDING Q1b — P2: manifest invalidation and summary/log invalidation are not one publication

Location: formal/quint/check-scope.py:55-69, especially separate writes at lines 56 and 69, and initialization order at lines 126-129. Documentation claim: docs/verification/quint.md:48.

save_evidence atomically replaces each file individually. On startup it first publishes RUNNING to results.json, then replaces summary.md, then returns so old logs can be deleted. Kill the process after the first replacement and before the second: results.json says RUNNING while summary.md still says Status: PASS and the prior successful verify logs survive. The interrupted directory therefore still presents stale successful evidence through the summary linked from the documentation.

The deterministic probe starts from actual completed PASS artifacts, pauses immediately after the real atomic results.json replacement (no source edit), and sends actual SIGKILL. Observed exit -9, manifest RUNNING, summaryPass true, verifyExists true, verifyPass true. A separate injected OSError at summary writing produces exit 1 and manifest FAIL, but again leaves the old PASS summary and log. The latter is an injected write failure, not a real full-disk experiment.

The canonical JSON manifest fails closed in both cases. This is a stale secondary-artifact defect, not a false-success process exit or a stale PASS canonical manifest. The ordinary preflight and typecheck repros from R1 now pass; this residual specifically concerns interruption/write failure between publication boundaries.

Reproduce:
  python3 /tmp/github-v2-quint-scope-review-r2/probe-runner.py
Evidence: runner-probes.json fields manifest-summary-kill and summary-write-error; their directories and raw process logs under runner-probes/.

Suggested correction: make the current invocation's generation authoritative across the manifest, summary, and logs, for example with an atomic pointer to a generation containing an incomplete summary from the start, or remove the summary's independent current-PASS claim. Add a fault at the publication boundary. Simply swapping the order of two independent replacements moves the inconsistency window.

EXACT DISPOSITION OF R1 FINDINGS

Q1 ordinary missing-tool failure: CLOSED. A real subprocess with missing QUINT_BIN exits 1, replaces manifest and summary with failure, and removes old verify logs.
Q1 typecheck failure: CLOSED. An executable reporting the expected version but failing typecheck leaves FAIL and no old verification log.
Q1 concurrent invocation: CLOSED for a shared intact evidence-directory lock. With one real process holding the lock in a RUNNING invocation, a second exits 1 with 'Scope evidence directory is locked by another invocation'; all active evidence hashes are unchanged. SIGKILL releases the lock; the next invocation can acquire it.
Q1 interruption outside the subprocess wait: SIGTERM produces FAIL; SIGKILL after initial invalidation leaves RUNNING and no old logs. This does not close Q1a/Q1b above.
Q2 repository versus installation fence: CLOSED. scopeState.qnt:75-80 invalidates either field independently. NegScopeRepo and NegScopeInstallation each obtain the intended counterexample. Independent mutations directly deleting the respective guard, with BUG="none", also violate safe. They do not rely on the built-in mutation flag.
Remote/checkpoint observation gap: CLOSED. scopeState.qnt:84-90 permits separate advances after review; focused controls and independent direct guard deletions both obtain invariant violations. Both committed and independently rerun focused traces are receive -> review -> one changed dimension -> applyConfiguration.

INDEPENDENT RESULTS

Full scratch runner command:
  JAVA_HOME="$(/usr/libexec/java_home -v '21+')" python3 /tmp/github-v2-quint-scope-review-r2/snapshot/formal/quint/check-scope.py

Actual TLC outcomes:
  ScopeState: safety and temporal PASS; 327,197 generated, 66,384 distinct, depth 17.
  ScopeHandoff: safety and temporal PASS; 54 generated, 20 distinct, depth 7.
  Thirteen NegScope cases: expected q_inv invariant counterexamples, exit 1.
The two positive graph counts match the committed evidence exactly. Negative counts describe search prefixes, can vary with seeds/two workers, and are not complete graph sizes. No timeout, parse error, unrelated invariant, or temporal failure was credited as one of those 13 safety negatives.

All 21 committed scope input hashes match current reviewed files and the independent-run hashes. For all 15 cases, both committed and rerun raw logs match recorded exit, final state counts, seed, graph depth, and required success/counterexample markers. Java is OpenJDK 23.0.2. Both completed manifests say PASS.

Eight scope runner regressions and seven original runner regressions pass in scratch. The scope regressions print '5 states generated, 3 distinct states found' from a mocked PASS_LOG. Those numbers are fixtures, not TLC evidence. The original seven regressions target scripts/check-quint.py, not check-scope.py.

Twelve additional real TLC probes pass their expected outcome checks:
  Seven reachability counterexamples witness successful apply, unknown local bytes while deferred, CAS origin retention, quiet hidden publication pending, quiet deferred conflict offer pending, quiet handoff acknowledgment pending, and durable acknowledgment after ingestion/supersession.
  Four direct guard-deletion mutants (repository, installation, remote, checkpoint) each violate safe.
  Deleting the conflict-before-apply guard produces an actual temporal counterexample. It is recorded as TEMPORAL, not counted among the 13 safety negatives.
These establish reachable useful work and reachable pending temporal antecedents; the positive properties are not explained by globally frozen execution. Scripts and raw traces are probe-models.py, model-probes.json, and probes/.

Historical preservation: all 261 original evidence files retain their R1 before-review hashes. The historical TLC manifest still has 56 TLC results and 45 simulations; Apalache has two bounded results and two simulations. All 70 input hashes in each old manifest still match. These historical suites were audited but not rerun. The final evidence audit found zero changes across the 388 root files baselined for this review. Concurrent work changed root HEAD and runtime files; this review did not touch or validate those changes.

Audit/reproduction:
  python3 /tmp/github-v2-quint-scope-review-r2/audit-evidence.py
  python3 /tmp/github-v2-quint-scope-review-r2/probe-models.py
  python3 /tmp/github-v2-quint-scope-review-r2/snapshot/formal/quint/test-check-scope.py
  python3 /tmp/github-v2-quint-scope-review-r2/snapshot/scripts/test-check-quint.py
Detailed audit: evidence-audit.json. Full scope output: full-run.log and snapshot/formal/quint/evidence/scope-tlc/.

FINITE BOUNDS AND INTERPRETATION

The contracts remain readable, Quint-only, finite and factorized. Generated TLA is compiler output, not a second authored specification. No TypeScript refinement or composed runtime safety result follows.

scopeState has one remotely added configuration path, one newly local hidden path, initial absent origins, finite version integers, one native CAS race, and one-shot flags for local/unreadable/hidden/scope/freshness changes. There is a single fenceChanged budget: repository or installation may be invalidated independently, but not both sequentially in the same behavior. Both fences are Boolean validity abstractions, not two alternate valid repository identities, installation IDs, or ledger histories. All three scope components can be independently excluded through one shared scope-change budget. They do not model parsing, path aliases, inventory, capture classification, candidate trees, modes, or upload boundaries.

Post-review remote and checkpoint can each advance once and can both advance in a behavior. Some stale reviews can remain permanently stale; the progress property does not promise eventual configuration application or refreshed consent/review. Hidden consent is equality to the current finite version. Unknown and absent are distinct values, but the real scanner's determination that a file is missing is outside the model.

scopeHandoff has one obsolete hold, one valid replacement, one malformed neighbor, fixed issue identity, Boolean durable-record/supersession state, and an absent origin. Durable writes are atomic abstractions. Partial writes, exact serialized bytes, another replacement identity, retention cleanup, and real recovery parsing are excluded. Repeated crash/restart loops are possible before quiet; finite state space is not a finite bound on the number of crashes. After quiet, disturbance is disabled and weak fairness supplies conditional progress. It supplies no time bound or guarantee through perpetual interference.

The documentation appropriately states the no-refinement boundary and most finite assumptions. Its interrupted-run claim at quint.md:48 needs correction with the runner fixes above. Endpoint input hashing detects the tested persistent change; this review does not claim transactional source snapshots, detection of a transient edit subsequently restored, power-loss durability, or exhaustive coverage of arbitrary OS/filesystem faults.

Runtime boundary: the user reports 407 root runtime tests and separate active configuration-engine findings C0/C8/C4. This review did not rerun those runtime tests, review their pending fixes, or close C0/C8/C4. The formal scope pass cannot close implementation findings. No runtime approval is given.
