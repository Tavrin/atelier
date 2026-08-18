import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const DEFAULT_VERIFICATION_SIDE_EFFECT_ALLOWLIST = Object.freeze([]);
export const VERIFICATION_SIDE_EFFECT_PATH_INVALID =
  "EATELIER_VERIFICATION_SIDE_EFFECT_PATH_INVALID: ";

function normalizedRoot(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function validRelativeRoot(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.includes("\\")
  ) return false;
  const root = normalizedRoot(value);
  if (!root || root === ".") return false;
  const segments = root.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return segments[0] !== ".git";
}

export function validateVerificationSideEffectAllowlist(
  value,
  prefix = "defaults.verificationSideEffectAllowlist",
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [`${prefix} must be an array of worktree-relative directory roots`];
  }
  const problems = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!validRelativeRoot(value[index])) {
      problems.push(
        `${prefix}[${index}] must be a non-empty worktree-relative directory root ` +
          "without dot segments, backslashes, NUL, or .git",
      );
    }
  }
  return problems;
}

export function resolveVerificationSideEffectAllowlist(defaults = {}) {
  const configured = defaults.verificationSideEffectAllowlist ??
    DEFAULT_VERIFICATION_SIDE_EFFECT_ALLOWLIST;
  const problems = validateVerificationSideEffectAllowlist(configured);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return [...new Set(configured.map(normalizedRoot))].sort();
}

export function verificationSideEffectAllowed(path, allowlist = []) {
  const candidate = normalizedRoot(String(path || ""));
  return allowlist.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function inside(root, candidate) {
  const segment = relative(root, candidate);
  return segment === "" || (
    segment !== ".." &&
    !segment.startsWith(`..${sep}`) &&
    !isAbsolute(segment)
  );
}

// A writable exception is created by trusted Atelier code before the verifier
// starts. Walk each component without following symlinks: an operator-approved
// relative name must never turn into a writable path outside the tested tree.
export function prepareVerificationSideEffectRoots(worktreePath, allowlist = []) {
  const worktree = realpathSync(worktreePath);
  const roots = [];
  for (const allowed of allowlist) {
    let current = worktree;
    for (const segment of allowed.split("/")) {
      current = join(current, segment);
      try {
        const metadata = lstatSync(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          const error = new Error(
            `${VERIFICATION_SIDE_EFFECT_PATH_INVALID}${allowed} is not a real directory root`,
          );
          error.code = "EATELIER_VERIFICATION_SIDE_EFFECT_PATH_INVALID";
          throw error;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        mkdirSync(current);
      }
    }
    const canonical = realpathSync(current);
    if (!inside(worktree, canonical)) {
      const error = new Error(
        `${VERIFICATION_SIDE_EFFECT_PATH_INVALID}${allowed} escapes the tested tree`,
      );
      error.code = "EATELIER_VERIFICATION_SIDE_EFFECT_PATH_INVALID";
      throw error;
    }
    roots.push(resolve(canonical));
  }
  return roots;
}
