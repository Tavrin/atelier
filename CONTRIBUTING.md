# Contributing to Atelier

Thanks for looking. Atelier is a single-maintainer project, so the most useful
thing you can do is tell me what broke, on what platform, with the output.

## Before you open a PR

[AGENTS.md](AGENTS.md) holds the binding rules. Two of them will reject a PR on
sight, so they are worth stating here:

**Core takes no runtime dependencies.** Not one. Atelier core is Node standard
library ESM — no npm install, no build step, no CDN. `node:*` modules are not
dependencies and are unrestricted. A self-contained `themes/<id>/` bundle may
vendor a frozen, auditable, single-file library in-repo (three.js is the
sanctioned precedent), but nothing may become a core runtime dependency. If you
believe core genuinely needs a capability where hand-rolling is riskier than
depending, say so in an issue first — that is a decision, never a silent
install.

**The security core is lifted, not rewritten.** The 415 content-type gate, the
256 KB body cap, leading-dash rejection, and `execFile` argv arrays (never a
shell) came from a verified source. Do not weaken or reimplement them.

## Verifying

```sh
node --test          # from the repository root
```

For any change to request handling, subprocess execution, or dispatch
surfaces, also run the injection probe described in
[docs/SECURITY.md](docs/SECURITY.md).

The suite is currently 828 cases and should be fully green before and after
your change. Browser tests (`*.browser.test.mjs`) need headless Chrome and are
excluded from that count.

## Especially wanted

- **Windows verification.** The code is written to be portable but has never
  been run end to end on Windows. [docs/WINDOWS.md](docs/WINDOWS.md) is the
  checklist; results either way are valuable.
- **macOS confirmation.** Should work, not routinely exercised.
- **Agent adapters.** [docs/AGENTS-ADAPTERS.md](docs/AGENTS-ADAPTERS.md)
  defines the contract for integrating an agent CLI beyond `claude` and
  `codex`. Adapters must model what a lane genuinely cannot do rather than
  pretending capabilities are uniform.
- **Themes.** [docs/THEMES.md](docs/THEMES.md) is the handbook. The honesty
  rule is the interesting constraint: nothing may be rendered from vibes,
  elapsed time, or output volume — every visual must map to a field that
  exists.

## Reporting bugs

Include the command, the full output, your OS and `node --version`, and
whether it reproduces on a second run. If it involves a dispatch, the relevant
lines from `atelier logs` are usually the fastest way to a diagnosis — that
event log exists precisely so "why did it do that" has an answer.

## Security

Do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).
