# Atelier MCP bridge

`atelier mcp` exposes the running Atelier cockpit to MCP clients as a fixed set of
tools. It is a zero-dependency MCP server over stdio: Node reads and writes
JSON-RPC 2.0 messages while every tool operation is forwarded with `fetch` to
the existing loopback HTTP API.

The Atelier service must already be running. By default the bridge connects to
`http://127.0.0.1:5170`; `atelier mcp --port <port>` overrides `PORT`, which in
turn overrides the default. If the service cannot be reached, the tool result
asks the operator to run `systemctl --user start atelier`.

## Architecture

```text
MCP client -- stdio JSON-RPC --> atelier mcp -- loopback HTTP/SSE --> running Atelier service
                                                                       |
                                                registry + tracker + dispatcher + event logs
```

The bridge deliberately owns no registry, tracker, dispatcher, process, or
event-stream state. The running service is the single source of truth for live
dispatches and all mutations. This avoids a second in-memory dispatcher view,
competing lifecycle decisions, or tracker writes from the wrong directory.
Server-side validation and gates therefore apply identically to the web UI,
CLI proxy commands, and MCP tools.

`atelier_dispatch_tail` is the one SSE-backed read. It consumes only the
service's replay prefix, slices the last requested events, and aborts at the
first heartbeat instead of following the live stream.

## Register the server

Use an absolute path to the Atelier checkout. Start the Atelier service separately,
then register the stdio subprocess with the MCP client.

Claude Code:

```sh
claude mcp add --scope user atelier -- node /absolute/path/to/atelier/bin/atelier.mjs mcp
```

For a non-default service port, append `--port <port>` after `mcp`.

Generic stdio client configuration:

```json
{
  "mcpServers": {
    "atelier": {
      "command": "node",
      "args": [
        "/absolute/path/to/atelier/bin/atelier.mjs",
        "mcp"
      ]
    }
  }
}
```

Clients whose configuration supports environment variables may set `PORT`
instead of adding `--port` to `args`.

## Tools

Every tool publishes a title, description, JSON Schema input, and explicit
`readOnlyHint` and `destructiveHint` annotations. Optional inputs are marked
with `?` below.

| Tool | Inputs | `readOnlyHint` | `destructiveHint` | Result or effect |
| --- | --- | ---: | ---: | --- |
| `atelier_projects` | none | `true` | `false` | Lists projects with archetype, capabilities, and automation flags. |
| `atelier_agents` | none | `true` | `false` | Lists registered adapters, capabilities, and dispatch options. |
| `atelier_board` | `project` | `true` | `false` | Returns the project's `/state` board shape. |
| `atelier_ticket` | `project`, `id` | `true` | `false` | Returns one ticket with description, status, and comments. |
| `atelier_chronicle` | `project?` | `true` | `false` | Without `project`, returns the bounded aggregate merged-work chronicle. With `project`, returns that project's chronicle and outcome-derived scorecard. Both are frozen at server boot; `generatedAt` is the freshness timestamp. |
| `atelier_dispatches` | `project?`, `state?` | `true` | `false` | Returns dispatch records matching the optional filters. |
| `atelier_dispatch` | `id` | `true` | `false` | Returns one full dispatch record. |
| `atelier_dispatch_tail` | `id`, `lines?` (default `50`) | `true` | `false` | Returns the last replayed transcript events without following. |
| `atelier_dispatch_diff` | `id`, `patch?` (default `true`) | `true` | `false` | Returns diff statistics and an optional bounded unified patch. |
| `atelier_rollup` | none | `true` | `false` | Returns the service's cost rollup. |
| `atelier_logs` | `kind?` (comma-separated), `project?`, `dispatchId?`, `ticketId?`, `actor?`, `source?`, `since?`, `limit?` (default `200`, max `1000`) | `true` | `false` | Returns the newest matching structured event-log entries in chronological order: queue drain decisions, dispatch transitions and actions with actor/failure context, settings/registry changes with actor and field diffs, budget verdicts, park/un-park, and service lifecycle. |
| `atelier_settings` | `project` | `true` | `false` | Returns the project's mutable-settings view. |
| `atelier_queue` | `project` | `true` | `false` | Returns ready-queue state, including breaker failures and the last error. |
| `atelier_main_health` | `project` | `true` | `false` | Returns the project's post-merge verification banner state, including unresolved failures. |
| `atelier_convoys` | `project?`, `id?` | `true` | `false` | Lists convoy status with optional project and id filters. |
| `atelier_ticket_create` | `project`, `title`, `description`, `type`, `priority` | `false` | `false` | Creates a tracker ticket. |
| `atelier_ticket_comment` | `project`, `id`, `text` | `false` | `false` | Adds a ticket comment. |
| `atelier_ticket_action` | `project`, `id`, `action`, `actor?` | `false` | `false` | Claims a ticket for the required actor or promotes a triage ticket. |
| `atelier_ticket_close` | `project`, `id`, `reason` | `false` | `true` | Closes a ticket with the supplied reason. |
| `atelier_dispatch_start` | `project`, `ticketId?`, `prompt?`, `lane?`, `model?`, `effort?`, `maxTurns?`, `planFirst?`, `force?` | `false` | `false` | Starts an isolated dispatch through the service. |
| `atelier_bakeoff_start` | `project`, `ticketId`, `lanes?` (default Claude + Codex), `force?` | `false` | `false` | Starts two isolated attempts on distinct agent lanes. |
| `atelier_reply` | `id`, `text`, `force?` | `false` | `false` | Sends live input or resumes a supported dispatch. |
| `atelier_plan_action` | `id`, `action`, `text?`, `force?` | `false` | `false` | Approves a plan or requests revision. |
| `atelier_review` | `id`, `force?` | `false` | `false` | Starts a linked read-only spec-audit dispatch. |
| `atelier_review_disposition` | `id`, `findingRef`, `disposition`, `redirectTicket?`, `note`, `actor` | `false` | `false` | Appends an audited human disposition (`accepted`, `refuted`, `redirected`, or `waived`) for one structured review finding; `redirectTicket` is required only for `redirected`. |
| `atelier_verify_rerun` | `id` | `false` | `false` | Re-runs worktree verification on a completed dispatch whose verdict failed; retains every attempt. |
| `atelier_merge` | `id`, `force?`, `forcedBy?`, `reason?`, `dispositionRef?` | `false` | `false` | Requests the service's gated merge. When `force` is `true`, the audit triple `forcedBy`, `reason`, and `dispositionRef` is required. |
| `atelier_main_health_ack` | `id` | `false` | `false` | Acknowledges an unresolved post-merge verification failure. |
| `atelier_dismiss` | `id` | `false` | `true` | Removes a terminal dispatch's worktree and branch. |
| `atelier_stop` | `id` | `false` | `true` | Stops an active dispatch and its process group. |
| `atelier_settings_patch` | `project`, `fields` | `false` | `false` | Patches fields accepted by the mutable project-settings API. |
| `atelier_queue_set` | `project`, `enabled` | `false` | `false` | Enables or pauses ready-queue autonomy. |
| `atelier_queue_resume` | `project`, `resumeTicketId` | `false` | `false` | Un-parks a ready-queue ticket that hit its consecutive-failure limit. |
| `atelier_convoy_create` | `project`, `ticketIds` (2..20 unique ids) | `false` | `false` | Starts an ordered convoy. |
| `atelier_convoy_resume` | `id` | `false` | `false` | Resumes a paused convoy at its current ticket. |
| `atelier_convoy_cancel` | `id` | `false` | `true` | Cancels future convoy progression without stopping the in-flight dispatch. |
| `atelier_doctor_gc` | `olderThanDays?` (default `7`), `dryRun?` (default `false`) | `false` | `true` | Dismisses old terminal dispatches and removes orphan Atelier worktrees, or reports candidates in dry-run mode. |
| `atelier_project_add` | `registration` | `false` | `false` | Atomically registers a validated project using the onboarding API. |
| `atelier_project_remove` | `project` | `false` | `true` | Removes a registry entry without deleting repository or tracker files. |
| `atelier_tracker_move` | `project`, `to` (`external` or `in-repo`) | `false` | `true` | Moves the complete tracker and runs the server's rollback-protected smoke check. |
| `atelier_open_editor` | exactly one of `project` or `id` | `false` | `false` | Opens a project or dispatch worktree using the server-configured editor command. |

Unknown, missing, and mistyped tool arguments are rejected as JSON-RPC invalid
parameters (`-32602`) before any HTTP request. That boundary validation follows
the published input schemas, including nested settings and project-registration
fields. HTTP 4xx and 5xx responses become MCP tool results with `isError: true`;
the service's human-readable error text is preserved verbatim. Structured HTTP
error fields are preserved as JSON text, including bake-off budget metadata
needed for a deliberate `force` retry. Project,
tracker, dispatch, budget, lifecycle, and filesystem gates remain authoritative
in the running service.

## Trust and safety

Registering this server gives an MCP host tools that can mutate the local Atelier
cockpit. Review tool calls and arguments before approving them. Tool annotations
are descriptive hints, not enforcement.

The bridge does not bypass Atelier's server-side controls. Dispatch caps, daily
cost budgets, daily unpriced-dispatch caps, tracker placement, plan state,
verification requirements, force
handling, merge gates, and dismiss eligibility remain authoritative in the
loopback service. In particular, `atelier_merge` remains gated even though its
`destructiveHint` is `false`, while `atelier_dismiss` is marked destructive
because it removes the retained worktree and branch. Convoy cancellation,
garbage collection, project removal, and tracker moves are also marked
destructive. Project removal only deregisters the project; it does not delete
the repository or tracker files. `atelier_dismiss` and `atelier_doctor_gc` succeed
on a terminal dispatch whose project was later deregistered, but the contract
is deliberately asymmetric: the RECORD is removed (dismissed) either way, but
its worktree is never deleted without a registered project to re-verify
ownership of that path against. Without one, dismissal only reports the
worktree as unremoved (a `worktree not removed (project deregistered): ...`
warning on the record, surfaced in `atelier_doctor_gc`'s result too) and leaves
it for manual cleanup or for `atelier_project_add` to re-register the project
first, which restores the normal git-backed cleanup path. Anything needing
project config beyond that (merge, verify re-run, resume, an active/
non-terminal dispatch) still refuses outright with the same 404.
`atelier_queue_set` remains non-destructive because the persisted toggle can be
reversed without removing work.

Atelier has no authentication and remains loopback-only. Do not expose either
the cockpit service or this local stdio integration as a remote unauthenticated
service.

The bridge stamps proxied requests with the syntactically validated actor
`mcp`; the dashboard and first-party themes similarly stamp `ui` or
`theme:<id>`. These labels are audit attribution, not authenticated provenance:
the loopback API validates only their bounded shape, and same-page theme code
shares the MVP trust boundary. Enforced theme tiers and provenance remain
future isolation work. Chronicle responses are likewise a boot snapshot, not
live history: they stay frozen until restart, and `generatedAt` is the freshness
contract. A project registered after boot receives an empty bounded
per-project chronicle with that boot timestamp and remains absent from the
aggregate until Atelier restarts.

## Protocol and limitations

The bridge's latest supported protocol revision is
[`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25).
During `initialize` it echoes recognized client revisions (`2024-11-05`,
`2025-03-26`, `2025-06-18`, or `2025-11-25`) and otherwise replies with
`2025-11-25`. It accepts `notifications/initialized`, supports `ping`, and
exits cleanly when the client closes stdin.

The stdio framing follows the MCP transport specification: each message is one
UTF-8 JSON-RPC object delimited by a newline, messages contain no embedded
literal newlines, and stdout contains protocol messages only. This is not
`Content-Length` framing.

No required behavior for the advertised stdio `tools` capability was
intentionally skipped. The implementation deliberately leaves these optional
or unadvertised surfaces out:

- No MCP Streamable HTTP transport; Atelier's HTTP API is an internal loopback
  target behind the stdio bridge, not an MCP endpoint.
- No prompts, resources, completions, logging, tasks, sampling, elicitation,
  roots, or server-initiated requests.
- No tool-list change notifications or pagination; the complete
  manifest-backed tool set is returned in one `tools/list` response.
- No task-augmented tool execution, progress notifications, or structured
  output schemas. Tool results contain JSON serialized as MCP text content.
- No per-request timeout or MCP cancellation handling for ordinary proxied
  fetches. Client EOF or process termination ends the bridge; dispatch
  lifecycle and stopping remain explicit service operations. Transcript replay
  is bounded separately by aborting its SSE request at the first heartbeat.
- No JSON-RPC batch arrays. MCP stdio messages are handled individually, one
  newline-delimited object at a time.
- The bridge does not start, supervise, or reconnect the Atelier service. Service
  lifecycle remains an operator responsibility.
