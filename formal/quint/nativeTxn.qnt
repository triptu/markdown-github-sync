/// Design §6: one path, same-volume atomic no-clobber renames, exact hashes.
/// Process death preserves completed syscalls; power loss and open-fd writes
/// after unlink are outside this model. E and N are pinned before the intent.
module nativeTxn {
  const BUG: str
  const KIND: str
  const INTERFERENCE: bool
  pure val E = if (KIND == "create") -1 else 0
  pure val N = if (KIND == "delete") -1 else 1
  type State = { path: int, hold: int, stage: int, intent: bool, verified: bool,
    status: str, recovery: Set[int], lastWriter: int, failures: Set[str], quiet: bool, budget: int }
  var s: State
  action init = s' = { path: E, hold: -1, stage: -1, intent: false, verified: false,
    status: "new", recovery: Set(E, N).exclude(Set(-1)), lastWriter: -1,
    failures: Set(), quiet: false, budget: 2 }
  action begin = all { s.status == "new", s' = { ...s, intent: true, status: "work" } }
  action stagePartial = all { s.intent, KIND != "text", N != -1, s.stage == -1,
    s' = { ...s, stage: 3 } }
  action stageComplete = all { s.intent, KIND != "text", s.stage == 3,
    s' = { ...s, stage: N } }
  action displace = all {
    s.intent, KIND != "text", E != -1, s.hold == -1, s.path != -1, s.path != N,
    s.stage == N or N == -1,
    s' = { ...s, path: -1, hold: s.path, verified: false }
  }
  action verifyHold = all { s.intent, KIND != "text", s.hold == E, E != -1, not(s.verified),
    s' = { ...s, verified: true } }
  action install = all {
    s.intent, KIND != "text", N != -1, s.stage == N,
    s.path == -1 or BUG == "clobber-recreation",
    (s.verified or E == -1),
    s' = { ...s, path: N, stage: -1,
      failures: if (s.path != -1) s.failures.union(Set("clobbered")) else s.failures }
  }
  action rollback = all {
    s.intent, KIND != "text", s.path == -1, s.hold != -1, s.hold != E,
    s' = { ...s, path: s.hold, hold: -1, intent: false, status: "changed",
      recovery: s.recovery.union(Set(s.hold)) }
  }
  action complete = all {
    s.intent, s.path == N,
    s' = { ...s, intent: false, hold: -1,
      status: if (s.hold == -1 or s.hold == E) "applied" else "changed",
      recovery: if (BUG == "skip-rehash") s.recovery else s.recovery.union(Set(s.hold)).exclude(Set(-1)) }
  }
  action conflict = all {
    s.intent, s.path != -1, s.path != E, s.path != N,
    s' = { ...s, intent: false, hold: -1, status: if (KIND == "text") "interrupted" else "changed",
      recovery: s.recovery.union(Set(s.path, s.hold)).exclude(Set(-1)) }
  }
  /// The actual process operation may terminate with partial bytes. Recovery
  /// treats every non-E/non-N value as interrupted, never a prefix heuristic.
  action textWrite = all {
    s.intent, KIND == "text", s.path == E,
    nondet bytes = Set(N, 3).oneOf()
    s' = { ...s, path: bytes }
  }
  action prefixGuess = all {
    BUG == "prefix-guess", s.intent, s.path == 4,
    s' = { ...s, path: N, failures: s.failures.union(Set("prefix-overwrite")) }
  }
  action writer = all {
    INTERFERENCE, not(s.quiet), s.budget > 0,
    nondet bytes = Set(2, 4).oneOf()
    s' = { ...s, path: bytes, lastWriter: bytes, budget: s.budget - 1 }
  }
  action heldWriter = all {
    INTERFERENCE, not(s.quiet), s.budget > 0, s.hold != -1,
    nondet bytes = Set(2, 4).oneOf()
    s' = { ...s, hold: bytes, lastWriter: bytes, budget: s.budget - 1 }
  }
  action crash = all { not(s.quiet), s.budget > 0,
    s' = { ...s, verified: false, budget: s.budget - 1 } }
  action quiesce = all { not(s.quiet), s' = { ...s, quiet: true } }
  action worker = any { begin, stagePartial, stageComplete, displace, verifyHold, install,
    rollback, complete, conflict, textWrite, prefixGuess }
  action step = any { worker, writer, heldWriter, crash, quiesce, s' = s }
  val writerPreserved = s.lastWriter == -1 or s.path == s.lastWriter or s.hold == s.lastWriter
    or s.recovery.contains(s.lastWriter)
  val pinned = Set(E, N).exclude(Set(-1)).subseteq(s.recovery)
  val exact = s.failures == Set()
  val safe = writerPreserved and pinned and exact
  temporal progress = worker.weakFair(s) implies always(s.quiet implies eventually(not(s.intent) and s.status != "new"))
}
