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
npm test             # from the repository root
```

`npm test` runs `scripts/test-batch.mjs`, which is the exact batch CI gates on,
and it prints the number of files it is running so nobody has to trust a number
written down in a document. It should be fully green before and after your
change. Two things sit outside it: the browser suites (below), and the injection
probe for security-sensitive changes (below).

Do **not** use a bare `node --test`. It discovers every `*.test.mjs` in the tree,
including the browser suites that need headless Chrome and the frozen theme
suites, and it hangs rather than failing — it once sat for an hour and thirteen
minutes in CI against a batch that takes about seventy seconds. The batch script
enumerates its file list explicitly because Node's test runner has no file-level
exclude flag. `npm run test:all` is that bare run, kept only for the rare case
where you want it.

**One precondition the suite does not create for you.** Some dispatch tests
resolve the executables `claude` and `br` through `PATH`. **Both names must
resolve** — roughly forty cases in `server/lib/dispatch.test.mjs` fail otherwise.
CI installs a harmless stub for each; the repository does not currently ship
them, so a clean checkout without both binaries will not go fully green. If you
hit that, it is this, not your change. The real CLIs work, and so does an
executable no-op file named `claude` and another named `br` on your `PATH`.

For any change to request handling, subprocess execution, or dispatch
surfaces, also run the injection probe: it is not a separate command but the
set of security contracts listed under "Probe suite" in
[docs/SECURITY.md](docs/SECURITY.md), which `npm test` covers — read that list
and confirm your change did not weaken any of them.

Browser tests (`*.browser.test.mjs`) need headless Chrome and are outside the
batch; run them with a browser available.

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
