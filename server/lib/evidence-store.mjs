// Atelier's immutable evidence store.
//
// Integrity is anchored outside the store: (1) the caller already holds an id;
// (2) that id is both the envelope filename and the hash of its canonical
// identity fields; (3) those fields include the body's content digest; (4) a
// body change breaks that digest, while changing the digest to match breaks the
// envelope id; and (5) nothing stored here is self-certifying. Reads must verify
// both links against the caller's reference.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  fsyncDirectoryBestEffort,
  readFileNoFollowSync,
} from "./fs-integrity.mjs";
import { ensureDir, stateDir as atelierStateDir } from "./paths.mjs";

export const EVIDENCE_SCHEMA_VERSION = 1;

export const EVIDENCE_ERROR_CODES = Object.freeze({
  EVIDENCE_INVALID_ID: "EVIDENCE_INVALID_ID",
  EVIDENCE_INVALID_TYPE: "EVIDENCE_INVALID_TYPE",
  EVIDENCE_INVALID_ATTRIBUTES: "EVIDENCE_INVALID_ATTRIBUTES",
  EVIDENCE_INVALID_PROVENANCE: "EVIDENCE_INVALID_PROVENANCE",
  EVIDENCE_BODY_TOO_LARGE: "EVIDENCE_BODY_TOO_LARGE",
  EVIDENCE_ENVELOPE_TOO_LARGE: "EVIDENCE_ENVELOPE_TOO_LARGE",
  EVIDENCE_NOT_FOUND: "EVIDENCE_NOT_FOUND",
  EVIDENCE_NO_BODY: "EVIDENCE_NO_BODY",
  EVIDENCE_DIGEST_MISMATCH: "EVIDENCE_DIGEST_MISMATCH",
  EVIDENCE_ID_MISMATCH: "EVIDENCE_ID_MISMATCH",
  EVIDENCE_CONFLICT: "EVIDENCE_CONFLICT",
  EVIDENCE_UNSUPPORTED_SCHEMA: "EVIDENCE_UNSUPPORTED_SCHEMA",
  EVIDENCE_MALFORMED: "EVIDENCE_MALFORMED",
});

export class EvidenceStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const MAX_ATTRIBUTES = 32;
const MAX_PROVENANCE_REFS = 32;
const MAX_ATTRIBUTE_STRING_LENGTH = 512;
const TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const ID_PATTERN = /^ev1_[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const DEFAULT_FILE_OPS = Object.freeze({
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
});

function evidenceError(code, message, cause) {
  return new EvidenceStoreError(code, message, cause ? { cause } : undefined);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// This serializer deliberately implements only JSON's lossless subset. It
// never inherits JSON.stringify's silent dropping of values, because two inputs
// that differ by a dropped value must not accidentally acquire one identity.
function canonicalJson(value) {
  const ancestors = new Set();

  function serialize(current) {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("canonical JSON rejects non-finite numbers");
      return JSON.stringify(current);
    }
    if (["undefined", "function", "symbol", "bigint"].includes(typeof current)) {
      throw new TypeError(`canonical JSON rejects ${typeof current}`);
    }
    if (ancestors.has(current)) throw new TypeError("canonical JSON rejects cyclic structures");

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${Array.from({ length: current.length }, (_, index) =>
          serialize(current[index]),
        ).join(",")}]`;
      }
      if (!isPlainObject(current)) throw new TypeError("canonical JSON requires plain objects");
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new TypeError("canonical JSON rejects symbol keys");
      }
      return `{${Object.keys(current)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return serialize(value);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw evidenceError(
      EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ID,
      "Evidence id must match ev1_<64 lowercase hex characters>",
    );
  }
  return id;
}

function validateType(type, code = EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_TYPE) {
  if (typeof type !== "string" || !TYPE_PATTERN.test(type)) {
    throw evidenceError(code, "Evidence type must be a bounded lowercase type string");
  }
  return type;
}

function validateAttributes(
  attributes,
  code = EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_ATTRIBUTES,
) {
  if (!isPlainObject(attributes)) {
    throw evidenceError(code, "Evidence attributes must be a flat plain object");
  }
  const keys = Reflect.ownKeys(attributes);
  if (keys.length > MAX_ATTRIBUTES || keys.some((key) => typeof key !== "string")) {
    throw evidenceError(code, `Evidence attributes must contain at most ${MAX_ATTRIBUTES} keys`);
  }

  const normalized = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
    if (!TYPE_PATTERN.test(key) || !descriptor?.enumerable || !("value" in descriptor)) {
      throw evidenceError(code, `Invalid evidence attribute key: ${key}`);
    }
    const value = descriptor.value;
    if (typeof value === "number" && Object.is(value, -0)) {
      throw evidenceError(code, `Evidence attribute ${key} must not be -0`);
    }
    const scalar =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= MAX_ATTRIBUTE_STRING_LENGTH);
    if (!scalar) {
      throw evidenceError(code, `Evidence attribute ${key} must be a bounded scalar value`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function validateProvenance(
  provenanceRefs,
  code = EVIDENCE_ERROR_CODES.EVIDENCE_INVALID_PROVENANCE,
) {
  if (!Array.isArray(provenanceRefs) || provenanceRefs.length > MAX_PROVENANCE_REFS) {
    throw evidenceError(
      code,
      `Evidence provenance must contain at most ${MAX_PROVENANCE_REFS} references`,
    );
  }
  const seen = new Set();
  const normalized = [];
  for (const ref of provenanceRefs) {
    if (typeof ref !== "string" || !ID_PATTERN.test(ref) || seen.has(ref)) {
      throw evidenceError(code, "Evidence provenance references must be unique valid v1 ids");
    }
    seen.add(ref);
    normalized.push(ref);
  }
  return normalized;
}

function bodyBuffer(body) {
  if (body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  throw evidenceError(
    EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
    "Evidence body must be a string, Buffer, or Uint8Array",
  );
}

function identityFields({ schemaVersion, type, contentDigest, attributes, provenanceRefs }) {
  return { schemaVersion, type, contentDigest, attributes, provenanceRefs };
}

function identityFor(fields) {
  return `ev1_${sha256(Buffer.from(canonicalJson(identityFields(fields)), "utf8"))}`;
}

function frozenEnvelope(envelope) {
  Object.freeze(envelope.attributes);
  Object.freeze(envelope.provenanceRefs);
  return Object.freeze(envelope);
}

/**
 * Open an immutable evidence store under an Atelier state directory.
 *
 * `has` is intentionally only an existence probe. `read` verifies the
 * caller-held id against the envelope, and `readBody` additionally verifies the
 * body's digest.
 */
export function createEvidenceStore({
  stateDir = atelierStateDir(),
  fileOps,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("stateDir must be a path");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new TypeError("maxBodyBytes must be a non-negative safe integer");
  }

  const ops = { ...DEFAULT_FILE_OPS, ...(fileOps || {}) };
  const root = join(resolve(stateDir), "evidence");
  const objects = join(root, "objects", "sha256");
  const envelopes = join(root, "envelopes");
  const paths = Object.freeze({ root, objects, envelopes });

  function objectPath(digest) {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        "Stored content digest is not a valid sha256 digest",
      );
    }
    const hex = digest.slice("sha256:".length);
    return join(objects, hex.slice(0, 2), hex.slice(2));
  }

  function envelopePath(id) {
    assertId(id);
    const hex = id.slice("ev1_".length);
    return join(envelopes, hex.slice(0, 2), `${id}.json`);
  }

  function inspectStoreDirectory(path, { allowMissing = false } = {}) {
    let details;
    try {
      details = ops.lstatSync(path);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return false;
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence store directory cannot be inspected safely: ${path}`,
        error,
      );
    }
    let isDirectory;
    let isSymbolicLink;
    try {
      isDirectory = details.isDirectory();
      isSymbolicLink = details.isSymbolicLink();
    } catch (error) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence store directory cannot be inspected safely: ${path}`,
        error,
      );
    }
    if (!isDirectory || isSymbolicLink) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence store path is not a real directory: ${path}`,
      );
    }
    return true;
  }

  function ensurePrivateDirectory(path) {
    if (!inspectStoreDirectory(path, { allowMissing: true })) {
      try {
        ensureDir(path);
      } catch (error) {
        // A racing replacement is reported as an integrity failure, not as a
        // platform-specific mkdir error.
        inspectStoreDirectory(path);
        throw error;
      }
    }
    inspectStoreDirectory(path);
    if (process.platform !== "win32") ops.chmodSync(path, 0o700);
  }

  function prepareObjectShard(path) {
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(join(root, "objects"));
    ensurePrivateDirectory(objects);
    ensurePrivateDirectory(dirname(path));
  }

  function prepareEnvelopeShard(path) {
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(envelopes);
    ensurePrivateDirectory(dirname(path));
  }

  function guardObjectShard(path) {
    for (const directory of [root, join(root, "objects"), objects, dirname(path)]) {
      inspectStoreDirectory(directory, { allowMissing: true });
    }
  }

  function guardEnvelopeShard(path) {
    for (const directory of [root, envelopes, dirname(path)]) {
      inspectStoreDirectory(directory, { allowMissing: true });
    }
  }

  function boundedRead(path, { maxBytes, tooLargeCode, failureCode, failureMessage }) {
    let details;
    try {
      details = ops.lstatSync(path);
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw evidenceError(failureCode, failureMessage, error);
    }
    let isRegularFile;
    try {
      isRegularFile = details.isFile() && !details.isSymbolicLink();
    } catch (error) {
      throw evidenceError(failureCode, failureMessage, error);
    }
    if (!isRegularFile) {
      throw evidenceError(failureCode, failureMessage);
    }
    if (typeof details.size !== "number" || details.size > maxBytes) {
      throw evidenceError(
        tooLargeCode,
        `Evidence file exceeds the ${maxBytes}-byte read limit: ${path}`,
      );
    }
    try {
      return { bytes: readFileNoFollowSync(path, undefined, { fileOps: ops }), size: details.size };
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw evidenceError(failureCode, failureMessage, error);
    }
  }

  function writeTempThenLink(path, contents, verifyExisting) {
    const directory = dirname(path);
    const temporary = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    let descriptor;
    let result;
    let failure;
    try {
      descriptor = ops.openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        ops.fchmodSync(descriptor, 0o600);
        ops.writeFileSync(descriptor, contents, { encoding: "utf8" }, temporary);
        ops.fsyncSync(descriptor);
      } finally {
        const openDescriptor = descriptor;
        descriptor = undefined;
        ops.closeSync(openDescriptor);
      }
      try {
        ops.linkSync(temporary, path);
        result = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        result = verifyExisting(temporary);
      }
    } catch (error) {
      failure = error;
    } finally {
      if (descriptor !== undefined) {
        try {
          ops.closeSync(descriptor);
        } catch (error) {
          if (!failure) failure = error;
        }
      }
      try {
        ops.unlinkSync(temporary);
      } catch (error) {
        if (error?.code !== "ENOENT" && !failure) failure = error;
      }
      fsyncDirectoryBestEffort(directory, { fileOps: ops });
    }
    if (failure) throw failure;
    return result;
  }

  function writeBodyOnce(path, contents, expectedDigest) {
    prepareObjectShard(path);
    return writeTempThenLink(path, contents, (temporary) => {
      const existing = boundedRead(path, {
        maxBytes: maxBodyBytes,
        tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE,
        failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
        failureMessage: `Existing evidence object cannot be verified: ${path}`,
      });
      if (`sha256:${sha256(existing.bytes)}` === expectedDigest) return false;

      // The old direct-to-final writer could strand a strict prefix after a
      // crash. A complete mismatching file remains an immutable conflict.
      if (existing.size < contents.byteLength) {
        try {
          ops.unlinkSync(path);
          ops.linkSync(temporary, path);
          return true;
        } catch (error) {
          if (error?.code === "EEXIST") {
            const raced = boundedRead(path, {
              maxBytes: maxBodyBytes,
              tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE,
              failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
              failureMessage: `Existing evidence object cannot be verified: ${path}`,
            });
            if (`sha256:${sha256(raced.bytes)}` === expectedDigest) return false;
          }
          throw evidenceError(
            EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
            `Interrupted evidence object cannot be replaced safely: ${path}`,
            error,
          );
        }
      }
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
        `Existing evidence object conflicts with digest ${expectedDigest}`,
      );
    });
  }

  function writeEnvelopeOnce(path, contents) {
    prepareEnvelopeShard(path);
    return writeTempThenLink(path, contents, (temporary) => {
      const existing = boundedRead(path, {
        maxBytes: MAX_ENVELOPE_BYTES,
        tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE,
        failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
        failureMessage: `Existing evidence envelope cannot be verified: ${path}`,
      });
      if (existing.bytes.equals(contents)) return false;
      if (existing.size < contents.byteLength) {
        try {
          ops.unlinkSync(path);
          ops.linkSync(temporary, path);
          return true;
        } catch (error) {
          if (error?.code === "EEXIST") {
            const raced = boundedRead(path, {
              maxBytes: MAX_ENVELOPE_BYTES,
              tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE,
              failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
              failureMessage: `Existing evidence envelope cannot be verified: ${path}`,
            });
            if (raced.bytes.equals(contents)) return false;
          }
          throw evidenceError(
            EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
            `Interrupted evidence envelope cannot be replaced safely: ${path}`,
            error,
          );
        }
      }
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_CONFLICT,
        `Existing evidence envelope conflicts at ${path}`,
      );
    });
  }

  function validateStoredEnvelope(parsed, requestedId) {
    if (!isPlainObject(parsed)) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope ${requestedId} is not an object`,
      );
    }
    if (!Object.hasOwn(parsed, "schemaVersion")) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope ${requestedId} has no schema version`,
      );
    }
    if (parsed.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_UNSUPPORTED_SCHEMA,
        `Evidence envelope schema ${String(parsed.schemaVersion)} is not readable; supported versions: ${EVIDENCE_SCHEMA_VERSION}`,
      );
    }
    const expectedKeys = [
      "attributes",
      "contentDigest",
      "id",
      "provenanceRefs",
      "schemaVersion",
      "type",
    ];
    if (Object.keys(parsed).sort().join("\0") !== expectedKeys.join("\0")) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope ${requestedId} has an invalid shape`,
      );
    }
    if (typeof parsed.id !== "string" || !ID_PATTERN.test(parsed.id)) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope ${requestedId} contains an invalid id`,
      );
    }
    validateType(parsed.type, EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED);
    if (
      parsed.contentDigest !== null &&
      (typeof parsed.contentDigest !== "string" ||
        !DIGEST_PATTERN.test(parsed.contentDigest))
    ) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope ${requestedId} contains an invalid content digest`,
      );
    }
    const attributes = validateAttributes(
      parsed.attributes,
      EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
    );
    const provenanceRefs = validateProvenance(
      parsed.provenanceRefs,
      EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
    );
    const envelope = {
      schemaVersion: parsed.schemaVersion,
      id: parsed.id,
      type: parsed.type,
      contentDigest: parsed.contentDigest,
      attributes,
      provenanceRefs,
    };
    const recomputedId = identityFor(envelope);
    if (parsed.id !== requestedId || recomputedId !== requestedId) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_ID_MISMATCH,
        `Evidence envelope identity does not match requested id ${requestedId}`,
      );
    }
    return frozenEnvelope(envelope);
  }

  function mint({ type, body, attributes = {}, provenanceRefs = [] } = {}) {
    const normalizedType = validateType(type);
    const normalizedAttributes = validateAttributes(attributes);
    const normalizedProvenance = validateProvenance(provenanceRefs);
    const contents = bodyBuffer(body);
    if (contents && contents.byteLength > maxBodyBytes) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE,
        `Evidence body exceeds the ${maxBodyBytes}-byte limit`,
      );
    }
    const contentDigest = contents === undefined ? null : `sha256:${sha256(contents)}`;
    const fields = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      type: normalizedType,
      contentDigest,
      attributes: normalizedAttributes,
      provenanceRefs: normalizedProvenance,
    };
    const id = identityFor(fields);
    const envelope = { schemaVersion: EVIDENCE_SCHEMA_VERSION, id, ...fields };
    const envelopeBytes = Buffer.from(canonicalJson(envelope), "utf8");
    if (envelopeBytes.byteLength > MAX_ENVELOPE_BYTES) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE,
        `Canonical evidence envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      );
    }

    // Body first is the only safe crash window: an interruption can strand an
    // unreferenced object, but can never publish an envelope with no body.
    if (contents !== undefined) writeBodyOnce(objectPath(contentDigest), contents, contentDigest);
    const created = writeEnvelopeOnce(envelopePath(id), envelopeBytes);
    return Object.freeze({ id, contentDigest, created });
  }

  function read(id) {
    assertId(id);
    const path = envelopePath(id);
    guardEnvelopeShard(path);
    let stored;
    try {
      stored = boundedRead(path, {
        maxBytes: MAX_ENVELOPE_BYTES,
        tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_ENVELOPE_TOO_LARGE,
        failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        failureMessage: `Evidence envelope cannot be read safely: ${id}`,
      });
    } catch (error) {
      if (error?.cause?.code === "ENOENT") {
        throw evidenceError(
          EVIDENCE_ERROR_CODES.EVIDENCE_NOT_FOUND,
          `Evidence envelope not found: ${id}`,
          error.cause,
        );
      }
      throw error;
    }
    const { bytes } = stored;
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Evidence envelope is not valid JSON: ${id}`,
        error,
      );
    }
    const envelope = validateStoredEnvelope(parsed, id);
    const canonicalBytes = Buffer.from(canonicalJson(envelope), "utf8");
    if (!bytes.equals(canonicalBytes)) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_MALFORMED,
        `Stored evidence envelope is not in canonical form: ${id}`,
      );
    }
    return envelope;
  }

  function readBody(id) {
    const envelope = read(id);
    if (envelope.contentDigest === null) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_NO_BODY,
        `Evidence envelope has no body: ${id}`,
      );
    }
    const path = objectPath(envelope.contentDigest);
    guardObjectShard(path);
    const { bytes: body } = boundedRead(path, {
      maxBytes: maxBodyBytes,
      tooLargeCode: EVIDENCE_ERROR_CODES.EVIDENCE_BODY_TOO_LARGE,
      failureCode: EVIDENCE_ERROR_CODES.EVIDENCE_DIGEST_MISMATCH,
      failureMessage: `Evidence body cannot be read safely: ${id}`,
    });
    if (`sha256:${sha256(body)}` !== envelope.contentDigest) {
      throw evidenceError(
        EVIDENCE_ERROR_CODES.EVIDENCE_DIGEST_MISMATCH,
        `Evidence body digest does not match envelope ${id}`,
      );
    }
    return Buffer.from(body);
  }

  function has(id) {
    const path = envelopePath(assertId(id));
    guardEnvelopeShard(path);
    return ops.existsSync(path);
  }

  function resolveProvenance(id) {
    return read(id).provenanceRefs.map((ref) => {
      try {
        return { ref, status: "resolved", type: read(ref).type };
      } catch (error) {
        if (error?.code === EVIDENCE_ERROR_CODES.EVIDENCE_NOT_FOUND) {
          return { ref, status: "unknown" };
        }
        throw error;
      }
    });
  }

  return Object.freeze({ mint, read, readBody, has, resolveProvenance, paths });
}
