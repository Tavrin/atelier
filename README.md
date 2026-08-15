# Atelier

**A local-first workshop for supervising coding agents across every project you
work on.**

Atelier is the room you sit in while several coding agents work for you. It
gives you one board across all your repositories, sends each piece of work into
an isolated Git worktree, runs your real test suite before anything is allowed
to merge, and lets you talk to a running agent mid-task instead of waiting for
it to finish being wrong.

It runs entirely on your machine. Zero runtime dependencies, no build step, no
account, no telemetry, and it binds to `127.0.0.1` only.

---

## Why this exists

Running one coding agent is a chat window. Running five is an operations
problem, and it fails in specific ways:

- You lose track of **who is working on what**, across how many repositories.
- An agent reports success and you have **no independent proof** it ran anything.
- Work lands on your working tree and you cannot tell **which change came from where**.
- You notice an agent going the wrong way and have **no way to correct it** without
  killing the run and starting over.
- Something merged, main broke, and there is **no record of why the decision was made**.

Atelier's answer to each is structural rather than advisory: isolation by
construction, verification computed from your own test suite, an append-only
event log, and a merge that a human clicks.

## How a piece of work moves through it

```
  ticket ──▶ dispatch ──▶ agent works ──▶ verify ──▶ review ──▶ you merge
             │            in isolated     your real   optional   the only
             │            git worktree    test suite  second     way work
             │                                        opinion    reaches main
             └── you can reply mid-run, steering the session in place
```

Every stage is a real state on a real record, and every transition is a line in
a structured log you can read later.

**Isolation.** Each dispatch gets its own Git worktree cut from a clean ref.
Your primary checkout is never touched, so five agents can work on one
repository at once without colliding.

**Verification is computed, never claimed.** When an agent finishes, Atelier
runs the verification commands *you* configured for that project, in that
worktree, and records the exit codes. An agent saying "all tests pass" changes
nothing. A dispatch that produced no diff is recorded as `empty`, which is a
distinct state from success and from failure — an agent that stopped to ask a
question has not failed.

**Merging is a human act.** Nothing reaches your main branch without a click,
and the merge gate refuses dispatches that are unverified, empty, or stale.

**Live steering.** A running agent can be replied to. The reply is queued into
the same session, in the same worktree, and the transcript continues where it
was — you correct the course instead of restarting it.

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer. Nothing else to install — Atelier's runtime is Node's standard library |
| **Git** | Any modern version, with worktree support |
| **[`br`](https://github.com/Dicklesworthstone/beads_rust)** | The tracker CLI (a Rust port of [Steve Yegge's Beads](https://github.com/steveyegge/beads)). Install with `cargo install --git https://github.com/Dicklesworthstone/beads_rust.git beads_rust --locked`, or the project's [install script](https://github.com/Dicklesworthstone/beads_rust/blob/main/docs/INSTALLING.md) |
| **An agent CLI** | At least one of [Claude Code](https://claude.com/claude-code) (`claude`) or [Codex](https://github.com/openai/codex) (`codex`) |

Linux is the developed-against platform and macOS should work. The code is
written to be Windows-portable, but Windows has **not** been verified end to
end — [`docs/WINDOWS.md`](docs/WINDOWS.md) is the checklist for closing that
gap, and working through it is a genuinely useful contribution.

## Quickstart

```sh
git clone https://github.com/Tavrin/atelier.git
cd atelier
node bin/atelier.mjs init
node bin/atelier.mjs serve
```

Open `http://127.0.0.1:5170` and choose **Add your first project**. Atelier
probes the folder, proposes settings it detected, and asks you to confirm them.
Its own registry, dispatch records, and default tracker live outside your
repositories, under the platform's user-data directories — adding a project to
Atelier does not write anything into that project.

Then dispatch something:

```sh
node bin/atelier.mjs dispatch <project> --prompt "fix the flaky timeout in the queue tests" --follow
```

`--follow` streams the session live. Or drive the whole thing from the board.

Run `node bin/atelier.mjs --help` for the full CLI.

## Concepts

**Project.** A Git repository you have registered, plus its verification
commands, its tracker location, and its dispatch settings.

**Tracker.** Atelier reads and writes tickets through `br`. By default the
tracker lives outside your repository, in Atelier-owned state. You can
explicitly choose an in-repo `.beads` directory instead, and Atelier will
respect that choice — including never committing it unless you turn that on.

**Dispatch.** One agent run: a worktree, a prompt or ticket, a lane, a model, a
transcript, a cost, and a terminal outcome.

**Lane.** Which agent CLI runs the work — `claude` or `codex`. The lanes have
genuinely different capabilities (Codex, for instance, cannot be steered
mid-run and does not report its cost), and Atelier models those differences
explicitly rather than pretending they are interchangeable.

**Verification.** Project-configured commands run in the dispatch worktree
after the agent exits. This is the gate, and it is the environment's verdict,
not the agent's.

**Review.** An optional adversarial second pass over the diff, with recorded
dispositions — what you accepted, what you refuted, and why.

## Interfaces

Atelier exposes the same capabilities three ways, deliberately:

- **The web UI** at `127.0.0.1:5170` — board, dispatch views, live transcripts,
  event log, styleguide.
- **The CLI** — `atelier dispatch`, `reply`, `plan`, `logs`, `projects`,
  `doctor`, and more.
- **[MCP](docs/MCP.md)** — `atelier mcp` bridges MCP-capable agents to the
  running cockpit over loopback, so an agent can operate the board itself.

Agents get full control through MCP, not a reduced subset. Oversight comes from
gates that bind everyone equally — budget caps, the verification gate, the human
merge click — never from hiding capabilities from the agent.

## Themes

The dashboard is one presentation of the data, not the only one. The theme
system exposes projections, an event stream, and an action surface, so a theme
can be an ordinary dense dashboard or something else entirely. The repository
ships `cozy-village`, a 3D village where the state of your work is the state of
the town, built to a strict honesty rule: nothing in the scene can be rendered
from vibes, elapsed time, or output volume — every visual maps to a field that
exists. See the [theme author handbook](docs/THEMES.md).

## Security boundaries

Atelier runs agents that execute code on your machine, so its boundaries are
deliberate and documented in [SECURITY.md](docs/SECURITY.md):

- Binds `127.0.0.1` explicitly. **There is no authentication** — exposing it
  remotely is unsupported, not merely discouraged.
- Subprocesses are executed with argv arrays. A shell is never invoked on user
  input.
- The HTTP core enforces a JSON content-type gate, a 256 KB body cap, and
  leading-dash argument rejection.
- Secret-shaped environment variables (including `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY`) are stripped from dispatch environments, and secrets are
  redacted from events before they are emitted or persisted.

## Status

Atelier is **working software in active single-maintainer use**, not a 1.0. Be
aware that:

- There is no authentication, by design. It is a single-user local tool.
- Windows support is written for but not verified end to end.
- The `cozy-village` theme's optional Moss WebGPU renderer is a preview build
  and is opt-in; the default renderer is three.js.
- The API surface may still change between versions.

## Documentation

| Document | What it covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Server, dispatcher lifecycle, state machine, persistence |
| [Registry](docs/REGISTRY.md) | Project configuration and tracker placement |
| [Security](docs/SECURITY.md) | Loopback and request-handling boundaries |
| [MCP bridge](docs/MCP.md) | Architecture, registration, tool inventory, trust boundaries |
| [Agent adapters](docs/AGENTS-ADAPTERS.md) | The contract for integrating an agent CLI |
| [Design system](docs/DESIGN.md) | Tokens, components, responsive behavior, shortcuts |
| [Theme handbook](docs/THEMES.md) | Bundles, data surfaces, lifecycle, trust tiers |
| [Notifications](docs/NOTIFICATIONS.md) | Self-hosted delivery, and why no third parties |
| [The loop](docs/LOOP.md) | The dispatch cycle as a formal five-field loop |
| [Windows](docs/WINDOWS.md) | The unverified-platform checklist, and how to report results |
| [Lessons](docs/lessons/INDEX.md) | Durable traps found the hard way while building this |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the rules that will reject a PR on
sight (chiefly: core takes no runtime dependencies, ever) and how to verify a
change. [AGENTS.md](AGENTS.md) is the full binding rule set.

Most wanted right now: **Windows verification** — see
[docs/WINDOWS.md](docs/WINDOWS.md). The code is written for it and has never
been run there.

Security issues go through [private reporting](SECURITY.md), not public issues.

## License

[MIT](LICENSE).

The `cozy-village` theme vendors two MIT-licensed libraries in-repo, frozen,
with provenance and SHA-256 manifests recorded next to them:
[three.js](https://threejs.org), and a preview build of the Moss web renderer —
a WebGPU engine by the same author, which is **not currently public**, so that
vendored copy cannot be checked against its upstream source. Its MIT license is
included verbatim alongside it.
