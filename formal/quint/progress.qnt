/// Infinite behaviors of a finite protocol, without a turn cutoff.
/// Quiescence is an explicit environment action, not a completion schedule.
module progress {
  const INDEPENDENT: bool
  const FAIR: bool
  import vaultSync(BUG = "none", INDEPENDENT = INDEPENDENT) as p from "./vaultSync"
  var quiet: bool
  var budget: int
  action init = all { p::init, quiet' = false, budget' = 2 }
  action deviceStep(d: int): bool = any {
    p::sync(d), p::receive(d), p::reconcileUnknown(d), p::publishDecision(d), p::finish(d),
    { nondet f = p::files.oneOf() p::applyFile(d, f) },
    { nondet f = p::files.oneOf() nondet choice = Set("mine", "remote").oneOf()
      p::decide(d, f, choice) }
  }
  action server = { nondet d = p::devices.oneOf() p::process(d) }
  action environment = all {
    not(quiet), budget > 0,
    nondet d = p::devices.oneOf()
    nondet f = p::files.oneOf()
    p::save(d, f), quiet' = quiet, budget' = budget - 1
  }
  action stopEnvironment = all { not(quiet), p::s' = p::s, quiet' = true, budget' = budget }
  action step = any {
    environment, stopEnvironment,
    all { any { deviceStep(0), deviceStep(1), server, p::s' = p::s },
      quiet' = quiet, budget' = budget }
  }
  temporal fairness = deviceStep(0).weakFair(p::s) and deviceStep(1).weakFair(p::s)
    and server.weakFair(p::s)
  temporal convergence = (if (FAIR) fairness else true)
    implies always(quiet implies eventually(p::converged))
  val safe = p::safe and p::liveCurrentOrOwn and p::savedCurrent and (not(INDEPENDENT) or p::independentNoConflict)
    and p::s.nextCommit <= 5
    and p::devices.forall(d => p::history(p::s.head).contains(p::device(d).checkpoint))
}
