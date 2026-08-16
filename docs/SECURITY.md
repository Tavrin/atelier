# Atelier Security Model

Atelier is a single-user, single-machine tool with local authentication. Its server
is safe to use only while it remains bound to the loopback interface. The
threat model covers hostile web pages attempting localhost requests,
user-controlled strings reaching subprocesses, accidental project-tree writes,
unexpected API billing, and credentials appearing in operator-visible output.

## Enforced controls

1. **Loopback binding and local authentication.** The server binds `127.0.0.1`,
   never `0.0.0.0`. On first start it writes a 0600 installation secret to
   `${ATELIER_STATE_DIR:-~/.local/state/atelier}/auth-secret`. API reads require
   a signed bearer or browser session. Mutations additionally enforce the exact
   loopback Host and same-origin Origin; browser mutations require the session's
   CSRF token. Remote exposure remains forbidden.
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
6. **Per-project command warnings.** Registry `warn` entries are injected into
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
environment keys matching `key|token|secret|password|credential`
(case-insensitive), including `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, so a
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

Run `node --test` after any change to request handling, subprocess execution,
dispatch, or streaming. The suite covers these security contracts:

1. A dispatch prompt beginning with `-` is rejected before subprocess launch.
2. Shell metacharacters in a comment remain literal data.
3. Missing JSON content type returns 415 and a body over 256KB returns 413.
4. Dispatch traversal/dot slugs are rejected before any Git call.
5. The listener binds only to `127.0.0.1`.
6. Known credential patterns are absent from emitted and persisted events,
   including verification output, while benign text remains unchanged.
