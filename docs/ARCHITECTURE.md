# Atelier Architecture

One zero-dependency node process serving a loopback web cockpit + a CLI,
over N registered project repos. Born from the Moss "moss-board" seed after
a bake-off against Vibe Kanban (verdict: absorb VK's UX traits, keep our
structural advantages - single tracker store, per-repo permission posture,
exact cost, headless parity, no cloud).

`MCP client -- stdio JSON-RPC --> atelier mcp -- loopback fetch --> running Atelier service`

## Modules

- bin/atelier.mjs - CLI: init | serve | mcp | projects | track | move-tracker |
  dispatch | reply | plan | logs | doctor. `doctor
  --gc` explicitly dismisses old terminal dispatches and sweeps orphan Atelier
  worktree directories; boot never performs this destructive cleanup. The
  dispatch command uses the SAME code path as POST /api/dispatch (headless
  parity is a feature, not an accident). `atelier reply` uses the running
  loopback server's `POST /api/dispatch/:id/reply` route (port 5170, or `PORT`)
  so it never opens a competing dispatcher over live state; `--follow` resumes
  the dispatch SSE stream after the reply boundary.
- server/server.mjs - http router, static UI, SSE endpoints. Loopback only. At
  server construction it reads every explicitly allowlisted UI asset into one
  immutable boot snapshot, so a checkout update cannot mix new browser modules
  with an older running process; newly deployed UI appears after restart.
- server/lib/
  - mcp.mjs - zero-dependency MCP stdio bridge. It advertises the frozen tool
    set and proxies every operation to the running loopback API; it owns no
    dispatcher state.
  - parity.mjs - shared agent/UI capability manifest binding the HTTP routes,
    MCP tool inventory, and safety annotations into one checked contract.
  - themes.mjs - validates first-party `themes/<id>/manifest.json` bundles and
    snapshots their entry modules, assets, and vendored dependencies at boot.
    The theme inventory is served at `GET /api/themes`; bundle assets stay under
    `/themes/<id>/`. Theme mutations carry a bounded `theme:<id>` actor label,
    but that validation is syntactic attribution, not caller authentication or
    proof that the named theme originated the request.
  - world-contract.mjs - the single public five-gate record projection, the
    authoritative open/dependency-clear/unparked ready-issue projection, plus
    bounded per-project merged-work chronicles, outcome-derived scorecard
    summaries, and the bounded cross-project chronicle at `GET /api/chronicle`.
    Chronicles are captured from the server's boot record snapshot and remain
    frozen until restart. Their `generatedAt` boot timestamp is the freshness
    contract; a project registered after boot receives an empty per-project
    snapshot and remains absent from the aggregate until the next restart.
  - http.mjs, exec.mjs - the seed's verified security core (see
    SECURITY.md), plus spawnTracked/killTracked (process-group lifecycle)
    and envHygiene.
  - event-log.mjs - the structured operational event log (atelier-e5x): one
    append-only JSONL line per consequential decision under
    ~/.local/state/atelier/logs/, size-rotated, redacted at WRITE time through
    stream.mjs's shared value redactor. Three properties it owes its callers:
    `append` is total (it cannot fail a dispatch), it never persists a secret,
    and followers advance a BYTE cursor (`tail` then `poll`) so every appended
    byte is delivered exactly once across rotation. Its writer API is not
    server-internal - `append(kind, payload, { source })` defaults source to
    "server" and the schema carries `v` - so Track B's per-dispatch hook events
    are an additive change.
  - paths.mjs - XDG config/state dirs (win32 equivalents).
  - registry.mjs - projects.json load + exhaustive validation (REGISTRY.md).
  - capabilities.mjs - per-project probe (tracker presence + declared-vs-
    detected, agent docs, branch/dirty/worktrees), onboarding inference, and
    a 60s cache. Tracker-only probes skip Git.
  - tracker.mjs - br wrappers: cwd = the configured tracker directory
    (`trackerPath`, defaulting to the project primary checkout). This supports
    full projects with Atelier-owned external trackers while keeping every br
    call out of dispatch worktrees (worktree writes strand - founding lesson).
  - tracker-move.mjs - reversible `.beads` relocation for full projects:
    rename or verified cross-device copy, atomic registry switch, post-move
    `br ready`, and compensating filesystem/registry rollback on smoke failure.
    It never invokes Git.
  - agents/ - pluggable harness adapters for lane policy, composer choices,
    pre-launch checks, launch/stream wiring, and stop behavior. The frozen
    contract and one-file registration recipe are documented in
    [AGENTS-ADAPTERS.md](AGENTS-ADAPTERS.md).
  - dispatch.mjs - the VK-absorption core. Lifecycle: queued -> preparing
    (worktree add -b atelier/<slug>-<id> from the CLEAN mainBranch, under
    ~/.local/state/atelier/worktrees/, never inside/basing on a dirty
    primary; dirty-primary warning surfaced) -> running (the selected adapter
    launches in the worktree; Claude streams NDJSON and Codex uses companion
    background-job polling, with complete prompts delivered through Atelier-owned
    state files rather than size-limited argv) ->
    completed|completed_empty|needs_input|failed|stopped.
    A successful turn is classified before it is verified: an empty committed diff
    with a question-shaped final message becomes `needs_input`, an empty diff
    without one becomes `completed_empty`, and a question on top of real changes
    stays `completed` with a warning (see the state diagram below). A reply to a
    terminal resumable dispatch follows
    completed|completed_empty|needs_input|failed|stopped -> resuming -> running
    and then the normal verification/completion path again. A reply to a running
    live-input adapter stays running and is written directly to its stdin.
    New ticket attempts receive redacted, tail-bounded context for every prior
    terminal attempt, including its lane/model, outcome, surviving branch, and
    Atelier-authored salvage or completion commit when one can be identified.
    Merge, reply, dismiss, stop, and review startup share one per-dispatch
    lifecycle reservation. Stop preserves user intent when it meets a reply:
    it waits for resume startup to finish and then stops the resumed child;
    when stop owns the reservation first, competing lifecycle actions are
    refused with `dispatch is being stopped`.
    Opt-in Claude plan-preview uses the same isolated worktree and resumable
    session, but its first run is read-only and pauses in `plan_ready`; approval
    resumes with the full project tools, while revision resumes read-only and
    returns to the pause. A completed dispatch can launch a linked read-only
    spec-audit dispatch whose prompt contains the target diff plus either the
    ticket description or the persisted standalone prompt. Claude receives the
    CLI's strongest no-tools posture plus deny patterns (a documented
    best-effort boundary), while Codex uses its true read-only sandbox. Its
    parsed PASS/FAIL verdict is stored on the target as the current member of an
    append-only round history; each round also records its audited HEAD, time, and
    mechanically counted contract finding lines. Finding extraction consumes the
    complete captured agent result before the bounded `exitSummary` projection can
    truncate it. The cockpit renders the resulting
    FAIL → FAIL → PASS trajectory instead of flattening it to the last verdict.
    Opt-in `requireReview` applies the per-project `reviewPolicy`: `strict`
    (default) gates on every open finding, `tiered` permits only MINOR/NIT and
    files one linked follow-up ticket per finding, and `advisory` treats non-blocker
    findings as report-only. A bare accepted disposition remains open; only
    refuted, redirected, and waived dispositions neutralize a finding under any
    policy. Normal tiered filing requires a source ticket, a configured tracker,
    and a linked review dispatch; absent those, clients hold ordinary merge
    eligibility and the dashboard exposes audited force merge. Tiered follow-up
    debt is persisted in the same record image as the merge result before
    worktree or branch deletion, retried three times in-process,
    recovered again at boot, and remains visible in doctor GC output until its
    tracker link is auto-committed when configured. BLOCKER always gates unless
    an audited force merge is used. Each untagged location line or finding bullet
    (`-`, `*`, `+`, numeric ordered-list markers, or common Unicode bullets)
    in both FAIL and PASS outputs becomes its own synthetic MAJOR finding; a
    malformed tagged line, including one with punctuation after its bracket,
    keeps its severity with a null location without discarding valid sibling
    findings; contradictory PASS/FAIL output is malformed. Capture exposes at
    most 10 structured findings
    and a `findingCount` of at most 10; overflow sets `findingsTruncated`, retains
    the first 10 entries, and durably carries every later finding line into one
    lossless follow-up ticket per finding. Ordered overflow
    severities plus per-severity counts let the shared review assessment include
    every omitted finding in gates, client eligibility, and statistics; an omitted
    BLOCKER therefore stays gated everywhere. Finding paths are capped at 500
    characters and finding
    summaries at 1,000, while the round summary and findings text remain capped at
    2,000 and 4,000 respectively; every shortened string ends in
    `...[truncated]`. A re-raised redirect is open/new only when its
    summary appends `— NEW EVIDENCE: <specific code or behavior changed since
    redirect>`; otherwise it remains excluded as `redirect-disputed` only while
    the original redirect is still current. A later acceptance of the disputed
    finding, or a superseding acceptance of that original redirect, reopens it.
    Matching identity is the normalized file, 10-line band, and a bounded
    normalized first-sentence prefix. A period ends that prefix only when
    followed by whitespace and an uppercase letter, so abbreviations and file
    extensions remain identity-bearing; commas and semicolons do too.
    Severity-aware trajectory parking runs even before any disposition exists;
    only opaque finding lists use count fallback.
    A redirect must name an existing tracker ticket other than the source ticket;
    its disposition stores both the carrier project and ticket id, and
    redirected-in work prevents only that project-scoped sole carrier from being
    auto-closed. Merge and disposition writes share the dispatch lifecycle
    reservation, so merge eligibility cannot outlive a concurrent disposition change.
    The pure `shared/review-assessment.mjs` module is the sole finding-set,
    lineage-disposition, gate-state, and policy assessment implementation used by
    dispatch merge, the World Contract, the dashboard, and first-party themes.
    Ready-queue launches also carry an unattended-work
    rule - never end on a clarifying question; take the smallest reasonable
    interpretation, state the assumption, and proceed - which operator-launched and
    review dispatches deliberately do not get, because a human is there to answer.
    A queue-launched dispatch that completes with a
    passing verification automatically starts that linked review, and boot recovery
    idempotently starts one if a restart interrupted the completion-to-review handoff.
    The target link is persisted before review preparation begins. While that linked
    review is active, replies to the target are refused so its audited diff cannot
    change underneath the merge gate. After settlement, a fix reply retains the
    completed round and permits another audit only while finding counts strictly
    shrink. A mechanically contradicted implementation handoff parks immediately;
    a non-shrinking round parks from round two; and a still-shrinking thread parks
    only after its `maxFixRounds` backstop (default four). Parking refuses further
    fix replies, releases the tracker claim through the ticket-wide fencing gate,
    and posts the bounded last findings, reason, and branch/HEAD salvage pointer
    for a fresh dispatch. The contradiction check is deliberately only a tripwire
    for blatant direct claims that conflict with Atelier's recorded verification or
    merge ancestry; it is not a lie detector. Quoted/reported claims are ignored,
    missing evidence produces a warning and skips that check, and paraphrase
    evasion remains an accepted residual risk.
    Each review persists the exact target branch HEAD it audited. Reply completion or
    boot recovery treats older-HEAD verdicts as stale, and merge accepts PASS only when
    that reviewed HEAD still equals the target branch tip. Review creation is serialized
    per target across manual and automatic callers.
    Review dispatches
    remain outside ready-queue project occupancy and its global capacity accounting,
    and their cost is excluded from the ready queue's USD budget gate (while remaining
    visible in cost rollups). Reviews on adapters without trustworthy cost reporting do
    consume the separate daily unpriced-dispatch count, preventing that fallback from
    being bypassed. Otherwise the queue can continue onto independent work while the
    audit runs. Convoys
    persist an operator-ordered ticket list and
    dispatch one ordinary, batch-tagged member at a time; only a successful
    merge advances the cursor, while failed, stopped, or dismissed-unmerged
    members pause the batch for explicit resume or cancel. An opt-in bake-off
    creates one ordinary dispatch per selected lane with a shared batch id,
    but distinct branches and worktrees. The batch claims its ticket once;
    failures release that claim only after no viable sibling remains, while a
    merged winner retains it and permanently excludes sibling merges. At exit:
    stranded-br-writes check (worktree .beads vs configured tracker), then a
    pre-verification Atelier commit for adapters that declare they cannot commit
    their own work, with turns + costUSD recorded. Adapters that cannot report
    trustworthy cost can instead be bounded by a per-project daily dispatch
    count. Billing remains subscription-based and dispatch env strips inherited
    secret-shaped variables, including ANTHROPIC_API_KEY and OPENAI_API_KEY.
    Worktree verification records the exact
    worktree `HEAD` tested (`verify.testedTree`), the main tip seen at that
    moment, and how many main commits the verified branch was behind. Atelier does not merge
    or rebase main into a dispatch before this pass: the command always runs in
    the dispatch worktree. Consequently, a stale-base branch can report fewer
    tests than the current main checkout because newer test files are genuinely
    absent from that tree; this was the source of the observed 232-vs-248 count
    drift, not two executions against the same checkout.
    A COMPLETED dispatch whose verdict FAILED can re-run those same commands in
    its retained worktree, because one flaky suite must not permanently strand a
    dispatch whose only recovery was otherwise a `force` merge that records
    nothing. The re-run is an attempt: `verify.attempt` numbers it, `verify.attempts`
    retains every prior {state, steps, testedTree, mainTip, startedAt, endedAt},
    and `verify.state` keeps mirroring the CURRENT verdict, so a fail-then-pass
    flip stays visible as evidence while the merge gate reads one field as
    before. Records written before attempts existed keep their flat verdict and
    are read as attempt 1. Only a failed verdict is eligible - a passed one is
    not stranded, and `skipped` (a `needs_input`/`completed_empty` outcome,
    `verify: false`, or a project with no commands) never had a suite to re-run.
    The attempt occupies a verification slot exactly like a live verify, taken
    synchronously before its first await, and holds the dispatch's lifecycle
    reservation, so stop/merge/reply/dismiss and a second re-run all refuse with
    an honest 409 while it runs. It performs NO tracker mutation: it neither
    re-claims a released ticket nor un-parks a queue attempt (merging is what
    closes the ticket). An interrupted re-run - restart or shutdown sweep -
    records the attempt as interrupted and restores the terminal state it
    re-verified from, rather than failing the dispatch out of the only state
    merge accepts.
    Non-merged terminal worktrees and branches remain available for review
    until explicit dismissal. Dismissal removes both, tolerates already-gone
    artifacts, releases a held tracker claim, and keeps the append-only history
    record with a dismissed timestamp. Stop during preparation also attempts
    best-effort cleanup of the partially-created artifacts. A dispatch merge
    never imports `.beads` from its branch: Atelier skips the fast-forward path
    when tracker bytes differ, restores `.beads` from the exact pre-merge main
    commit before creating the merge commit, and records a warning when branch
    tracker bytes are discarded. After a merge updates the main ref, Atelier
    returns the merge response without waiting for another test pass, then
    checks that exact merge commit once with the project's `verifyCommands` in a
    detached Atelier-owned worktree. The persisted
    `postMerge` verdict and `post-merge` SSE event include the exact tested tree,
    step results, and a bounded redacted failing-output tail. Checks are FIFO and
    single-flight per project. Each failure remains independently unresolved;
    acknowledgement persists and only mutes its banner until a later commit
    passes. A configured outbound alert carries the same bounded evidence.
  - stream.mjs - claude stream-json NDJSON -> normalized SSE events
    (status/message/usage/exit), tool inputs redacted.
  - groups.mjs - registry groups: unioned boards + fan-out dispatch with a
    shared ticket id. No sync engine by design.
- ui/ - vanilla index.html + app.js + atelier.css (seed tokens). Views:
  per-project board (or degraded git+dispatch view), dispatch composer,
  live dispatch view (SSE transcript, diff tab, stop), all-dispatches
  aggregate (the cross-runtime "where are my agents" answer), group view. The
  built-in dashboard can switch to a discovered first-party world in the same
  page while its persistent top strip keeps the dashboard and command palette
  reachable. Theme entry modules are imported only on first selection and may
  export bounded generation-owned `dispose(generation)` hooks; the host aborts
  in-flight mounts, confirms loss only for contexts recorded as WebGL, removes
  WebGPU/2D/uninitialized canvases without creating a teardown context, and
  clears only that generation's subtree. The
  exported `/theme-lib/theme-stream.mjs` helper owns one aggregate SSE source,
  a bounded LRU per-dispatch pool, and resync-before-delivery reconnects. For this MVP,
  `tier: "render+actions"` is manifest metadata, not an enforced isolation or
  grant boundary; community-theme sandboxing and tier enforcement remain
  explicitly out of scope. Themes are same-page first-party code, so neither
  the actor header nor the manifest tier is a provenance or privilege boundary
  in this MVP. The complete author contract is in [THEMES.md](THEMES.md).

## Notification delivery

Atelier has two notification surfaces. The browser can create desktop
notifications from its existing SSE connection while the cockpit is open. The
dispatcher can also POST redacted, bounded alerts to the optional
`defaults.notifyUrl`; that URL is the pluggable delivery seam and does not
change the loopback-only server bind.

The supported cross-device bridge is a SELF-HOSTED receiver on localhost or an
operator-controlled tailnet. The post-v3 Atelier-native direction is an optional
bundled local notifier for background desktop delivery, with the browser SSE
path retained as the zero-install foreground fallback. Browser Web Push is not
the default: locally generated VAPID keys encrypt payloads but do not remove the
browser push service from the route. The full decision, setup, payload, and
failure semantics are recorded in [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Dispatch state diagram

```text
queued -> preparing -> running -----------------> verifying -> completed
                         |                            |          | merge
                         | plan first                 |          v
                         v                            |        merged metadata
                     plan_ready -- approve ----------+
                         ^
                         | revise (read-only resume)
                         +----------------------------

preparing -> prepare_failed
running|resuming|verifying -> failed|stopped
successful turn, empty diff, question-shaped last message -> needs_input
successful turn, empty diff, no question                  -> completed_empty
completed|completed_empty|needs_input|failed|stopped -> resuming -> running
completed (verify failed) -> verifying -> completed  (explicit verification re-run)
```

`needs_input` and `completed_empty` are the outcomes of a SUCCESSFUL turn that
produced nothing usable, decided before verification runs (a green suite on an
unchanged tree is not evidence). They are separate terminal states rather than
flags on `completed`, so the merge gate and automatic-review gate refuse them by
construction, and the cost rollup counts them in `runs` but in neither `completed`
nor `failed` - the same uncounted treatment `stopped` already gets. Both record
`verify: skipped` with a reason, count as ready-queue non-successes through the
ordinary failure-kind path (park-eligible at the same `queueFailureLimit`), release
the tracker claim exactly like a failure (still behind the unresolved-orphan
fence), and notify with the question rather than a success. Reply/resume is the
answer path: it clears the prior turn's verdict - but only once the resumed turn
genuinely reaches a live child, and reversibly until that child emits `spawn`, so a
resume that dies before spawning still shows the operator what was asked - so an
answered dispatch cannot show `needs_input` beside a fresh
`verify: passed`. The verdict itself is the additive `outcome` record field
(`kind`, `changes`, `finalMessage`, `question`, `answerPath`, `detectedAt`,
`detail`), present on every classified terminal run so "the detector ran and
cleared this" is auditable; it also rides the terminal `status` SSE event.

Detection **fails closed** on both lanes. Each adapter reports its final message
as data - retrieved, or an explicit retrieval failure - and never substitutes a
weaker source: a failed or unparseable Codex companion `result` call is recorded
as a failure instead of falling back to the status snapshot's bounded summary, and
the claude lane classifies from the untruncated `result` text rather than the
head-first display slice. (On the codex lane the classified text is the
companion's `rawOutput` when the result carries one; a result that only carries a
summary is classified from that summary, which the companion may itself have
bounded.) An unretrievable final message is treated as if it had
asked a question, with a warning. The question shape is the trailing block - the
last six non-empty lines - so a question above its option list still counts, while a
`?` inside a line does not. Alongside the question mark (ASCII and full-width) a
small closed list of hand-off phrases counts as asking (`let me know`, `please
choose/confirm/clarify/specify`, and a `which option/approach/one` that opens a
sentence or is followed by a second-person cue); matches inside a quoted span are
ignored, because copy the agent WROTE is not the agent asking. Emptiness is decided
by Git against the dispatch's recorded `baseCommit` (captured at preparation,
re-validated before use, `mainBranch` merge-base for older records), excluding
`.beads`; when Git cannot answer, the record says `changes: unknown` rather than claiming
either side - and
an unknown comparison with no question still records `completed`, because
reclassifying it would be the third gate this design deliberately does not have.

A crash between the terminal transition and queue settlement is repaired at boot:
a persisted terminal record that already has a failure kind but no `queueOutcome`
has its attempt counted, its park accounting applied, and its claim handed back on
the next start, so the window cannot silently swallow a queue attempt. The repair is
idempotent in both directions. It never double-counts: `queue.json` is written
before the record, so a persistence-degraded window can leave the attempt already
counted, and an attempt already naming this dispatch id means only the missing
record-side outcome is rebuilt. And it never double-releases: the claim goes back at
most once per boot per record - the orphan-reap pass owns the release for a record
that still fences a worker (it is the pass that can prove death), a merged or
dismissed record is left alone, and every release still passes
`ticketClaimBlocker`, so a successor or an unproven worker keeps the ticket.

`plan_ready` is a non-terminal pause with no child process. It keeps its
worktree, session, and tracker claim, survives boot recovery unchanged, and is
excluded from the concurrent-process cap. Dispatch public records add only the
optional `plan` object for this flow.

Convoy state is separate from dispatch state: `running` means the batch is
waiting for or operating its current member, `paused` requires an explicit
resume after a member failure, `canceled` leaves any in-flight member alone,
and `completed` means every member merged. Convoy members use the unchanged
dispatch lifecycle and cap, with additive `batchId`, `batchKind`, and
`batchSeq` fields in their public records.

Bake-off state is also represented only by ordinary dispatch records. Siblings
share `batchKind: "bakeoff"` and one `batchId`, but each has its own lane,
branch, worktree, lifecycle, and cap slot. The first successful merge is the
only merge allowed for the batch; unmerged siblings remain available for
comparison and explicit dismissal.

### Server restart survival (atelier-tzw)

A Atelier service restart is lane-asymmetric. The systemd user unit uses
`KillMode=process` (not `mixed` - see
`docs/lessons/killmode-mixed-kills-detached-codex-workers.md`), so systemd
signals only Atelier's own main process and never touches anything else in its
control group. `dispatcher.shutdown()` uses that room to decide per dispatch:
a running codex dispatch with a captured `codexJobId`/`codexWorkspace` is
`detach()`ed (left running, untouched) rather than killed, and the next
boot's `agent.reattach()` polls the same companion job - honoring whatever it
finds (still running, completed while Atelier was down, or dead, verified via
PID + `/proc` start-time identity so a reused PID is never trusted). Every
other active dispatch (claude, or a codex dispatch that had not yet captured
a job) is failed with `exitSummary: "server restart"`; a claude-lane record
with a captured `sessionId` and worktree is additionally marked
`restartResumeReady: true`, surfaced in the record/UI/MCP as "Resume after
restart" - the same `reply()`-resume path used for any other terminal dispatch,
except it first re-claims the dispatch's tracker ticket (released at
shutdown) and refuses on conflict rather than resuming unclaimed.

**Fencing, and the unresolved-orphan state.** An unclean death (SIGKILL, OOM,
crash) runs no sweep at all, so every child is left behind. **Every process Atelier
spawns that can outlive it carries a fence** - a persisted pid plus the `/proc`
start-time identity that proves the pid was never recycled. There are four such
pairs on a record, and they are one vocabulary (`FENCING_FIELDS`), not four
schemes:

| pair | process | spawned by |
|---|---|---|
| `childPid`/`childPidIdentity` | the claude lane's direct child | dispatch/resume |
| `codexWorkerPid`/`codexWorkerPidIdentity` | the codex companion worker | dispatch/resume |
| `verifyPid`/`verifyPidIdentity` | the verification runner | first-run verify **and** explicit re-run |
| `postMerge.pid`/`postMerge.pidIdentity` | the post-merge verification runner | `merge()` |

The last two are atelier-yqk/atelier-kaz. A verification suite is often the heaviest
thing on the box (`cargo nextest` on Moss: minutes of CPU and a real GPU lease),
so a crash mid-verification used to orphan it with no boot coverage at all -
the record healed honestly while the process ran on invisibly. The post-merge
pair existed but sat *outside* the vocabulary: invisible to `hasFencingPid`, with
its own boot recovery that killed only on an exact identity match, never
re-probed after the signal, and then deleted both fields on **every** branch -
including the live-pid-with-no-identity branch, which is not death. Two
concurrent post-merge verifiers on main after a restart was a reachable outcome.

Every boot resolves all four - for records in *any* state, terminal included,
because the sweep marks a record `failed` while its SIGTERM is still in flight. A
pid resolves to exactly one of: **dead** (gone, a zombie, or alive under a
*different* start-time identity, which proves the OS recycled the pid and our
child exited), or **unresolved**. Only confirmed death clears the fields; only an
exact identity match is ever signalled, and the signal is a **process-group**
kill, so a verifier's own children (a test runner's workers) go with it.
A verifier that survives a fast restart is killed at boot because boot has
already concluded its attempt; that survivor could never report its result back
into the new Atelier process.

The pairs differ in exactly one declared way, and it is declared **on the pair**
rather than checked at each gate: `holdsClaim`. A live process behind a
claim-holding pair may still be writing to the *dispatch's own* worktree, so it
retains the tracker claim and blocks a successor. The post-merge verifier is the
one pair with `holdsClaim: false` - it runs in a throwaway worktree of its own,
against a commit already on main, for a record whose ticket `merge()` has already
closed. An unproven one is therefore **surfaced and never double-started**, but it
retains no claim and blocks no successor.

"Cannot confirm death" is *not* death. An **unresolved orphan** - a live pid with
no persisted identity (the crash window, or a host with no `/proc`), an
unreadable identity, or an identity-matched child that survived the kill - sets
`orphanUnresolved: true` on the record, retains the fence, suppresses
`restartResumeReady`, surfaces a warning, and **keeps the tracker claim**. (An
unproven *post-merge* verifier gets everything on that list except the flag and
the claim - see `holdsClaim` above: it still retains its fence and still surfaces
its warning, so it is never lost and never double-started.) One
classifier (`classifyFencedPid`) makes that decision for every lane and every
lifecycle verb, so no path can invent a fourth answer: the codex reattach
verdict is three-way rather than a boolean, a transient companion-status failure
never counts as worker death, and a `stop()` whose cancellation threw reaps first
and retains the claim if the reap cannot confirm.

Every codex snapshot is examined the same way, whatever its status string says -
including the two edges that used to decide a turn's fate without looking at the
worker at all: an *unrecognized* status (which says nothing about liveness) and a
*terminal* one. A terminal status is a report, not an observation, so the snapshot's
own reported pid is fenced when Atelier never captured it (the crash window: the job
store knows the worker, our record does not) and then probed. A turn completes -
and so becomes mergeable - only when its worker is proven gone.

**Releasing a claim is a question about the ticket, not the record.** A ticket is
one shared resource, so `releaseClaim`'s guard refuses while *any* record for that
`(project, ticketId)` holds an unproven fence, while any non-terminal record still
holds it, or while an admission holds its reservation - and it re-runs that scan
*after* the awaited `br` mutation, restoring the claim if something landed in the
window. Two terminal records for one ticket used to let the clean one free a ticket
its sibling still fenced a live worker on.

**A fence is released only by proven death, and death has exactly two proofs:**
an *observed* exit (node reaped the child - no probe can be more authoritative)
or a probe that finds the pid gone, a zombie, or recycled. The observed-exit
clear is what makes the fence usable as an admission signal at all: because a
completed dispatch has no fence, **admission blocks on the raw fence, not just on
the derived flag** - the boot pass that derives it is asynchronous, and a
successor must not slip through the window before it runs. That blocks every path
that would spawn a child for the ticket (reply-resume, plan continuation, queue
retry, convoy advance, bake-off leg, manual redispatch), makes `merge()` refuse
to remove a worktree from under an unproven worker (`force` overrides, after
re-deriving - the usual case by the time a human clicks merge is that the worker
has since exited, and a stale verdict must not demand a force), and stops a
bake-off from freeing its shared claim on behalf of a failed-but-unproven sibling.
The UI mirrors each of those refusals rather than offering a control the server
would 409: reply, plan Approve/Revise, and the normal merge button all disable,
while Force merge stays offered because the server genuinely honours it.

The shutdown sweep is the one place that retains a claim *without* flagging: its
own SIGTERM is still in flight, so it leaves both the claim and the verdict to
the next boot, which releases the ticket once death is confirmed (and does not, if
another record has since taken it). Otherwise an ordinary restart would lose its
"Resume after restart" affordance. Dismissal is the operator's override: it reaps
once, then clears the fence unconditionally - it has to, because a pid left
behind would have the next boot re-derive the condition and silently undo the
dismissal.

Claim verification is likewise unconditional: **every** resume re-takes the
tracker claim, not just one flagged `restartResumeReady`, because a dispatch that
failed *after* a successful turn had its claim released by `finish()` and would
otherwise resume invisibly to the board.

**Operational cost off Linux.** Identity corroboration is `/proc`-only. Where
there is no `/proc`, `kill(pid, 0)` still *proves* death (ESRCH) - the common
case - but it can never prove a live pid is or is not ours. So a record that
still carries a live pid after a restart lands unresolved and stays there: its
ticket is blocked until the pid dies (any later boot then releases it) or the
operator dismisses the dispatch. That is the honest reading of the evidence
available on those hosts, not a bug to work around.

### Reaping codex companion process trees (atelier-za6)

Fencing answers "may this worktree be written to". It does not free memory. A
codex companion job is **three processes plus per-session MCP children**, and
they deliberately escape each other's process groups: the job store's
`job.pid` is a detached task-worker, which starts an app-server *broker* keyed
by cwd in its own group, which starts the `codex app-server` wrapper, the native
binary, and MCP/code-mode children in groups of their own. The companion's own
cancel is a `kill(-job.pid)`, so it reaches the task-worker and nothing else.
Left alone, that leaked ~10 GiB PSS across 211 app-servers in a day - including
jobs whose worktrees had been deleted 12 hours earlier - and was the hard cap on
unattended operation.

So each record additionally carries `codexProcessTree`: every member of the live
tree with the *same* `/proc` start-time identity the fencing pids use. It is
captured on every live poll and **unioned** with the previous capture, because a
broker reparents to init the moment its task-worker exits - a later walk from the
same root would silently lose exactly the processes that leak.

Two mechanisms consume it, and **both route every kill decision through
`classifyFencedPid`**, so the reaper adds a reap *set*, never a second definition
of death. Only the "alive" verdict - identity-corroborated, provably ours -
authorizes a signal; "cannot corroborate" is retained and reported, the same
asymmetry the fencing lesson requires. **Age is never a criterion**: a resume
relaunches the companion in the same worktree and therefore reuses that
workspace's app-server if one is still up, so an age sweep killed a live resume
once already (`docs/lessons/codex-process-age-is-not-liveness.md`).

1. **Terminal transitions.** `transition()` is the one choke point every terminal
   state funnels through, so completion, failure and stop all reap there. There is
   **no resumability exemption**: a resume does not need the old app-server, it
   cold-starts one. Dismissal and merge reap again on their way to removing the
   worktree, which is where an ignored SIGTERM gets escalated before the directory
   goes.
2. **The GC sweep** - at boot, on a conservative interval (default 10 min,
   `createServer({ codexSweepIntervalMs })`), and inside `atelier doctor --gc`.
   Single-flight, one `/proc` scan per run, skipped while shutting down. It is
   what covers an unclean death, which runs no terminal transition at all. Half
   one re-signals captured trees whose record is terminal; half two needs no
   persisted state, matching processes by cwd. A dispatcher built with
   `sweepCodexProcessesAtBoot: false` skips the boot pass - `atelier doctor --gc`
   uses that, so a short-lived CLI process never reaps on the running server's
   behalf and `--dry-run` stays side-effect-free.

Every reap - terminal, dismissal, merge, resume, sweep - runs the same
termination: refresh the set against a live `/proc` read so a child forked since
the last poll dies with its tree, SIGTERM, wait out a bounded grace
(`codexReapEscalationMs`, default 5 s), **re-walk the closure again** (a root that
ignored the SIGTERM kept running, and a root that keeps running keeps forking),
then SIGKILL whatever is left - each candidate re-classified immediately before its own signal, because SIGKILL cannot be blocked and a pid recycled inside the read-to-kill window would take a kill meant for someone else - **all inside one call**. That is what lets dismissal and merge *await* the reap and know
the tree is gone before the worktree is removed from under it, with the default
configuration rather than only when a caller sets the grace to zero. `reply()`
does the same before relaunching, because the companion's
`ensureBrokerSession(cwd)` would otherwise reuse a broker Atelier is mid-SIGTERM on -
and then **re-classifies**: any member still alive under this dispatch's own
identity, or any signal that failed (an `EPERM` leaves the process running and lands
in the reap's errors, not its retained list), refuses the resume with a 409 naming
the pid. It also re-asserts admission after that await, so a shutdown or drain lease
that landed during the wait refuses rather than spawning into a closing server.
Reaps are serialized per record, so an awaited one also awaits any terminal reap
still finishing.

**`atelier doctor --gc` is not a second reaper.** A local gc refuses outright while
the instance lock shows a live owner and points at the API (`atelier_doctor_gc` /
`POST /api/doctor/gc`), which reaches the live dispatcher and its interlocks; two
reapers on one state directory share no single-flight. `--dry-run` stays available
and is side-effect-free by construction: it builds its Dispatcher in **observer
mode**, which schedules no boot pass that could signal (orphan fencing, post-merge
child termination, codex sweeps) or mutate (queue settlement and reconciliation,
tracker claim release, companion reattach, linked-review settlement, convoy drain,
automatic review, and the interrupted-verification-re-run repair - that one both
persists and transitions, and a terminal transition reaps). Observer also forces
dry-run inside the reaper's own choke point, the sweep and `gc`, so kill-freeness
does not depend on a caller remembering to pair the flag.

**The only thing that keeps a tree alive is a turn in flight.** Every reap path is
gated on the record's state, so an ACTIVE or `stopping` dispatch is never a
candidate - that, not the retention of finished turns' app-servers, is what makes
the recorded incident (a live resume killed by an age sweep) impossible.

**The cold-start contract** is what the flipped default rests on, and it is worth
stating because "reaping breaks resume" is the intuition that produced the
original exemption. A codex thread is a persisted rollout file under
`~/.codex/sessions`, and the companion's own `ensureBrokerSession(cwd)` starts a
fresh broker when none is running. So reaping a terminal record's tree costs a
later resume one cold start and nothing else; the `sessionId` and the worktree are
untouched. Retaining them instead bounded memory by unmerged-undismissed dispatch
count - the same pile-up that has put three-digit undismissed worktree counts on
this host. If a cold start genuinely fails, the resume fails loudly through the
ordinary companion-launch path rather than reporting a turn nothing ran.

**Scope is the safety property, and it is structural.** The cwd pass considers
only `<stateDir>/worktrees/<project>/<dispatch-dir>` - Atelier's own dispatch
worktrees, deliberately not `post-merge-worktrees` or `merge-worktrees` (no
companion runs there, and a merged record's post-merge verifier *does*). A
process anywhere else is never signalled and never even named: the user's own
Claude Code sessions run codex companions in ordinary checkouts, and those are not
Atelier's to touch.

**Inside that scope, the kill set is identity and nothing else.** A cwd says where
a process is *standing*, not what it is - a user's shell, or their own editor's
agent, can stand in a dispatch worktree too. Nor does argv: a command line is
self-reported, so any process can name `codex-companion.mjs` in it, and a user's
OWN codex companion legitimately runs with a cwd inside a atelier worktree. Shape
plus location still adds up to a stranger.

So a cwd-matched process may be signalled only when it is an
**identity-corroborated member of a tree Atelier itself captured** for that record.
Everything else is **listed, never killed** - `atelier doctor --gc` prints it with
the reason it was spared, annotated when its command line *looks* like a companion
(useful to whoever reads the listing, never a licence). Descendants of a
corroborated member are reaped whatever *they* look like and whatever their own
cwd is, because being the child of a corroborated process is itself the
corroboration - that is how an MCP server started elsewhere gets collected.

The cost of that strictness is small, which is what makes it affordable: the
capture path persists a tree on **every live poll**, so the crash window leaves a
persisted tree behind and the identity pass collects it. What the cwd pass gives up
is only the case where Atelier captured nothing at all - and there it has no evidence,
so listing is the honest answer. (Constraint 1 of the spec was amended to match:
its original cwd prong is demoted to report-only.)

The situational criterion is the **worktree's existence**, not an individual
process's `(deleted)` cwd marker: the marker is reported to the operator but is
never a criterion, because an agent that removed a subdirectory it was standing in
would otherwise condemn its own live dispatch.

Non-Linux hosts have no identity to corroborate and no `/proc` to enumerate, so
there is no sweep at all rather than a sweep that finds nothing: the result carries
`supported: false`, `atelier doctor --gc` says *"codex process sweep unavailable on
this platform"* rather than "0 reaped", and nothing is ever signalled. That is the
same honest reading of unavailable evidence the fencing rules take. Records written
before this field simply have no tree: no reap, no crash.

`atelier doctor --safe-restart` talks to the already-running server over its
own loopback API, holding a short-lived drain lease (`POST
/api/dispatches/drain-lease`) that blocks `dispatch()`/reply-resume/plan-
continue for its duration, so nothing can transition into an active state
between the idle check and the actual `systemctl --user restart`.
`--install-service` never restarts an already-running unit itself (only
`daemon-reload`) - applying a unit change is the human's/doctor's decision.

## Event log (atelier-e5x)

"Why did the queue do X" is one grep of one file, not forensics over registry
mtimes. Every consequential decision is a JSONL line
`{v, ts, seq, source, kind, ...payload}` under `~/.local/state/atelier/logs/`
(`events.jsonl` plus size-rotated `events.N.jsonl`, created lazily - an install
with no history is not an error).

Kinds emitted today: `queue.drain` (one `passId` per sweep, per project:
picked, or skipped with a machine-readable reason - budget, unpriced-cap,
active, capacity, parked, no-ready, tracker-moving - plus the cause and
candidates considered), `queue.settings`,
`queue.park`, `queue.unpark`, `dispatch.transition` (from -> to with
failureKind and outcome, starting at record creation), `dispatch.review`,
`dispatch.reply`, `dispatch.plan`, `dispatch.merge`, `dispatch.dismiss`,
`dispatch.main-health-acknowledge`, `budget.evaluation`, `registry.change`
(actor + field-level diff), `service.start`, `service.stop`,
`service.shutdown`, `log.degraded`. The live inventory is whatever the code
emits; nothing
enumerates it as a contract, deliberately, so a new kind needs no registry
update.

Rules that make it safe to log from lifecycle paths:

- **It cannot fail a dispatch.** The dispatcher funnels every event through one
  `logEvent` tap; `append` is total and never awaited. It bounds before making
  the redacted copy, then enqueues in memory; a scheduled microtask rotates and
  performs one `appendFileSync` for the whole batch. Graceful shutdown flushes
  the final batch.
- **An observer dispatcher writes nothing** - it observes state, it does not
  narrate it - enforced at that one tap rather than per call site.
- **No readout is an event.** `budget.evaluation` fires at the enforcement
  choke points only, and an unchanged consecutive drain skip is counted as a
  repeat rather than rewritten every interval (the next differing decision
  carries `previous.repeats`/`previous.since`). A log that narrates polling
  evicts the decisions an operator is looking for.
- **Crash tolerance matches the dispatch index:** a torn final line is skipped
  by readers and its boundary repaired before the next append; `seq` is
  recovered from the newest readable tail rather than reset. An unclean crash
  can lose at most the current unflushed batch. After a write failure, events
  are counted and dropped during a bounded retry backoff; recovery writes one
  `log.degraded` summary instead of retrying the filesystem for every event.

Read surfaces, all sharing one filter validator (so a bad filter is rejected
identically everywhere, and no filter combination can ask for more than 1000
events): `atelier logs [--follow]`, `GET /api/logs`, the `atelier_logs` MCP tool,
and the `#/logs` UI table. `--follow` reads the file directly (it works with the
server down) and tracks rotation by byte cursor plus first-line identity;
retention loss is an explicit gap marker. `--limit` bounds the backfill only,
never the follow. Filtered reads also have a byte-scan cap and report
`truncated: true` when callers should narrow the filter.

## Persistence

Tracker data: a full project's in-repo `.beads` or configured external
tracker directory, or a tracker-only project's Atelier-owned directory. Dispatch
records/events: append-only JSONL under ~/.local/state/atelier/dispatches/;
convoy cursors: `~/.local/state/atelier/convoys.json`
(in-memory Map is the live view; boot marks orphaned process-active work as failed and
logs the count of terminal, non-merged records still available for dismissal).
Registry: ~/.config/atelier/projects.json. Structured event log:
append-only, size-rotated JSONL under ~/.local/state/atelier/logs/. Atelier's own
development tracker: the committed .beads in this repo.

## What Atelier deliberately is not

Multi-user, cloud-anything, a sync engine, a CI system, or a framework app.
See the rejected-ideas list in the v1 plan and AGENTS.md hard rules.
