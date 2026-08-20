# Evidence store

Atelier's evidence store is a content-addressed, write-once filesystem store for
immutable bodies and typed reference envelopes. It is intentionally independent
of the rotating event log and the rebuildable dispatch index. The module is
self-contained in `server/lib/evidence-store.mjs`; this package does not wire it
into the server, dispatcher, CLI, UI, or MCP.

## Schema and bounds

Schema version 1 envelopes have exactly this shape:

```js
{
  schemaVersion: 1,
  id: "ev1_<64 lowercase hex characters>",
  type: "<bounded type string>",
  contentDigest: "sha256:<64 lowercase hex characters>" | null,
  attributes: { "<bounded key>": "flat scalar value" },
  provenanceRefs: ["ev1_<64 lowercase hex characters>"]
}
```

`type` and attribute keys match `/^[a-z][a-z0-9._-]{0,63}$/`.
`attributes` is a flat plain object with at most 32 keys. Each value is `null`,
a boolean, a finite number other than `-0`, or a string no longer than 512
characters. Nested values, `-0`, non-finite numbers, arrays, and other objects
are rejected rather than silently normalized. `provenanceRefs` contains at most
32 unique syntactically valid envelope ids; its order is meaningful and
preserved. The canonical serialized envelope is limited to 16 KiB. Reads stat
the stored envelope and reject anything larger with
`EVIDENCE_ENVELOPE_TOO_LARGE` before loading its bytes.

A `null` `contentDigest` means the envelope is a pure marker with no body. An
empty body is different: it has the SHA-256 digest of zero bytes and can be read
back as a zero-length `Buffer`. Bodies default to an 8 MiB limit and are
rejected before any filesystem write when they exceed the configured limit.
Body reads and existing-object comparisons stat first and raise
`EVIDENCE_BODY_TOO_LARGE` before loading bytes that exceed the same configured
limit.

## Storage layout

The store is rooted at `join(resolve(stateDir), "evidence")`, where `stateDir`
follows Atelier's XDG/Windows rules and `ATELIER_STATE_DIR` override unless
explicitly passed to `createEvidenceStore`. A relative `stateDir` is resolved
against the current working directory once, when the handle is constructed;
later working-directory changes cannot redirect that handle.

```text
evidence/
  objects/sha256/<first-2-digest-hex>/<remaining-62-digest-hex>
  envelopes/<first-2-id-hex>/<full-envelope-id>.json
```

Directories are created lazily and on demand with mode `0700`; object and
envelope files use mode `0600`. The two-character shards bound directory
fan-out. Every path component derived from an id or digest is sliced only after
the complete caller- or envelope-supplied string passes its strict regular
expression. Before a shard is used for a read or write, every existing
store-owned directory component from `evidence/` through that shard is checked
with `lstat` and must be a real directory, not a symlink. Final reads also
refuse symlinks and non-regular files. These checks raise the cost of a
same-user redirection attack; they do not eliminate it, because another process
running as the owner can race the checks or rewrite state the owner controls.

## Identity and canonical serialization

The v1 identity is:

```text
ev1_ + sha256hex(canonicalJson({
  schemaVersion,
  type,
  contentDigest,
  attributes,
  provenanceRefs
}))
```

Canonical JSON sorts object keys by JavaScript code unit, emits no whitespace,
uses `JSON.stringify` rules for strings and finite numbers, and rejects values
JSON would silently discard: `undefined`, functions, symbols, non-finite
numbers, `BigInt`, cycles, and non-plain objects. Attribute validation also
rejects `-0`, whose JSON spelling would otherwise collide with `0`. Array order
is retained.

Minting the same semantic fields twice therefore produces the same id. If the
canonical envelope and any body already exist intact, the second mint is an
idempotent no-op and reports `created: false`. The store injects no time,
randomness, or counter; it is an identity store, not a clock. Callers that need
two otherwise identical occurrences to remain distinguishable must supply an
occurrence-scoped attribute such as a timestamp, dispatch id, or turn number.

## Integrity chain

Verification is not circular:

1. The caller already holds an `id`; that external reference is the trust
   anchor, not data stored beside the evidence.
2. The id is the envelope filename, and the id is the SHA-256 hash of the
   envelope's canonical identity fields.
3. Those fields include `contentDigest`, the SHA-256 hash of the body.
4. Changing the body makes `contentDigest` fail. Changing `contentDigest` to
   match the altered body changes the recomputed envelope id, which no longer
   matches the caller's reference and filename.
5. Nothing inside the store certifies itself. A read is valid only relative to
   the reference the caller supplied.

`read` parses and validates the exact v1 shape, recomputes the identity from the
envelope fields, compares both the recomputed id and the embedded id with the
requested id, and requires the stored bytes to equal the canonical serialization
exactly. Semantically equivalent but reformatted, key-reordered, escaped, or
duplicate-key JSON is therefore `EVIDENCE_MALFORMED`. This is the load-bearing
check. `readBody` first performs that envelope verification, then hashes the
bounded no-follow body read and compares it with `contentDigest`. Any malformed
data, mismatch, unsupported schema, or unsafe file fails closed with a typed
error; no read repairs data, returns `null`, or falls back to unverified
content.

## API

```js
createEvidenceStore({ stateDir, fileOps, maxBodyBytes })
```

The returned frozen handle contains exactly:

- `mint({ type, body?, attributes?, provenanceRefs? })` writes evidence and
  returns `{ id, contentDigest, created }`. A body is a string encoded as UTF-8,
  a `Uint8Array`, or a `Buffer`.
- `read(id)` returns a validated, frozen envelope.
- `readBody(id)` returns a digest-verified `Buffer`; a marker raises
  `EVIDENCE_NO_BODY`.
- `has(id)` tests envelope-path existence only. It performs no parsing, id
  verification, body lookup, or digest verification and must never be treated
  as an integrity result.
- `resolveProvenance(id)` returns one ordered result per direct reference:
  `{ ref, status: "resolved", type }` when present and valid, or
  `{ ref, status: "unknown" }` when absent. Unknown evidence is a normal state.
  A present but corrupt reference still throws. `resolved` means only that this
  store holds an identity-valid envelope for the reference; it says nothing
  about the presence or integrity of that envelope's body. `readBody` makes the
  body-presence and body-integrity assertion.
- `paths` exposes `{ root, objects, envelopes }` for diagnostics and tests.

All module-defined failures use `EvidenceStoreError` and an exported code from
the frozen `EVIDENCE_ERROR_CODES` map. Missing evidence is distinguishable as
`EVIDENCE_NOT_FOUND`; invalid ids are rejected before filesystem access.

## Write-once durability and crash behavior

Bodies and envelopes are created through a temp-then-link sequence in the
destination shard: create a unique temporary file with
`O_EXCL`/`O_NOFOLLOW`, correct the mode on its open descriptor, write, fsync,
close, atomically hard-link it to the final write-once path, remove the
temporary name, and then best-effort fsync the shard directory. An existing
final path makes the link fail with `EEXIST` and enters bounded idempotency
verification. Existing bodies are rehash-verified. An equal digest is an
idempotent success; complete different bytes at the expected digest path are
`EVIDENCE_CONFLICT`. Existing envelope bytes must equal the newly computed
canonical bytes exactly or minting also fails with `EVIDENCE_CONFLICT`. A
strictly shorter mismatching final file left by the former direct-to-final
writer is recognized as an interrupted write and replaced with the complete
temp file; equal- or greater-length mismatches remain conflicts. No complete
existing store file is overwritten.

A crash during the new write sequence can leave at most an orphan temporary
file in a shard, never a partial file at the final digest or envelope name.
Normal success and failure paths attempt to remove their temporary file. A
future collector should sweep stale temporary files; this package does not yet
implement that garbage collection.

Mint writes the body before the envelope. A crash after the body write and
before envelope publication can leave an unreferenced immutable object. That is
harmless future-collector garbage. The reverse order could expose a dangling
envelope whose promised body never became durable, so it is forbidden. A retry
rehashes the stranded body and can publish the envelope with `created: true`.

## Retention contract

This package implements no deletion, mutation, garbage collection, or
compaction. Atelier retains every stored object and envelope indefinitely.

A future collector must start from explicitly named roots and use
reachability. It must never delete an object referenced by a retained envelope,
and it must never delete an envelope named by a retained envelope's
`provenanceRefs`. Because ids are content-derived, deleting evidence and later
re-minting byte- and field-identical evidence restores the same id; deletion is
not identity revocation. Absence remains `EVIDENCE_NOT_FOUND` or provenance
status `"unknown"`, never invented substitute content.

## Secrets

The store performs no redaction. Silently rewriting a body or attribute would
destroy the evidence it claims to preserve. Mode `0600` protects files at rest,
and this package exposes no client streaming surface, but callers still must not
place credentials in unredacted `attributes`. If capture-time redaction is ever
required, it belongs at the caller's capture boundary before minting.

## Event authority and other non-goals

This store is not an event authority. It has no ordering, sequence number,
internal timestamp, listing or iteration API, recent-history query, log append,
or event emission. The event log remains Atelier's sole operational event
authority, and the evidence store must not acquire a chronological read
surface.

It also does not provide command identities, idempotency keys, context
manifests, attestations, merge-gate fields, indexes, caches, or application
wiring. It neither reads nor migrates any existing Atelier state. The layout is
an isolated immutable blob/envelope contract, not a ledger schema or query
model, so it makes no choice between SQLite or any other future ledger storage
engine and does not constrain that decision.

## Forward compatibility

This implementation writes and reads v1 only. Encountering another
`schemaVersion` raises `EVIDENCE_UNSUPPORTED_SCHEMA` and reports the found and
supported versions. A future v2 should begin writing v2 envelopes while keeping
the v1 reader available for existing references. Its identity must use a new
version prefix (for example `ev2_`), so a v2 identity cannot be confused with a
v1 identity. Introducing that reader/writer is a future explicit migration of
the format capability; this package performs no data migration or rewriting.
