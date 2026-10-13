/// One configuration path plus one newly local hidden path. Values are exact
/// abstract versions: -2 unknown/unreadable, -1 proven absent, 0/1/2 bytes.
/// Scope booleans stand for validated eligibility, not Git pattern parsing.
module scopeState {
  const BUG: str
  type Review = { valid: bool, local: int, remote: int, checkpoint: int,
    repo: bool, installation: bool }
  type State = {
    local: int, remote: int, origin: int, checkpoint: int, deferred: bool,
    review: Review, repo: bool, installation: bool,
    parentScope: bool, headScope: bool, localScope: bool,
    hiddenLocal: int, hiddenConsent: int, hiddenPublished: bool,
    configPublished: bool, configApplied: bool, conflictOffered: bool,
    badUnknown: bool, badOrigin: bool, badReview: bool, badFence: bool,
    badScope: bool, badConsent: bool, badDeferred: bool,
    arrived: bool, changed: bool, unreadable: bool, raced: bool,
    scopeChanged: bool, fenceChanged: bool, consentChanged: bool,
    remoteChanged: bool, checkpointChanged: bool,
    crashed: bool, quiet: bool
  }
  var s: State
  def noReview: Review = { valid: false, local: -1, remote: -1,
    checkpoint: -1, repo: true, installation: true }
  action init = s' = {
    local: -1, remote: 1, origin: -1, checkpoint: 0, deferred: false,
    review: noReview, repo: true, installation: true,
    parentScope: true, headScope: true, localScope: true,
    hiddenLocal: 0, hiddenConsent: -1, hiddenPublished: false,
    configPublished: false, configApplied: false, conflictOffered: false,
    badUnknown: false, badOrigin: false, badReview: false, badFence: false,
    badScope: false, badConsent: false, badDeferred: false,
    arrived: false, changed: false, unreadable: false, raced: false,
    scopeChanged: false, fenceChanged: false, consentChanged: false,
    remoteChanged: false, checkpointChanged: false,
    crashed: false, quiet: false
  }
  /// A remote configuration addition advances the remote checkpoint while
  /// retaining the absent merge origin and deferring all local application.
  action receive = all {
    not(s.arrived), not(s.crashed),
    s' = { ...s, arrived: true, checkpoint: 1, deferred: true }
  }
  action becomeUnreadable = all {
    s.arrived, not(s.unreadable), not(s.configApplied), not(s.quiet),
    s' = { ...s, local: -2, unreadable: true }
  }
  action readableAgain = all {
    s.unreadable, not(s.changed), not(s.quiet),
    s' = { ...s, local: 2, changed: true }
  }
  action localEdit = all {
    s.arrived, not(s.changed), s.local != -2, not(s.quiet),
    s' = { ...s, local: 2, changed: true }
  }
  action review = all {
    s.deferred, s.local != -2, not(s.review.valid), not(s.crashed),
    s' = { ...s, review: { valid: true, local: s.local,
      remote: s.remote, checkpoint: s.checkpoint,
      repo: s.repo, installation: s.installation } }
  }
  /// A native CAS observes a newer local version after exact review. It may
  /// report changed, but cannot replace the saved absent merge origin.
  action nativeChanged = all {
    s.review.valid, not(s.raced), s.local == s.review.local,
    not(s.quiet), not(s.crashed),
    s' = { ...s, local: 2, raced: true, review: noReview,
      origin: if (BUG == "drop-origin") s.remote else s.origin,
      badOrigin: s.badOrigin or (BUG == "drop-origin") }
  }
  action offerConflict = all {
    s.deferred, s.local == 2, s.origin == -1,
    not(s.conflictOffered), not(s.crashed),
    s' = { ...s, conflictOffered: true }
  }
  action changeFence = all {
    s.arrived, not(s.fenceChanged), not(s.quiet),
    nondet which = Set(0, 1).oneOf()
    s' = { ...s, repo: if (which == 0) false else s.repo,
      installation: if (which == 1) false else s.installation,
      fenceChanged: true }
  }
  /// A changed remote version and a changed checkpoint are separate events.
  /// Either can stale an otherwise exact reviewed configuration operation.
  action advanceRemote = all {
    s.review.valid, not(s.remoteChanged), not(s.quiet), not(s.crashed),
    s' = { ...s, remote: 2, remoteChanged: true }
  }
  action advanceCheckpoint = all {
    s.review.valid, not(s.checkpointChanged), not(s.quiet), not(s.crashed),
    s' = { ...s, checkpoint: 2, checkpointChanged: true }
  }
  action changeScope = all {
    not(s.scopeChanged), not(s.quiet),
    nondet which = Set(0, 1, 2).oneOf()
    s' = { ...s,
      parentScope: if (which == 0) false else s.parentScope,
      headScope: if (which == 1) false else s.headScope,
      localScope: if (which == 2) false else s.localScope,
      scopeChanged: true }
  }
  action consent = all {
    s.hiddenConsent == -1, not(s.crashed),
    s' = { ...s, hiddenConsent: s.hiddenLocal }
  }
  action changeHidden = all {
    not(s.consentChanged), not(s.quiet),
    s' = { ...s, hiddenLocal: 2, consentChanged: true }
  }
  /// Direct configuration mutation uses a persisted exact review and both
  /// current fences. A stale preview is refused even after restart.
  action applyConfiguration = all {
    (s.review.valid or BUG == "missing-review"), not(s.configApplied),
    not(s.crashed),
    (s.local == s.review.local and s.local != -2 and
      (s.remote == s.review.remote or BUG == "skip-remote-version") and
      (s.checkpoint == s.review.checkpoint or BUG == "skip-checkpoint") and
      (s.local != 2 or s.conflictOffered) and
      (((s.repo == s.review.repo and s.repo) or BUG == "skip-repo-fence") and
        ((s.installation == s.review.installation and s.installation) or
          BUG == "skip-installation-fence") or BUG == "missing-fence-guard")) or
      BUG == "missing-version-guard" or BUG == "missing-review",
    s' = { ...s, configApplied: true, local: s.remote, deferred: false,
      badUnknown: s.badUnknown or s.local == -2,
      badReview: s.badReview or s.local != s.review.local or
        s.remote != s.review.remote or s.checkpoint != s.review.checkpoint,
      badFence: s.badFence or not(s.repo and s.installation) or
        s.repo != s.review.repo or s.installation != s.review.installation }
  }
  /// Automatic publication is for the separate newly local hidden path.
  /// Config remains deferred and is never silently included in this action.
  action publishHidden = all {
    not(s.hiddenPublished), not(s.crashed),
    ((s.parentScope and s.headScope and s.localScope) or BUG == "ignore-scope") and
      (s.hiddenConsent == s.hiddenLocal or BUG == "ignore-consent"),
    s' = { ...s, hiddenPublished: true,
      badScope: s.badScope or not(s.parentScope and s.headScope and s.localScope),
      badConsent: s.badConsent or s.hiddenConsent != s.hiddenLocal }
  }
  /// An old mine decision must not convert unknown bytes to absent or turn
  /// deferred configuration into a candidate publication.
  action publishDeferred = all {
    s.deferred, s.arrived, BUG == "unknown-as-absent", s.local == -2,
    not(s.crashed),
    s' = { ...s, configPublished: true, badUnknown: true, badDeferred: true }
  }
  action crash = all {
    not(s.crashed), not(s.quiet), s' = { ...s, crashed: true }
  }
  action restart = all {
    s.crashed, s' = { ...s, crashed: false }
  }
  action quiesce = all {
    not(s.quiet), s.hiddenConsent == s.hiddenLocal,
    s.parentScope and s.headScope and s.localScope,
    s.repo and s.installation, not(s.crashed),
    s' = { ...s, quiet: true }
  }
  action worker = any { publishHidden, offerConflict }
  action step = any { receive, becomeUnreadable, readableAgain, localEdit,
    review, nativeChanged, offerConflict, changeFence, advanceRemote,
    advanceCheckpoint, changeScope, consent, changeHidden,
    applyConfiguration, publishHidden, publishDeferred, crash, restart,
    quiesce, s' = s }
  val safe = not(s.badUnknown or s.badOrigin or s.badReview or s.badFence or
    s.badScope or s.badConsent or s.badDeferred) and
    (not(s.deferred) or not(s.configPublished)) and
    (not(s.arrived) or s.origin == -1)
  temporal progress = worker.weakFair(s) implies always(all {
    s.quiet implies eventually(s.hiddenPublished),
    (s.quiet and s.deferred and s.local == 2) implies eventually(s.conflictOffered)
  })
}
