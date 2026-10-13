module NegLedgerReplay {
  import ledger(BUG = "replay-accepted", FAIR = true).* from "../ledger"
}
