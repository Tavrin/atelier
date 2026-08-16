# Security policy

## Reporting a vulnerability

Email **etienne.doux.pro@gmail.com**. Please do not open a public issue for a
security problem.

If GitHub's private vulnerability reporting is enabled on this repository, the
**Report a vulnerability** button under the Security tab works too — but email
is the channel that is always available.

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
- Secrets surviving redaction — appearing in the event log, persisted dispatch
  records, streamed events, or a dispatch's environment. Dispatch environments
  are meant to strip secret-shaped variables including `ANTHROPIC_API_KEY` and
  `OPENAI_API_KEY`.
- A dispatch escaping its worktree to modify the primary checkout, or the merge
  gate accepting work it should refuse (unverified, empty, or stale).
- Path traversal in the static file surface or theme bundle loading.
- A theme escaping its declared trust tier.

**Out of scope** — these are documented design decisions, not findings:

- **Remote access.** Authentication protects the loopback control plane; it is
  not permission to bind Atelier to a network interface. Remote exposure is unsupported.
- **Agents execute code.** That is the product. A dispatch running arbitrary
  commands inside its own worktree is intended behavior.
- Anything requiring an attacker who already has local shell access as your
  user. At that point they have your agent credentials regardless.
- Prompt injection *into an agent* through content you asked that agent to
  read. Atelier isolates the blast radius via worktrees and the merge gate; it
  cannot make an agent immune to its own inputs.

## Supported versions

Atelier is pre-1.0 and single-maintainer. Fixes land on `main`; there are no
backported release branches.
