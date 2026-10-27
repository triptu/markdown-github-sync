# Work log — October 2026

**Oct 1** — estimate for offline mode. three weeks if photos are out of scope, five if in.
**Oct 2** — Priya ok'd the estimate. photos in, but last.
**Oct 6** — route planner kickoff. long. [[Meeting - Route planner kickoff]]
**Oct 8** — read the old sync code. it retries forever with no backoff. no wonder batteries die.
**Oct 13** — paired with Leena on the badge. "3 waiting to send" beat "Offline queue (3)" by a mile.
**Oct 15** — on-call. two pages, both the same flaky health check.
**Oct 20** — spike day 1. queue writes to disk, but reorders on restart. fixed by sorting on insert id.
**Oct 21** — spike day 2. survives restart, airplane mode, and force-quit. merged behind `offline_queue_v1`.
**Oct 23** — retro. [[Retro notes Q3]]
**Oct 26** — 1-1, leading rollout now. [[1-1 with Priya]]
**Oct 27** — wrote rollout checklist draft. need support to review it.

- [ ] add queue size cap
- [ ] write the "badge says 0 but something's stuck" test
- [x] remove the infinite retry
