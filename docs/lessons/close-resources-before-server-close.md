---
title: SIGTERM hangs when cleanup waits for the HTTP close event that active SSE streams prevent
tags: [server, sse, lifecycle]
crates: [atelier-server]
symptom: A service restart reaches its stop timeout and systemd escalates SIGTERM to SIGKILL
root-cause: `server.close()` stops new accepts but waits for active SSE responses, while SSE and watcher cleanup was registered on the eventual close event
prevention: Stop accepting first, then synchronously end owned SSE responses and close watchers before awaiting the server close event; keep a bounded socket fallback
promoted: mechanized:server/cli.test.mjs
date: 2026-07-22
---

# The trap

Node's `server.close()` does not make an active event-stream response disappear.
If resource cleanup only runs on the server's `close` event, the stream prevents
that event, watchers remain live, and the instance lock is never released.

# How to detect

Start `atelier serve`, open an SSE endpoint, send SIGTERM or SIGINT, and assert the
process exits within two seconds with an EOF on the stream and no `atelier.lock`.

# References

- `server/server.mjs`
- `bin/atelier.mjs`
- `server/cli.test.mjs`
