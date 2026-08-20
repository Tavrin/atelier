import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAuthSecret, mintBearerToken } from "./lib/auth.mjs";
import {
  daemonBrokerDecision,
  DEFAULT_SANDBOX_BROKER_ALLOWLIST,
} from "./lib/execution/daemon-broker.mjs";
import { RECOVERY_LIMITS, redactGcResult } from "./lib/recovery.mjs";
import { REDACT_TEXT_PATTERNS } from "./lib/stream.mjs";
import { createServer, listenLoopback } from "./server.mjs";

const PATTERN_FIXTURES = [
  { text: "sk-1234567890abcdef", literal: "sk-1234567890abcdef" },
  { text: "ghp_12345678901234567890", literal: "ghp_12345678901234567890" },
  {
    text: "github_pat_12345678901234567890",
    literal: "github_pat_12345678901234567890",
  },
  { text: "AKIA123456789012", literal: "AKIA123456789012" },
  { text: "xoxb-1234567890", literal: "xoxb-1234567890" },
  {
    text: `eyJ${"a".repeat(20)}.${"b".repeat(10)}.${"c".repeat(10)}`,
    literal: `eyJ${"a".repeat(20)}.${"b".repeat(10)}.${"c".repeat(10)}`,
  },
  { text: '{"API_KEY":"json-secret-literal"}', literal: "json-secret-literal" },
  { text: "OPENAI_API_KEY=assignment-secret-literal", literal: "assignment-secret-literal" },
  { text: "Bearer abcdefghijkl", literal: "abcdefghijkl" },
];

function gcResultWithText(text) {
  return {
    dryRun: true,
    olderThanDays: 7,
    dismissed: [],
    orphans: [`/tmp/atelier-worktrees/${text}/orphan`],
    codexJobs: [],
    breakGlassAuthorizations: [],
    errors: [`scan error: ${text}`],
    warnings: [`retained candidate: ${text}`],
    persistenceFailureTargets: [],
    codexProcesses: {
      supported: true,
      swept: true,
      reaped: [],
      reported: [{
        pid: 321,
        command: `codex --resume ${text}`,
        cwd: "/tmp/atelier-worktrees/reported",
        cwdDeleted: false,
        worktreePath: "/tmp/atelier-worktrees/reported",
        reason: `ownership unproven: ${text}`,
      }],
      errors: [`process scan: ${text}`],
    },
    advisoryDebts: [],
  };
}

async function fixture(t, initialGcResult) {
  const root = await mkdtemp(join(tmpdir(), "atelier-gc-redaction-"));
  const atelierStateDir = join(root, "state");
  const gcCalls = [];
  let gcResult = initialGcResult;
  const dispatcher = {
    list: () => [],
    listConvoys: () => [],
    persistenceStatus: () => ({ degraded: false, targets: [] }),
    async gc(options = {}) {
      gcCalls.push(options);
      if (gcResult instanceof Error) throw gcResult;
      return gcResult;
    },
  };
  const server = createServer({
    registry: { version: 1, defaults: {}, groups: [], projects: [] },
    dispatcher,
    registryPath: join(root, "projects.json"),
    atelierStateDir,
    browserHomeDir: root,
    brExecutable: "br",
    boardEvents: { close() {} },
    eventLog: { append() {}, _flush() {} },
  });
  const { port } = await listenLoopback(server, 0);
  const secret = ensureAuthSecret(atelierStateDir);
  const tokens = Object.fromEntries(
    ["api", "mcp"].map((label) => [label, mintBearerToken(secret, label)]),
  );
  t.after(async () => {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
    await rm(root, { recursive: true, force: true });
  });
  return {
    port,
    tokens,
    gcCalls,
    setGcResult(value) {
      gcResult = value;
    },
  };
}

function requestJson(port, token, {
  method = "GET",
  path,
  body,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Authorization: `Bearer ${token}` };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise({ status: response.statusCode, text, body: JSON.parse(text) });
      });
    });
    request.on("error", rejectPromise);
    request.end(payload);
  });
}

test("doctor GC and deep recovery redact every shared text pattern without drift", async (t) => {
  assert.equal(
    PATTERN_FIXTURES.length,
    REDACT_TEXT_PATTERNS.length,
    "add a matching GC carrier fixture when the shared pattern list grows",
  );
  const state = await fixture(t, gcResultWithText(PATTERN_FIXTURES[0].text));

  for (const [index, { pattern }] of REDACT_TEXT_PATTERNS.entries()) {
    const { text, literal } = PATTERN_FIXTURES[index];
    const matcher = new RegExp(pattern.source, pattern.flags);
    assert.match(text, matcher, `fixture ${index + 1} must exercise its shared pattern`);
    const rawResult = gcResultWithText(text);
    assert.match(JSON.stringify(rawResult), new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    state.setGcResult(rawResult);

    const doctor = await requestJson(state.port, state.tokens.api, {
      method: "POST",
      path: "/api/doctor/gc",
      body: { dryRun: true },
    });
    const recovery = await requestJson(state.port, state.tokens.api, {
      path: "/api/recovery?deep=1",
    });

    assert.equal(doctor.status, 200);
    assert.equal(recovery.status, 200);
    assert.equal(JSON.stringify(doctor.body).includes(literal), false, `doctor leaked fixture ${index + 1}`);
    assert.equal(
      JSON.stringify(recovery.body.deep).includes(literal),
      false,
      `deep recovery leaked fixture ${index + 1}`,
    );
  }
});

test("doctor GC output equals the Recovery Center's shared GC redaction", async (t) => {
  const rawResult = {
    ...gcResultWithText("ghp_12345678901234567890"),
    operatorCredential: "credential-value-that-must-be-blanked",
  };
  const state = await fixture(t, rawResult);
  const response = await requestJson(state.port, state.tokens.api, {
    method: "POST",
    path: "/api/doctor/gc",
    body: { dryRun: true },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, redactGcResult(rawResult));
});

test("GC failures redact credential-shaped messages on both routes without changing status", async (t) => {
  const leaked = "sk-1234567890abcdef";
  const error = new Error(`scan failed: ${leaked}`);
  error.status = 503;
  const state = await fixture(t, error);

  const doctor = await requestJson(state.port, state.tokens.api, {
    method: "POST",
    path: "/api/doctor/gc",
    body: { dryRun: true },
  });
  const recovery = await requestJson(state.port, state.tokens.api, {
    path: "/api/recovery?deep=1",
  });

  for (const response of [doctor, recovery]) {
    assert.equal(response.status, 503);
    assert.equal(response.text.includes(leaked), false);
    assert.match(response.body.error, /scan failed: \[redacted\]/);
  }
});

test("credential-shaped orphan path segments are redacted on doctor and recovery surfaces", async (t) => {
  const leaked = "sk-1234567890abcdef";
  const state = await fixture(t, gcResultWithText(leaked));
  const doctor = await requestJson(state.port, state.tokens.api, {
    method: "POST",
    path: "/api/doctor/gc",
    body: { dryRun: true },
  });
  const recovery = await requestJson(state.port, state.tokens.api, {
    path: "/api/recovery?deep=1",
  });

  assert.deepEqual(doctor.body.orphans, ["/tmp/atelier-worktrees/[redacted]/orphan"]);
  assert.equal(JSON.stringify(recovery.body.deep).includes(leaked), false);
  assert.match(JSON.stringify(recovery.body.deep), /atelier-worktrees\/\[redacted\]\/orphan/);
  assert.ok(RECOVERY_LIMITS.some(({ topic, limit }) =>
    topic === "deep_scan_structural_fields" && /path segment matching a credential shape/.test(limit)));
});

test("doctor GC preserves every actionable id, path, pid, and count byte-for-byte", async (t) => {
  const rawResult = {
    dryRun: false,
    olderThanDays: 30,
    dismissed: ["dispatch-a1", "dispatch-b2"],
    orphans: ["/tmp/atelier-worktrees/project/orphan-c3"],
    codexJobs: ["job-d4", "job-e5"],
    breakGlassAuthorizations: ["break-glass-id-f6"],
    errors: ["codex jobs: directory unavailable"],
    warnings: ["orphan retained: identity unavailable"],
    persistenceFailureTargets: ["dispatch-record", "event-log"],
    codexProcesses: {
      supported: true,
      swept: true,
      reaped: [{ pid: 101, signal: "SIGTERM", reason: "terminal dispatch" }],
      reported: [{
        pid: 202,
        command: "codex app-server resume job-d4",
        cwd: "/tmp/atelier-worktrees/project",
        cwdDeleted: false,
        worktreePath: "/tmp/atelier-worktrees/project/orphan-c3",
        reason: "ownership unproven",
      }],
      errors: ["process table unavailable"],
    },
    advisoryDebts: [{ id: "dispatch-g7", project: "project", attempts: 2 }],
  };
  const state = await fixture(t, rawResult);
  const response = await requestJson(state.port, state.tokens.api, {
    method: "POST",
    path: "/api/doctor/gc",
    body: { olderThanDays: 30 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.text, JSON.stringify(rawResult));
  assert.deepEqual(response.body, rawResult);
});

test("the default sandbox broker denies doctor GC", () => {
  assert.deepEqual(
    daemonBrokerDecision("/api/doctor/gc", DEFAULT_SANDBOX_BROKER_ALLOWLIST),
    { allowed: false, reason: "outside-allowlist" },
  );
});

test("an operator wildcard can expose doctor GC through the sandbox broker", () => {
  assert.deepEqual(
    daemonBrokerDecision("/api/doctor/gc", ["/api/*"]),
    { allowed: true, reason: "allowlisted" },
  );
});

test("an MCP-labelled bearer reaches doctor GC and receives redacted output", async (t) => {
  const leaked = "sk-1234567890abcdef";
  const state = await fixture(t, gcResultWithText(leaked));
  const response = await requestJson(state.port, state.tokens.mcp, {
    method: "POST",
    path: "/api/doctor/gc",
    body: { dryRun: true },
  });

  assert.equal(response.status, 200);
  assert.equal(response.text.includes(leaked), false);
  assert.equal(state.gcCalls.at(-1).actor, "mcp");
});

test("deep recovery pins every GC scan to the literal dry run", async (t) => {
  const state = await fixture(t, gcResultWithText("ordinary diagnostic"));
  for (const path of [
    "/api/recovery?deep=1",
    "/api/recovery?deep=1&dryRun=0",
    "/api/recovery?deep=1&dryRun=false",
  ]) {
    const response = await requestJson(state.port, state.tokens.api, { path });
    assert.equal(response.status, 200);
  }

  assert.equal(state.gcCalls.length, 3);
  assert.deepEqual(
    state.gcCalls.map(({ dryRun }) => dryRun),
    [true, true, true],
  );
});
