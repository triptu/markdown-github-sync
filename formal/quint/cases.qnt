/// Small adversarial schedules: all intermediate states are checked.
/// These are scenario languages, not unrestricted exploration of all events.
module cases {
  const BUG: str
  const CASE: str
  import vaultSync(BUG = BUG, INDEPENDENT = CASE == "independent") as p from "./vaultSync"
  var turn: int
  action init = all { p::init, turn' = 0 }

  /// Both clients prepare at the same old head. Either processing order is
  /// explored; the loser must reread and merge the other file before retrying.
  action independent = 
    if (turn == 0) p::save(0, 0)
    else if (turn == 1) p::save(1, 1)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::sync(1)
    else if (turn == 4) any { p::process(0), p::process(1) }
    else if (turn == 5) any { p::process(0), p::process(1) }
    else if (turn == 6) p::receive(0)
    else if (turn == 7) p::receive(1)
    else if (turn == 8) any { p::sync(0), p::sync(1) }
    else if (turn == 9) any { p::process(0), p::process(1) }
    else if (turn == 10) any { p::receive(0), p::receive(1) }
    else if (turn == 11) p::applyFile(0, 0)
    else if (turn == 12) p::applyFile(0, 1)
    else if (turn == 13) p::applyFile(1, 0)
    else if (turn == 14) p::applyFile(1, 1)
    else if (turn == 15) p::finish(0)
    else if (turn == 16) p::finish(1)
    else if (turn == 17) any { p::sync(0), p::sync(1) }
    else if (turn == 18) any { p::applyFile(0, 0), p::applyFile(1, 0) }
    else if (turn == 19) any { p::applyFile(0, 1), p::applyFile(1, 1) }
    else if (turn == 20) any { p::finish(0), p::finish(1) }
    else p::stutter

  /// Accepted + lost response + ordinary revert. The candidate is still in
  /// ancestry: apply it once, then follow the revert, never replay the draft.
  action responseLoss = 
    if (turn == 0) p::save(0, 0)
    else if (turn == 1) p::sync(0)
    else if (turn == 2) p::process(0)
    else if (turn == 3) p::loseResponse(0)
    else if (turn == 4) p::external(0, 0)
    else if (turn == 5) p::reconcileUnknown(0)
    else if (turn == 6) p::applyFile(0, 0)
    else if (turn == 7) p::applyFile(0, 1)
    else if (turn == 8) p::finish(0)
    else if (turn == 9) p::sync(0)
    else if (turn == 10) p::applyFile(0, 0)
    else if (turn == 11) p::applyFile(0, 1)
    else if (turn == 12) p::finish(0)
    else p::stutter

  /// The branch is back at the parent. That does NOT prove nonacceptance.
  action unknownRewind = 
    if (turn == 0) p::save(0, 0)
    else if (turn == 1) p::sync(0)
    else if (turn == 2) p::process(0)
    else if (turn == 3) p::loseResponse(0)
    else if (turn == 4) p::rewind(0)
    else if (turn == 5) p::reconcileUnknown(0)
    else p::stutter

  /// A delayed request's parent was removed. Generic fast-forward would
  /// resurrect it; the exact-parent comparator rejects it instead.
  action exactPublish = 
    if (turn == 0) p::external(1, 3)
    else if (turn == 1) p::save(0, 0)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::rewind(0)
    else if (turn == 4) p::process(0)
    else p::stutter

  /// Journal -> one replacement -> crash -> remaining path -> checkpoint.
  /// A save arriving after capture is both left live and captured durably.
  action application = 
    if (turn == 0) p::external(0, 3)
    else if (turn == 1) p::external(1, 3)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::applyFile(0, 1)
    else if (turn == 4) p::crash(0)
    else if (turn == 5) p::save(0, 0)
    else if (turn == 6) p::applyFile(0, 0)
    else if (turn == 7) p::finish(0)
    else p::stutter

  /// A remote edit (or local edit) after the decision invalidates the scope.
  action staleDecision = 
    if (turn == 0) p::save(0, 0)
    else if (turn == 1) p::external(0, 3)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::decide(0, 0, "mine")
    else if (turn == 4) any { p::external(0, 2), p::save(0, 0) }
    else if (turn == 5) p::publishDecision(0)
    else if (turn == 6) p::sync(0)
    else p::stutter

  action replayUnique =
    if (turn <= 4) responseLoss
    else if (turn == 5) p::reconcileUnknown(0)
    else if (turn == 6) p::process(0)
    else p::stutter

  action unauthored =
    if (turn == 0) p::external(0, 3)
    else if (turn == 1) p::external(1, 3)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::applyFile(0, 0)
    else if (turn == 4) p::crash(0)
    else if (turn == 5) p::external(0, 0)
    else if (turn == 6) p::sync(0)
    else p::stutter

  action useRemote =
    if (turn == 0) p::save(0, 0)
    else if (turn == 1) p::external(0, 3)
    else if (turn == 2) p::sync(0)
    else if (turn == 3) p::decide(0, 0, "remote")
    else if (turn == 4) p::publishDecision(0)
    else if (turn == 5) p::applyFile(0, 0)
    else if (turn == 6) p::applyFile(0, 1)
    else if (turn == 7) p::finish(0)
    else p::stutter

  action adoption =
    if (turn == 0) p::external(0, 3)
    else if (turn == 1) p::sync(0)
    else if (turn == 2) p::applyFile(0, 0)
    else if (turn == 3) p::applyFile(0, 1)
    else if (turn == 4) p::finish(0)
    else if (turn == 5) p::save(0, 0)
    else if (turn == 6) p::rewind(0)
    else if (turn == 7) p::sync(0)
    else if (turn == 8) p::adopt(0)
    else if (turn == 9) p::sync(0)
    else p::stutter

  action step = all {
    if (turn >= completionTurn) p::stutter
    else if (CASE == "adoption") adoption
    else if (CASE == "replay-unique") replayUnique
    else if (CASE == "unauthored") unauthored
    else if (CASE == "use-remote") useRemote
    else if (CASE == "silent-draft") { if (turn < 8) application else p::sync(0) }
    else if (CASE == "independent") independent
    else if (CASE == "response-loss") responseLoss
    else if (CASE == "unknown-rewind") unknownRewind
    else if (CASE == "exact-publish") exactPublish
    else if (CASE == "application") application
    else if (CASE == "stale-decision") staleDecision
    else p::step,
    turn' = if (turn < completionTurn) turn + 1 else turn
  }
  val exactHead = p::exactHead
  val unknownHeld = p::unknownHeld
  val journalFirst = p::journalFirst
  val newerPreserved = p::newerPreserved
  val wholeCheckpoint = p::wholeCheckpoint
  val scopedDecisions = p::scopedDecisions
  val carriedCaptured = p::carriedCaptured
  val noReplay = p::noReplay
  val noBlindOverwrite = p::noBlindOverwrite
  val noUnauthoredChange = p::noUnauthoredChange
  val checkpointPublished = p::checkpointPublished
  val latestSavePreserved = p::latestSavePreserved
  val safe = p::safe and (CASE != "independent" or p::independentNoConflict)
  val witness =
    if (CASE == "adoption") turn >= 10 and p::device(0).phase == "resolving" and p::device(0).recovery.contains(1)
    else if (CASE == "use-remote") turn >= 8 and p::device(0).checkpoint == p::s.head and p::device(0).recovery.contains(1)
    else if (CASE == "silent-draft") turn >= 9 and p::device(0).phase == "resolving"
    else if (CASE == "independent") turn >= 21 and p::converged
    else if (CASE == "response-loss") turn >= 13 and p::device(0).checkpoint == p::s.head
        and p::device(0).live == p::tree(p::s.head) and p::s.nextCommit == 3
    else if (CASE == "unknown-rewind") turn >= 6 and p::device(0).phase == "applying" and p::device(0).target == 1 and p::s.nextCommit == 2
    else if (CASE == "exact-publish") turn >= 5 and p::s.commits.get(2).status == "cancelled" and p::s.head == 0
    else if (CASE == "application") turn >= 8 and p::device(0).checkpoint == 2
        and p::device(0).live.get(0) == 1 and p::device(0).draft.get(0) == 1
        and p::device(0).recovery.contains(1) and p::device(0).carry.get(0) == 0
    else if (CASE == "stale-decision") turn >= 7 and p::device(0).phase == "resolving"
        and p::device(0).decisions.get(0) == "none"
    else true
  /// Bounded completion assertion, checked as safety only for fixed schedules.
  /// This is not temporal liveness or fairness verification.
  val completed = (turn < completionTurn) or witness
  pure val completionTurn = if (CASE == "adoption") 10
    else if (CASE == "use-remote") 8
    else if (CASE == "silent-draft") 9
    else if (CASE == "replay-unique" or CASE == "unauthored") 7
    else if (CASE == "independent") 21
    else if (CASE == "response-loss") 13 else if (CASE == "unknown-rewind") 6
    else if (CASE == "exact-publish") 5 else if (CASE == "application") 8
    else if (CASE == "stale-decision") 7 else 5
}

