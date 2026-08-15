# Shared contract files during parallel writers: route around, don't race

**Trap.** Two writers were live at once (a Codex job committing to the
primary; the integrator editing ui/ files). A UI change (button → select)
broke a contract test asserting `id="theme-toggle"` — but the assertion
lives in server.test.mjs, a file the concurrent job was actively editing.
Fixing the assert meant racing a file another writer owned.

**Rule.** When a needed edit lands in a file a concurrent job owns:
prefer satisfying the existing contract (keep the old id on the new
element) and queue the rename for a later, single-writer spec. A slightly
stale name is cheap; a lost write or a mangled merge is not. Same logic
as the primary/worktree split — writers must have disjoint files, and
contract tests count as owned files.

**Applies to.** Any repo where an integrator works alongside delegated
background jobs on the primary checkout.
