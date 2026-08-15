import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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

// Read-only counterpart to acquireInstanceLock: who, if anyone, currently owns the
// instance lock. Returns undefined when the lock is absent or its owner is gone, so
// a caller can distinguish "a Atelier server is live here" from "stale lock file"
// WITHOUT taking the lock (atelier-za6 round 3: `atelier doctor --gc` must be able to
// refuse rather than act behind a running server's back).
export function liveInstanceOwner(directory, { killProcess = process.kill } = {}) {
  const path = join(directory, "atelier.lock");
  let owner;
  try {
    owner = Number(readFileSync(path, "utf8").trim());
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return ownerIsAlive(owner, killProcess) ? owner : undefined;
}

export function acquireInstanceLock(directory, {
  pid = process.pid,
  killProcess = process.kill,
} = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "atelier.lock");

  try {
    writeLock(path, pid);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = Number(readFileSync(path, "utf8").trim());
    } catch (readError) {
      if (readError.code !== "ENOENT") throw readError;
    }
    if (ownerIsAlive(owner, killProcess)) {
      const locked = new Error(`Another Atelier instance is already running (PID ${owner})`);
      locked.code = "EATELIERLOCKED";
      throw locked;
    }
    // Atomic stale takeover: rename the stale lock to a per-contender
    // graveyard name - rename succeeds for exactly ONE contender, so two
    // racers can no longer both delete-and-own. If the rename captured a
    // DIFFERENT (freshly written, live) lock, hand it back and yield.
    const graveyard = `${path}.takeover.${pid}`;
    try {
      renameSync(path, graveyard);
    } catch (renameError) {
      if (renameError.code !== "ENOENT") throw renameError;
    }
    if (existsSync(graveyard)) {
      let captured;
      try {
        captured = Number(readFileSync(graveyard, "utf8").trim());
      } catch {
        captured = undefined;
      }
      if (captured !== undefined && captured !== owner && ownerIsAlive(captured, killProcess)) {
        if (!existsSync(path)) {
          try {
            renameSync(graveyard, path);
          } catch {
            rmSync(graveyard, { force: true });
          }
        } else {
          rmSync(graveyard, { force: true });
        }
        const locked = new Error(`Another Atelier instance is already running (PID ${captured})`);
        locked.code = "EATELIERLOCKED";
        throw locked;
      }
      rmSync(graveyard, { force: true });
    }
    try {
      writeLock(path, pid);
    } catch (retryError) {
      if (retryError.code !== "EEXIST") throw retryError;
      const locked = new Error("Another Atelier instance acquired the server lock");
      locked.code = "EATELIERLOCKED";
      throw locked;
    }
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        const owner = Number(readFileSync(path, "utf8").trim());
        if (owner === pid) rmSync(path, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
  };
}
