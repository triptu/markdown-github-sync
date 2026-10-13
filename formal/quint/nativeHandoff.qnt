/// One native issue and one independent authored path. Values stand for exact
/// bytes: 0 is the expected preimage, 1 the intended next value, and 2 the
/// recovered native bytes. -1 is an absent value, never a retained byte value.
module nativeHandoff {
  const BUG: str
  type Evidence = { present: bool, kind: str, id: int, expected: int, next: int, found: int, hold: bool }
  type State = {
    stage: str, attempted: bool, live: int,
    nativeIssue: bool, nativeEvidence: Evidence,
    fetched: bool, fetchedEvidence: Evidence,
    recorded: bool, engineIssue: bool, engineEvidence: Evidence,
    acknowledged: bool, ready: bool, loaded: bool,
    choice: bool, choiceExpected: int, choiceNext: int, reviewed: bool,
    published: int, otherPublished: bool, autoViolation: bool,
    edited: bool, quiet: bool, budget: int
  }
  var s: State
  def emptyEvidence: Evidence = { present: false, kind: "none", id: -1,
    expected: -1, next: -1, found: -1, hold: false }
  action init = s' = {
    stage: "prepared", attempted: false, live: 0,
    nativeIssue: false, nativeEvidence: emptyEvidence,
    fetched: false, fetchedEvidence: emptyEvidence,
    recorded: false, engineIssue: false, engineEvidence: emptyEvidence,
    acknowledged: false, ready: false, loaded: true,
    choice: false, choiceExpected: -1, choiceNext: -1, reviewed: false,
    published: 1, otherPublished: false, autoViolation: false,
    edited: false, quiet: false, budget: 2
  }
  action persistAttempt = all {
    s.loaded, s.stage == "prepared",
    s' = { ...s, stage: "attempting", attempted: BUG != "no-attempt-flag" }
  }
  /// Abstract outputs of nativeTxn.qnt. Native recovery owns these bytes;
  /// the engine cannot read them except by fetching an outstanding issue.
  action nativeEffect = all {
    s.loaded, s.stage == "attempting",
    nondet kind = Set("interrupted", "displaced", "orphan").oneOf()
    s' = { ...s, stage: "effect", live: if (kind == "interrupted") 2 else 1,
      nativeEvidence: { present: true, kind: kind, id: 7,
        expected: 0, next: 1, found: 2, hold: true } }
  }
  action recover = all {
    s.loaded, s.stage == "effect", s.nativeEvidence.present,
    s' = { ...s, stage: "issued", nativeIssue: true }
  }
  action fetch = all {
    s.loaded, s.nativeIssue, not(s.fetched),
    s' = { ...s, fetched: true, fetchedEvidence: s.nativeEvidence }
  }
  /// This is one atomic durable engine save. A fetched copy is volatile and
  /// cannot authorize acknowledgment until the complete engine record exists.
  action ingest = all {
    s.loaded, s.fetched, not(s.recorded), not(s.ready),
    s' = { ...s, ready: true, recorded: BUG != "collapse-changed",
      engineIssue: BUG != "collapse-changed",
      engineEvidence: if (BUG == "collapse-changed") emptyEvidence
        else if (BUG == "drop-found-bytes") { ...s.fetchedEvidence, found: -1 }
        else s.fetchedEvidence }
  }
  /// Acknowledgment disposes the native record. From here, only the engine's
  /// durable record can supply the issue bytes for a later review.
  action acknowledge = all {
    s.loaded, s.nativeIssue, s.recorded or BUG == "early-ack",
    s' = { ...s, nativeIssue: false, nativeEvidence: emptyEvidence,
      fetched: false, fetchedEvidence: emptyEvidence, acknowledged: true }
  }
  action publishIssuePath = all {
    s.loaded, s.ready, not(s.engineIssue), s.published != s.live,
    s' = { ...s, published: s.live,
      autoViolation: s.autoViolation or (s.stage == "issued" and not(s.reviewed)) }
  }
  action publishOtherPath = all {
    s.loaded, not(s.otherPublished), s' = { ...s, otherPublished: true }
  }
  action edit = all {
    not(s.quiet), not(s.edited), s.stage == "issued",
    s' = { ...s, live: 4, edited: true,
      engineIssue: if (BUG == "clear-on-edit") false else s.engineIssue }
  }
  /// Human choice is not assumed fair for automatic ingestion/other-path progress.
  action review = all {
    s.loaded, s.engineIssue, s.engineEvidence.present, not(s.choice),
    nondet selectedValue = Set(0, 1, s.engineEvidence.found, s.live).oneOf()
    s' = { ...s, choice: true, choiceExpected: s.live, choiceNext: selectedValue }
  }
  action applyChoice = all {
    s.loaded, s.choice, s.engineIssue,
    s' = if (s.live == s.choiceExpected)
      { ...s, live: s.choiceNext, engineIssue: false, reviewed: true }
      else { ...s, choice: false }
  }
  action crash = all {
    not(s.quiet), s.budget > 0, s.loaded,
    s' = { ...s, loaded: false, fetched: false, fetchedEvidence: emptyEvidence,
      ready: false, budget: s.budget - 1 }
  }
  action resume = all {
    not(s.loaded), s' = { ...s, loaded: true, ready: s.recorded }
  }
  action quiesce = all { not(s.quiet), s' = { ...s, quiet: true } }
  action worker = any { persistAttempt, nativeEffect, recover, fetch, ingest, acknowledge,
    publishIssuePath, publishOtherPath, applyChoice, resume }
  action step = any { worker, review, edit, crash, quiesce, s' = s }
  val noAutoUnknown = not(s.autoViolation)
  val ackBacked = not(s.acknowledged) or (s.recorded and s.engineEvidence.present
    and s.engineEvidence.hold and s.engineEvidence.id == 7
    and Set("interrupted", "displaced", "orphan").contains(s.engineEvidence.kind)
    and s.engineEvidence.expected == 0 and s.engineEvidence.next == 1
    and s.engineEvidence.found == 2 and not(s.nativeEvidence.present))
  val attemptBeforeEffect = not(Set("effect", "issued").contains(s.stage)) or s.attempted
  val evidenceRetained = s.stage != "issued" or s.nativeEvidence.present or s.engineEvidence.present
  val safe = noAutoUnknown and ackBacked and attemptBeforeEffect and evidenceRetained
  temporal progress = worker.weakFair(s) implies always(s.quiet implies eventually(s.recorded and s.otherPublished))
}
