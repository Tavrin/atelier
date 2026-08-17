import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_FILE_OPS = Object.freeze({
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
});

function operations(fileOps) {
  return { ...DEFAULT_FILE_OPS, ...(fileOps || {}) };
}

function closeAfter(ops, descriptor, operation) {
  let failure;
  try {
    return operation();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      ops.closeSync(descriptor);
    } catch (closeError) {
      if (!failure) throw closeError;
    }
  }
}

export function writeFileAtomic(path, contents, { mode = 0o600, fileOps } = {}) {
  const ops = operations(fileOps);
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    ops.writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const descriptor = ops.openSync(temporary, constants.O_RDWR | noFollow);
    closeAfter(ops, descriptor, () => ops.fsyncSync(descriptor));
    ops.renameSync(temporary, path);
  } catch (error) {
    try {
      ops.rmSync(temporary, { force: true });
    } catch {
      // The original write error is the actionable failure.
    }
    throw error;
  }

  // Windows and some unusual filesystems do not permit opening/fsyncing a
  // directory. The file fsync + atomic rename remain mandatory; only this
  // final directory-metadata flush is best-effort for portability.
  let directoryDescriptor;
  try {
    directoryDescriptor = ops.openSync(directory, "r");
    ops.fsyncSync(directoryDescriptor);
  } catch {
    // See portability comment above.
  } finally {
    if (directoryDescriptor !== undefined) {
      try {
        ops.closeSync(directoryDescriptor);
      } catch {
        // Best-effort directory fsync includes best-effort close.
      }
    }
  }
}

export function appendDurable(path, line, { fileOps } = {}) {
  const ops = operations(fileOps);
  ops.appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  // `mode` only applies when append creates the file. Tighten an existing
  // legacy product too so every successful durable append leaves it owner-only.
  ops.chmodSync(path, 0o600);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const descriptor = ops.openSync(path, constants.O_RDONLY | noFollow);
  closeAfter(ops, descriptor, () => ops.fsyncSync(descriptor));
}

export function readFileNoFollowSync(path, options, { fileOps } = {}) {
  const ops = operations(fileOps);
  const details = ops.lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    const error = new Error(`Atelier refuses non-regular or symlinked state file: ${path}`);
    error.code = "EATELIERINTEGRITY";
    throw error;
  }
  // O_NOFOLLOW closes the lstat/open race on platforms that provide it. Windows
  // keeps the lstat guard because Node does not expose an equivalent there.
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const descriptor = ops.openSync(path, constants.O_RDONLY | noFollow);
  return closeAfter(ops, descriptor, () => {
    if (!ops.fstatSync(descriptor).isFile()) {
      const error = new Error(`Atelier refuses non-regular state file: ${path}`);
      error.code = "EATELIERINTEGRITY";
      throw error;
    }
    return ops.readFileSync(descriptor, options);
  });
}
