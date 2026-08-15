# Persisted history must become live before mutation

**Trap.** Dispatch records loaded from `index.jsonl` are inert history, so
background refreshes may replace `entry.record` with the newest snapshot. A
merge that retained the old object across awaited Git commands could update a
detached record while the live entry reverted to pre-merge state.

**Rule.** Once a lifecycle reservation authorizes mutation of a persisted
record, mark the entry non-inert before the first awaited operation. This keeps
history refresh read-only for that live object until the mutation has persisted
its terminal state.

**Applies to.** Merge, resume, dismiss, or any future operation that turns
persisted terminal history back into mutable dispatcher state.
