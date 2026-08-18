import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mintBearerToken, verifyBearerToken } from "../auth.mjs";
import { createBwrapBackend } from "./sandbox.mjs";
import {
  SANDBOX_BROKER_ACTOR,
  SANDBOX_BROKER_ENV,
  SANDBOX_BROKER_SOCKET,
  createDaemonApiBroker,
} from "./daemon-broker.mjs";

const SECRET = "a".repeat(43);

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

async function brokerRequest(socketPath, path, { method = "GET", headers = {} } = {}) {
  const { request } = await import("node:http");
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = request({ socketPath, path, method, headers }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { body += chunk; });
      incoming.on("end", () => {
        let value;
        try {
          value = JSON.parse(body);
        } catch {
          value = body;
        }
        resolvePromise({ status: incoming.statusCode, value });
      });
    });
    outgoing.once("error", rejectPromise);
    outgoing.end();
  });
}

async function fixture(t, allowlist) {
  const directory = await mkdtemp(join(tmpdir(), "atelier-daemon-broker-"));
  const socketPath = join(directory, "broker.sock");
  const seen = [];
  const daemon = createServer((request, response) => {
    const authorization = String(request.headers.authorization || "");
    const actor = verifyBearerToken(SECRET, authorization.replace(/^Bearer /, ""));
    seen.push({ path: request.url, actor, authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ actor, path: request.url })}\n`);
  });
  const port = await listen(daemon);
  const broker = await createDaemonApiBroker({
    socketPath,
    allowlist,
    targetPort: port,
    bearerToken: mintBearerToken(SECRET, SANDBOX_BROKER_ACTOR),
  });
  t.after(async () => {
    await broker.close();
    await close(daemon);
    await rm(directory, { recursive: true, force: true });
  });
  return { broker, seen, directory, port };
}

test("denial matrix: /api/session is unconditionally denied at the broker", async (t) => {
  const { broker, seen } = await fixture(t, ["/api/*"]);
  const response = await brokerRequest(broker.socketPath, "/api/session");
  assert.equal(response.status, 403);
  assert.equal(response.value.reason, "unconditionally-denied");
  assert.equal(seen.length, 0);
});

test("denial matrix: /api/break-glass is unconditionally denied at the broker", async (t) => {
  const { broker, seen } = await fixture(t, ["/api/*"]);
  const response = await brokerRequest(broker.socketPath, "/api/break-glass", { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(response.value.reason, "unconditionally-denied");
  assert.equal(seen.length, 0);
});

test("denial matrix: permissive operator configuration cannot admit either authority path", async (t) => {
  const { broker, seen } = await fixture(t, ["/api/*", "/api/session", "/api/break-glass"]);
  for (const path of ["/api/session", "/api/break-glass"]) {
    const response = await brokerRequest(broker.socketPath, path, { method: "PATCH" });
    assert.equal(response.status, 403, path);
    assert.equal(response.value.reason, "unconditionally-denied", path);
  }
  assert.equal(seen.length, 0);
});

test("denial matrix: a path outside the operator allowlist is denied", async (t) => {
  const { broker, seen } = await fixture(t, ["/api/dispatches"]);
  const response = await brokerRequest(broker.socketPath, "/api/projects");
  assert.equal(response.status, 403);
  assert.equal(response.value.reason, "outside-allowlist");
  assert.equal(seen.length, 0);
});

test("denial matrix: an allowlisted request reaches the daemon as sandboxed-agent", async (t) => {
  const { broker, seen } = await fixture(t, ["/api/dispatches"]);
  const response = await brokerRequest(broker.socketPath, "/api/dispatches?active=1", {
    headers: {
      authorization: `Bearer ${mintBearerToken(SECRET, "api")}`,
      cookie: "atelier_session=caller-controlled",
      origin: "http://caller.invalid",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.actor, SANDBOX_BROKER_ACTOR);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actor, SANDBOX_BROKER_ACTOR);
});

test("denial matrix: sandbox construction exposes only the broker socket, never daemon TCP", () => {
  const backend = createBwrapBackend({ file: "/fixture/bwrap" });
  const wrapped = backend.wrap({
    confinement: "sandboxed-write",
    credential: "none",
    file: "/provider",
    args: [],
    cwd: "/workspace",
    env: {},
    brokerSocketPath: "/operator/state/brokers/dispatch.sock",
  });
  assert.ok(wrapped.args.includes("--unshare-all"));
  assert.deepEqual(
    wrapped.args.slice(wrapped.args.indexOf("--dir"), wrapped.args.indexOf("--dir") + 5),
    [
      "--dir",
      "/tmp/atelier",
      "--ro-bind",
      "/operator/state/brokers/dispatch.sock",
      SANDBOX_BROKER_SOCKET,
    ],
  );
  assert.equal(wrapped.env[SANDBOX_BROKER_ENV], SANDBOX_BROKER_SOCKET);
  assert.equal(wrapped.args.some((value) => /127\.0\.0\.1|localhost/.test(value)), false);
});

test("denial matrix: a sandboxed child reaches the daemon only through its bound broker", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap backend is Linux-only");
    return;
  }
  const backend = createBwrapBackend();
  const probe = backend.probe();
  if (!probe.available) {
    t.skip(probe.reason);
    return;
  }
  const { broker, directory, port } = await fixture(t, ["/api/dispatches"]);
  const script = `
    const http = require("node:http");
    const call = (options) => new Promise((resolve) => {
      const request = http.request(options, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      request.setTimeout(500, () => request.destroy(new Error("timeout")));
      request.on("error", (error) => resolve({ error: error.code || error.message }));
      request.end();
    });
    (async () => {
      const direct = await call({ hostname: "127.0.0.1", port: ${port}, path: "/api/dispatches" });
      const throughBroker = await call({ socketPath: process.env.${SANDBOX_BROKER_ENV}, path: "/api/dispatches" });
      process.stdout.write(JSON.stringify({ direct, throughBroker }));
    })().catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const wrapped = backend.wrap({
    confinement: "sandboxed-write",
    credential: "none",
    file: process.execPath,
    args: ["-e", script],
    cwd: directory,
    env: process.env,
    brokerSocketPath: broker.socketPath,
    operatorBindings: [process.execPath],
  });
  const child = spawn(wrapped.file, wrapped.args, {
    cwd: directory,
    env: wrapped.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (...args) => resolvePromise(args));
  });
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(typeof result.direct.error, "string", "sandbox unexpectedly reached daemon TCP");
  assert.equal(result.throughBroker.status, 200);
  assert.equal(JSON.parse(result.throughBroker.body).actor, SANDBOX_BROKER_ACTOR);
});
