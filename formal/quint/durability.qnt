/// Separate persistence boundaries; fixed repository/base identity.
/// Native compare-and-replace is an assumption pending the adapter design.
module durability {
  const BUG: str
  pure val paths = Set(0, 1)
  type Tree = int -> int
  type Observation = { local: Tree, remote: Tree, head: int }
  pure val absent: Observation = { local: paths.mapBy(_ => -1), remote: paths.mapBy(_ => -1), head: -1 }
  type Disk = {
    approval: Observation, operation: Observation,
    recovery: Set[int], done: Set[int], checkpoint: int, active: bool, accounted: Tree
  }
  type State = {
    live: Tree, remote: Tree, head: int, disk: Disk,
    view: Observation, staged: Observation, lastSave: int,
    failures: Set[str], hint: bool
  }
  var s: State
  action init = s' = {
    live: paths.mapBy(_ => 1), remote: paths.mapBy(_ => 3), head: 1,
    disk: { approval: absent, operation: absent,
      recovery: Set(), done: Set(), checkpoint: 0, active: false, accounted: paths.mapBy(_ => -1) },
    view: absent, staged: absent, lastSave: 1, failures: Set(), hint: false
  }
  val current = { local: s.live, remote: s.remote, head: s.head }
  action observe = all { not(s.disk.active), s' = { ...s, view: current } }
  action persistObservation = all {
    s.view != absent, not(s.disk.active),
    s' = { ...s, disk: { ...s.disk,
      recovery: if (BUG == "volatile-observation") s.disk.recovery else s.disk.recovery.union(paths.map(f => s.view.local.get(f))) } }
  }
  /// A UI approval is volatile until the next, distinct persistence action.
  action approve = all {
    not(s.disk.active), s.view != absent,
    paths.forall(f => s.disk.recovery.contains(s.view.local.get(f))) or BUG == "volatile-observation",
    s' = { ...s, staged: s.view }
  }
  action persistApproval = all {
    s.staged != absent, not(s.disk.active),
    s' = { ...s, disk: { ...s.disk, approval: s.staged } }
  }
  val consentMatches = s.disk.approval.local == s.live and s.disk.approval.remote == s.remote
  action prepare = all {
    not(s.disk.active), s.disk.checkpoint != s.head,
    s.disk.approval != absent,
    consentMatches or BUG == "unscoped-approval",
    s' = { ...s,
      disk: { ...s.disk, active: true, operation: current, done: Set() },
      failures: if (not(consentMatches)) s.failures.union(Set("stale-approval")) else s.failures }
  }
  /// Atomic file operation ends BEFORE the durable acknowledgement.
  action replace(f: int): bool = all {
    s.disk.active, not(s.disk.done.contains(f)),
    s.live.get(f) != s.disk.operation.remote.get(f),
    s.live.get(f) == s.disk.operation.local.get(f) or BUG == "unguarded-replace",
    s' = { ...s, live: s.live.set(f, s.disk.operation.remote.get(f)),
      failures: if (s.live.get(f) != s.disk.operation.local.get(f))
        s.failures.union(Set("overwrite-newer")) else s.failures }
  }
  /// A mismatch is captured durably before marking its path accounted for.
  action account(f: int): bool = all {
    s.disk.active, not(s.disk.done.contains(f)),
    s.live.get(f) != s.disk.operation.local.get(f),
    s' = { ...s, disk: { ...s.disk, done: s.disk.done.union(Set(f)), accounted: s.disk.accounted.set(f, s.live.get(f)),
      recovery: if (BUG == "account-before-capture") s.disk.recovery
        else s.disk.recovery.union(Set(s.live.get(f))) } }
  }
  action finish = all {
    s.disk.active, s.disk.done == paths,
    s' = { ...s, disk: { ...s.disk, active: false, checkpoint: s.disk.operation.head } }
  }
  /// Restart clears all volatile observation/decision state, including staged approval.
  action crash = s' = { ...s, view: absent, staged: absent }
  action save = all {
    s.lastSave == 1,
    s' = { ...s, live: s.live.set(0, 2), lastSave: 2 }
  }
  /// Content-version consent: identical bytes at a new head remain approved.
  action remoteAdvance = all { s.head == 1, s' = { ...s, head: 2 } }
  /// A byte-identical recreation or a duplicate/self-echo event only schedules.
  action echo = s' = { ...s, hint: not(s.hint) }
  action step = any {
    echo,
    observe, persistObservation, approve, persistApproval, prepare,
    { nondet f = paths.oneOf() replace(f) },
    { nondet f = paths.oneOf() account(f) },
    finish, crash, save, remoteAdvance, s' = s
  }
  val approvalDurable = s.disk.approval == absent or
    paths.forall(f => s.disk.recovery.contains(s.disk.approval.local.get(f)))
  val approvalScoped = not(s.failures.contains("stale-approval"))
  val newerPreserved = not(s.failures.contains("overwrite-newer"))
  val accountedCaptured = s.disk.done.forall(f =>
    s.disk.accounted.get(f) == s.disk.operation.remote.get(f)
      or s.disk.recovery.contains(s.disk.accounted.get(f)))
  val latestSavePreserved = s.live.get(0) == s.lastSave or s.disk.recovery.contains(s.lastSave)
  val checkpointCoherent = s.disk.checkpoint != s.disk.operation.head or s.disk.done == paths
  val journalDurable = not(s.disk.active) or s.disk.operation != absent
  val safe = latestSavePreserved and checkpointCoherent and journalDurable and approvalDurable and approvalScoped and newerPreserved and accountedCaptured
}
