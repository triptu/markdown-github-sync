module ConsentVersions {
  import durability(BUG = "none") as p from "../durability"
  var turn: int
  action init = all { p::init, turn' = 0 }
  action scheduled =
    if (turn == 0) p::observe
    else if (turn == 1) p::persistObservation
    else if (turn == 2) p::approve
    else if (turn == 3) p::persistApproval
    else if (turn == 4) p::remoteAdvance
    else if (turn == 5) p::echo
    else if (turn == 6) p::crash
    else if (turn == 7) p::prepare
    else if (turn == 8) p::replace(0)
    else if (turn == 9) p::echo
    else if (turn == 10) p::account(0)
    else if (turn == 11) p::replace(1)
    else if (turn == 12) p::account(1)
    else if (turn == 13) p::finish
    else p::s' = p::s
  action step = all { scheduled, turn' = if (turn < 14) turn + 1 else turn }
  val witness = turn == 14 and p::s.disk.checkpoint == 2 and p::s.live == p::s.remote
  val safe = p::safe and (turn < 14 or witness)
}
