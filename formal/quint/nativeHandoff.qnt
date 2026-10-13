/// Native review F1/F2 boundary: native evidence is not an ordinary draft.
/// Two paths: path 0 has an issue, path 1 is an independent authored change.
module nativeHandoff {
  const BUG: str
  type State = {
    stage: str, attempted: bool, live: int, found: int, kind: str,
    nativeIssue: bool, fetched: bool, recorded: bool, engineIssue: bool,
    acknowledged: bool, ready: bool, loaded: bool, recovery: Set[int],
    choice: bool, expected: int, next: int, reviewed: bool,
    published: int, otherPublished: bool, autoViolation: bool,
    edited: bool, quiet: bool, budget: int
  }
  var s: State
  action init = s' = {
    stage: "prepared", attempted: false, live: 0, found: -1, kind: "none",
    nativeIssue: false, fetched: false, recorded: false, engineIssue: false,
    acknowledged: false, ready: false, loaded: true, recovery: Set(0, 1),
    choice: false, expected: -1, next: -1, reviewed: false,
    published: 1, otherPublished: false, autoViolation: false,
    edited: false, quiet: false, budget: 2
  }
  action persistAttempt = all {
    s.loaded, s.stage == "prepared",
    s' = { ...s, stage: "attempting", attempted: BUG != "no-attempt-flag" }
  }
  /// Abstract outputs of nativeTxn.qnt. A displaced/orphan value may be hidden
  /// while the visible path already equals N; it must still reach review.
  action nativeEffect = all {
    s.loaded, s.stage == "attempting",
    nondet kind = Set("interrupted", "displaced", "orphan").oneOf()
    s' = { ...s, stage: "effect", kind: kind, found: 2,
      live: if (kind == "interrupted") 2 else 1, recovery: s.recovery.union(Set(2)) }
  }
  action recover = all {
    s.loaded, s.stage == "effect",
    s' = { ...s, stage: "issued", nativeIssue: true }
  }
  action fetch = all {
    s.loaded, s.nativeIssue, not(s.fetched),
    s' = { ...s, fetched: true }
  }
  action ingest = all {
    s.loaded, s.fetched, not(s.recorded), not(s.ready),
    s' = { ...s, ready: true, recorded: BUG != "collapse-changed", engineIssue: BUG != "collapse-changed" }
  }
  action acknowledge = all {
    s.loaded, s.nativeIssue, s.recorded or BUG == "early-ack",
    s' = { ...s, nativeIssue: false, acknowledged: true }
  }
  action publishIssuePath = all {
    s.loaded, s.ready, not(s.engineIssue), s.published != s.live,
    s' = { ...s, published: s.live,
      autoViolation: s.autoViolation or (s.stage == "issued" and not(s.reviewed)) }
  }
  action publishOtherPath = all {
    s.loaded, not(s.otherPublished), s' = { ...s, otherPublished: true }
  }
  /// New bytes do not silently clear an outstanding path issue.
  action edit = all {
    not(s.quiet), not(s.edited), s.stage == "issued",
    s' = { ...s, live: 4, edited: true,
      engineIssue: if (BUG == "clear-on-edit") false else s.engineIssue }
  }
  /// Human choice is not assumed fair for automatic ingestion/other-path progress.
  action review = all {
    s.loaded, s.engineIssue, not(s.choice),
    nondet selectedValue = Set(0, 1, s.found, s.live).oneOf()
    s' = { ...s, choice: true, expected: s.live, next: selectedValue,
      recovery: s.recovery.union(Set(s.live)) }
  }
  action applyChoice = all {
    s.loaded, s.choice, s.engineIssue,
    s' = if (s.live == s.expected) { ...s, live: s.next, engineIssue: false, reviewed: true }
      else { ...s, choice: false }
  }
  action crash = all {
    not(s.quiet), s.budget > 0, s.loaded,
    s' = { ...s, loaded: false, fetched: false, ready: false, budget: s.budget - 1 }
  }
  action resume = all {
    not(s.loaded), s' = { ...s, loaded: true, ready: s.recorded }
  }
  action quiesce = all { not(s.quiet), s' = { ...s, quiet: true } }
  action worker = any { persistAttempt, nativeEffect, recover, fetch, ingest, acknowledge,
    publishIssuePath, publishOtherPath, applyChoice, resume }
  action step = any { worker, review, edit, crash, quiesce, s' = s }
  val noAutoUnknown = not(s.autoViolation)
  val ackBacked = not(s.acknowledged) or s.recorded
  val attemptBeforeEffect = not(Set("effect", "issued").contains(s.stage)) or s.attempted
  val evidenceRetained = s.stage != "issued" or Set(0, 1, 2).subseteq(s.recovery)
  val safe = noAutoUnknown and ackBacked and attemptBeforeEffect and evidenceRetained
  temporal progress = worker.weakFair(s) implies always(s.quiet implies eventually(s.recorded and s.otherPublished))
}
