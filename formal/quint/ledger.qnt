/// Selected v2 contract, design §§2–3. Ref effects are linearizable.
/// Two installations; d0 may retry once, d1 once total. No ledger GC.
module ledger {
  const BUG: str
  const FAIR: bool
  pure val devices = Set(0, 1)
  pure val ids = Set(1, 2, 3)
  pure def owner(id: int): int = if (id == 2) 1 else 0
  pure def receipt(id: int): int = 2 * id
  pure def seal(id: int): int = 2 * id + 1
  type Operation = { parent: int, anchor: int, receipt: int, seal: int, verdict: str }
  type Device = { active: int, phase: str, anchor: int, loaded: bool,
    sent: bool, sealSent: bool, rounds: int }
  type State = {
    head: int, ledger: int -> int, chain: int -> Set[int],
    ops: int -> Operation, recorded: Set[int], sealed: Set[int],
    dev: int -> Device, publishQueue: Set[int], sealQueue: Set[int],
    accepted: Set[int], cancelled: Set[int], consumed: Set[int],
    ancestry: int -> Set[int], nodeAncestors: int -> Set[int], failures: Set[str],
    online: bool, quiet: bool, budget: int
  }
  var s: State
  pure val blankOp: Operation = { parent: 0, anchor: 0, receipt: 0, seal: 0, verdict: "unused" }
  pure val blankDev: Device = { active: 0, phase: "idle", anchor: 0, loaded: true,
    sent: false, sealSent: false, rounds: 0 }
  action init = s' = { head: 0, ledger: devices.mapBy(_ => 0), chain: devices.mapBy(_ => Set(0)),
    ops: ids.mapBy(_ => blankOp), recorded: Set(), sealed: Set(),
    dev: devices.mapBy(_ => blankDev), publishQueue: Set(), sealQueue: Set(),
    accepted: Set(), cancelled: Set(), consumed: Set(),
    ancestry: 0.to(3).mapBy(_ => Set(0)), nodeAncestors: 0.to(7).mapBy(_ => Set(0)), failures: Set(), online: true, quiet: false, budget: 2 }
  def device(d: int): Device = s.dev.get(d)
  def op(id: int): Operation = s.ops.get(id)
  action prepare(d: int): bool = all {
    device(d).loaded, device(d).active == 0, device(d).rounds < 3,
    not(s.consumed.contains(d)) or BUG == "replay-accepted",
    nondet id = ids.filter(i => owner(i) == d and not(s.recorded.contains(i))).oneOf()
    // Fixed allocation order prevents equivalent object-renaming permutations.
    all { id != 3 or s.recorded.contains(1),
    s' = { ...s, recorded: s.recorded.union(Set(id)),
      ops: s.ops.set(id, { parent: s.head, anchor: device(d).anchor,
        receipt: receipt(id), seal: 0, verdict: "undecided" }),
      nodeAncestors: s.nodeAncestors.set(receipt(id), s.nodeAncestors.get(device(d).anchor).union(Set(receipt(id)))),
      ancestry: s.ancestry.set(id, s.ancestry.get(s.head).union(Set(id))),
      dev: s.dev.set(d, { ...device(d), active: id, phase: "prepared", sent: false, sealSent: false }) } }
  }
  action markDispatched(d: int): bool = all {
    device(d).loaded, device(d).phase == "prepared",
    s' = { ...s, dev: s.dev.set(d, { ...device(d), phase: "dispatched" }) }
  }
  action sendPublish(d: int): bool = all {
    device(d).loaded, device(d).phase == "dispatched", not(device(d).sent),
    s' = { ...s, publishQueue: s.publishQueue.union(Set(device(d).active)),
      dev: s.dev.set(d, { ...device(d), sent: true }) }
  }
  /// An error or lost response has no verdict effect. The queued request may
  /// arrive after a seal, after a crash, or during a later operation.
  action deliverPublish(id: int): bool = all {
    s.online, s.publishQueue.contains(id),
    val d = owner(id)
    val win = s.head == op(id).parent and (s.ledger.get(d) == op(id).anchor or BUG == "ignore-anchor")
    val partial = win and BUG == "split-cas"
    s' = { ...s, publishQueue: s.publishQueue.exclude(Set(id)),
      head: if (win) id else s.head,
      ledger: if (win and not(partial)) s.ledger.set(d, receipt(id)) else s.ledger,
      chain: if (win and not(partial)) s.chain.set(d, s.nodeAncestors.get(receipt(id))) else s.chain,
      accepted: if (win) s.accepted.union(Set(id)) else s.accepted,
      failures: s.failures.union(if (partial) Set("non-atomic-publication") else Set())
        .union(if (win and s.accepted.contains(id)) Set("replayed-request") else Set()) }
  }
  action prepareSeal(d: int): bool = all {
    device(d).loaded, s.online, device(d).phase == "dispatched", device(d).sent,
    val id = device(d).active
    all { s.ledger.get(d) == op(id).anchor,
    s' = { ...s, nodeAncestors: s.nodeAncestors.set(seal(id), s.nodeAncestors.get(op(id).anchor).union(Set(seal(id)))),
      sealed: s.sealed.union(Set(id)), ops: s.ops.set(id, { ...op(id), seal: seal(id) }),
      dev: s.dev.set(d, { ...device(d), phase: "sealing" }) } }
  }
  action sendSeal(d: int): bool = all {
    device(d).loaded, device(d).phase == "sealing", not(device(d).sealSent),
    s' = { ...s, sealQueue: s.sealQueue.union(Set(device(d).active)),
      dev: s.dev.set(d, { ...device(d), sealSent: true }) }
  }
  action deliverSeal(id: int): bool = all {
    s.online, s.sealQueue.contains(id),
    val d = owner(id)
    val win = s.ledger.get(d) == op(id).anchor or BUG == "seal-current-anchor"
    s' = { ...s, sealQueue: s.sealQueue.exclude(Set(id)),
      ledger: if (win) s.ledger.set(d, seal(id)) else s.ledger,
      chain: if (win) s.chain.set(d, s.nodeAncestors.get(seal(id))) else s.chain,
      cancelled: if (win) s.cancelled.union(Set(id)) else s.cancelled }
  }
  /// A successful fresh read is required. Absence at a null anchor remains
  /// undecided; no error/absence/branch-ancestry inference is permitted.
  action settle(d: int): bool = all {
    device(d).loaded, s.online, Set("dispatched", "sealing").contains(device(d).phase),
    val id = device(d).active
    val accepted = s.ledger.get(d) == receipt(id)
    val cancelled = (s.sealed.contains(id) and s.ledger.get(d) == seal(id))
      or (BUG == "absence-rejection" and s.ledger.get(d) == op(id).anchor)
    all { accepted or cancelled,
    s' = { ...s, ops: s.ops.set(id, { ...op(id), verdict: if (accepted) "accepted" else "cancelled" }),
      consumed: if (accepted) s.consumed.union(Set(d)) else s.consumed,
      dev: s.dev.set(d, { ...device(d), active: 0, phase: "idle", anchor: s.ledger.get(d),
        rounds: if (accepted) 0 else device(d).rounds + 1 }) } }
  }
  /// Out-of-contract foreign ref mutation. The automatic writer stops;
  /// recovery/re-anchoring requires a separate reviewed protocol.
  action tamper = all {
    BUG == "foreign-ledger", not(s.quiet), s.budget > 0,
    nondet d = devices.oneOf()
    all { device(d).active != 0,
      s' = { ...s, ledger: s.ledger.set(d, 8), chain: s.chain.set(d, Set(8)), budget: s.budget - 1 } }
  }
  action diverge(d: int): bool = all {
    device(d).loaded, s.online, Set("dispatched", "sealing").contains(device(d).phase),
    val id = device(d).active
    all { not(Set(op(id).anchor, receipt(id), seal(id)).contains(s.ledger.get(d))),
      s' = { ...s, ops: s.ops.set(id, { ...op(id), verdict: "diverged" }),
        dev: s.dev.set(d, { ...device(d), phase: "diverged" }) } }
  }
  action reschedule(d: int): bool = all {
    device(d).loaded, device(d).active == 0, device(d).rounds == 3,
    s' = { ...s, dev: s.dev.set(d, { ...device(d), rounds: 0 }) }
  }
  action crash(d: int): bool = all {
    not(s.quiet), s.budget > 0, device(d).loaded,
    s' = { ...s, budget: s.budget - 1,
      recorded: if (BUG == "forget-journal") s.recorded.exclude(Set(device(d).active)) else s.recorded,
      dev: s.dev.set(d, { ...device(d), loaded: false }) }
  }
  action resume(d: int): bool = all {
    not(device(d).loaded),
    s' = { ...s, dev: s.dev.set(d, { ...device(d), loaded: true }) }
  }
  action rewind = all {
    not(s.quiet), s.budget > 0, s.head != 0,
    nondet target = s.ancestry.get(s.head).exclude(Set(s.head)).oneOf()
    s' = { ...s, head: target, budget: s.budget - 1 }
  }
  action outage = all {
    not(s.quiet), s.budget > 0,
    s' = { ...s, online: not(s.online), budget: s.budget - 1 }
  }
  action quiesce = all { not(s.quiet), s' = { ...s, quiet: true, online: true } }
  action client(d: int): bool = any {
    prepare(d), markDispatched(d), sendPublish(d), prepareSeal(d), sendSeal(d), settle(d), reschedule(d), resume(d), diverge(d)
  }
  action server = any {
    { nondet id = ids.oneOf() deliverPublish(id) },
    { nondet id = ids.oneOf() deliverSeal(id) }
  }
  action step = any { client(0), client(1), server, crash(0), crash(1), rewind, outage, tamper, quiesce, s' = s }
  val exclusive = s.accepted.intersect(s.cancelled) == Set()
  val atomicPublication = not(s.failures.contains("non-atomic-publication"))
  val verdictSound = s.recorded.forall(id =>
    (op(id).verdict != "accepted" or s.accepted.contains(id)) and
    (op(id).verdict != "cancelled" or s.cancelled.contains(id)))
  val journalFirst = s.publishQueue.subseteq(s.recorded) and s.sealQueue.subseteq(s.sealed)
    and s.accepted.union(s.cancelled).subseteq(s.recorded)
  val receiptRetained = s.accepted.forall(id => s.chain.get(owner(id)).contains(receipt(id)))
  val noReplay = not(s.failures.contains("replayed-request")) and devices.forall(d => s.accepted.filter(id => owner(id) == d).size() <= 1)
  val anchorMonotone = devices.forall(d => s.chain.get(d).contains(device(d).anchor))
  val identitiesStable = s.recorded.forall(id => op(id).receipt == receipt(id)
    and (not(s.sealed.contains(id)) or op(id).seal == seal(id)))
  val divergenceStops = devices.forall(d => device(d).phase != "diverged" or
    (device(d).active != 0 and op(device(d).active).verdict == "diverged"))
  val safeUnderTamper = exclusive and verdictSound and journalFirst and identitiesStable and divergenceStops
  val safe = divergenceStops and exclusive and atomicPublication and verdictSound and journalFirst and receiptRetained
    and noReplay and anchorMonotone and identitiesStable
  val allSettled = s.recorded.forall(id => op(id).verdict != "undecided")
  temporal fairness = client(0).weakFair(s) and client(1).weakFair(s) and server.weakFair(s)
  temporal progress = (if (FAIR) fairness else true) implies always(s.quiet implies eventually(allSettled))
}
