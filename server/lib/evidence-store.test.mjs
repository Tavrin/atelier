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
import { dirname, join, resolve, sep } from "node:path";
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

test("mint copies caller-owned body bytes before hashing and writing", async (t) => {
  const root = await evidenceRoot(t, "body-copy");
  const shared = new SharedArrayBuffer(4);
  const callerBytes = new Uint8Array(shared);
  callerBytes.set([0x10, 0x20, 0x30, 0x40]);
  const expected = Buffer.from(callerBytes);
  let mutated = false;
  const store = createEvidenceStore({
    stateDir: root,
    fileOps: {
      ...fs,
      openSync(path, flags, ...rest) {
        if (
          !mutated &&
          path.includes(`${sep}objects${sep}`) &&
          typeof flags === "number" &&
          (flags & constants.O_CREAT) !== 0
        ) {
          callerBytes[0] = 0xff;
          mutated = true;
        }
        return fs.openSync(path, flags, ...rest);
      },
    },
  });

  const minted = store.mint({ type: "test.body-copy", body: callerBytes });
  assert.equal(mutated, true, "the caller's shared bytes changed during the write");
  assert.deepEqual(store.readBody(minted.id), expected);
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

test("a relative stateDir is fixed to the construction cwd", async (t) => {
  const root = await evidenceRoot(t, "absolute-root");
  const constructionCwd = join(root, "construction");
  const laterCwd = join(root, "later");
  mkdirSync(constructionCwd);
  mkdirSync(laterCwd);
  const originalCwd = process.cwd();
  let store;
  try {
    process.chdir(constructionCwd);
    store = createEvidenceStore({ stateDir: "relative-state" });
    process.chdir(laterCwd);
    const minted = store.mint({ type: "test.absolute-root", body: "anchored" });

    assert.equal(store.paths.root, resolve(constructionCwd, "relative-state", "evidence"));
    assert.equal(store.readBody(minted.id).toString(), "anchored");
    assert.equal(existsSync(join(laterCwd, "relative-state")), false);
  } finally {
    process.chdir(originalCwd);
  }
});

test("evidence-envelope survives restart, event rotation, and dispatch-index rebuild", async (t) => {
  const root = await evidenceRoot(t, "proof");
  const moduleUrl = new URL("./evidence-store.mjs", import.meta.url).href;
  const proofInputs = [
    {
      type: "proof.text",
      bodyHex: "726573746172742d737461626c65",
      attributes: { occurrence: "turn-1" },
    },
    {
      type: "proof.binary",
      bodyHex: "00ff01fe",
      attributes: { occurrence: "turn-2" },
    },
    { type: "proof.marker", bodyHex: null, attributes: { occurrence: "turn-3" } },
  ];
  const expectedEnvelopes = [
    {
      schemaVersion: 1,
      id: "ev1_843a53a0b8c5a02fdff4492399a6e386cf55cfeb9fd072a786bbf97b3bf8fd9e",
      type: "proof.text",
      contentDigest: "sha256:e3490e4f7cbbf3c45bdc28dde6510d38a7c07206c87d26955be8e09ee1ba70a8",
      attributes: { occurrence: "turn-1" },
      provenanceRefs: [],
    },
    {
      schemaVersion: 1,
      id: "ev1_e7d22d0bdda209dd80553d94d934b464c51295b7b01bf7cd7c052eeefb361b26",
      type: "proof.binary",
      contentDigest: "sha256:5d8d910591d272938aef5f966e0816e374beaf7b5adf02cca5f8f770596c2ce3",
      attributes: { occurrence: "turn-2" },
      provenanceRefs: [],
    },
    {
      schemaVersion: 1,
      id: "ev1_7185a1e342d0331d971d646c166479e6744cb25f4785323d56783fd927d20452",
      type: "proof.marker",
      contentDigest: null,
      attributes: { occurrence: "turn-3" },
      provenanceRefs: [],
    },
  ];
  const childScript = `
    import { createEvidenceStore } from ${JSON.stringify(moduleUrl)};
    const inputs = JSON.parse(process.argv[1]);
    const store = createEvidenceStore({ stateDir: process.argv[2] });
    const ids = inputs.map(({ bodyHex, ...input }) =>
      store.mint({
        ...input,
        ...(bodyHex === null ? {} : { body: Buffer.from(bodyHex, "hex") }),
      }).id,
    );
    process.stdout.write(JSON.stringify(ids));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childScript, JSON.stringify(proofInputs), root],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const ids = JSON.parse(child.stdout);
  assert.deepEqual(ids, expectedEnvelopes.map((envelope) => envelope.id));

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
  for (const [index, expectedEnvelope] of expectedEnvelopes.entries()) {
    assert.deepEqual(store.read(ids[index]), expectedEnvelope);
    if (proofInputs[index].bodyHex === null) {
      assert.throws(
        () => store.readBody(ids[index]),
        expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_NO_BODY),
      );
    } else {
      assert.deepEqual(
        store.readBody(ids[index]),
        Buffer.from(proofInputs[index].bodyHex, "hex"),
      );
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

test("a semantically unchanged but non-canonical envelope is malformed", async (t) => {
  const root = await evidenceRoot(t, "envelope-canonical");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({
    type: "tamper.canonical",
    attributes: { alpha: 1, beta: "two" },
  });
  const path = envelopePath(store, minted.id);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);

  assert.throws(
    () => store.read(minted.id),
    (error) =>
      expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED)(error) &&
      /not in canonical form/.test(error.message),
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

test(
  "symlinked shard directories are refused for reads and writes",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await evidenceRoot(t, "shard-symlink");

    const readStore = createEvidenceStore({ stateDir: join(root, "read-state") });
    const minted = readStore.mint({ type: "tamper.read-shard" });
    const storedEnvelope = envelopePath(readStore, minted.id);
    const readShard = dirname(storedEnvelope);
    const readTarget = join(root, "outside-read");
    mkdirSync(readTarget);
    writeFileSync(join(readTarget, storedEnvelope.slice(readShard.length + 1)), readFileSync(storedEnvelope));
    fs.rmSync(readShard, { recursive: true, force: true });
    symlinkSync(readTarget, readShard, "dir");

    assert.throws(
      () => readStore.read(minted.id),
      (error) =>
        expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED)(error) &&
        error.message.includes(readShard),
    );

    const writeStore = createEvidenceStore({ stateDir: join(root, "write-state") });
    const body = Buffer.from("redirect-me");
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const destination = objectPath(writeStore, digest);
    const writeShard = dirname(destination);
    const writeTarget = join(root, "outside-write");
    mkdirSync(writeStore.paths.objects, { recursive: true });
    mkdirSync(writeTarget);
    symlinkSync(writeTarget, writeShard, "dir");

    assert.throws(
      () => writeStore.mint({ type: "tamper.write-shard", body }),
      (error) =>
        expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED)(error) &&
        error.message.includes(writeShard),
    );
    assert.equal(existsSync(join(writeTarget, destination.slice(writeShard.length + 1))), false);
  },
);

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

test("stored envelope fields with the wrong type fail with a typed error", async (t) => {
  const root = await evidenceRoot(t, "malformed-field-type");
  const store = createEvidenceStore({ stateDir: root });
  const minted = store.mint({ type: "tamper.field-type", body: "original" });
  const path = envelopePath(store, minted.id);
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  envelope.contentDigest = { toString: null };
  writeFileSync(path, JSON.stringify(envelope));

  assert.throws(
    () => store.read(minted.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED),
  );
});

test("all envelope and body reads enforce size bounds before loading bytes", async (t) => {
  const root = await evidenceRoot(t, "bounded-reads");

  const envelopeState = join(root, "envelope-read");
  const envelopeSetup = createEvidenceStore({ stateDir: envelopeState });
  const oversizedEnvelope = envelopeSetup.mint({ type: "bounds.envelope-read" });
  writeFileSync(envelopePath(envelopeSetup, oversizedEnvelope.id), Buffer.alloc(16 * 1024 + 1));
  let envelopeReads = 0;
  const envelopeReader = createEvidenceStore({
    stateDir: envelopeState,
    fileOps: {
      ...fs,
      readFileSync(...args) {
        envelopeReads += 1;
        return fs.readFileSync(...args);
      },
    },
  });
  assert.throws(
    () => envelopeReader.read(oversizedEnvelope.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE),
  );
  assert.equal(envelopeReads, 0);

  const bodyState = join(root, "body-read");
  const bodySetup = createEvidenceStore({ stateDir: bodyState, maxBodyBytes: 16 });
  const oversizedBody = bodySetup.mint({ type: "bounds.body-read", body: "12345678" });
  let bodyReads = 0;
  const bodyReader = createEvidenceStore({
    stateDir: bodyState,
    maxBodyBytes: 4,
    fileOps: {
      ...fs,
      readFileSync(...args) {
        bodyReads += 1;
        return fs.readFileSync(...args);
      },
    },
  });
  assert.throws(
    () => bodyReader.readBody(oversizedBody.id),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE),
  );
  assert.equal(bodyReads, 1, "only the bounded envelope was loaded");

  const objectConflictState = join(root, "object-conflict");
  const objectConflict = createEvidenceStore({ stateDir: objectConflictState, maxBodyBytes: 4 });
  const intended = Buffer.from("tiny");
  const intendedDigest = `sha256:${createHash("sha256").update(intended).digest("hex")}`;
  const occupiedObject = objectPath(objectConflict, intendedDigest);
  mkdirSync(dirname(occupiedObject), { recursive: true });
  writeFileSync(occupiedObject, "oversized");
  let objectConflictReads = 0;
  const boundedObjectConflict = createEvidenceStore({
    stateDir: objectConflictState,
    maxBodyBytes: 4,
    fileOps: {
      ...fs,
      readFileSync(...args) {
        objectConflictReads += 1;
        return fs.readFileSync(...args);
      },
    },
  });
  assert.throws(
    () => boundedObjectConflict.mint({ type: "bounds.object-conflict", body: intended }),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE),
  );
  assert.equal(objectConflictReads, 0);

  const envelopeConflictState = join(root, "envelope-conflict");
  const envelopeConflictSetup = createEvidenceStore({ stateDir: envelopeConflictState });
  const envelopeConflictInput = { type: "bounds.envelope-conflict" };
  const occupiedEnvelope = envelopeConflictSetup.mint(envelopeConflictInput);
  writeFileSync(
    envelopePath(envelopeConflictSetup, occupiedEnvelope.id),
    Buffer.alloc(16 * 1024 + 1),
  );
  let envelopeConflictReads = 0;
  const boundedEnvelopeConflict = createEvidenceStore({
    stateDir: envelopeConflictState,
    fileOps: {
      ...fs,
      readFileSync(...args) {
        envelopeConflictReads += 1;
        return fs.readFileSync(...args);
      },
    },
  });
  assert.throws(
    () => boundedEnvelopeConflict.mint(envelopeConflictInput),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE),
  );
  assert.equal(envelopeConflictReads, 0);
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

test("negative zero attributes are rejected without silent normalization", async (t) => {
  const root = await evidenceRoot(t, "negative-zero");
  const store = createEvidenceStore({ stateDir: root });

  assert.throws(
    () => store.mint({ type: "invalid.negative-zero", attributes: { offset: -0 } }),
    (error) =>
      expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ATTRIBUTES)(error) &&
      /offset/.test(error.message),
  );
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

test("mint replaces a legacy partial final object without weakening real conflicts", async (t) => {
  const root = await evidenceRoot(t, "partial-final");
  const store = createEvidenceStore({ stateDir: root });
  const body = Buffer.from("complete durable body");
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const path = objectPath(store, digest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.subarray(0, 5));

  const minted = store.mint({ type: "durability.partial-retry", body });
  assert.equal(minted.contentDigest, digest);
  assert.deepEqual(store.readBody(minted.id), body);
  assert.equal(
    readdirSync(dirname(path)).some((name) => name.endsWith(".tmp")),
    false,
    "successful retry removed its temporary file",
  );

  const conflictingBody = Buffer.alloc(body.byteLength, 0x78);
  assert.equal(conflictingBody.byteLength, body.byteLength);
  writeFileSync(path, conflictingBody);
  assert.throws(
    () => store.mint({ type: "durability.partial-retry", body }),
    expectCode(EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT),
  );
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
