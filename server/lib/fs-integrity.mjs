import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
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
  appendDescriptorSync: appendFileSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeDescriptorSync: writeFileSync,
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
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    const descriptor = ops.openSync(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    );
    closeAfter(ops, descriptor, () => {
      // Creation modes are filtered through the process umask. Correct the
      // already-open inode before making it visible at the destination.
      ops.fchmodSync(descriptor, mode);
      ops.writeDescriptorSync(descriptor, contents, { encoding: "utf8" }, temporary);
      ops.fsyncSync(descriptor);
    });
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
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const mode = 0o600;
  let descriptor;
  let created = false;
  try {
    descriptor = ops.openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollow,
      mode,
    );
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    descriptor = ops.openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
  }
  closeAfter(ops, descriptor, () => {
    // Never chmod a pre-existing state file. For a newly-created product,
    // fchmod defeats a permissive umask while retaining descriptor identity.
    if (created) ops.fchmodSync(descriptor, mode);
    ops.appendDescriptorSync(descriptor, line, { encoding: "utf8" }, path);
    // The append and fsync intentionally use the same descriptor/inode.
    ops.fsyncSync(descriptor);
  });
}

export function appendGuarded(path, line, { fileOps } = {}) {
  const ops = operations(fileOps);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const mode = 0o600;
  let descriptor;
  let created = false;
  try {
    descriptor = ops.openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        noFollow,
      mode,
    );
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    descriptor = ops.openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
  }
  closeAfter(ops, descriptor, () => {
    if (created) ops.fchmodSync(descriptor, mode);
    ops.appendDescriptorSync(descriptor, line, { encoding: "utf8" }, path);
  });
}

export function writeFileExclusiveDurable(
  path,
  contents,
  { mode = 0o600, fileOps } = {},
) {
  const ops = operations(fileOps);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const descriptor = ops.openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    mode,
  );
  closeAfter(ops, descriptor, () => {
    ops.fchmodSync(descriptor, mode);
    ops.writeDescriptorSync(descriptor, contents, { encoding: "utf8" }, path);
    ops.fsyncSync(descriptor);
  });
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
