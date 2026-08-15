---
title: Fresh tabs break when request-time UI reads outrun the running server allowlist
tags: [server, ui, lifecycle]
crates: [atelier-server]
symptom: After merging a new UI module, refreshed tabs hang on Loading projects until Atelier restarts
root-cause: The old process serves the newly merged app.js from disk, but its in-memory static allowlist has no route for that app's new import
prevention: Snapshot every allowlisted UI asset before listening, and traverse served module imports in a regression test so allowlist drift fails the gate
promoted: mechanized:server/server.test.mjs
date: 2026-07-22
---

# The trap

Atelier used to read each UI asset from the checkout on every request. A merge
could therefore make a fresh tab receive new JavaScript from an old process;
if that JavaScript imported a newly added module, the old route map returned
404 and the app never booted. This happened twice in one day.

# How to detect

Start a server, change a copied UI tree, and verify the running instance still
serves its original bytes while a restarted instance serves the update. Walk
all static imports reachable from served `/app.js` and require every route to
return JavaScript successfully.

# References

- `server/server.mjs`
- `server/server.test.mjs`
