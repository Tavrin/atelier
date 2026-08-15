# Agent adapters

Atelier's dispatcher orchestrates registered agent adapters. Lane-specific policy,
process launch, output consumption, pre-launch probes, and stop behavior live in
`server/lib/agents/<id>.mjs`; the dispatcher continues to own dispatch records,
persistence, state transitions, verification, worktree cleanup, and tracker
claims.

## Contract

Each module exports one frozen adapter object with these fields:

- `id`: the stable lane value stored in dispatch records and sent by the UI.
- `displayName`: the human-readable lane label.
- `capabilities`: exactly five booleans:
  - `liveStream`: Atelier receives live, normalized agent output rather than
    coarse status snapshots.
  - `liveInput`: Atelier can send JSONL user turns to the running harness through
    its piped stdin. Adapters without this capability retain the default ignored
    stdin used to avoid non-interactive launch stalls.
  - `canResume`: the harness can resume a prior agent session. This is declared
    for the dispatcher's terminal reply/resume path.
  - `reportsCost`: the harness supplies trustworthy per-dispatch cost data.
  - `commitsOwnWork`: the harness can write Git metadata and is responsible for
    committing its completed work. After a successful run from an adapter that
    declares this `false`, Atelier stages non-tracker worktree changes and commits
    them on the dispatch branch before verification. The subject is
    `chore(dispatch): <ticket> - work by <agent> [atelier-committed]` and the
    redacted agent summary is the commit body. `.beads` remains on the separate
    stranded-write harvesting path and is excluded from this commit.
- `options()`: returns `{ models, efforts, resolvedModel? }`. The arrays contain
  `{ value, label }` choices for the composer. Return an empty array when the
  setting is owned outside Atelier. Adapters with no model choices may expose
  `resolvedModel` so the composer can show the externally configured value.
- `resolveModel({ requested, profile })`: returns the model Atelier records for
  the dispatch. The adapter owns model defaults and validation. Claude applies
  its model whitelist; Codex ignores Atelier model requests and reports the
  model selected by its own local configuration.
- `validate({ model, effort })`: enforces remaining adapter option policy
  before a dispatch is claimed or prepared. Preserve user-facing error text
  when moving existing policy.
- `preLaunchChecks({ entry, project, worktreePath, commandRunner })`: performs
  lane-specific checks after the isolated worktree exists and before launch.
  It may attach adapter runtime data or warnings to `entry`; throw to enter the
  normal `prepare_failed` lifecycle.
- `launch({ entry, project, prompt, worktreePath, dispatchDir, maxTurns, env, spawner,
  commandRunner, callbacks })`: launches the harness with argv arrays and the
  injected execution seams. `dispatchDir` is Atelier-owned persistent state for
  adapter artifacts that must not live in the tracked worktree. It must never
  invoke a shell. The exact callback
  surface is `{ captureSession, emit, finish, normalizeLine, streamLines,
  transition }`: `captureSession` persists a harness session id on the dispatch,
  `emit` persists a normalized/redacted event, `finish` returns control to the
  dispatcher lifecycle, `normalizeLine` maps Claude-style NDJSON,
  `streamLines` consumes process streams line by line, and `transition` records
  a lifecycle change. Adapters use only the callbacks they need.
- `resume({ entry, project, text, worktreePath, dispatchDir, maxTurns, env, spawner,
  commandRunner, callbacks })`: continues an existing harness session in the
  same worktree and environment, using the same callback surface and output
  normalization as `launch`. Adapters without resume support must throw a clear
  not-supported error and declare `canResume: false`.
- `stop({ entry, commandRunner })`: performs the adapter-specific stop. It
  returns `{ finish: true }` when the dispatcher should finish immediately, or
  `{ finish: false }` when a killed child will finish through its close handler.

The registry is the `agents` Map in `server/lib/agents/index.mjs`.
`getAgent(lane)` is the only dispatcher lookup path, and `GET /api/agents`
serializes the same Map for the composer.

Projects may set `defaultAgent` to a registered adapter id. Dispatch selection
uses an explicit request first, then the project's own legacy
`dispatchProfile.lane`, then `defaultAgent`, then
`defaults.dispatchProfile.lane`, and finally `claude`.
`GET /api/projects` exposes the merged `dispatchProfile`, the source-preserving
`ownDispatchProfile`, and the resulting `resolvedDefaultAgent` separately so
clients can apply that precedence without treating an inherited lane as explicit.

## Reply and live-input flow

Claude's `system/init` event supplies the session id used by terminal replies.
The Codex companion supplies its thread id in the background job state; Atelier
stores that value in the same dispatch `sessionId` field. Atelier persists the id,
enters `resuming`, emits the redacted user `reply` event, and resumes the agent
in the original worktree and environment. Claude launches `claude --resume`.
Codex writes each full launch or resume prompt to a mode-`0600` file in
`<atelier-state>/dispatches/`, then launches
`codex-companion.mjs task --write --resume --background --json` with only a
short instruction to read that file. This avoids the kernel's per-argument
length limit without truncating task, ticket, or review content. The companion
selects the completed thread tracked for that isolated workspace/session.
Successful resumes run the configured verification stage again.

Atelier sets `CLAUDE_PLUGIN_DATA` for every Codex companion launch and resume to
`<atelier-state>/codex-companion`, so the companion's thread registry and job
records survive host reboots. Threads created before this durable state path was
introduced remain in the companion's volatile `/tmp` fallback and cannot be
recovered after that directory is cleared; Atelier does not migrate them.

Claude Code 2.1.216 was validated directly with `--input-format stream-json`.
The accepted JSONL user-message shape is:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
```

Atelier writes the initial prompt and each live reply with that envelope, one
newline-delimited object at a time, and leaves stdin open until child exit.
`spawnTracked` keeps its ignored-stdin default; only adapters declaring
`liveInput: true` request a piped stdin override.

Codex declares `canResume: true` and keeps `liveInput: false`: terminal replies
can continue its captured thread, but Atelier has no Codex mid-turn input channel.

## Codex process-tree lifecycle

A companion job is three processes plus per-session MCP children, each in its own
process group, so nothing the companion signals reaches all of them. On every live
poll the codex adapter hands the dispatcher the worker pid it just corroborated
(`callbacks.captureCodexProcessTree`), which walks the parent chain and persists
each member with its `/proc` start-time identity. The capture is gated on
`captureWorkerPid`'s verdict: that classifies any existing fence first, so a
reported pid Atelier cannot corroborate - a recycled one, or one reported while a
different worker is still alive - is neither adopted nor has its descendants
recorded as Atelier's to kill. The dispatcher reaps that tree on
terminal transitions, dismissal and merge, and sweeps for leftovers at boot and on
an interval. Only a turn that is still in flight keeps its tree, and only a member
Atelier itself captured is ever signalled - a companion-shaped command line in a
atelier worktree is reported, not reaped.

The adapter-visible consequence is the **cold-start contract**: a Codex resume
relaunches in the original worktree, and if that workspace's app-server has been
reaped the companion's `ensureBrokerSession(cwd)` starts a fresh one. The thread
lives in a persisted rollout file under `~/.codex/sessions`, so a reap costs a
resume one cold start and never the session - which is why terminal records get no
resumability exemption. A cold start that genuinely fails surfaces through the
normal companion-launch failure path. See `docs/ARCHITECTURE.md` ("Reaping codex
companion process trees") and
`docs/lessons/codex-process-age-is-not-liveness.md`.

## Review read-only posture

Codex review dispatches omit the companion's `--write` flag and therefore run
inside Codex's true read-only sandbox. Claude has no equivalent sandbox
guarantee. Atelier gives Claude reviews no built-in tools, enables safe mode,
uses strict MCP configuration with no supplied servers, disables slash
commands, and applies a deny list that includes mutating built-ins and
`mcp__*`. The same posture is retained when a review session resumes.

Claude's enforcement is consequently best-effort deny-list based, not a
security boundary: a future CLI behavior change or an administrator-managed
policy surface could fall outside Atelier's controls. Review prompts contain the
complete spec and target diff so Claude needs no project or extension tools.

## Adding an agent

1. Add `server/lib/agents/<id>.mjs` and export a frozen object implementing the
   full contract above. Keep model and effort policy, process argv, polling or
   streaming, pre-launch requirements, and cancellation inside that file.
2. Import the object in `server/lib/agents/index.mjs` and add one `[id, adapter]`
   Map entry. The dispatcher and composer need no lane-specific branch.
3. Run `node --test` from the repository root. The registry-wide adapter
   contract test fails if any registered adapter omits a method, capability, or
   composer-option shape.

Capability declarations must be honest. If Atelier's integration with a harness
cannot stream live output, accept live input, resume sessions, or report
trustworthy cost, declare that capability `false`. The UI must degrade visibly;
an adapter must never fake support that its harness does not provide.

Codex declares `commitsOwnWork: false` by design. In Codex `workspace-write`,
both a checkout's `.git` and the resolved gitdir behind a worktree `.git`
pointer are protected read-only even when their parent is an additional
writable root. `--add-dir` therefore cannot grant a narrowly scoped exception;
the available bypass removes sandbox protection broadly and is not appropriate
for Atelier dispatches. Atelier owns the isolated worktree and branch already, so
the dispatcher performs the narrow Git commit after Codex exits instead.
