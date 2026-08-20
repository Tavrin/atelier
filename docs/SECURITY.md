# Atelier Security Model

Atelier is a single-user, single-machine tool with local authentication. Its server
is safe to use only while it remains bound to the loopback interface. The
threat model covers hostile web pages attempting localhost requests,
user-controlled strings reaching subprocesses, accidental project-tree writes,
unexpected API billing, and credentials appearing in operator-visible output.

## Execution confinement: what a dispatched agent can actually reach

This is the section to read first, because it is the one people assume rather
than check. Atelier's default is **not** a sandbox.

A trust profile has two fields, `confinement` and `credential`. The built-in
default is `{confinement: "trusted-local", credential: "none"}` — the code's own
label for it is `trusted-local (no isolation; ...)`. Projects and operator
defaults may select a different profile; nothing selects one for you.

| | `trusted-local` (default) | `advisory` | `sandboxed-write` / `sandboxed-review-readonly` |
|---|---|---|---|
| **OS containment** | none | none — non-enforcing label only | namespaces unshared via `bwrap` |
| **Platform** | any | any | **Linux only.** No backend exists on macOS or Windows |
| **Backends** | n/a | n/a | `bwrap` implemented; `podman` is detected but wrapping is unimplemented and fails closed |
| **Usable with the shipped agent CLIs** | yes | yes | **no — see below** |
| **Writable roots** | everything your user can write | everything your user can write | the workspace plus operator-approved roots; user home, `/tmp` and the runtime dir are masked |
| **Network** | full | full | unshared; no loopback |
| **Credential mode** | inherited, minus secret-shaped env keys | same | `brokered` or `in-sandbox`; brokered access reaches the daemon only over a bound unix socket |
| **Daemon API** | full loopback API | full loopback API | allowlisted broker paths only; `/api/session` and `/api/break-glass` denied unconditionally, before allowlist matching |
| **Verification posture** | commands run unconfined | unconfined | same enforced mounts as the agent |

**Why the sandboxed profiles cannot be used with `claude` or `codex` today.**
Enforcing confinement unshares the network, and the broker deliberately does not
proxy provider APIs. Every agent adapter this repository ships declares that it
requires provider network access, so admission refuses the combination with
`EATELIER_SANDBOX_NETWORK_INCOMPATIBLE` rather than launching something that
would fail obscurely or, worse, appear confined. The sandbox is real, tested and
fail-closed; it is waiting on an agent that can work without reaching a remote
API from inside the sandbox. Until then, **every dispatch of a shipped lane runs
`trusted-local`.**

Fail-closed is the rule throughout: if an enforcing profile is selected and no
backend is available, the dispatch is refused. Atelier does not silently downgrade
to `trusted-local`.

### What the worktree does and does not give you

A dispatch worktree is a real boundary for *file writes to tracked content*: the
agent edits its own working tree, and your primary checkout's files are not
modified. It is not a process, network, credential, or permission boundary, and
the worktrees share the repository's Git metadata — creating and removing them
writes to the primary repository's `.git`, and branches are visible repository-wide.

### Verification containment

The normal path is contained by construction: once a result is finalized, Atelier
creates a **detached checkout of the result commit** under
`<stateDir>/verify-worktrees/`, redirects build caches to a scratch directory,
and treats the tested tree as read-only apart from an operator-owned side-effect
allowlist (empty by default). A clean run produces an attestation bound to that
commit and tree, and the merge gate compares it against the branch head.

There is one residual. If verification runs when no finalized result commit and
tree exist yet, it runs **in the agent's own writable dispatch worktree**, and
produces no attestation. That path is bounded rather than contained: the ordinary
merge gate refuses any record without `result.commit` and a matching attestation,
so such a run cannot merge — but it did execute your verification commands in a
tree the agent can still write. This coupling is known and recorded in the code
at its site.

Note also that under `trusted-local` — the default — the read-only tested tree and
scratch-directory redirection are *requested* through the same profile-aware
wrapper the sandbox uses, but nothing enforces them at the OS level. They are
real hygiene, not a containment guarantee.

## Enforced controls

1. **Loopback binding and local authentication.** The server binds `127.0.0.1`,
   never `0.0.0.0`. On first start it writes a 0600 installation secret to
   `${ATELIER_STATE_DIR:-~/.local/state/atelier}/auth-secret`. API reads require
   a signed bearer or browser session. Mutations additionally enforce the exact
   loopback Host and same-origin Origin; browser mutations require the session's
   CSRF token. Remote exposure remains forbidden.
   This authentication does not defend against another trusted-local process
   running as the same OS user: the session bootstrap is unauthenticated (Host-
   checked only), so any local process able to reach the port can obtain a
   `human-ui` session. Treat it as discipline against hostile web pages and
   stray clients, not as a boundary between local processes.
   *When* a sandboxed profile is in use — see the confinement section above for
   why that is not currently possible with the shipped lanes — the dispatch has
   no loopback network and reaches the daemon only through a bound unix broker
   socket. The operator-owned broker allowlist denies unknown paths and
   unconditionally denies `/api/session` and `/api/break-glass` before allowlist
   matching. The broker does not provide remote provider API access.
2. **No shell execution.** Subprocesses use `execFile` or `spawn` with explicit
   argv arrays. User strings remain single arguments and are never interpolated
   into a shell command.
3. **Argument and path gates.** User-supplied subprocess arguments reject a
   leading dash. Dispatch slugs match `/^[a-z0-9-]{1,40}$/`; registry paths are
   absolute existing directories; traversal is rejected before `git worktree
   add`.
4. **Browser mutation gate.** POST and PATCH requests require
   `Content-Type: application/json` and bodies are capped at 256KB. This forces
   ordinary cross-origin browser mutations through a CORS preflight Atelier does not
   answer. The UI bootstraps an HttpOnly, SameSite=Strict session cookie and
   attaches `X-Atelier-CSRF` to mutations.
5. **Project-tree invisibility.** Atelier keeps registry, runtime records,
   worktrees, and default tracker-only stores under XDG config/state roots. An
   explicitly selected tracker-only folder is Atelier-owned and is the sole
   exception. Dispatch branches are local-only and explicit dismissal removes
   their worktree and branch.
6. **Merge authority and override authority are different things.** An ordinary
   merge requires a finalized result, an attestation bound to that exact commit
   and result version, a branch head that still matches, and any configured
   review — and empty dispatches can never merge. Ordinary merge is a normal
   capability available over the API and MCP; it is not reserved to a human.
   What *is* reserved: forcing a merge past those checks requires a break-glass
   token minted from a human browser session, bound to one dispatch, action and
   commit, single-use, expiring, and audited on both mint and consumption.
   Automation bearers are refused `force: true` outright, and the sandbox broker
   denies `/api/break-glass` unconditionally.
7. **Per-project command warnings.** Registry `warn` entries are injected into
   dispatch prompts and surfaced in the UI. They guide the agent; they are not a
   subprocess policy engine.

## Best-effort safeguards and limits

### Output masking

At the dispatcher emit boundary, Atelier masks common credential-shaped strings
in assistant text, raw lines, tool results, tool-input previews, verification
output, status detail, and exit summaries before events are persisted or sent
over SSE. Tool-input objects also retain field-level masking for keys matching
`key|token|secret|password`.

The structured event log (`~/.local/state/atelier/logs/`, atelier-e5x) redacts at
WRITE time through the same shared redactor - `redactValue` in
`server/lib/stream.mjs`, so secret-shaped KEYS are blanked and credential shapes
in strings replaced before a line is ever appended, never at read time. Settings
and registry events carry field-level before/after diffs, which is exactly why
that ordering matters. Event values are also length-bounded, and an oversized
event degrades to its identity fields rather than being dropped.

This is pattern-based, best-effort masking, not a guarantee that logs are
secret-free. Unknown credential formats, encoded values, short tokens, or
secrets split across events can evade it. Treat dispatch JSONL, the event log,
and UI output as sensitive, review artifacts before sharing them, and add newly
observed formats to `REDACT_TEXT_PATTERNS` in `server/lib/stream.mjs`.

### Environment hygiene

`envHygiene()` is a denylist, not an allowlist or sandbox. It removes inherited
environment keys containing `key`, `token`, `secret`, `password`, `passwd`, or
`credential` (case-insensitive), plus `SSH_AUTH_SOCK` and `GPG_AGENT_INFO`.
The environment policy and sandbox use this one shared classifier, including
for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so a
stray exported key cannot silently switch an agent from subscription billing to
API billing. Other inherited environment variables remain available to the
child process. Registry validation uses the same secret-shaped key pattern for
dispatch environment values, but operators must still avoid placing credentials
in Atelier configuration or dispatch prompts.

### Outbound notification boundary

Atelier has no default notification egress. Setting `defaults.notifyUrl` is an
explicit opt-in to send redacted dispatch metadata to that URL. Redaction is a
best-effort safeguard, not permission to send the payload to a third party:
ticket IDs, review summaries, and bounded failure evidence can still disclose
private work. Use only a SELF-HOSTED endpoint on localhost or infrastructure
you control, as described in [NOTIFICATIONS.md](NOTIFICATIONS.md).

The dispatcher sends no notification authentication header. Do not place a
username, password, bearer token, or secret topic in `notifyUrl`; the registry
is intentionally not a credential store. Put authentication at an
operator-controlled local proxy if it is required. Exposing the receiver over
a tailnet does not authorize exposing Atelier itself: Atelier remains bound to
`127.0.0.1`.

## Probe suite

Run `npm test` after any change to request handling, subprocess execution,
dispatch, or streaming. (Bare `node --test` discovers the browser suites and
hangs; see CONTRIBUTING.md.) The suite covers these security contracts:

1. A dispatch prompt beginning with `-` is rejected before subprocess launch.
2. Shell metacharacters in a comment remain literal data.
3. Missing JSON content type returns 415 and a body over 256KB returns 413.
4. Dispatch traversal/dot slugs are rejected before any Git call.
5. The listener binds only to `127.0.0.1`.
6. Known credential patterns are absent from emitted and persisted events,
   including verification output, while benign text remains unchanged.
