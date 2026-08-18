import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendGuarded,
  appendDurable,
  writeFileAtomic,
  writeFileExclusiveDurable,
} from "./fs-integrity.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-fs-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomic write leaves old contents intact when rename never happens", (t) => {
  const root = fixture(t);
  const path = join(root, "state.json");
  writeFileSync(path, "old\n");
  assert.throws(
    () => writeFileAtomic(path, "new\n", {
      fileOps: {
        closeSync,
        fsyncSync,
        openSync,
        renameSync() {
          throw Object.assign(new Error("injected crash before rename"), { code: "EIO" });
        },
        rmSync,
        writeFileSync,
      },
    }),
    /injected crash/,
  );
  assert.equal(readFileSync(path, "utf8"), "old\n");
});

test("fsync failures surface from atomic and append writes", (t) => {
  const root = fixture(t);
  const atomicPath = join(root, "atomic.json");
  assert.throws(
    () => writeFileAtomic(atomicPath, "value\n", {
      fileOps: {
        fsyncSync() {
          throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" });
        },
      },
    }),
    /fixture fsync failure/,
  );
  assert.equal(lstatSync(root).isDirectory(), true);
  assert.throws(
    () => appendDurable(join(root, "append.jsonl"), "value\n", {
      fileOps: {
        fsyncSync() {
          throw Object.assign(new Error("fixture append fsync failure"), { code: "EIO" });
        },
      },
    }),
    /fixture append fsync failure/,
  );
});

test("new durable products are owner-only without chmodding existing append targets", (t) => {
  const root = fixture(t);
  const atomicPath = join(root, "atomic.json");
  const appendPath = join(root, "append.jsonl");
  const newAppendPath = join(root, "new-append.jsonl");
  writeFileAtomic(atomicPath, "atomic\n");
  writeFileSync(appendPath, "legacy\n", { mode: 0o666 });
  chmodSync(appendPath, 0o666);
  appendDurable(appendPath, "append\n");
  appendDurable(newAppendPath, "new\n");
  assert.equal(statSync(atomicPath).mode & 0o777, 0o600);
  assert.equal(statSync(appendPath).mode & 0o777, 0o666);
  assert.equal(statSync(newAppendPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(atomicPath, "utf8"), "atomic\n");
  assert.equal(readFileSync(appendPath, "utf8"), "legacy\nappend\n");
});

test("first durable append best-effort fsyncs its containing directory", (t) => {
  const root = fixture(t);
  const path = join(root, "created.jsonl");
  let directoryFsyncs = 0;
  const descriptors = new Set();
  appendDurable(path, "created\n", {
    fileOps: {
      openSync(target, ...args) {
        const descriptor = openSync(target, ...args);
        if (target === root) descriptors.add(descriptor);
        return descriptor;
      },
      fsyncSync(descriptor) {
        if (descriptors.has(descriptor)) directoryFsyncs += 1;
        return fsyncSync(descriptor);
      },
    },
  });
  assert.equal(directoryFsyncs, 1);
  assert.equal(readFileSync(path, "utf8"), "created\n");
});

test("guarded append keeps owner-only creation and does not fsync output lines", (t) => {
  const root = fixture(t);
  const path = join(root, "stream.jsonl");
  appendGuarded(path, "output\n", {
    fileOps: {
      fsyncSync() {
        throw new Error("guarded append must not fsync");
      },
    },
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), "output\n");
});

test("atomic and append creation modes defeat a permissive umask", (t) => {
  const root = fixture(t);
  const previous = process.umask(0o777);
  try {
    const atomicPath = join(root, "atomic.json");
    const appendPath = join(root, "append.jsonl");
    writeFileAtomic(atomicPath, "atomic\n");
    appendDurable(appendPath, "append\n");
    assert.equal(statSync(atomicPath).mode & 0o777, 0o600);
    assert.equal(statSync(appendPath).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});

test("append refuses a symlink before writing any bytes", (t) => {
  const root = fixture(t);
  const target = join(root, "outside.jsonl");
  const link = join(root, "append.jsonl");
  writeFileSync(target, "before\n");
  symlinkSync(target, link);
  assert.throws(() => appendDurable(link, "after\n"), (error) =>
    ["ELOOP", "EEXIST"].includes(error?.code));
  assert.throws(() => appendGuarded(link, "after\n"), (error) =>
    ["ELOOP", "EEXIST"].includes(error?.code));
  assert.equal(readFileSync(target, "utf8"), "before\n");
});

test("exclusive durable writes cannot overwrite same-name evidence", (t) => {
  const root = fixture(t);
  const evidence = join(root, "queue.json.corrupt-fixture");
  writeFileExclusiveDurable(evidence, "first\n");
  assert.throws(
    () => writeFileExclusiveDurable(evidence, "second\n"),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(readFileSync(evidence, "utf8"), "first\n");
});
