import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { readFileNoFollowSync } from "./fs-integrity.mjs";

function readLockOwner(path) {
  return Number(readFileNoFollowSync(path, "utf8").trim());
}

function ownerIsAlive(pid, killProcess) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function writeLock(path, pid) {
  const descriptor = openSync(path, "wx", 0o600);
  let failure;
  try {
    writeFileSync(descriptor, `${pid}\n`, "utf8");
  } catch (error) {
    failure = error;
  } finally {
    closeSync(descriptor);
  }
  if (failure) {
    rmSync(path, { force: true });
    throw failure;
  }
}

function lockedError(message) {
  const error = new Error(message);
  error.code = "EATELIERLOCKED";
  return error;
}

function confirmLockOwner(path, pid) {
  let owner;
  try {
    owner = readLockOwner(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (owner !== pid) {
    throw lockedError("Atelier instance lock changed during acquisition; possible contention");
  }
}

// Read-only counterpart to acquireInstanceLock: who, if anyone, currently owns the
// instance lock. Returns undefined when the lock is absent or its owner is gone, so
// a caller can distinguish "a Atelier server is live here" from "stale lock file"
// WITHOUT taking the lock (atelier-za6 round 3: `atelier doctor --gc` must be able to
// refuse rather than act behind a running server's back).
export function liveInstanceOwner(directory, { killProcess = process.kill } = {}) {
  const path = join(directory, "atelier.lock");
  let owner;
  try {
    owner = readLockOwner(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return ownerIsAlive(owner, killProcess) ? owner : undefined;
}

export function acquireInstanceLock(directory, {
  pid = process.pid,
  killProcess = process.kill,
  beforeTakeoverRename,
} = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "atelier.lock");

  try {
    writeLock(path, pid);
    confirmLockOwner(path, pid);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = readLockOwner(path);
    } catch (readError) {
      if (readError.code !== "ENOENT") throw readError;
    }
    if (ownerIsAlive(owner, killProcess)) {
      throw lockedError(`Another Atelier instance is already running (PID ${owner})`);
    }
    // Atomic stale takeover: rename the stale lock to a per-contender
    // graveyard name - rename succeeds for exactly ONE contender, so two
    // racers can no longer both delete-and-own. If the rename captured a
    // DIFFERENT (freshly written, live) lock, hand it back and yield.
    const graveyard = `${path}.takeover.${pid}`;
    beforeTakeoverRename?.({ path, stalePid: owner });
    try {
      renameSync(path, graveyard);
    } catch (renameError) {
      if (renameError.code !== "ENOENT") throw renameError;
    }
    if (existsSync(graveyard)) {
      let captured;
      try {
        captured = readLockOwner(graveyard);
      } catch {
        captured = undefined;
      }
      if (captured !== owner) {
        try {
          // link+unlink is the no-clobber equivalent of restoring by rename:
          // unlike POSIX rename(), it cannot overwrite a third contender.
          linkSync(graveyard, path);
          rmSync(graveyard, { force: true });
        } catch (restoreError) {
          if (restoreError.code !== "EEXIST") throw restoreError;
          // An exact triple race can still strand this evidence. Lease
          // generations (ATT-017/P1) are the durable fix.
          const stolen = `${path}.stolen-${captured}`;
          try {
            renameSync(graveyard, stolen);
          } catch {
            // Preserve the graveyard under its takeover name if the evidence
            // path itself raced; authority still fails closed below.
          }
          throw lockedError(
            `Atelier instance lock changed during stale takeover (PID ${captured}); possible contention`,
          );
        }
        throw lockedError(`Another Atelier instance is already running (PID ${captured})`);
      }
      rmSync(graveyard, { force: true });
    }
    try {
      writeLock(path, pid);
      confirmLockOwner(path, pid);
    } catch (retryError) {
      if (retryError.code !== "EEXIST") throw retryError;
      throw lockedError("Another Atelier instance acquired the server lock");
    }
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        const owner = readLockOwner(path);
        if (owner === pid) rmSync(path, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}
