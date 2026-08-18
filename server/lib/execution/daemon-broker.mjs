import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const SANDBOX_BROKER_ACTOR = "sandboxed-agent";
export const SANDBOX_BROKER_SOCKET = "/tmp/atelier/daemon.sock";
export const SANDBOX_BROKER_ENV = "ATELIER_BROKER_SOCKET";
export const DEFAULT_SANDBOX_BROKER_ALLOWLIST = Object.freeze(["/api/dispatches"]);

const UNCONDITIONALLY_DENIED_PATHS = new Set([
  "/api/session",
  "/api/break-glass",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CALLER_AUTHORITY_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "x-atelier-csrf",
]);

export function validateSandboxBrokerAllowlist(
  value,
  prefix = "defaults.sandboxBrokerAllowlist",
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${prefix} must be an array of API path patterns`];
  const problems = [];
  for (let index = 0; index < value.length; index += 1) {
    const pattern = value[index];
    if (
      typeof pattern !== "string" ||
      !pattern.startsWith("/api/") ||
      pattern.includes("\0") ||
      pattern.includes("?") ||
      pattern.includes("#") ||
      (pattern.includes("*") && !pattern.endsWith("/*")) ||
      pattern.slice(0, -1).includes("*")
    ) {
      problems.push(
        `${prefix}[${index}] must be an /api/ path with at most one trailing /* wildcard`,
      );
    }
  }
  return problems;
}

export function resolveSandboxBrokerAllowlist(defaults = {}) {
  const configured = defaults.sandboxBrokerAllowlist ?? DEFAULT_SANDBOX_BROKER_ALLOWLIST;
  const problems = validateSandboxBrokerAllowlist(configured);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return [...new Set(configured)].sort();
}

function allowlistMatches(path, pattern) {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

function canonicalDeniedPath(path) {
  const withoutTrailingSlashes = String(path).replace(/\/+$/, "") || "/";
  return withoutTrailingSlashes.toLowerCase();
}

// This guard is deliberately separate from allowlist matching. No registry
// value, including /api/*, can make either human-authority endpoint eligible.
export function daemonBrokerDecision(path, allowlist) {
  if (UNCONDITIONALLY_DENIED_PATHS.has(canonicalDeniedPath(path))) {
    return { allowed: false, reason: "unconditionally-denied" };
  }
  if (!allowlist.some((pattern) => allowlistMatches(path, pattern))) {
    return { allowed: false, reason: "outside-allowlist" };
  }
  return { allowed: true, reason: "allowlisted" };
}

function forwardedHeaders(headers, bearerToken) {
  const forwarded = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || CALLER_AUTHORITY_HEADERS.has(normalized)) continue;
    if (value !== undefined) forwarded[normalized] = value;
  }
  forwarded.authorization = `Bearer ${bearerToken}`;
  return forwarded;
}

function writeJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function targetPortValue(targetPort) {
  const value = typeof targetPort === "function" ? targetPort() : targetPort;
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

export async function createDaemonApiBroker({
  socketPath,
  allowlist,
  targetPort,
  bearerToken,
  request = httpRequest,
} = {}) {
  if (typeof socketPath !== "string" || !socketPath) {
    throw new TypeError("daemon broker socketPath is required");
  }
  if (typeof bearerToken !== "string" || !bearerToken) {
    throw new TypeError("daemon broker bearerToken is required");
  }
  const resolvedAllowlist = resolveSandboxBrokerAllowlist({
    sandboxBrokerAllowlist: allowlist,
  });
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  await rm(socketPath, { force: true });

  const server = createHttpServer((incoming, outgoing) => {
    let url;
    try {
      url = new URL(incoming.url, "http://atelier-broker");
    } catch {
      writeJson(outgoing, 400, { error: "Invalid broker request path" });
      return;
    }
    const decision = daemonBrokerDecision(url.pathname, resolvedAllowlist);
    if (!decision.allowed) {
      incoming.resume();
      writeJson(outgoing, 403, {
        error: decision.reason === "unconditionally-denied"
          ? `Atelier daemon broker unconditionally denies ${url.pathname}`
          : `Atelier daemon broker allowlist denies ${url.pathname}`,
        reason: decision.reason,
      });
      return;
    }
    const port = targetPortValue(targetPort);
    if (port === null) {
      incoming.resume();
      writeJson(outgoing, 503, { error: "Atelier daemon broker target is unavailable" });
      return;
    }
    let upstreamResponse;
    const upstream = request({
      hostname: "127.0.0.1",
      port,
      method: incoming.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders(incoming.headers, bearerToken),
    }, (response) => {
      upstreamResponse = response;
      const headers = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
          headers[name] = value;
        }
      }
      outgoing.writeHead(response.statusCode ?? 502, headers);
      response.pipe(outgoing);
    });
    let downstreamAborted = false;
    const abortUpstream = () => {
      if (downstreamAborted) return;
      downstreamAborted = true;
      upstreamResponse?.destroy();
      upstream.destroy();
    };
    incoming.once("aborted", abortUpstream);
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) abortUpstream();
    });
    upstream.once("error", (error) => {
      if (!outgoing.headersSent) {
        writeJson(outgoing, 502, { error: `Atelier daemon broker upstream failed: ${error.message}` });
      } else {
        outgoing.destroy(error);
      }
    });
    incoming.pipe(upstream);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);

  let closed = false;
  return Object.freeze({
    socketPath,
    allowlist: Object.freeze([...resolvedAllowlist]),
    actor: SANDBOX_BROKER_ACTOR,
    async close() {
      if (closed) return;
      closed = true;
      const closing = new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
      for (const socket of sockets) socket.destroy();
      await closing;
      await rm(socketPath, { force: true });
    },
  });
}
