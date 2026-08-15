---
title: Advertised MCP schemas do not validate runtime tool arguments
tags: [mcp, validation, http]
crates: [server]
symptom: A misspelled tool field reaches the loopback API and returns an unrelated HTTP error.
root-cause: tools/list published inputSchema objects but tools/call never evaluated arguments against them.
prevention: Validate unknown, missing, and mistyped fields against the exact advertised schema before any proxy request.
promoted: mechanized:server/lib/mcp.test.mjs
date: 2026-07-22
---

# The trap

An MCP caller sent `patch` instead of the required `fields` argument to
`atelier_settings_patch`. The bridge forwarded a body-less PATCH, so the useful
schema mistake was hidden behind the HTTP server's Content-Type 415 response.

# How to detect

Exercise wrong field names, missing required fields, and wrong JSON types at
`tools/call`; each must return JSON-RPC `-32602` and make zero HTTP requests.

# References

- `server/lib/mcp.mjs`
- `server/lib/mcp.test.mjs`
