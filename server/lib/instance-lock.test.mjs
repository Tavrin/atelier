import assert from "node:assert/strict";
import { existsSync, renameSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireInstanceLock } from "./instance-lock.mjs";

test("instance lock rejects a live owner and is removed on release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = acquireInstanceLock(directory, { pid: 123, killProcess: () => {} });

  assert.equal(await readFile(first.path, "utf8"), "123\n");
  assert.throws(
    () => acquireInstanceLock(directory, { pid: 456, killProcess: () => {} }),
    (error) => error.code === "EATELIERLOCKED" && /PID 123/.test(error.message),
  );

  first.release();
  assert.equal(existsSync(first.path), false);
});

test("instance lock replaces a stale PID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-lock-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "atelier.lock");
  await writeFile(path, "123\n");
  const lock = acquireInstanceLock(directory, {
    pid: 456,
    killProcess() {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    },
  });

  assert.equal(await readFile(path, "utf8"), "456\n");
  lock.release();
  assert.equal(existsSync(path), false);
});

test("stale takeover yields when the graveyard captures a fresh live lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "atelier.lock");
  // A stale lock from a dead pid...
  await writeFile(path, "999999999\n");
  // ...but by the time this contender renames, ANOTHER live process has
  // already replaced it (simulated: the file now carries a live pid).
  await writeFile(path, `${process.pid}\n`);
  assert.throws(
    () => acquireInstanceLock(directory, {
      pid: process.pid + 1,
      killProcess: (pid) => {
        if (pid === 999999999) { const e = new Error("gone"); e.code = "ESRCH"; throw e; }
        return true;
      },
    }),
    (error) => error.code === "EATELIERLOCKED",
  );
  // The live lock was preserved or restored - never silently destroyed.
  assert.equal((await readFile(path, "utf8")).trim(), String(process.pid));
});

test("stale takeover interleaving leaves only the fresh contender owning the lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-lock-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "atelier.lock");
  const stalePid = 101;
  const contenderPid = 202;
  const freshPid = 303;
  await writeFile(path, `${stalePid}\n`);
  let freshLock;

  assert.throws(
    () => acquireInstanceLock(directory, {
      pid: contenderPid,
      killProcess(pid) {
        if (pid === stalePid) {
          const error = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
        return true;
      },
      beforeTakeoverRename({ path: lockPath }) {
        renameSync(lockPath, `${lockPath}.taken-by-b`);
        freshLock = acquireInstanceLock(directory, {
          pid: freshPid,
          killProcess: () => true,
        });
      },
    }),
    (error) => error.code === "EATELIERLOCKED" && /PID 303/.test(error.message),
  );

  assert.ok(freshLock, "the fresh contender believes it acquired the lock");
  assert.equal(await readFile(path, "utf8"), `${freshPid}\n`);
  freshLock.release();
  assert.equal(existsSync(path), false);
});
