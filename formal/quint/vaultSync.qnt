/// GitHub is authoritative. File values are abstract immutable bytes.
/// See docs/verification/quint.md for bounds, code mapping, and omissions.
module vaultSync {
  const BUG: str
  const INDEPENDENT: bool

  pure val devices = Set(0, 1)
  pure val files = Set(0, 1)
  pure val commitIds = 0.to(5)
  pure val emptyTree = files.mapBy(_ => 0)
  pure val noDraft = files.mapBy(_ => -1)
  pure val noDecision = files.mapBy(_ => "none")

  type Tree = int -> int
  type Commit = { parent: int, tree: Tree, history: Set[int], status: str, author: int }
  type Device = {
    live: Tree, checkpoint: int, draft: Tree, carry: Tree, phase: str,
    candidate: int, target: int, expected: Tree, accounted: Set[int], journal: bool,
    reviewLocal: Tree, reviewRemote: Tree, reviewHead: int, reviewBase: int, own: Set[int], seen: Set[(int, int)], decisions: int -> str, recovery: Set[int]
  }
  type State = {
    head: int, commits: int -> Commit, nextCommit: int, nextValue: int,
    dev: int -> Device, lastSaved: (int, int) -> int,
    everPublished: Set[(int, int)], removed: Set[int], failures: Set[str], event: str
  }
  var s: State

  pure val initialDevice: Device = {
    live: emptyTree, checkpoint: 0, draft: noDraft, carry: noDraft, phase: "idle",
    candidate: 0, target: 0, expected: emptyTree, accounted: Set(), journal: false,
    reviewLocal: emptyTree, reviewRemote: emptyTree, reviewHead: 0, reviewBase: 0, own: Set(), seen: Set((0, 0), (1, 0)), decisions: noDecision, recovery: Set()
  }
  pure val initialState: State = {
    head: 0,
    commits: commitIds.mapBy(c => {
      parent: 0, tree: emptyTree, history: Set(0), status: if (c == 0) "accepted" else "unused", author: -1
    }),
    nextCommit: 1, nextValue: 1, dev: devices.mapBy(_ => initialDevice),
    lastSaved: tuples(devices, files).mapBy(_ => -1),
    everPublished: Set((0, 0), (1, 0)), removed: Set(), failures: Set(), event: "initial"
  }
  action init = s' = initialState

  def tree(c: int): Tree = s.commits.get(c).tree
  def history(c: int): Set[int] = s.commits.get(c).history
  def device(d: int): Device = s.dev.get(d)
  def effectiveBase(d: int): Tree = files.mapBy(f =>
    if (device(d).carry.get(f) >= 0) device(d).carry.get(f)
    else tree(device(d).checkpoint).get(f))
  def drafts(d: int): Tree = files.mapBy(f =>
    if (device(d).live.get(f) != effectiveBase(d).get(f)) device(d).live.get(f) else -1)
  def conflicts(d: int, remote: Tree): Set[int] = files.filter(f =>
    drafts(d).get(f) >= 0 and remote.get(f) != effectiveBase(d).get(f)
      and remote.get(f) != drafts(d).get(f))
  def putDevice(d: int, updatedDevice: Device, event: str): State = {
    ...s, dev: s.dev.set(d, updatedDevice), event: event
  }
  def flag(st: State, condition: bool, failure: str): State = {
    ...st, failures: if (condition) st.failures.union(Set(failure)) else st.failures
  }

  /// An editor save can occur during a network request or local application.
  action save(d: int, f: int): bool = all {
    s.nextValue <= 3,
    not(INDEPENDENT) or d == f,
    s' = { ...putDevice(d, { ...device(d), live: device(d).live.set(f, s.nextValue), own: device(d).own.union(Set(s.nextValue)), seen: device(d).seen.union(Set((f, s.nextValue))) }, "save"),
      nextValue: s.nextValue + 1, lastSaved: s.lastSaved.set((d, f), s.nextValue) }
  }

  /// Capture bytes and the apply operation before any replacement.
  def applying(d: int, target: int): Device = {
    ...device(d), phase: "applying", target: target, expected: device(d).live,
    accounted: Set(), journal: BUG != "no-journal",
    recovery: if (BUG == "discard-remote") Set() else device(d).recovery.union(files.map(f => device(d).live.get(f)))
  }
  def candidateState(d: int, parent: int, contents: Tree): State = {
    val c = s.nextCommit
    val commit = { parent: parent, tree: contents,
      history: history(parent).union(Set(c)), status: "pending", author: d }
    val prepared = { ...putDevice(d, { ...device(d), phase: "publishing", candidate: c,
        checkpoint: if (BUG == "optimistic-checkpoint") c else device(d).checkpoint,
        draft: drafts(d), expected: device(d).live, journal: true,
        recovery: if (BUG == "discard-remote") Set() else device(d).recovery.union(files.map(f => device(d).live.get(f))) }, "prepare"),
      commits: s.commits.set(c, commit), nextCommit: c + 1 }
    val changed = files.filter(f => contents.get(f) != tree(parent).get(f))
    flag(flag(prepared, changed.exists(f => not(device(d).seen.contains((f, tree(parent).get(f))))), "blind-overwrite"),
      changed.exists(f => not(device(d).own.contains(contents.get(f)))), "unauthored-change")
  }

  action sync(d: int): bool = all {
    device(d).phase == "idle",
    s.head != device(d).checkpoint or drafts(d) != noDraft or device(d).carry != noDraft,
    if (not(history(s.head).contains(device(d).checkpoint))) {
      s' = putDevice(d, { ...device(d), phase: "paused" }, "history-rewritten")
    } else if (conflicts(d, tree(s.head)).size() > 0) {
      val old = device(d)
      val reused = files.mapBy(f => if (
        old.reviewBase == old.checkpoint and old.reviewLocal.get(f) == old.live.get(f) and old.reviewRemote.get(f) == tree(s.head).get(f)
      ) old.decisions.get(f) else "none")
      s' = putDevice(d, { ...old, phase: "resolving", draft: drafts(d),
        reviewLocal: old.live, reviewRemote: tree(s.head), reviewHead: s.head, reviewBase: old.checkpoint, decisions: reused,
        recovery: if (BUG == "discard-remote") Set() else old.recovery.union(files.map(f => old.live.get(f))) }, "review")
    } else {
      val contents = files.mapBy(f =>
        if (drafts(d).get(f) >= 0) drafts(d).get(f) else tree(s.head).get(f))
      if (contents == tree(s.head)) {
        s' = putDevice(d, applying(d, s.head), "journal-apply")
      } else all {
        s.nextCommit <= 5,
        s' = candidateState(d, s.head, contents)
      }
    }
  }

  /// The server processes a delayed request. Even a rewind to an ancestor
  /// must fail unless the branch head equals the exact expected parent.
  action process(d: int): bool = {
    val c = device(d).candidate
    val request = s.commits.get(c)
    val accepted = if (BUG == "fast-forward") request.history.contains(s.head)
      else s.head == request.parent
    val replacement = { ...s, head: if (accepted) c else s.head,
      commits: s.commits.set(c, { ...request, status: if (accepted) "accepted" else "cancelled" }),
      everPublished: if (accepted) s.everPublished.union(files.map(f => (f, request.tree.get(f)))) else s.everPublished,
      event: if (accepted) "accepted" else "head-moved" }
    all { request.status == "pending",
      s' = flag(replacement, accepted and s.head != request.parent, "not-exact-head") }
  }

  action receive(d: int): bool = all {
    device(d).phase == "publishing",
    s.commits.get(device(d).candidate).status != "pending",
    if (s.commits.get(device(d).candidate).status == "accepted") {
      // Use the expected pre-request snapshot, not a newer editor save.
      s' = putDevice(d, { ...applying(d, device(d).candidate),
        expected: device(d).expected, draft: device(d).draft }, "journal-accepted")
    } else {
      s' = putDevice(d, { ...device(d), phase: "idle" }, "validated-cancellation")
    }
  }

  /// Lost response / restart: validated receipt status abstracts ledger.qnt.
  action loseResponse(d: int): bool = all {
    device(d).phase == "publishing",
    s' = putDevice(d, { ...device(d), phase: "unknown" }, "response-lost")
  }
  action reconcileUnknown(d: int): bool = all {
    device(d).phase == "unknown",
    val c = device(d).candidate
    if (BUG != "replay-known" and BUG != "replay-unknown" and s.commits.get(c).status == "accepted") {
      s' = putDevice(d, { ...applying(d, c), expected: device(d).expected,
        draft: device(d).draft }, "validated-receipt")
    } else if (BUG == "replay-unknown" or BUG == "replay-known") all {
      s.nextCommit <= 5,
      s' = flag(candidateState(d, s.head, tree(c)), true, "unknown-replayed")
    } else {
      // Content abstraction waits for ledger.qnt to return a receipt or seal.
      // Neither ancestry nor error wording supplies a rejection verdict.
      s' = putDevice(d, { ...device(d), phase: "awaiting-ledger" }, "awaiting-ledger-verdict")
    }
  }

  /// Force rewind is an owner action; never simulated by ordinary publication.
  action rewind(destination: int): bool = all {
    history(s.head).contains(destination), s.head != destination,
    s' = { ...s, head: destination, removed: s.removed.union(history(s.head).exclude(history(destination))), event: "rewind" }
  }
  /// An external ordinary Git client may edit or revert one file.
  action external(f: int, value: int): bool = all {
    s.nextCommit <= 5, value >= 0, value <= 3,
    value != tree(s.head).get(f),
    val c = s.nextCommit
    val contents = tree(s.head).set(f, value)
    s' = { ...s, head: c, nextCommit: c + 1,
      commits: s.commits.set(c, { parent: s.head, tree: contents,
        history: history(s.head).union(Set(c)), status: "accepted", author: -1 }),
      everPublished: s.everPublished.union(files.map(f => (f, contents.get(f)))), event: "external" }
  }

  action decide(d: int, f: int, choice: str): bool = all {
    device(d).phase == "resolving", conflicts(d, device(d).reviewRemote).contains(f),
    device(d).decisions.get(f) == "none", Set("mine", "remote").contains(choice),
    s' = putDevice(d, { ...device(d), decisions: device(d).decisions.set(f, choice),
      seen: device(d).seen.union(Set((f, device(d).reviewRemote.get(f)))) }, "decision")
  }
  action publishDecision(d: int): bool = all {
    device(d).phase == "resolving",
    conflicts(d, device(d).reviewRemote).forall(f => device(d).decisions.get(f) != "none"),
    val stale = device(d).live != device(d).reviewLocal or tree(s.head) != device(d).reviewRemote
      or device(d).reviewBase != device(d).checkpoint
    if (stale and BUG != "stale-decision") {
      s' = putDevice(d, { ...device(d), phase: "idle" }, "refresh-stale-review")
    } else {
      val contents = files.mapBy(f => if (device(d).decisions.get(f) == "remote") tree(s.head).get(f)
        else if (drafts(d).get(f) >= 0) drafts(d).get(f) else tree(s.head).get(f))
      if (contents == tree(s.head)) {
        s' = flag(putDevice(d, applying(d, s.head), "journal-resolved"), stale, "stale-decision-used")
      } else all {
        s.nextCommit <= 5,
        s' = flag(candidateState(d, s.head, contents), stale, "stale-decision-used")
      }
    }
  }

  /// One atomic compare-and-replace. If it changed, capture and carry it.
  action applyFile(d: int, f: int): bool = all {
    device(d).phase == "applying", not(device(d).accounted.contains(f)),
    val old = device(d)
    val expected = old.expected.get(f)
    val replacement = tree(old.target).get(f)
    val matches = old.live.get(f) == expected or old.live.get(f) == replacement
    val replace = matches or BUG == "no-guard"
    val newer = not(replace)
    val updated = { ...old,
      live: if (replace) old.live.set(f, replacement) else old.live,
      draft: if (newer) old.draft.set(f, old.live.get(f)) else old.draft,
      carry: if (newer and BUG != "silent-draft") old.carry.set(f, expected) else old.carry.set(f, -1),
      recovery: if (newer and BUG != "no-capture") old.recovery.union(Set(old.live.get(f))) else old.recovery,
      seen: if (replace) old.seen.union(Set((f, replacement))) else old.seen,
      accounted: old.accounted.union(Set(f)),
      checkpoint: if (BUG == "partial-checkpoint") old.target else old.checkpoint }
    val nextState = putDevice(d, updated, if (newer) "newer-draft-carried" else "replace")
    val noJournal = replace and not(old.journal)
    val noGuard = replace and not(matches)
    val partial = updated.checkpoint != old.checkpoint and updated.accounted != files
    s' = flag(flag(flag(nextState, noJournal, "replacement-before-journal"), noGuard, "newer-draft-overwritten"),
      partial, "partial-checkpoint")
  }

  /// Restart after replacement keeps the durable batch and expected versions.
  action crash(d: int): bool = all {
    device(d).phase == "applying",
    s' = if (device(d).journal) { ...s, event: "restart-resumes-journal" }
      else putDevice(d, { ...device(d), phase: "idle", accounted: Set() }, "restart-forgets-batch")
  }
  action finish(d: int): bool = all {
    device(d).phase == "applying", device(d).accounted == files,
    val old = device(d)
    s' = putDevice(d, { ...old, checkpoint: old.target, phase: "idle", journal: false,
      draft: files.mapBy(f => if (old.live.get(f) == tree(old.target).get(f)) -1 else old.draft.get(f)),
      decisions: noDecision }, "checkpoint-complete")
  }
  /// Explicit user adoption of rewritten history, from the retired baseline.
  /// This abstract atomic action is not a proposed native file transaction.
  action adopt(d: int): bool = all {
    device(d).phase == "paused",
    val old = device(d)
    val keep = files.filter(f => old.live.get(f) != tree(old.checkpoint).get(f))
    val live = files.mapBy(f => if (keep.contains(f)) old.live.get(f) else tree(s.head).get(f))
    s' = putDevice(d, { ...old, phase: "idle", checkpoint: s.head, live: live,
      draft: files.mapBy(f => if (keep.contains(f)) live.get(f) else -1),
      carry: files.mapBy(f => if (keep.contains(f)) tree(old.checkpoint).get(f) else -1),
      accounted: Set(), decisions: noDecision,
      recovery: old.recovery.union(files.map(f => old.live.get(f))),
      seen: old.seen.union(files.exclude(keep).map(f => (f, tree(s.head).get(f)))) }, "explicit-adoption")
  }
  action stutter = s' = { ...s, event: "stutter" }

  /// Content scheduler inside finite budgets; publication status abstracts
  /// a validated ledger receipt/seal. The composition is not a refinement proof.
  action step = any {
    { nondet d = devices.oneOf() nondet f = files.oneOf() save(d, f) },
    { nondet d = devices.oneOf() sync(d) },
    { nondet d = devices.oneOf() process(d) },
    { nondet d = devices.oneOf() receive(d) },
    { nondet d = devices.oneOf() loseResponse(d) },
    { nondet d = devices.oneOf() reconcileUnknown(d) },
    { nondet c = commitIds.oneOf() rewind(c) },
    { nondet f = files.oneOf() nondet value = 0.to(3).oneOf() external(f, value) },
    { nondet d = devices.oneOf() nondet f = files.oneOf() nondet choice = Set("mine", "remote").oneOf() decide(d, f, choice) },
    { nondet d = devices.oneOf() publishDecision(d) },
    { nondet d = devices.oneOf() nondet f = files.oneOf() applyFile(d, f) },
    { nondet d = devices.oneOf() crash(d) },
    { nondet d = devices.oneOf() finish(d) },
    { nondet d = devices.oneOf() adopt(d) },
    stutter
  }

  /// Safety properties refer to durable state, with small event ghosts for
  /// transition obligations (ordering, exact comparison, decision validity).
  val exactHead = not(s.failures.contains("not-exact-head"))
  val unknownHeld = not(s.failures.contains("unknown-replayed"))
  val journalFirst = not(s.failures.contains("replacement-before-journal"))
  val newerPreserved = not(s.failures.contains("newer-draft-overwritten"))
  val wholeCheckpoint = not(s.failures.contains("partial-checkpoint"))
  val scopedDecisions = not(s.failures.contains("stale-decision-used"))
  val checkpointPublished = devices.forall(d => s.commits.get(device(d).checkpoint).status == "accepted")
  val noResurrection = s.removed.intersect(history(s.head)) == Set()
  val latestSavePreserved = tuples(devices, files).forall(df => {
    val d = df._1
    val f = df._2
    val value = s.lastSaved.get(df)
    value == -1 or device(d).live.get(f) == value or device(d).draft.get(f) == value
      or device(d).recovery.contains(value) or s.everPublished.contains((f, value))
  })
  val carriedCaptured = tuples(devices, files).forall(df => {
    val d = df._1
    val f = df._2
    not(device(d).accounted.contains(f)) or device(d).carry.get(f) == -1
      or (device(d).draft.get(f) >= 0 and device(d).recovery.contains(device(d).draft.get(f)))
  })
  val independentNoConflict = not(INDEPENDENT) or devices.forall(d => device(d).phase != "resolving")
  val noBlindOverwrite = not(s.failures.contains("blind-overwrite"))
  val noUnauthoredChange = not(s.failures.contains("unauthored-change"))
  val liveCommittedOrOwn = devices.forall(d => files.forall(f =>
    s.everPublished.contains((f, device(d).live.get(f))) or device(d).own.contains(device(d).live.get(f))))
  val liveCurrentOrOwn = devices.forall(d => files.forall(f =>
    history(s.head).exists(c => tree(c).get(f) == device(d).live.get(f))
      or device(d).own.contains(device(d).live.get(f))))
  val savedCurrent = tuples(devices, files).forall(df => {
    val d = df._1
    val f = df._2
    val value = s.lastSaved.get(df)
    value == -1 or device(d).live.get(f) == value or device(d).draft.get(f) == value
      or device(d).recovery.contains(value) or history(s.head).exists(c => tree(c).get(f) == value)
  })
  val baseCoherent = devices.forall(d => device(d).phase == "applying" or files.forall(f =>
    device(d).live.get(f) == tree(device(d).checkpoint).get(f) or device(d).own.contains(device(d).live.get(f))))
  def introduced(c: int): Set[int] = files.filter(f => tree(c).get(f) != tree(s.commits.get(c).parent).get(f)).map(f => tree(c).get(f))
  val noReplay = history(s.head).forall(a => history(s.head).forall(b =>
    a == b or s.commits.get(a).author == -1 or s.commits.get(b).author == -1
      or introduced(a).intersect(introduced(b)) == Set()))
  val candidateRetained = devices.forall(d => not(Set("unknown", "awaiting-ledger").contains(device(d).phase)) or
    (device(d).candidate > 0 and s.commits.get(device(d).candidate).status != "unused"))
  val typeOK = commitIds.contains(s.head) and devices.forall(d =>
    commitIds.contains(device(d).checkpoint) and device(d).accounted.subseteq(files))
  val safe = typeOK and noBlindOverwrite and noUnauthoredChange and liveCommittedOrOwn
    and baseCoherent and noReplay and candidateRetained and exactHead and unknownHeld and journalFirst and newerPreserved and wholeCheckpoint
    and scopedDecisions and checkpointPublished and noResurrection and latestSavePreserved and carriedCaptured

  val converged = devices.forall(d => device(d).phase == "idle" and device(d).checkpoint == s.head
    and device(d).live == tree(s.head) and device(d).draft == noDraft)
}
