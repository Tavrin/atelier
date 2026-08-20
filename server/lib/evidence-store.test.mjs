import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import {
  createEvidenceStore,
  EVIDENCE_ERROR_CODES,
  EVIDENCE_SCHEMA_VERSION,
  EvidenceStoreError,
} from "./evidence-store.mjs";
import { createEventLog } from "./event-log.mjs";

async function evidenceRoot(t, slug) {
  const root = await mkdtemp(join(tmpdir(), `atelier-evidence-${slug}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function expectCode(code) {
  return (error) => error instanceof EvidenceStoreError && error.code === code;
}

function objectPath(store, digest) {
  const hex = digest.slice("sha256:".length);
  return join(store.paths.objects, hex.slice(0, 2), hex.slice(2));
}

function envelopePath(store, id) {
  const hex = id.slice("ev1_".length);
  return join(store.paths.envelopes, hex.slice(0, 2), `${id}.json`);
}

function fileCount(path) {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  ).length;
}

test("binary evidence round-trips byte-identically through a validated envelope", async (t) => {
  const root = await evidenceRoot(t, "binary");
  const store = createEvidenceStore({ stateDir: root });
  const body = Buffer.from([0x41, 0x00, 0xff, 0xfe, 0x42]);
  const minted = store.mint({
    type: "test.binary",
    body,
    attributes: { attempt: 1, accepted: true, note: null },
  });

  assert.equal(minted.created, true);
  assert.equal(store.has(minted.id), true);
  assert.deepEqual(Object.keys(store), [
    "mint",
    "read",
    "readBody",
    "has",
    "resolveProvenance",
    "paths",
  ]);
  const envelope = store.read(minted.id);
  assert.equal(envelope.schemaVersion, EVIDENCE_SCHEMA_VERSION);
  assert.equal(envelope.id, minted.id);
  assert.equal(envelope.contentDigest, minted.contentDigest);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.attributes), true);
  assert.equal(Object.isFrozen(envelope.provenanceRefs), true);
  assert.deepEqual(store.readBody(minted.id), body);
});

test("a zero-byte body is distinct from a bodyless envelope", async (t) => {
  const root = await evidenceRoot(t, "empty");
  const store = createEvidenceStore({ stateDir: root });
  const empty = store.mint({ type: "test.empty", body: Buffer.alloc(0) });
  const bodyless = store.mint({ type: "test.empty" });

  assert.notEqual(empty.id, bodyless.id);
  assert.match(empty.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(bodyless.contentDigest, null);
  assert.deepEqual(store.readBody(empty.id), Buffer.alloc(0));
  assert.throws(
    () => store.readBody(bodyless.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_NO_BODY),
  );
  assert.throws(
    () => store.read(`ev1_${"f".repeat(64)}`),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_NOT_FOUND),
  );
});

test("identical evidence mints idempotently with one object and envelope", async (t) => {
  const root = await evidenceRoot(t, "idempotent");
  const store = createEvidenceStore({ stateDir: root });
  const input = { type: "test.retry", body: "same", attributes: { dispatch: "d-1" } };

  const first = store.mint(input);
  const second = store.mint(input);
  assert.equal(first.id, second.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(fileCount(store.paths.objects), 1);
  assert.equal(fileCount(store.paths.envelopes), 1);
});

test("identity canonicalizes attributes and changes with meaningful fields", async (t) => {
  const root = await evidenceRoot(t, "identity");
  const store = createEvidenceStore({ stateDir: root });
  const refA = `ev1_${"a".repeat(64)}`;
  const refB = `ev1_${"b".repeat(64)}`;
  const first = store.mint({
    type: "test.identity",
    attributes: { alpha: 1, beta: "two" },
    provenanceRefs: [refA, refB],
  });
  const reorderedAttributes = store.mint({
    type: "test.identity",
    attributes: { beta: "two", alpha: 1 },
    provenanceRefs: [refA, refB],
  });
  const changedAttribute = store.mint({
    type: "test.identity",
    attributes: { alpha: 2, beta: "two" },
    provenanceRefs: [refA, refB],
  });
  const changedType = store.mint({
    type: "test.identity.other",
    attributes: { alpha: 1, beta: "two" },
    provenanceRefs: [refA, refB],
  });
  const reorderedRefs = store.mint({
    type: "test.identity",
    attributes: { alpha: 1, beta: "two" },
    provenanceRefs: [refB, refA],
  });

  assert.equal(first.id, reorderedAttributes.id);
  assert.notEqual(first.id, changedAttribute.id);
  assert.notEqual(first.id, changedType.id);
  assert.notEqual(first.id, reorderedRefs.id);
});

test("evidence-envelope survives restart, event rotation, and dispatch-index rebuild", async (t) => {
  const root = await evidenceRoot(t, "proof");
  const moduleUrl = new URL("./evidence-store.mjs", import.meta.url).href;
  const childScript = `
    import { createEvidenceStore } from ${JSON.stringify(moduleUrl)};
    const store = createEvidenceStore({ stateDir: process.argv[1] });
    const inputs = [
      { type: "proof.text", body: "restart-stable", attributes: { occurrence: "turn-1" } },
      { type: "proof.binary", body: Buffer.from([0, 255, 1, 254]), attributes: { occurrence: "turn-2" } },
      { type: "proof.marker", attributes: { occurrence: "turn-3" } },
    ];
    const result = inputs.map((input) => {
      const minted = store.mint(input);
      return {
        ...minted,
        envelope: store.read(minted.id),
        bodyHex: minted.contentDigest === null ? null : store.readBody(minted.id).toString("hex"),
      };
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript, root], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const references = JSON.parse(child.stdout);

  const log = createEventLog({ stateDir: root, maxBytes: 260, rotations: 2 });
  for (let index = 0; index < 24; index += 1) {
    log.append("proof.rotation", { index, detail: "x".repeat(90) });
    log._flush();
  }
  const logFiles = (await readdir(log.directory)).sort();
  assert.deepEqual(logFiles, ["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);
  const retainedLog = logFiles
    .map((name) => readFileSync(join(log.directory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(retainedLog, /"index":0[,}]/, "the oldest rotated events were discarded");

  const dispatchDirectory = join(root, "dispatches");
  const dispatchIndex = join(dispatchDirectory, "index.jsonl");
  mkdirSync(dispatchDirectory, { recursive: true });
  writeFileSync(dispatchIndex, '{"id":"old-a"}\n{"id":"old-b"}\n');
  writeFileSync(dispatchIndex, '{"id":"compacted-b"}\n');
  unlinkSync(dispatchIndex);
  writeFileSync(dispatchIndex, '{"id":"rebuilt-c"}\n');

  // This is the first parent-process store handle: all evidence was minted by
  // another Node process that has exited.
  const store = createEvidenceStore({ stateDir: root });
  for (const reference of references) {
    assert.deepEqual(store.read(reference.id), reference.envelope);
    if (reference.bodyHex === null) {
      assert.throws(
        () => store.readBody(reference.id),
        expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_NO_BODY),
      );
    } else {
      assert.equal(store.readBody(reference.id).toString("hex"), reference.bodyHex);
    }
  }
});

test("a modified object fails digest verification", async (t) => {
  const root = await evidenceRoot(t, "body-tamper");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.body", body: "original" });
  const path = objectPath(store, minted.contentDigest);
  const bytes = readFileSync(path);
  bytes[0] ^= 0xff;
  writeFileSync(path, bytes);

  assert.throws(
    () => store.readBody(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_DIGEST_MISMATCH),
  );
});

test("a modified envelope fails the caller-anchored id check", async (t) => {
  const root = await evidenceRoot(t, "envelope-tamper");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.envelope", body: "original" });
  const path = envelopePath(store, minted.id);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  envelope.type = "tamper.changed";
  writeFileSync(path, JSON.stringify(envelope));

  assert.throws(
    () => store.read(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_ID_MISMATCH),
  );
});

test("a symlinked object is refused", { skip: process.platform === "win32" }, async (t) => {
  const root = await evidenceRoot(t, "object-symlink");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.object-link", body: "original" });
  const path = objectPath(store, minted.contentDigest);
  const target = join(root, "substitute-body");
  writeFileSync(target, "original");
  unlinkSync(path);
  symlinkSync(target, path);

  assert.throws(
    () => store.readBody(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_DIGEST_MISMATCH),
  );
});

test("a symlinked envelope is refused", { skip: process.platform === "win32" }, async (t) => {
  const root = await evidenceRoot(t, "envelope-symlink");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.envelope-link" });
  const path = envelopePath(store, minted.id);
  const target = join(root, "substitute-envelope");
  writeFileSync(target, readFileSync(path));
  unlinkSync(path);
  symlinkSync(target, path);

  assert.throws(
    () => store.read(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED),
  );
});

test("a truncated or non-JSON envelope is malformed", async (t) => {
  const root = await evidenceRoot(t, "malformed");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.truncated" });
  writeFileSync(envelopePath(store, minted.id), '{"schemaVersion":1');

  assert.throws(
    () => store.read(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED),
  );
});

test("an unreadable future schema reports the found and supported versions", async (t) => {
  const root = await evidenceRoot(t, "schema");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.schema" });
  const path = envelopePath(store, minted.id);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  envelope.schemaVersion = 2;
  writeFileSync(path, JSON.stringify(envelope));

  assert.throws(
    () => store.read(minted.id),
    (error) =>
      expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_UNSUPPORTED_SCHEMA)(error) &&
      /schema 2/.test(error.message) &&
      /supported versions: 1/.test(error.message),
  );
});

test("different content occupying a digest path is a write conflict", async (t) => {
  const root = await evidenceRoot(t, "collision");
  const store = createEvidenceStore({ stateDir: root });
  const intended = Buffer.from("intended");
  const digest = `sha256:${createHash("sha256").update(intended).digest("hex")}`;
  const path = objectPath(store, digest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "different");

  assert.throws(
    () => store.mint({ type: "conflict.object", body: intended }),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT),
  );
});

test("invalid mint inputs reject with typed codes before any store write", async (t) => {
  const root = await evidenceRoot(t, "validation");
  const validRef = `ev1_${"a".repeat(64)}`;
  const largeAttributes = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `k${String(index).padStart(2, "0")}${"x".repeat(61)}`,
      "v".repeat(512),
    ]),
  );
  const thirtyThree = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
  );
  const cases = [
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE,
      options: { maxBodyBytes: 2 },
      input: { type: "invalid.large-body", body: "abc" },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE,
      input: { type: "invalid.large-envelope", attributes: largeAttributes },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ATTRIBUTES,
      input: { type: "invalid.attributes", attributes: thirtyThree },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ATTRIBUTES,
      input: { type: "invalid.nested", attributes: { nested: { value: true } } },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ATTRIBUTES,
      input: { type: "invalid.number", attributes: { value: Number.POSITIVE_INFINITY } },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_TYPE,
      input: { type: "Invalid Type" },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_PROVENANCE,
      input: { type: "invalid.ref", provenanceRefs: ["../bad"] },
    },
    {
      code: EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_PROVENANCE,
      input: { type: "invalid.duplicate", provenanceRefs: [validRef, validRef] },
    },
  ];

  for (const [index, invalid] of cases.entries()) {
    const stateDir = join(root, `case-${index}`);
    const store = createEvidenceStore({ stateDir, ...invalid.options });
    assert.throws(() => store.mint(invalid.input), expectCode(invalid.code));
    assert.equal(existsSync(store.paths.root), false, `case ${index} wrote no store directory`);
  }
});

test("invalid ids are rejected before any filesystem access", async (t) => {
  const root = await evidenceRoot(t, "path-safety");
  let accesses = 0;
  const store = createEvidenceStore({
    stateDir: root,
    fileOps: {
      existsSync() {
        accesses += 1;
        return false;
      },
      lstatSync() {
        accesses += 1;
        throw new Error("filesystem reached");
      },
      openSync() {
        accesses += 1;
        throw new Error("filesystem reached");
      },
    },
  });
  const attempts = [
    "../..",
    join(sep, "tmp", "absolute-evidence"),
    `ev1_${"g".repeat(64)}`,
    `ev2_${"a".repeat(64)}`,
  ];
  for (const id of attempts) {
    assert.throws(() => store.read(id), expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ID));
    assert.throws(() => store.has(id), expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ID));
  }
  assert.equal(accesses, 0);
  assert.equal(existsSync(store.paths.root), false);
});

test("provenance resolution preserves resolved and unknown references in order", async (t) => {
  const root = await evidenceRoot(t, "provenance");
  const store = createEvidenceStore({ stateDir: root });
  const present = store.mint({ type: "source.present" });
  const unknown = `ev1_${"c".repeat(64)}`;
  const subject = store.mint({
    type: "subject.provenance",
    provenanceRefs: [unknown, present.id],
  });

  assert.deepEqual(store.resolveProvenance(subject.id), [
    { ref: unknown, status: "unknown" },
    { ref: present.id, status: "resolved", type: "source.present" },
  ]);
});

test("deep provenance resolves one ordered level at a time", async (t) => {
  const root = await evidenceRoot(t, "deep-provenance");
  const store = createEvidenceStore({ stateDir: root });
  const a = store.mint({ type: "chain.a" });
  const b = store.mint({ type: "chain.b", provenanceRefs: [a.id] });
  const c = store.mint({ type: "chain.c", provenanceRefs: [b.id] });

  assert.deepEqual(store.resolveProvenance(a.id), []);
  assert.deepEqual(store.resolveProvenance(b.id), [
    { ref: a.id, status: "resolved", type: "chain.a" },
  ]);
  assert.deepEqual(store.resolveProvenance(c.id), [
    { ref: b.id, status: "resolved", type: "chain.b" },
  ]);
});

test("content-derived provenance makes a self-cycle structurally unconstructible", async (t) => {
  const root = await evidenceRoot(t, "cycle");
  const store = createEvidenceStore({ stateDir: root });
  const withoutReference = store.mint({ type: "cycle.node" });
  const withReference = store.mint({
    type: "cycle.node",
    provenanceRefs: [withoutReference.id],
  });

  // An envelope id hashes provenanceRefs. Naming its own final id in that array
  // would therefore require finding a SHA-256 preimage/fixed point; merely
  // adding the id minted before the ref changes the identity.
  assert.notEqual(withoutReference.id, withReference.id);
  assert.notEqual(withReference.id, store.read(withReference.id).provenanceRefs[0]);
});

test("an envelope-write failure strands only a body and retry publishes the envelope", async (t) => {
  const root = await evidenceRoot(t, "crash-window");
  let failEnvelopeCreate = true;
  const store = createEvidenceStore({
    stateDir: root,
    fileOps: {
      ...fs,
      openSync(path, flags, ...rest) {
        if (
          failEnvelopeCreate &&
          path.includes(`${sep}envelopes${sep}`) &&
          typeof flags === "number" &&
          (flags & constants.O_CREAT) !== 0
        ) {
          const error = new Error("injected envelope write failure");
          error.code = "EIO";
          throw error;
        }
        return fs.openSync(path, flags, ...rest);
      },
    },
  });
  const input = { type: "durability.retry", body: "durable body" };

  assert.throws(() => store.mint(input), /injected envelope write failure/);
  assert.equal(fileCount(store.paths.objects), 1, "the body was durable before publication");
  assert.equal(fileCount(store.paths.envelopes), 0, "no dangling envelope was published");

  failEnvelopeCreate = false;
  const retried = store.mint(input);
  assert.equal(retried.created, true);
  assert.equal(fileCount(store.paths.objects), 1);
  assert.equal(fileCount(store.paths.envelopes), 1);
  assert.equal(store.readBody(retried.id).toString(), "durable body");
});

test(
  "evidence files are 0600 and every store directory is 0700",
  { skip: process.platform === "win32" ? "POSIX mode bits are not portable to win32" : false },
  async (t) => {
    const root = await evidenceRoot(t, "modes");
    const store = createEvidenceStore({ stateDir: root });
    const minted = store.mint({ type: "mode.assertion", body: "private" });
    const body = objectPath(store, minted.contentDigest);
    const envelope = envelopePath(store, minted.id);
    const directories = [
      store.paths.root,
      join(store.paths.root, "objects"),
      store.paths.objects,
      dirname(body),
      store.paths.envelopes,
      dirname(envelope),
    ];

    assert.equal(statSync(body).mode & 0o777, 0o600);
    assert.equal(statSync(envelope).mode & 0o777, 0o600);
    for (const directory of directories) {
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    }
  },
);
