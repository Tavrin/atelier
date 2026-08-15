# AGENTS.md — Atelier

Atelier is a zero-dependency, single-user, loopback-only agent cockpit:
kanban board + dispatcher + live following across multiple projects.
Design record: docs/ARCHITECTURE.md. Registry: ~/.config/atelier/projects.json.

## Hard rules

- **Zero runtime dependencies in core.** Atelier core is Node stdlib ESM only:
  no npm installs, build step, or CDN. `node:*` stdlib modules are not
  dependencies and are unrestricted. Self-contained `themes/<id>/` bundles
  may vendor their own dependencies (three.js is sanctioned); none may become
  a core runtime dependency. Core escape hatch: vendoring a specific, frozen,
  auditable single-file library in-repo is allowed when it beats rewriting
  (the GLTFLoader pattern). Never hand-roll cryptography — `node:crypto`
  covers it. If core ever needs a capability where hand-rolling is riskier
  than depending, that is a named decision for the human, never a silent
  install. Rationale (re-affirmed 2026-08-02, loop/graph-engineering audit):
  the orchestrator that commits to every project is the worst place for
  supply-chain surface; in-repo code stays legible to the agents that
  maintain it; and "own your control flow" beats any orchestration framework
  — Atelier IS the orchestration layer.
- **Lift, don't rewrite.** The security core (415 Content-Type gate, 256KB
  body cap, leading-dash rejection, execFile argv arrays - never a shell)
  came verbatim from a verified seed. Never weaken or reimplement it.
- **Loopback only.** The server binds 127.0.0.1 explicitly. No auth exists;
  adding remote exposure without auth is forbidden.
- **br runs against the configured tracker directory, never a dispatch worktree.**
  The default is the PRIMARY checkout; `trackerPath` may instead select an
  external Atelier-owned directory. Tracker state is per-directory and worktree
  br writes strand (see docs/lessons/). Dispatch code injects this rule.
- **Atelier writes no application/runtime files into tracked project trees.**
  Registry, dispatch, worktree, and default tracker state stays under XDG.
  The only tracked-tree exception is `.beads` after the user explicitly chooses
  an in-repo tracker placement. Tracker moves never git-add or commit it (or
  its removal); the user's repository means the user's commit. An explicitly
  selected tracker-only folder outside XDG is also Atelier-owned.
- **Dispatches never touch primary checkouts.** Worktree per dispatch, based
  on a clean ref. Respect per-project `warn` fields (forbidden commands).
- **Agent/UI parity (the Moss principle).** AI agents get FULL control:
  every UI capability has an MCP/API equivalent - oversight is alerts,
  audit trails, and gates that bind everyone equally (budget, verify,
  the human merge click), NEVER capability asymmetry. Consequential
  tools carry honest annotations; none are withheld.
- **No secrets** in the registry, logs, or streamed events (redact tool
  inputs before emit). Dispatch env strips inherited secret-shaped variables,
  including ANTHROPIC_API_KEY and OPENAI_API_KEY (subscription billing guard).

## Working here

- Tracker: an Atelier-owned tracker outside the repo (`br ready` /
  `br update --claim`). This repository does not ship a committed `.beads`.
- Windows-portable: node:path everywhere, no symlinks, POSIX+win32 branches
  for process-group kill and XDG paths.
- Verify: `node --test` (from the repo root) plus the injection probe in docs/SECURITY.md
  before any change to request handling, exec, or dispatch surfaces.
- Lessons: durable traps go to docs/lessons/ (one-line INDEX entry, payload
  in the file) - same compound loop as the Moss repo that birthed this tool.
