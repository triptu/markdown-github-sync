/// An obsolete oversized hold and a valid replacement share one path. A
/// malformed neighboring issue is independently quarantined. Exact bytes are
/// abstract identities; durable saves and acknowledgment are distinct steps.
module scopeHandoff {
  const BUG: str
  type State = {
    oldHold: bool, replacement: bool, malformedNeighbor: bool,
    engineRecord: bool, superseded: bool, acknowledged: bool,
    origin: int, recovered: bool, clean: bool, crashed: bool,
    badAck: bool, badRetirement: bool, badOrigin: bool, quiet: bool
  }
  var s: State
  action init = s' = {
    oldHold: true, replacement: false, malformedNeighbor: false,
    engineRecord: false, superseded: false, acknowledged: false,
    origin: -1, recovered: false, clean: false, crashed: false,
    badAck: false, badRetirement: false, badOrigin: false, quiet: false
  }
  action mixedRecovery = all {
    not(s.recovered), not(s.crashed),
    s' = { ...s, replacement: true, malformedNeighbor: true,
      recovered: true }
  }
  /// Validation of one neighbor cannot erase the valid issue's authority.
  action isolateNeighbor = all {
    s.malformedNeighbor, s.replacement, not(s.crashed),
    s' = { ...s, malformedNeighbor: false, clean: true,
      replacement: if (BUG == "discard-replacement") false else s.replacement,
      badRetirement: BUG == "discard-replacement" }
  }
  action persistReplacement = all {
    s.replacement, not(s.engineRecord), not(s.crashed),
    s' = { ...s, engineRecord: true }
  }
  /// Durable supersession retains the original absent origin even when the
  /// replacement's current bytes differ from the obsolete oversized source.
  action retireOld = all {
    s.clean, s.engineRecord, s.oldHold, not(s.crashed),
    s' = { ...s, oldHold: false, superseded: true,
      origin: if (BUG == "drop-origin") 1 else s.origin,
      badOrigin: BUG == "drop-origin" }
  }
  action acknowledge = all {
    s.replacement, not(s.acknowledged), not(s.crashed),
    (s.engineRecord and s.superseded) or BUG == "early-ack",
    s' = { ...s, acknowledged: true, replacement: false,
      badAck: not(s.engineRecord and s.superseded) }
  }
  action crash = all {
    not(s.crashed), not(s.quiet), s' = { ...s, crashed: true }
  }
  action restart = all {
    s.crashed, s' = { ...s, crashed: false }
  }
  action quiesce = all {
    s.recovered, not(s.quiet), not(s.crashed),
    s' = { ...s, quiet: true }
  }
  action worker = any { isolateNeighbor, persistReplacement,
    retireOld, acknowledge, restart }
  action step = any { mixedRecovery, isolateNeighbor, persistReplacement,
    retireOld, acknowledge, crash, restart, quiesce, s' = s }
  val safe = not(s.badAck or s.badRetirement or s.badOrigin) and
    (not(s.acknowledged) or s.engineRecord and s.superseded) and
    (not(s.superseded) or s.origin == -1)
  temporal progress = worker.weakFair(s) implies
    always(s.quiet implies eventually(s.acknowledged))
}
