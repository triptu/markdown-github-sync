/// Fixed schedules prove both races are exercised; these are safety witnesses,
/// separate from ledger.qnt's genuine temporal settlement property.
module ledgerCases {
  const PUBLICATION_WINS: bool
  import ledger(BUG = "none", FAIR = true) as p from "./ledger"
  var turn: int
  action init = all { p::init, turn' = 0 }
  action scheduled =
    if (turn == 0) p::prepare(0)
    else if (turn == 1) p::markDispatched(0)
    else if (turn == 2) p::sendPublish(0)
    else if (turn == 3) p::prepareSeal(0)
    else if (turn == 4) p::sendSeal(0)
    else if (turn == 5) { if (PUBLICATION_WINS) p::deliverPublish(1) else p::deliverSeal(1) }
    else if (turn == 6) p::crash(0)
    else if (turn == 7) p::resume(0)
    else if (turn == 8) p::settle(0)
    else if (turn == 9) { if (PUBLICATION_WINS) p::deliverSeal(1) else p::prepare(0) }
    else if (turn == 10) { if (PUBLICATION_WINS) p::rewind else p::markDispatched(0) }
    else if (PUBLICATION_WINS) p::s' = p::s
    else if (turn == 11) p::sendPublish(0)
    else if (turn == 12) p::deliverPublish(3)
    else if (turn == 13) p::settle(0)
    else if (turn == 14) p::rewind
    else if (turn == 15) p::deliverPublish(1)
    else p::s' = p::s
  action step = all { scheduled, turn' = if (turn < 16) turn + 1 else turn }
  val witness = turn == 16 and p::s.head == 0 and
    (if (PUBLICATION_WINS) p::s.accepted == Set(1) and p::s.cancelled == Set()
     else p::s.accepted == Set(3) and p::s.cancelled == Set(1) and p::s.ledger.get(0) == p::receipt(3))
  val safe = p::safe and (turn < 16 or witness)
}
