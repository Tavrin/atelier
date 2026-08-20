# Security policy

## Reporting a vulnerability

Email **etienne.doux.pro@gmail.com**. Please do not open a public issue for a
security problem.

If GitHub's private vulnerability reporting is enabled on this repository, the
**Report a vulnerability** button under the Security tab works too — but email
is the channel that is always available.

Before reporting, it is worth reading the threat model below and the execution
confinement section of [docs/SECURITY.md](docs/SECURITY.md) — several things that
look like findings are documented defaults, and the document says plainly which.

Include what you can: the version or commit, the affected surface, a
reproduction, and what an attacker gains. I am a single maintainer, so expect
an acknowledgement in days rather than hours.

## What Atelier's threat model actually is

Atelier is a **single-user, local-only tool that deliberately runs coding
agents which execute code on your machine**. Some things that would be
vulnerabilities in a web application are, here, the entire point of the
program. Reports are most useful when they respect that boundary.

**In scope** — these are real bugs, please report them:

- Anything reachable from the loopback HTTP surface that escapes the intended
  request handling: bypassing authentication, Host/Origin/CSRF enforcement,
  the JSON content-type gate, the 256 KB body cap, or leading-dash rejection.
- **Any path that reaches a shell.** Subprocesses are executed with argv
  arrays; a shell being invoked on user-influenced input is a bug regardless of
  whether you can demonstrate an exploit.
- A credential that Atelier's redaction and environment-hygiene patterns are
  meant to catch surviving into the event log, persisted dispatch records,
  streamed events, or a dispatch's environment — `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY` among them. Both mechanisms are pattern denylists by design,
  so a *novel* credential format slipping through is a gap to widen the patterns
  for rather than a vulnerability; a value the existing patterns should have
  matched and did not is a bug.
- A dispatch escaping its worktree to modify the primary checkout, or the merge
  gate accepting work it should refuse — merging without a finalized result, an
  attestation bound to that exact commit and result version, or a matching branch
  head; merging an empty dispatch; or reaching any of that without consuming a
  valid human-minted break-glass token.
- Automation obtaining override authority: an automation bearer or the sandbox
  broker reaching `force: true` or `/api/break-glass`, or a break-glass token
  being replayed, used past expiry, or used against a different dispatch or commit
  than it was bound to.
- A sandboxed dispatch escaping its declared confinement, or an enforcing trust
  profile silently downgrading to `trusted-local` instead of failing closed.
- Path traversal in the static file surface or theme bundle loading.

**Out of scope** — these are documented design decisions, not findings:

- **Remote access.** Authentication protects the loopback control plane; it is
  not permission to bind Atelier to a network interface. Remote exposure is unsupported.
- **Agents execute code, and by default nothing contains them.** That is the
  product. The default trust profile is `trusted-local`: a dispatched agent runs
  as your user with your files, credentials and network, and the worktree is a
  working-tree boundary, not a sandbox. "The default profile provides no OS
  isolation" is documented behavior — see
  [docs/SECURITY.md](docs/SECURITY.md) — not a finding. A *sandboxed* profile
  failing to confine what it claims to confine is very much a finding.

- **Theme trust tiers are metadata today, not an enforced boundary.** First-party
  themes execute same-page with the browser session's authority; the manifest
  tier is a label, and the iframe/grant isolation it anticipates is unimplemented.
  A theme "escaping its tier" is therefore not currently a boundary violation.
  Path traversal in theme bundle loading still is, and remains in scope above.
- Anything requiring an attacker who already has local shell access as your
  user. At that point they have your agent credentials regardless.
- Prompt injection *into an agent* through content you asked that agent to
  read. Atelier isolates the blast radius via worktrees and the merge gate; it
  cannot make an agent immune to its own inputs.

## Supported versions

Atelier is pre-1.0 and single-maintainer. Fixes land on `main`; there are no
backported release branches.
