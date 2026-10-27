# Project plan: Driver app offline mode

**Team:** Routes squad at Lanternfield Freight (made-up)
**Owner:** me
**Status:** spike done, rollout planning

## Problem

Drivers lose signal in the valley stretch and in underground loading bays. When that happens the app freezes on "Saving…" and they take a photo of the screen as proof of delivery. Support gets about 40 tickets a week from this.

## Goal

A driver can complete every step of a delivery with no signal, and the app catches up on its own when signal comes back. No lost scans, no duplicate deliveries.

## Non-goals

- offline maps (separate project)
- editing the route while offline
- syncing between two phones for the same driver

## Approach

1. Every action becomes an entry in a local queue (scan, signature, photo, note)
2. The queue is written to disk before the UI says "done"
3. A background worker sends entries in order when online
4. The server ignores entries it has already seen (each has an id)
5. The UI shows a small "3 waiting to send" badge, nothing louder

## Open questions

- [ ] how long do we keep entries that keep failing? 7 days?
- [ ] photos are big. send them last, or compress first?
- [x] can the server accept out-of-order entries? — yes, it sorts by timestamp
- [ ] what does the driver see if an entry is rejected after the fact?

## Milestones

| # | what | when | status |
|---|---|---|---|
| 1 | spike: queue survives restart | W43 | done |
| 2 | scans + signatures offline | W45 | in progress |
| 3 | photos offline | W47 | not started |
| 4 | 10% of drivers | W48 | |
| 5 | everyone | W50 | |

## Risks

- **Old phones.** Some drivers are on phones with very little storage. Need a cap on the queue size.
- **Clock skew.** Phones with wrong clocks will send weird timestamps. Server should use receive time as a tiebreak.
- **Silent failure.** The worst outcome is the badge saying 0 while something is stuck. Need a test for that specifically.
- **Support confusion.** Support should know what "waiting to send" means before we roll out.

## Metrics

- tickets tagged "stuck saving" per week (target: under 5)
- median time from action to server receipt
- number of entries older than 24h in any queue (target: 0)

## People

- Priya — eng manager, approves scope
- Arjun's friend Kabir in support (not on team, but helpful for driver feedback)
- Leena — design, owns the badge

## Log

- W41: kickoff, see [[Meeting - Route planner kickoff]] (shared meeting, offline mode was item 3)
- W42: estimate accepted
- W43: spike merged behind flag, notes in [[Work log October]]
- W44: Priya asked me to lead rollout, see [[1-1 with Priya]]

## Lessons so far

The spike was only good because it had a two-day limit. [[2026011510 Constraints make the work visible]]
