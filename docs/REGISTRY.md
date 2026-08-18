# Atelier Project Registry

Location: `~/.config/atelier/projects.json` (override: ATELIER_CONFIG_DIR).
Validated on load by server/lib/registry.mjs; `atelier doctor` reports all
problems at once.

MCP automation may read project settings and patch ordinary workflow fields,
but it cannot change the gate-critical `verifyCommands`, `requireReview`, or
`reviewPolicy` fields. Those three remain mutable through the human UI, CLI,
and API bearer surfaces; they do not require a break-glass token. This keeps
automation from pre-loosening a merge gate while preserving normal operator
configuration workflows. A break-glass token authorizes only one force merge
and is minted only by a web-session action; bearer credentials cannot mint one.
This is surface discipline, not a same-UID security boundary: the loopback
`/api/session` bootstrap is unauthenticated, so an unlabeled process running as
the Atelier user is trusted-local by owner decision and can obtain the
`human-ui` session. The static CSRF value and eight-hour session lifetime do not
change that fact. Consequently, `atelier merge <dispatchId> --force` refuses
with instructions to mint in the web UI; there is intentionally no CLI mint
path. ATT-008 makes the distinction enforceable: sandboxed agents must receive
brokered API access that excludes both `/api/session` and `/api/break-glass`.
The existing actor gate remains valuable for every labeled surface and for
those future sandboxed agents.

## Schema (version 1)

- `defaults.concurrentDispatchCap` - running+preparing dispatches across all
  projects.
- `defaults.queueFailureLimit` - positive per-ticket ready-queue runtime failure
  limit before parking; defaults to 2. A project can override it.
- `defaults.maxFixRounds` - positive review-round hard backstop; defaults to 4.
  A project can override it. Strictly shrinking review finding counts may
  continue through this many rounds; round 5 parks under the default.
- `defaults.dispatchProfile` - {defaultModel, effort, maxTurns,
  allowedTools[], lane, dispatchEnv{}} merged under each project's
  `dispatchProfile`.
  Claude-lane models: sonnet, sonnet[1m], opus, opus[1m], haiku (aliases
  track the latest tier model; [1m] = 1M context; fable is rejected -
  reserved for the architect session). `effort`: low | medium | high |
  xhigh | max (omit for the CLI default; ignored on the codex lane, whose
  reasoning effort lives in ~/.codex/config.toml).
- `defaults.editorCommand` - optional executable name or absolute executable
  path used by the local "Open in editor" actions. Atelier appends the resolved
  project/worktree path as the sole argument. Spaces, arguments, and shell
  metacharacters are rejected; the client never supplies the target path.
- `defaults.notifyUrl` - optional outbound HTTP POST target for terminal
  dispatch, review, and post-merge health notifications. Leave it unset for no
  outbound delivery. To keep notification data inside infrastructure you
  control, point it only at a SELF-HOSTED receiver such as an ntfy topic on
  localhost or your tailnet; do not use the public ntfy service. Atelier does not
  add authentication headers, and the registry is not a secret store. See
  [Notifications](NOTIFICATIONS.md) for setup, payload, and delivery limits.
- `groups[]` - {name, projects[], note}: display union + fan-out dispatch;
  no data sync. Cross-repo work uses a shared ticket-id string convention.
- `projects[]`:
  - `name` /^[a-z0-9][a-z0-9._-]*$/ - `path` absolute, must exist.
  - `archetype`: `full`, `git-only`, or `tracker-only`.
    - `full` requires a Git checkout and a `committed` or `personal`
      tracker. Board, dispatch, verification, merge, and queue surfaces are
      available.
    - `git-only` requires a Git checkout and forces `tracker: "none"`.
      Dispatch surfaces remain available; board operations are unavailable.
    - `tracker-only` does not require Git and forces `tracker: "personal"`.
      Its board works normally, while dispatch, verification, merge, and
      queue operations return 409. The tracker lives at `path`, or at
      `<stateDir>/trackers/<name>/` when the API creation request omits a
      path.
    Existing entries without `archetype` are inferred in memory as `full`
    when a Git checkout has a tracker, otherwise `git-only`. Loading does not
    rewrite the registry.
  - `mainBranch` - the CLEAN base ref dispatch worktrees are created from
    (never the possibly-dirty primary HEAD). null = probe-resolved. Onboarding
    lists the probe's actual local branches and locally known remote HEAD,
    preferring `main`/`master` when present and otherwise the current branch;
    a custom-ref escape remains available for unborn branches.
  - `tracker`: `committed` (`.beads` versioned in its Git checkout),
    `personal` (`.beads` present but not versioned, including the normal
    Atelier-managed external case), or `none` (degraded view: git state +
    dispatch only).
  - `trackerPath` - optional absolute directory containing the tracker's
    `.beads/`; every `br` command and board read uses this directory. When
    omitted, it defaults to the project `path`, preserving existing entries.
    It must exist and may not be nested inside another registered project's
    path (equality with that project path is allowed). Atelier-managed trackers
    normally live at `<stateDir>/trackers/<name>/`.
  - `autoCommitTracker` - optional, defaults to `false`. After Atelier-driven
    tracker mutations, stage and commit only `.beads` when the configured
    tracker directory is inside a Git checkout. A normal Atelier-managed
    external tracker is not a repository, so this silently skips; if the
    trackers directory is later made a Git repository, it works there too.
  - `autoCloseOnMerge` - optional, defaults to `false`. After Atelier merges a
    ticket dispatch, close its ticket with the merged short SHA. With
    `autoCommitTracker`, that close is committed pathspec-only as well.
    Tracker automation flags are rejected for tracker-less projects and for
    non-Git tracker-only stores.
  - `requireReview` - optional, defaults to `false`. When enabled, merge
    applies the linked read-only spec-audit review and the project's
    `reviewPolicy` in addition to the verification gate. A review compares the
    target diff with the tracker ticket description, or with the persisted
    prompt for a standalone prompt dispatch. Queue-launched dispatches
    automatically start that review after completing with a passing
    verification; reviews do not occupy ready-queue
    project or global capacity. Reviews retain every round and mechanically
    count `[BLOCKER]`, `[MAJOR]`, `[MINOR]`, and `[NIT]` finding lines. A false
    implementation handoff, a non-shrinking count, or the configured hard
    backstop parks the thread and creates a bounded ticket re-spec with its
    branch/HEAD salvage pointer. An explicit force merge can override a missing
    or failed review, but does not reopen a parked fix thread.
  - `legacyCodexCompanion` - optional boolean, defaults to `false`. New Codex
    dispatches use Atelier's supported, version-and-digest-pinned app-server
    adapter. Setting this to `true` selects the deprecated plugin-cache
    companion for compatibility; each affected record receives a deprecation
    warning and pins the companion script plus the Node interpreter that runs
    it. The companion PATH-searches `codex` internally, so the Codex binary is
    not pinned; that unenforceable binary identity is a reason to migrate.
  - `reviewPolicy` - optional; `strict` (the default) gates on every open
    finding, `tiered` gates on BLOCKER/MAJOR while filing each remaining
    MINOR/NIT as its own follow-up ticket with a linking comment during merge,
    and `advisory`
    treats non-blocker findings as report-only. A BLOCKER gates every policy
    regardless of disposition and can be overridden only by an audited force
    merge. Under every policy, only refuted, redirected, and waived
    dispositions neutralize a finding; bare accepted findings remain open.
    Normal tiered advisory filing requires a source ticket, a configured
    tracker, and a linked review dispatch, otherwise only the audited force
    path is available. Each untagged location line or finding bullet in FAIL
    output is retained as its own synthetic MAJOR finding. A malformed tagged
    line retains its declared severity with a null location even when punctuation
    follows the tag, and cannot erase valid siblings, while contradictory PASS/FAIL
    output is malformed. Redirects require an existing ticket other than the
    source ticket, and that sole carrier is not auto-closed while redirected-in
    work remains. Owed tiered follow-up-ticket debts are durable with the merge
    record and appear in `atelier doctor --gc` until any configured tracker
    auto-commit succeeds; bounded in-process and boot recovery retry them.
  - `maxFixRounds` - optional positive integer overriding the default review
    hard backstop. A round parks when its number is greater than this setting;
    false self-reports and non-shrinking counts can park earlier.
  - `budgetUSDPerDay` - optional positive USD ceiling for dispatch costs whose
    records started during the current local calendar day. At or above the
    ceiling, ready-queue autonomy skips the project without incrementing its
    circuit-breaker failure count. Manual dispatch, reply/resume, and plan
    approval return a structured 409 unless the caller explicitly confirms a
    one-operation `force` override. Leaving the Settings field blank removes
    the ceiling.
  - `queueFailureLimit` - optional positive integer overriding the default
    number of failed queue-launched dispatches allowed before that ticket is
    parked.
  - `unpricedDispatchCapPerDay` - optional positive-integer ceiling on new
    dispatch records started during the current local calendar day on adapters
    whose `reportsCost` capability is `false`. It is an honest count fallback,
    not an estimate of USD. Priced lanes do not consume it; linked reviews on
    an unpriced lane do. Ready-queue starts and manual dispatches stop at the
    cap; a manual caller may explicitly confirm the same one-operation `force`
    override.
  - `containerized` + `verifyMode`:
    - `worktree` - verify commands run truthfully in the dispatch worktree.
    - `container-primary` - commands exec in a container bind-mounted to
      the PRIMARY tree: ADVISORY for worktree changes (a green run does not
      test the dispatch's diff). Surfaced as such in the UI.
    - `primary-postmerge` - environment (e.g. in-repo .venv) exists only in
      the primary; verify after syncing changes there.
    - `advisory` - informational only.
  - `verifyCommands[]`, `smokeCommand` - REAL commands (Makefile targets);
    onboarding may suggest commands from marker files, but probe never runs
    them and the user must confirm them before they enter the local registry.
    For `verifyMode: "worktree"`, Atelier first runs them on the completed dispatch
    branch and stamps its exact tested `HEAD`. After every
    successful merge, Atelier also runs the configured commands once against the
    exact updated-main commit in a temporary detached worktree. This post-merge
    pass is asynchronous and FIFO per project: it never delays or rolls back the
    merge, but each unresolved failure is persisted with bounded redacted
    evidence and raised through the event, board-banner, desktop, and configured
    outbound-notification paths. Acknowledgement is persisted; only a passing
    check on a later merge commit resolves the failure.
  - `warn` - forbidden-commands banner, injected into dispatch prompts.
  - `dispatchEnv` - non-secret environment variables added to the Claude,
    Codex, and worktree-verify processes. Project values override
    `defaults.dispatchProfile.dispatchEnv` key by key. For example, Moss can
    share its build cache with:

    ```json
    "dispatchEnv": {"CARGO_TARGET_DIR": "/home/<user>/.cache/atelier/cargo/moss"}
    ```

    Keys must match `/^[A-Z][A-Z0-9_]*$/`. Keys containing `key`, `token`,
    `secret`, `password`, or `credential` (case-insensitive) are rejected:
    secrets do not belong in the registry. Values must be strings without NUL.
  - `notes` - human context shown in the project header.

## Layout contract

For a new Git repository whose user chooses a tracker, onboarding asks where
the tracker should live:

- **Atelier-managed (default) - nothing added to the repo; this machine only.**
  Atelier initializes it at `<stateDir>/trackers/<name>/` and stores that path in
  `trackerPath`.
- **Inside the repository (committed) - syncs across machines and teammates
  via git; visible in the repo.** Atelier uses `<project>/.beads/`, so the user
  can version and share it with the repository.

Atelier writes no application or runtime files into a tracked project's working
tree. The explicit exception is tracker state: Atelier-driven `br` mutations
already update `.beads`, and `autoCommitTracker` may pathspec-stage and commit
only that directory. The other write outside the XDG roots is an explicitly
selected tracker-only folder, which is Atelier-owned by that choice.

| Data | Location | Write owner |
| --- | --- | --- |
| Registry and confirmed verification configuration | `<configDir>/projects.json` | Atelier, atomically via temp file + rename |
| Optional onboarding defaults | `<project>/.atelier.json` | User or project; Atelier only reads it and never creates it |
| Dispatch records, queue state, convoy state, and streamed events | `<stateDir>/` | Atelier |
| Dispatch worktrees | `<stateDir>/worktrees/<project>/` | Atelier; never nested in the primary checkout |
| Temporary merge worktrees | `<stateDir>/merge-worktrees/` | Atelier |
| Temporary post-merge verification worktrees | `<stateDir>/post-merge-worktrees/<project>/` | Atelier |
| Default tracker-only stores | `<stateDir>/trackers/<name>/` | Atelier |
| User-selected tracker-only store | The explicitly selected non-project folder | Atelier |
| Atelier-managed full-project tracker (default for new tracker choices) | `<stateDir>/trackers/<name>/.beads/` | Atelier; external and machine-local unless the trackers directory is separately versioned |
| In-repo full-project tracker (explicit opt-in) | `<project>/.beads/` | The project/user; Atelier initializes and operates it after explicit selection, and may opt-in commit future mutations |

`configDir` is `~/.config/atelier` on POSIX and the roaming application-data
equivalent on Windows. `stateDir` is `~/.local/state/atelier` on POSIX and the
local application-data equivalent on Windows. `ATELIER_CONFIG_DIR` and
`ATELIER_STATE_DIR` override them.

## Convoy runtime state

Convoys are runtime orchestration, not registry configuration. A full project
can submit an ordered list of 2-20 ready or open-unclaimed tickets through
`POST /api/projects/:name/convoy`. Atelier validates that the supplied order does
not put a blocker after a ticket that depends on it, then persists the cursor
in `<stateDir>/convoys.json`.

Each member is a normal dispatch and therefore uses the project's existing
dispatch profile, verification commands, tracker directory, and global
concurrent-dispatch cap. The next member starts only after merge. Failure,
stop, or dismissal without merge pauses the convoy; resume re-dispatches the
same cursor, and cancel never stops an already in-flight dispatch. Boot
re-derives the cursor from persisted dispatch records before trying to fill an
available cap slot.

## Bake-off runtime state

Bake-offs are explicitly requested dispatch batches, never a project default.
`POST /api/dispatch` with a ticket id and two distinct `lanes` creates two
ordinary records with a shared `batchId` and `batchKind: "bakeoff"`. Each lane
gets its own worktree and branch and consumes a normal global cap slot. Atelier
claims the tracker ticket once for the batch, does not release it while a
viable sibling remains, and keeps it when one sibling merges. After that first
merge, every sibling merge is rejected and the remaining attempts should be
dismissed after comparison.

## Daily dispatch limits

Daily spend is derived from persisted dispatch records, not a separate mutable
counter: Atelier sums `costUSD` for records whose `startedAt` falls within the
project host's current local day. A configured `budgetUSDPerDay` gates new
manual work once spend reaches the ceiling. Its 409 response includes
`budgetExceeded: true`, `spentUSD`, and `budgetUSD`, allowing the UI to show the
numbers before offering an explicit “Dispatch anyway” retry with `force: true`.

An enabled ready queue remains enabled while over budget. Its runtime
`lastError` reads `daily budget reached ($X of $Y)`, its consecutive-failure
count is unchanged, and the message clears on a later drain once the local-day
spend is below the ceiling. A force override applies only to the requested
manual operation; it does not disable or mutate the configured budget.

## Ready-queue retry parking

Queue-launched dispatches persist per-ticket attempts in `<stateDir>/queue.json`
and record each terminal queue outcome in the dispatch index. Each failure records
its time and kind. Once the configured failure limit is reached (2 by default),
later drains skip that ticket, the queue card shows the park reason, and Atelier
adds a tracker comment explaining the stop. Other ready tickets remain eligible,
so one bad ticket cannot monopolize an unattended queue. On boot, the dispatch
index repairs a stale `queue.json` left by a failed park-state write.

Use the queue card's Resume action, or POST
`/api/projects/:name/queue` with `{"resumeTicketId":"ticket-id"}`, to clear a
ticket's attempt memory explicitly. Atelier persists that resume decision so old
dispatch outcomes cannot re-park it after restart. Raising `queueFailureLimit`
above its saved attempt count also makes it eligible again.
Adapters with `reportsCost: false` cannot contribute trustworthy dollars to
that budget. For those lanes, `unpricedDispatchCapPerDay` provides a separate
count-based ceiling derived from persisted records started today. It never
invents a dollar estimate: cost rollups continue to show reported cost only.
At the cap, the 409 response carries `dispatchCountExceeded: true`,
`dispatchesToday`, and `dispatchCap`; the UI states plainly that these are
dispatches on lanes without reported cost before offering the explicit force
override. A mixed bake-off consumes only its unpriced lane, while a priced-only
dispatch does not consume the cap.

Ready-queue admission continues to exclude linked review dollars from the USD
budget, but the count fallback includes every unpriced dispatch because an
unpriced review has the same accounting blind spot. The queue reports
`daily unpriced dispatch cap reached (X of Y)` without incrementing the circuit
breaker. A terminal reply or plan continuation does not create a new dispatch
record, so it does not consume another count slot; USD-reporting lanes remain
governed by their accumulated-cost check on those operations.

## Moving a full-project tracker

The Settings action and `atelier move-tracker <project> --to external|in-repo`
use `POST /api/projects/:name/move-tracker` with body
`{"to":"external"}` or `{"to":"in-repo"}`. The operation refuses with 409
while that project has an active dispatch or its ready queue is currently
draining.

Atelier moves the entire `.beads` directory, including br's SQLite cache. It
uses a filesystem rename when possible; across devices it copies, verifies a
content manifest, and only then removes the source. Next it atomically updates
`trackerPath` and runs `br ready` at the destination. A failed smoke reverses
the directory move and registry update and returns 409.

Tracker relocation never runs `git add`, `git rm`, or `git commit` in the
project repository. Moving in returns a `nextSteps` note telling the user to
commit the new `.beads`; future Atelier mutations may be auto-committed only if
`autoCommitTracker` is enabled. Moving out tells the user to commit the removal
of `.beads`. The repository and its history remain the user's responsibility.

## `.atelier.json` opt-in defaults

A repository may opt in to onboarding defaults with a root `.atelier.json`.
It accepts a validated subset of project fields such as `name`,
`mainBranch`, `archetype`, `tracker`, `verifyMode`, `verifyCommands`, `warn`,
`defaultAgent`, `dispatchProfile`, `budgetUSDPerDay`, `requireReview`,
`reviewPolicy`, `maxFixRounds`, `autoCommitTracker`, and `autoCloseOnMerge`.
The file wins over marker-file inference in the probe response, the user still
confirms the form, and the local registry always wins at runtime. Atelier never
creates or edits
`.atelier.json`.
