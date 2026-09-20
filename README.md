# Atelier

**A local-first workshop for supervising coding agents across every project you
work on.**

Atelier is the room you sit in while several coding agents work for you. It
gives you one board across all your repositories, sends each piece of work into
its own Git worktree, runs your real test suite before anything is allowed to
merge, and lets you talk to a running agent mid-task instead of waiting for it
to finish being wrong.

Atelier itself runs entirely on your machine: zero runtime dependencies, no
build step, no account, no telemetry, and it binds to `127.0.0.1` only. The
agents it drives are a different matter — `claude` and `codex` are your own
provider CLIs, under your own account, and they send your code to their provider
like they do when you run them by hand. Atelier adds no telemetry of its own and
takes no copy; what those CLIs transmit and retain is between you and them.

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

Atelier's answer to each is structural rather than advisory: a separate
workspace per dispatch, verification computed from your own test suite, an
append-only event log, and a merge gate that refuses work without proof.

## How a piece of work moves through it

```
  ticket ──▶ dispatch ──▶ agent works ──▶ verify ──▶ review ──▶ merge
             │            in its own      your real   optional   gated on
             │            git worktree    test suite  second     evidence,
             │                                        opinion    not on a click
             └── you can reply mid-run, steering the session in place
```

Every stage is a real state on a real record, and every transition is a line in
a structured log you can read later.

**Separate workspaces.** Each dispatch gets its own Git worktree cut from a
clean ref, so five agents can work on one repository at once without colliding
and without editing the files in your primary checkout.

Be precise about what that is: it separates working trees, not processes, and it
is where the agent is *directed* to work rather than a fence it is *held* inside.
By default an agent runs as you, with your permissions, your home directory, your
credentials and your network — Atelier calls this posture `trusted-local`, and
its own code labels it *"no isolation"*. The worktrees share the repository's
Git metadata, so `git worktree` and branch state are common. Real OS containment
is a separate, opt-in trust profile that is Linux-only and, today, cannot be used
with either shipped agent CLI. [SECURITY.md](docs/SECURITY.md) has the full
matrix and a blunt section on what the default does not protect; read it before
pointing Atelier at anything you would not hand to the agent directly.

**Verification is computed, never claimed.** When an agent finishes, Atelier
runs the verification commands *you* configured for that project and records the
exit codes. An agent saying "all tests pass" changes nothing. Normally this runs
against a fresh detached checkout of the finalized result commit, and a passing
run produces an attestation bound to that exact commit and tree. A dispatch that
produced no diff is recorded as `empty`, which is a distinct state from success
and from failure — an agent that stopped to ask a question has not failed.

**The merge gate wants evidence, not a click.** An ordinary merge is refused
unless there is a finalized result, an attestation bound to it, and a branch head
that still matches both; empty dispatches can never merge. Two things follow that
the word "gate" can hide. First, an ordinary merge is a normal capability, so an
agent operating Atelier over MCP can perform one — what a human holds exclusively
is *override* authority, not merge authority. Second, those evidence checks can
be bypassed, but only by consuming a break-glass token that a human mints in the
browser, bound to one dispatch and one commit, single-use, expiring, and written
to the audit log.

**Live steering.** A running agent can be replied to. The reply is queued into
the same session, in the same worktree, and the transcript continues where it
was — you correct the course instead of restarting it.

## Requirements

| | |
|---|---|
| **Node.js** | 22 or newer (`engines` requires `>=22.0.0`; CI runs 22.x and 24.x). Nothing else to install — Atelier's runtime is Node's standard library |
| **Git** | Any modern version, with worktree support |
| **[`br`](https://github.com/Dicklesworthstone/beads_rust)** | The tracker CLI (a Rust port of [Steve Yegge's Beads](https://github.com/steveyegge/beads)). Install with `cargo install --git https://github.com/Dicklesworthstone/beads_rust.git beads_rust --locked`, or the project's [install script](https://github.com/Dicklesworthstone/beads_rust/blob/main/docs/INSTALLING.md) |
| **An agent CLI** | At least one of [Claude Code](https://claude.com/claude-code) (`claude`) or [Codex](https://github.com/openai/codex) (`codex`) |

Linux is the developed-against platform and the only one any CI job runs on.
macOS is expected to work for the ordinary foreground workflow but is not
verified end to end, and two things are known to be missing there: service
installation is refused on Darwin, and no sandbox backend exists. The code is
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

**Verification.** Project-configured commands run after the agent exits —
normally against a detached checkout of the finalized result commit, and in the
dispatch worktree only in the pre-finalization case that cannot produce a
mergeable attestation. This is the gate, and it is the environment's verdict, not
the agent's.

**Review.** An optional adversarial second pass over the diff, with recorded
dispositions — what you accepted, what you refuted, and why.

## Interfaces

Atelier exposes the same capabilities three ways, deliberately:

- **The web UI** at `127.0.0.1:5170` — board, dispatch views, live transcripts,
  event log, styleguide.
- **The CLI** — `atelier dispatch`, `track --yes`, `reply`, and `plan` mutate
  through the running loopback daemon; `doctor --gc --offline-maintenance` is
  the explicit locked offline exception. Read-only commands include `logs` and
  `projects`.
- **[MCP](docs/MCP.md)** — `atelier mcp` bridges MCP-capable agents to the
  running cockpit over loopback, so an agent can operate the board itself.

Agents get the working surface through MCP rather than a reduced subset of it,
including ordinary gated merges. Oversight comes from gates that bind everyone
equally — budget caps, the verification gate, the attestation checks — never from
hiding ordinary capabilities from the agent. The deliberate exceptions are the
powers that *weaken* those gates: minting a break-glass token and forcing a merge
require a human browser session and are refused to automation credentials
outright. That is human root authority, not capability asymmetry.

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
deliberate and documented in [SECURITY.md](docs/SECURITY.md). The most important
one to understand before you start:

**The default posture is `trusted-local`: no OS containment.** A dispatched agent
runs as your user, with your files, your credentials and your network. The
worktree is where it works, not a sandbox it is confined to, and the verification
and merge gates are controls over Atelier's own workflow rather than a fence
around the agent — they give you evidence about work that came through Atelier's
path, not a defence against a process that goes around it. Atelier does implement
enforced confinement — namespace isolation with the user's home
and `/tmp` masked, network unshared, and daemon access narrowed to an allowlisted
unix socket — but it is Linux-only, `bwrap` is the only backend that actually
wraps a process, and it denies network, so neither shipped agent CLI can run
under it today. Both declare that they need their provider's remote API, and
Atelier refuses that combination rather than pretending to confine it. In
practice, every dispatch of `claude` or `codex` today runs `trusted-local`.

The boundaries that ARE enforced on every install:

- Binds `127.0.0.1` explicitly and authenticates local API clients with a
  state-directory bearer or signed browser session. Remote exposure remains unsupported.
- Subprocesses are executed with argv arrays. A shell is never invoked on user
  input.
- The HTTP core enforces a JSON content-type gate, a 256 KB body cap, and
  leading-dash argument rejection.
- Secret-shaped environment variables (including `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY`) are stripped from dispatch environments, and credential-shaped
  values are redacted at write time — before an event is persisted or streamed,
  never at read time. Both mechanisms are pattern denylists doing real work, not
  proofs of absence: an unknown format, an encoded value, a short token or a
  secret split across events can pass through. Treat dispatch records, the event
  log and UI output as sensitive.

## Status

Atelier is **working software in active single-maintainer use**, not a 1.0. Be
aware that:

- Authentication is local and single-user; it is not a remote-access design, and
  it does not defend against another process running as the same OS user.
- Agent execution is `trusted-local` by default, and the sandboxed profiles
  cannot currently be used with the shipped agent CLIs (see above).
- Secret redaction is a best-effort pattern denylist, not a guarantee. Treat
  dispatch records, the event log, and UI output as sensitive.
- macOS is unverified; Windows support is written for but not verified end to end.
- The `cozy-village` theme's optional `moss` WebGPU engine is not bundled: it
  depends on a renderer package that is not published, so `?engine=moss` only
  works with a local build dropped into the gitignored
  `themes/cozy-village/vendor/moss-web-renderer/`. The default engine is three.js.
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

The `cozy-village` theme vendors [three.js](https://threejs.org) in-repo, frozen
at the revision named in its file header, carrying its SPDX license header; it
has no adjacent provenance or SHA-256 manifest, and adding one is a welcome
contribution. The optional `moss` engine's WebGPU renderer package is not
published and is deliberately **not** vendored here; the adapter under
`themes/cozy-village/world/engines/` expects a local build at the gitignored
path named above.
