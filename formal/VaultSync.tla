------------------------------ MODULE VaultSync ------------------------------
(***************************************************************************)
(* Finite protocol model of the GitHub-authoritative Obsidian vault sync   *)
(* described in docs/github-sync-proposal.md and docs/github-sync-review.md *)
(*                                                                         *)
(* Scope: two devices, two files, one GitHub branch ("main"), one external *)
(* publisher (another ordinary Git client), one owner who may rewind the   *)
(* branch (optional).  File contents are abstract values.  Every save and  *)
(* every external edit produces a fresh value, so a value identifies the   *)
(* edit that produced it.  A file is always present (no deletes).          *)
(*                                                                         *)
(* What is modelled:                                                       *)
(*   - local saves -> durable captured drafts -> candidate commit          *)
(*   - exact-head publication (compare-and-swap on the branch head)        *)
(*   - lost responses / delayed requests / crash during publication        *)
(*   - candidate-ancestry reconciliation after an unknown outcome          *)
(*   - guarded, journaled, per-file local application and a coherent       *)
(*     commit checkpoint that only advances after the whole batch          *)
(*   - whole-batch conflict pause with Use-mine / Use-GitHub decisions     *)
(*   - history rewind detection and explicit adoption (optional)           *)
(*                                                                         *)
(* The NC_* constants are negative controls.  Each one deliberately       *)
(* disables one safeguard; the matching .cfg must report a violation.      *)
(*                                                                         *)
(* Abstraction limits (see formal/README.md): atomic per-file apply,       *)
(* immutable object reads, no deletes/renames, no binary/trash races,      *)
(* no storage corruption, GitHub object store is reliable once accepted.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
  Devices,            \* set of model values, e.g. {d1, d2}
  Files,              \* set of model values, e.g. {f1, f2}
  Owner,              \* Owner[d] \subseteq Files: the files device d's user may edit
  MaxEnv,             \* budget of environment events (saves, external commits, faults)
  MaxCommits,         \* hard bound on commit identifiers (must never bind; see CommitBoundSlack)
  AllowRewind,        \* owner may rewind main to an ancestor
  AllowExternal,      \* another Git client may publish ordinary commits
  AllowQuiescence,    \* environment may stop forever (for liveness checks)
  \* ---- negative controls (all FALSE for the real protocol) ----
  NC_NoApplyGuard,        \* apply overwrites live file without comparing to captured version
  NC_NoApplyJournal,      \* crash during application forgets the in-progress batch
  NC_PartialCheckpoint,   \* checkpoint advanced per file instead of per completed batch
  NC_OptimisticCheckpoint,\* checkpoint advanced / drafts released when request is SENT
  NC_ReplayOnUnknown,     \* unknown outcome: "head differs, so it failed" without ancestry check
  NC_StaleResolution,     \* reuse a conflict decision against a different remote value
  NC_SilentNewDraft,      \* newer local edit found during apply becomes an ordinary draft
  NC_DiscardOnUseGitHub,  \* "Use GitHub" drops the local draft without a recovery copy
  NC_FastForwardRef,      \* ref update accepts any fast-forward instead of exact old head
  NC_ForgetSiblings       \* HeadMoved for one candidate treated as failure of the whole operation

ASSUME MaxEnv \in Nat /\ MaxCommits \in Nat /\ MaxCommits >= 1

AllFilesOwner == [d \in Devices |-> Files]

NoVal     == -1
Values    == 0..MaxEnv
CommitIds == 0..MaxCommits
Phases    == {"Idle", "Resolving", "Publishing", "Unknown", "Applying", "Paused", "Held"}
Decisions == {"none", "mine", "github"}
NoPlan    == [h |-> 0, dec |-> [f \in Files |-> "none"]]
Unused    == [parent |-> 0, tree |-> [f \in Files |-> 0], author |-> "none", status |-> "none"]

VARIABLES
  \* ---------------- GitHub ----------------
  head,        \* commit id at refs/heads/main
  commit,      \* CommitIds -> [parent, tree, author, status]; status: none|inflight|accepted|rejected
               \* (a rejected candidate is dropped once no device still refers to it)
  lost,        \* set of commit ids whose publication response will never reach the device
  \* ---------------- environment ----------------
  nextVal,     \* next fresh content value
  envBudget,   \* remaining environment events
  quiescent,   \* TRUE once the environment has stopped forever
  \* ---------------- per device, DURABLE ----------------
  live,        \* live[d][f]: current file content on disk
  ckpt,        \* ckpt[d]: coherent commit checkpoint (last fully applied commit)
  draft,       \* draft[d][f]: captured draft snapshot or NoVal (journal)
  cflag,       \* cflag[d][f]: file needs an explicit decision before publication (journal)
  phase,       \* phase[d]: session state (journal)
  plan,        \* plan[d]: [h: remote commit compared against, dec: per-file decision] (journal)
  cands,       \* cands[d]: candidate commit ids of the current publication operation (journal)
  cur,         \* cur[d]: most recent candidate (journal)
  target,      \* target[d]: commit being applied (journal)
  done,        \* done[d]: files already accounted for in the current application (journal)
  recovery,    \* recovery[d]: values preserved by an explicit decision (journal)
  \* ---------------- ghost / history variables (specification only) ----------------
  authorOf,    \* authorOf[v]: which device (or "ext"/"init") produced value v
  seenBy,      \* seenBy[v]: devices whose user has seen value v (live or in a conflict view)
  lastSaved,   \* lastSaved[d][f]: the most recent value the user on d saved for f
  everOnMain,  \* values that have been on main at some time
  removed,     \* commits removed from main's history by an owner rewind
  viol         \* flags recorded by the ghost checks at publication time

gh    == <<head, commit, lost>>
env   == <<nextVal, envBudget, quiescent>>
dev   == <<live, ckpt, draft, cflag, phase, plan, cands, cur, target, done, recovery>>
ghost == <<authorOf, seenBy, lastSaved, everOnMain, removed, viol>>
vars  == <<gh, env, dev, ghost>>

-----------------------------------------------------------------------------
(* Helpers *)

Tree(c)  == commit[c].tree
Base(d)  == Tree(ckpt[d])

RECURSIVE Anc(_)
Anc(c) == IF c = 0 THEN {0} ELSE {c} \cup Anc(commit[c].parent)

Created == {c \in CommitIds : commit[c].status # "none"}
Free    == {c \in CommitIds : commit[c].status = "none"}
Alloc   == CHOOSE c \in Free : \A c2 \in Free : c <= c2

\* Drop rejected candidates in S that no device refers to any more.
Dropped(cm, S) == [c \in CommitIds |-> IF c \in S /\ cm[c].status = "rejected" THEN Unused ELSE cm[c]]
AllCands == UNION {cands[d] : d \in Devices}

ChangedFiles(c) == {f \in Files : Tree(c)[f] # Tree(commit[c].parent)[f]}

TreeValues(c) == {Tree(c)[f] : f \in Files}

\* Fresh capture of saved local changes relative to the coherent checkpoint.
NewDraft(d) == [f \in Files |-> IF live[d][f] # Base(d)[f] THEN live[d][f] ELSE NoVal]

\* Files that need a decision when drafts dr are compared with remote commit h.
ConflictSet(d, h, dr) ==
  {f \in Files : dr[f] # NoVal /\ (Tree(h)[f] # Base(d)[f] \/ cflag[d][f])}

\* A previous decision may be reused only if the remote value and the local
\* snapshot it was made against are unchanged (NC_StaleResolution drops the check).
Reusable(d, f, h, dr) ==
  /\ plan[d].dec[f] # "none"
  /\ (NC_StaleResolution \/ (plan[d].h = h /\ draft[d][f] = dr[f]))

-----------------------------------------------------------------------------
(* Environment *)

UserSave(d, f) ==
  /\ ~quiescent /\ envBudget > 0 /\ f \in Owner[d]
  /\ LET v == nextVal IN
     /\ live'      = [live EXCEPT ![d][f] = v]
     /\ authorOf'  = [authorOf EXCEPT ![v] = d]
     /\ seenBy'    = [seenBy EXCEPT ![v] = @ \cup {d}]
     /\ lastSaved' = [lastSaved EXCEPT ![d][f] = v]
     /\ nextVal'   = v + 1
     /\ envBudget' = envBudget - 1
  /\ UNCHANGED <<gh, quiescent, ckpt, draft, cflag, phase, plan, cands, cur, target, done, recovery,
                 everOnMain, removed, viol>>

\* Another ordinary Git client commits on main: a fresh value or a revert to a historical value.
ExternalPublish(f) ==
  /\ AllowExternal /\ ~quiescent /\ envBudget > 0 /\ Free # {}
  /\ \E v \in ({nextVal} \cup {Tree(c)[f] : c \in Anc(head)}) \ {Tree(head)[f]} :
       LET c == Alloc
           t == [Tree(head) EXCEPT ![f] = v]
       IN /\ commit'     = [commit EXCEPT ![c] = [parent |-> head, tree |-> t, author |-> "ext", status |-> "accepted"]]
          /\ head'       = c
          /\ everOnMain' = everOnMain \cup {v}
          /\ IF v = nextVal
               THEN nextVal' = v + 1 /\ authorOf' = [authorOf EXCEPT ![v] = "ext"]
               ELSE UNCHANGED <<nextVal, authorOf>>
          /\ envBudget'  = envBudget - 1
  /\ UNCHANGED <<lost, quiescent, dev, seenBy, lastSaved, removed, viol>>

\* Owner rewinds main to an earlier commit (force-push / reset).
Rewind ==
  /\ AllowRewind /\ ~quiescent /\ envBudget > 0
  /\ \E c \in Anc(head) \ {head} :
       /\ head'    = c
       /\ removed' = removed \cup (Anc(head) \ Anc(c))
  /\ envBudget' = envBudget - 1
  /\ UNCHANGED <<commit, lost, nextVal, quiescent, dev,
                 authorOf, seenBy, lastSaved, everOnMain, viol>>

\* Device restarts.  Only volatile knowledge is lost: an in-flight response and
\* (negative control) an unjournaled application batch.
Crash(d) ==
  /\ ~quiescent /\ envBudget > 0
  /\ phase[d] \in {"Publishing", "Applying"}
  /\ IF phase[d] = "Publishing"
       THEN phase' = [phase EXCEPT ![d] = "Unknown"] /\ UNCHANGED done
       ELSE IF NC_NoApplyJournal
            THEN /\ phase' = [phase EXCEPT ![d] = "Idle"]
                 /\ done'  = [done EXCEPT ![d] = {}]
            ELSE UNCHANGED <<phase, done>>
  /\ envBudget' = envBudget - 1
  /\ UNCHANGED <<gh, nextVal, quiescent, live, ckpt, draft, cflag, plan, cands, cur, target, recovery, ghost>>

\* The response to the current publication request will never arrive.
LoseResponse(d) ==
  /\ ~quiescent /\ envBudget > 0
  /\ phase[d] = "Publishing" /\ cur[d] \notin lost
  /\ lost'      = lost \cup {cur[d]}
  /\ envBudget' = envBudget - 1
  /\ UNCHANGED <<head, commit, nextVal, quiescent, dev, ghost>>

GoQuiescent ==
  /\ AllowQuiescence /\ ~quiescent
  /\ quiescent' = TRUE
  /\ UNCHANGED <<gh, nextVal, envBudget, dev, ghost>>

-----------------------------------------------------------------------------
(* GitHub processes a publication request: exact compare-and-swap on main. *)

Process(c) ==
  /\ c \in Created /\ commit[c].status = "inflight"
  /\ LET ok == IF NC_FastForwardRef THEN head \in Anc(c) ELSE head = commit[c].parent
     IN IF ok
          THEN /\ head'       = c
               /\ commit'     = [commit EXCEPT ![c].status = "accepted"]
               /\ everOnMain' = everOnMain \cup TreeValues(c)
          ELSE /\ commit' = IF c \in AllCands THEN [commit EXCEPT ![c].status = "rejected"]
                                             ELSE [commit EXCEPT ![c] = Unused]   \* nobody waits for it
               /\ UNCHANGED <<head, everOnMain>>
  /\ UNCHANGED <<lost, env, dev, authorOf, seenBy, lastSaved, removed, viol>>

-----------------------------------------------------------------------------
(* Device: candidate creation (shared by Sync, PublishResolved, Reconcile) *)

\* Build candidate commit with parent h and tree t; dr is the draft snapshot it carries.
CreateCandidate(d, h, t, dr) ==
  /\ Free # {}
  /\ LET c       == Alloc
         changed == {f \in Files : t[f] # Tree(h)[f]}
     IN /\ commit'     = [commit EXCEPT ![c] = [parent |-> h, tree |-> t, author |-> d, status |-> "inflight"]]
        /\ cands'      = [cands EXCEPT ![d] = @ \cup {c}]
        /\ cur'        = [cur EXCEPT ![d] = c]
        /\ phase'      = [phase EXCEPT ![d] = "Publishing"]
        /\ viol'       = viol
                         \cup (IF AllowRewind /\ phase[d] = "Unknown" THEN {"uncertainRetry"} ELSE {})
                         \cup (IF \E f \in changed : d \notin seenBy[Tree(h)[f]] THEN {"blind"} ELSE {})
                         \cup (IF \E f \in changed : authorOf[t[f]] # d THEN {"unauthored"} ELSE {})
        /\ IF NC_OptimisticCheckpoint
             THEN ckpt' = [ckpt EXCEPT ![d] = c] /\ draft' = [draft EXCEPT ![d] = [f \in Files |-> NoVal]]
             ELSE ckpt' = ckpt /\ draft' = [draft EXCEPT ![d] = dr]

StartApply(d, t) ==
  /\ phase'  = [phase EXCEPT ![d] = "Applying"]
  /\ target' = [target EXCEPT ![d] = t]
  /\ done'   = [done EXCEPT ![d] = {}]

-----------------------------------------------------------------------------
(* Device: one synchronisation transaction, steps 1-5 of the proposal. *)
(* Capture saved changes durably, read main once, three-way compare,     *)
(* then either apply, publish, pause for decisions, or pause on rewind.  *)

Sync(d) ==
  /\ phase[d] = "Idle"
  /\ LET H    == head
         nd   == NewDraft(d)
         lc   == {f \in Files : nd[f] # NoVal}
         conf == ConflictSet(d, H, nd)
     IN
     IF ckpt[d] \notin Anc(H) THEN
        \* history moved: never treat a reset as an ordinary mass update
        /\ phase' = [phase EXCEPT ![d] = "Paused"]
        /\ draft' = [draft EXCEPT ![d] = nd]
        /\ UNCHANGED <<gh, plan, cands, cur, target, done, ckpt, viol>>
     ELSE IF conf # {} THEN
        /\ phase' = [phase EXCEPT ![d] = "Resolving"]
        /\ draft' = [draft EXCEPT ![d] = nd]
        /\ plan'  = [plan EXCEPT ![d] = [h |-> H, dec |-> [f \in Files |->
                        IF f \in conf /\ Reusable(d, f, H, nd) THEN plan[d].dec[f] ELSE "none"]]]
        /\ UNCHANGED <<gh, cands, cur, target, done, ckpt, viol>>
     ELSE IF lc = {} THEN
        /\ H # ckpt[d]
        /\ StartApply(d, H)
        /\ draft' = [draft EXCEPT ![d] = nd]
        /\ UNCHANGED <<gh, plan, cands, cur, ckpt, viol>>
     ELSE
        /\ CreateCandidate(d, H, [f \in Files |-> IF nd[f] # NoVal THEN nd[f] ELSE Tree(H)[f]], nd)
        /\ UNCHANGED <<head, lost, plan, target, done>>
  /\ UNCHANGED <<env, live, cflag, recovery, authorOf, seenBy, lastSaved, everOnMain, removed>>

\* The user decides one conflicted file.  The GitHub version is shown.
Resolve(d, f, choice) ==
  /\ phase[d] = "Resolving"
  /\ f \in ConflictSet(d, plan[d].h, draft[d])
  /\ plan[d].dec[f] = "none"
  /\ plan'     = [plan EXCEPT ![d].dec[f] = choice]
  /\ seenBy'   = [seenBy EXCEPT ![Tree(plan[d].h)[f]] = @ \cup {d}]
  /\ recovery' = IF choice = "github" /\ ~NC_DiscardOnUseGitHub
                   THEN [recovery EXCEPT ![d] = @ \cup {draft[d][f]}]
                   ELSE recovery
  /\ UNCHANGED <<gh, env, live, ckpt, draft, cflag, phase, cands, cur, target, done,
                 authorOf, lastSaved, everOnMain, removed, viol>>

\* All decisions made: publish the resolved batch against the exact remote commit it was decided on.
PublishResolved(d) ==
  /\ phase[d] = "Resolving"
  /\ LET h    == plan[d].h
         conf == ConflictSet(d, h, draft[d])
         t    == [f \in Files |->
                    IF draft[d][f] = NoVal THEN Tree(h)[f]
                    ELSE IF f \in conf /\ plan[d].dec[f] = "github" THEN Tree(h)[f]
                    ELSE draft[d][f]]
     IN /\ \A f \in conf : plan[d].dec[f] # "none"
        /\ IF t = Tree(h)
             THEN /\ StartApply(d, h)
                  /\ UNCHANGED <<gh, ckpt, draft, cands, cur, viol>>
             ELSE /\ CreateCandidate(d, h, t, draft[d])
                  /\ UNCHANGED <<head, lost, target, done>>
  /\ UNCHANGED <<env, live, cflag, plan, recovery, authorOf, seenBy, lastSaved, everOnMain, removed>>

\* Publication outcome delivered.
Receive(d) ==
  /\ phase[d] = "Publishing"
  /\ commit[cur[d]].status # "inflight"
  /\ cur[d] \notin lost
  /\ IF commit[cur[d]].status = "accepted"
       THEN /\ StartApply(d, cur[d])
            /\ cands'  = [cands EXCEPT ![d] = {}]
            /\ commit' = Dropped(commit, cands[d])
       ELSE IF cands[d] = {cur[d]} \/ NC_ForgetSiblings
       \* HeadMoved on the operation's only candidate: reread main and retry
       THEN /\ phase'  = [phase EXCEPT ![d] = "Idle"]
            /\ cands'  = [cands EXCEPT ![d] = {}]
            /\ commit' = Dropped(commit, cands[d])
            /\ UNCHANGED <<target, done>>
       \* HeadMoved on a re-issued candidate says nothing about its siblings:
       \* an earlier candidate may have been accepted (model finding F1)
       ELSE /\ phase' = [phase EXCEPT ![d] = "Unknown"]
            /\ UNCHANGED <<cands, target, done, commit>>
  /\ UNCHANGED <<head, lost, env, live, ckpt, draft, cflag, plan, cur, recovery, ghost>>

\* No response: outcome unknown.  While the environment is active a request
\* may also just be slow (counts as an environment event).
Timeout(d) ==
  /\ phase[d] = "Publishing"
  /\ \/ cur[d] \in lost /\ UNCHANGED envBudget
     \/ commit[cur[d]].status = "inflight" /\ ~quiescent /\ envBudget > 0 /\ envBudget' = envBudget - 1
  /\ phase' = [phase EXCEPT ![d] = "Unknown"]
  /\ UNCHANGED <<gh, nextVal, quiescent, live, ckpt, draft, cflag, plan, cands, cur, target, done, recovery, ghost>>

\* Unknown outcome: reread main and classify by ancestry, never by error text.
Reconcile(d) ==
  /\ phase[d] = "Unknown"
  /\ LET D == head
         H == commit[cur[d]].parent
         won == {c \in cands[d] : c \in Anc(D)}
     IN
     IF AllowRewind /\ won = {} /\ ~NC_ReplayOnUnknown THEN
        \* Absence from current ancestry is not evidence of non-acceptance if
        \* history can rewind, even when D = H. Retain the operation indefinitely;
        \* explicit recovery from Held is outside this baseline's liveness scope.
        /\ phase' = [phase EXCEPT ![d] = "Held"]
        /\ UNCHANGED <<gh, ckpt, draft, cands, cur, target, done, viol>>
     ELSE IF ckpt[d] \notin Anc(D) THEN
        /\ phase' = [phase EXCEPT ![d] = "Paused"]
        /\ UNCHANGED <<gh, ckpt, draft, cands, cur, target, done, viol>>
     ELSE IF won # {} /\ ~NC_ReplayOnUnknown THEN
        \* a candidate is an ancestor of main: publication succeeded; recover it first,
        \* a later Sync reconciles whatever D changed afterwards (including reverts)
        /\ StartApply(d, CHOOSE c \in won : TRUE)
        /\ cands'  = [cands EXCEPT ![d] = {}]
        /\ commit' = Dropped(commit, cands[d])
        /\ UNCHANGED <<head, lost, ckpt, draft, cur, viol>>
     ELSE IF D = H THEN
        \* inconclusive: main unchanged, request may still be in flight. Issue a new
        \* candidate on the same exact head; the compare-and-swap lets at most one win.
        /\ CreateCandidate(d, H, Tree(cur[d]), draft[d])
        /\ UNCHANGED <<head, lost, target, done>>
     ELSE
        \* In the no-rewind model only: main moved and no candidate is in its history.
        /\ phase'  = [phase EXCEPT ![d] = "Idle"]
        /\ cands'  = [cands EXCEPT ![d] = {}]
        /\ commit' = Dropped(commit, cands[d])
        /\ UNCHANGED <<head, lost, ckpt, draft, cur, target, done, viol>>
  /\ UNCHANGED <<env, live, cflag, plan, recovery, authorOf, seenBy, lastSaved, everOnMain, removed>>

\* Guarded, journaled application of one file of the target commit.
ApplyFile(d, f) ==
  /\ phase[d] = "Applying"
  /\ f \notin done[d]
  /\ LET T        == target[d]
         expected == IF draft[d][f] # NoVal THEN draft[d][f] ELSE Base(d)[f]
         tv       == Tree(T)[f]
     IN IF live[d][f] = expected \/ NC_NoApplyGuard
          THEN /\ live'   = [live EXCEPT ![d][f] = tv]
               /\ seenBy' = [seenBy EXCEPT ![tv] = @ \cup {d}]
               /\ UNCHANGED <<draft, cflag>>
          ELSE \* the user saved again during the request: keep it as a newer draft.
               \* If the target also changed this file, that draft needs a decision.
               /\ draft' = [draft EXCEPT ![d][f] = live[d][f]]
               /\ cflag' = IF tv # expected /\ ~NC_SilentNewDraft
                             THEN [cflag EXCEPT ![d][f] = TRUE] ELSE cflag
               /\ UNCHANGED <<live, seenBy>>
  /\ done' = [done EXCEPT ![d] = @ \cup {f}]
  /\ ckpt' = IF NC_PartialCheckpoint THEN [ckpt EXCEPT ![d] = target[d]] ELSE ckpt
  /\ UNCHANGED <<gh, env, phase, plan, cands, cur, target, recovery,
                 authorOf, lastSaved, everOnMain, removed, viol>>

\* Every path accounted for: advance the coherent checkpoint, release committed drafts.
Finish(d) ==
  /\ phase[d] = "Applying"
  /\ done[d] = Files
  /\ LET T == target[d] IN
     /\ ckpt'  = [ckpt EXCEPT ![d] = T]
     /\ draft' = [draft EXCEPT ![d] = [f \in Files |-> IF live[d][f] = Tree(T)[f] THEN NoVal ELSE draft[d][f]]]
     /\ cflag' = [cflag EXCEPT ![d] = [f \in Files |-> IF live[d][f] = Tree(T)[f] THEN FALSE ELSE cflag[d][f]]]
  /\ phase' = [phase EXCEPT ![d] = "Idle"]
  /\ plan'  = [plan EXCEPT ![d] = NoPlan]
  /\ done'  = [done EXCEPT ![d] = {}]
  /\ UNCHANGED <<gh, env, live, cands, cur, target, recovery, ghost>>

\* Explicit adoption of a rewritten branch: keep drafts relative to the old
\* checkpoint, keep a recovery copy of anything the new head does not contain,
\* and require a decision before publishing a draft over an unseen remote value.
Adopt(d) ==
  /\ phase[d] = "Paused"
  /\ ckpt[d] \in Created
  /\ LET H  == head
         ob == Base(d)
         keep == {f \in Files : live[d][f] # ob[f]}
     IN /\ ckpt'     = [ckpt EXCEPT ![d] = H]
        /\ live'     = [live EXCEPT ![d] = [f \in Files |-> IF f \in keep THEN live[d][f] ELSE Tree(H)[f]]]
        /\ recovery' = [recovery EXCEPT ![d] = @ \cup {live[d][f] : f \in {g \in Files : live[d][g] # Tree(H)[g]}}]
        /\ draft'    = [draft EXCEPT ![d] = [f \in Files |-> IF f \in keep THEN live[d][f] ELSE NoVal]]
        /\ cflag'    = [cflag EXCEPT ![d] = [f \in Files |-> f \in keep /\ Tree(H)[f] # ob[f]]]
        /\ seenBy'   = [v \in Values |-> IF \E f \in Files \ keep : Tree(H)[f] = v THEN seenBy[v] \cup {d} ELSE seenBy[v]]
  /\ phase' = [phase EXCEPT ![d] = "Idle"]
  /\ plan'  = [plan EXCEPT ![d] = NoPlan]
  /\ cands' = [cands EXCEPT ![d] = {}]
  /\ UNCHANGED <<gh, env, cur, target, done, authorOf, lastSaved, everOnMain, removed, viol>>

-----------------------------------------------------------------------------

DeviceStep(d) ==
  \/ Sync(d) \/ PublishResolved(d) \/ Receive(d) \/ Timeout(d) \/ Reconcile(d) \/ Finish(d) \/ Adopt(d)
  \/ \E f \in Files : ApplyFile(d, f)
  \/ \E f \in Files, ch \in {"mine", "github"} : Resolve(d, f, ch)

EnvStep ==
  \/ \E d \in Devices, f \in Files : UserSave(d, f)
  \/ \E f \in Files : ExternalPublish(f)
  \/ \E d \in Devices : Crash(d) \/ LoseResponse(d)
  \/ Rewind
  \/ GoQuiescent

Next ==
  \/ EnvStep
  \/ \E c \in CommitIds : Process(c)
  \/ \E d \in Devices : DeviceStep(d)

Init ==
  /\ head       = 0
  /\ commit     = [c \in CommitIds |-> IF c = 0 THEN [Unused EXCEPT !.author = "init", !.status = "accepted"] ELSE Unused]
  /\ lost       = {}
  /\ nextVal    = 1
  /\ envBudget  = MaxEnv
  /\ quiescent  = FALSE
  /\ live       = [d \in Devices |-> [f \in Files |-> 0]]
  /\ ckpt       = [d \in Devices |-> 0]
  /\ draft      = [d \in Devices |-> [f \in Files |-> NoVal]]
  /\ cflag      = [d \in Devices |-> [f \in Files |-> FALSE]]
  /\ phase      = [d \in Devices |-> "Idle"]
  /\ plan       = [d \in Devices |-> NoPlan]
  /\ cands      = [d \in Devices |-> {}]
  /\ cur        = [d \in Devices |-> 0]
  /\ target     = [d \in Devices |-> 0]
  /\ done       = [d \in Devices |-> {}]
  /\ recovery   = [d \in Devices |-> {}]
  /\ authorOf   = [v \in Values |-> IF v = 0 THEN "init" ELSE "none"]
  /\ seenBy     = [v \in Values |-> IF v = 0 THEN Devices ELSE {}]
  /\ lastSaved  = [d \in Devices |-> [f \in Files |-> NoVal]]
  /\ everOnMain = {0}
  /\ removed    = {}
  /\ viol       = {}

Fairness ==
  /\ \A d \in Devices : WF_vars(DeviceStep(d))
  /\ WF_vars(\E c \in CommitIds : Process(c))

Spec     == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
  /\ head \in Created
  /\ nextVal \in 1..(MaxEnv + 1)
  /\ \A d \in Devices :
       /\ phase[d] \in Phases
       /\ ckpt[d] \in Created
       /\ \A f \in Files : live[d][f] \in Values /\ draft[d][f] \in Values \cup {NoVal}
       /\ cands[d] \subseteq Created
       /\ plan[d].h \in Created

\* The commit-object bound is a finiteness device only; a free slot must always remain
\* so that no publication is ever cut off by the bound.
CommitBoundSlack == Free # {}

\* Values that are committed on main right now.
Committed(f) == {Tree(c)[f] : c \in Anc(head)}

\* Committed-only shared data, part 1: a checkpoint is always a commit on main.
CheckpointPublished == \A d \in Devices : ckpt[d] \in Anc(head)
\* (variant for the rewind model: between a rewind and adoption the checkpoint may have been removed)
CheckpointEverPublished == \A d \in Devices : commit[ckpt[d]].status = "accepted"

\* Committed-only shared data, part 2: a device only ever holds content that is on
\* main or that its own user typed.  Nothing uploaded-but-unpublished leaks in.
LiveIsCommittedOrOwn ==
  \A d \in Devices, f \in Files : live[d][f] \in Committed(f) \/ authorOf[live[d][f]] = d
LiveIsCommittedOrOwnEver ==
  \A d \in Devices, f \in Files : live[d][f] \in everOnMain \/ authorOf[live[d][f]] = d

\* The checkpoint is coherent: outside an application batch every live file is
\* either exactly the checkpoint's content or the local user's own edit.
BaseCoherent ==
  \A d \in Devices : phase[d] # "Applying" =>
    \A f \in Files : live[d][f] = Base(d)[f] \/ authorOf[live[d][f]] = d

\* Captured edits are preserved: the latest value the user saved is on main,
\* still live, held as a captured draft, or kept by an explicit decision.
CapturedEditsPreserved ==
  \A d \in Devices, f \in Files :
    LET v == lastSaved[d][f] IN
      \/ v = NoVal
      \/ v \in Committed(f)
      \/ live[d][f] = v
      \/ draft[d][f] = v
      \/ v \in recovery[d]

\* Rewind variant.  An owner rewind can remove a committed value from main after the
\* device has correctly followed main past it; the device is not a backup of main's
\* history.  So here "committed" means: was on main at some time.
CapturedEditsPreservedEver ==
  \A d \in Devices, f \in Files :
    LET v == lastSaved[d][f] IN
      \/ v = NoVal
      \/ v \in everOnMain
      \/ live[d][f] = v
      \/ draft[d][f] = v
      \/ v \in recovery[d]

\* A device never changes a file on main away from a value its user has not seen.
NoBlindOverwrite    == "blind" \notin viol
\* A device only ever introduces values its own user authored.
NoUnauthoredChange  == "unauthored" \notin viol
\* A draft is on main at most once: no two device commits in main's history introduce
\* the same value (a re-issued candidate after an unknown outcome must not land twice,
\* and a draft must not be replayed over a later revert).  Structural, no ghost state.
Introduced(c) == {Tree(c)[f] : f \in ChangedFiles(c)}
NoReplay ==
  \A c1, c2 \in Anc(head) :
    (c1 # c2 /\ commit[c1].author \in Devices /\ commit[c2].author \in Devices)
      => Introduced(c1) \cap Introduced(c2) = {}
\* Commits an owner removed from main never silently return.
NoResurrection      == removed \cap Anc(head) = {}
\* A rewind-capable repository cannot safely retry an unconfirmed publication.
NoUncertainRetry    == "uncertainRetry" \notin viol
HeldHasCandidates   == \A d \in Devices : phase[d] = "Held" => cands[d] # {}
\* Devices editing disjoint files never need a conflict decision.
NeverResolving      == \A d \in Devices : phase[d] # "Resolving"

Symm == Permutations(Devices) \cup Permutations(Files)

\* Model-specific owner map for the independent-file check (d1 edits f1 only, d2 edits f2 only).
\* Instantiated by MCIndependent; kept here so one module holds every operator the configs use.

-----------------------------------------------------------------------------
(* Liveness *)

Converged ==
  \A d \in Devices :
    /\ phase[d] = "Idle"
    /\ ckpt[d]  = head
    /\ \A f \in Files : live[d][f] = Tree(head)[f] /\ draft[d][f] = NoVal

\* Once the environment stops, both devices converge to main without further input
\* beyond conflict decisions (which are fair device steps).
Convergence == [](quiescent => <>Converged)

=============================================================================
