import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { HttpError } from "./http.mjs";
import { stateDir } from "./paths.mjs";

export const AUTH_SECRET_FILE = "auth-secret";
export const SESSION_COOKIE = "atelier_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

const TOKEN_PREFIX = "atelier-v1";
const CLIENT_LABELS = new Set(["api", "cli", "mcp"]);
const AUTH_FAILURE_LIMIT = 60;
const AUTH_FAILURE_WINDOW_MS = 1_000;

function writeSecret(path, secret) {
  const descriptor = openSync(path, "wx", 0o600);
  let failure;
  try {
    writeFileSync(descriptor, `${secret}\n`, "utf8");
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

function validateSecret(path, secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error(`Atelier auth secret is invalid: ${path}`);
  }
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Atelier auth secret must be owner-only (0600): ${path}`);
  }
  return secret;
}

export function ensureAuthSecret(directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, AUTH_SECRET_FILE);
  try {
    writeSecret(path, randomBytes(32).toString("base64url"));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return validateSecret(path, readFileSync(path, "utf8").trim());
}

function signature(secret, purpose, value) {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`)
    .digest("base64url");
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function mintBearerToken(secret, label) {
  if (!CLIENT_LABELS.has(label)) throw new TypeError(`Invalid bearer client label: ${label}`);
  return `${TOKEN_PREFIX}.${label}.${signature(secret, "bearer", label)}`;
}

export function verifyBearerToken(secret, token) {
  if (typeof token !== "string") return undefined;
  const match = token.match(/^atelier-v1\.(api|cli|mcp)\.([A-Za-z0-9_-]+)$/);
  if (!match) return undefined;
  return constantTimeEqual(match[2], signature(secret, "bearer", match[1]))
    ? match[1]
    : undefined;
}

export function clientBearerToken(label, {
  directory = stateDir(),
  env = process.env,
} = {}) {
  const configured = env.ATELIER_AUTH_TOKEN?.trim();
  if (configured) return configured;
  const path = join(directory, AUTH_SECRET_FILE);
  let secret;
  try {
    secret = validateSecret(path, readFileSync(path, "utf8").trim());
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Atelier auth token is unavailable: start the daemon or set ATELIER_AUTH_TOKEN (${path})`,
      );
    }
    throw error;
  }
  return mintBearerToken(secret, label);
}

function bearerFrom(request) {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? value.match(/^Bearer ([^\s]+)$/) : null;
  return match?.[1];
}

function cookiesFrom(request) {
  const header = request.headers.cookie;
  const value = Array.isArray(header) ? header.join(";") : header;
  return Object.fromEntries(
    String(value ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator === -1
          ? [part, ""]
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
}

function signedValue(secret, purpose, value) {
  return `${value}.${signature(secret, purpose, value)}`;
}

function verifySignedValue(secret, purpose, value) {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf(".");
  if (separator <= 0) return undefined;
  const payload = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  return constantTimeEqual(supplied, signature(secret, purpose, payload))
    ? payload
    : undefined;
}

function hostValue(request) {
  const header = request.headers.host;
  return Array.isArray(header) ? header[0] : header;
}

function allowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function validOrigin(request, host) {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  return origin === undefined || origin === `http://${host}`;
}

export function createRequestAuth({
  directory,
  now = Date.now,
  sessionTtlMs = SESSION_TTL_MS,
}) {
  const secret = ensureAuthSecret(directory);
  const failures = new Map();

  function authenticationFailure(request, message) {
    const key = request.socket?.remoteAddress ?? "loopback";
    const now = Date.now();
    const previous = failures.get(key);
    const current = !previous || now - previous.startedAt >= AUTH_FAILURE_WINDOW_MS
      ? { startedAt: now, count: 1 }
      : { ...previous, count: previous.count + 1 };
    failures.set(key, current);
    if (current.count > AUTH_FAILURE_LIMIT) {
      throw new HttpError(429, "Too many authentication failures");
    }
    throw new HttpError(401, message);
  }

  function requireAllowedHost(request, port) {
    const host = hostValue(request);
    if (!allowedHost(host, port)) throw new HttpError(403, "Host is not allowed");
    return host;
  }

  function authenticate(request, { mutation }) {
    const bearer = bearerFrom(request);
    if (bearer !== undefined) {
      const actor = verifyBearerToken(secret, bearer);
      if (!actor) authenticationFailure(request, "Invalid Atelier bearer token");
      return {
        actor,
        credential: "bearer",
        credentialKey: signature(secret, "event-stream", bearer),
      };
    }

    const session = verifySignedValue(
      secret,
      "session",
      cookiesFrom(request)[SESSION_COOKIE],
    );
    if (!session) authenticationFailure(request, "Atelier authentication is required");
    const match = /^(\d+):(\d+):([A-Za-z0-9_-]{43})$/.exec(session);
    const issuedAt = Number(match?.[1]);
    const expiresAt = Number(match?.[2]);
    const currentTime = now();
    if (
      !match ||
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= issuedAt ||
      issuedAt > currentTime ||
      expiresAt <= currentTime
    ) {
      authenticationFailure(request, "Atelier session is invalid or expired");
    }
    if (mutation) {
      const header = request.headers["x-atelier-csrf"];
      const csrf = Array.isArray(header) ? header[0] : header;
      const csrfSession = verifySignedValue(secret, "csrf", csrf);
      if (csrfSession !== session) {
        authenticationFailure(request, "A valid X-Atelier-CSRF token is required");
      }
    }
    return {
      actor: "human-ui",
      credential: "session",
      credentialKey: signature(secret, "event-stream", session),
    };
  }

  return {
    guard(request, { path, port }) {
      const api = path.startsWith("/api/");
      const sessionBootstrap = request.method === "GET" && path === "/api/session";
      if (!api) return { requestClass: "static" };

      const host = requireAllowedHost(request, port);
      if (sessionBootstrap) return { requestClass: "session-bootstrap" };

      const mutation = request.method !== "GET";
      if (mutation && !validOrigin(request, host)) {
        throw new HttpError(403, "Origin must exactly match the Atelier server");
      }
      return {
        requestClass: mutation ? "mutation" : "read-api",
        ...authenticate(request, { mutation }),
      };
    },

    mintSession() {
      const id = randomBytes(32).toString("base64url");
      const issuedAt = now();
      const expiresAt = issuedAt + sessionTtlMs;
      const session = `${issuedAt}:${expiresAt}:${id}`;
      return {
        cookie: `${SESSION_COOKIE}=${signedValue(secret, "session", session)}; HttpOnly; SameSite=Strict; Path=/`,
        csrfToken: signedValue(secret, "csrf", session),
      };
    },
  };
}
