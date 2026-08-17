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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendDurable, writeFileAtomic } from "./fs-integrity.mjs";

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

test("durable products are owner-only", (t) => {
  const root = fixture(t);
  const atomicPath = join(root, "atomic.json");
  const appendPath = join(root, "append.jsonl");
  writeFileAtomic(atomicPath, "atomic\n");
  writeFileSync(appendPath, "legacy\n", { mode: 0o666 });
  chmodSync(appendPath, 0o666);
  appendDurable(appendPath, "append\n");
  assert.equal(statSync(atomicPath).mode & 0o777, 0o600);
  assert.equal(statSync(appendPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(atomicPath, "utf8"), "atomic\n");
  assert.equal(readFileSync(appendPath, "utf8"), "legacy\nappend\n");
});
