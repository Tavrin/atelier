import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAuthSecret, mintBearerToken } from "./lib/auth.mjs";
import { TIMELINE_LIMIT } from "./lib/timeline.mjs";
import { createServer, listenLoopback } from "./server.mjs";

function record(index) {
  const id = `dispatch-${String(index).padStart(3, "0")}`;
  return {
    id,
    project: "fixture",
    ticketId: `ticket-${id}`,
    state: "running",
    startedAt: "2026-08-20T10:00:00.000Z",
    verify: null,
    review: null,
    merged: null,
    postMerge: null,
  };
}

function boardEventsStub() {
  return { refresh() {}, close() {}, onEvent() { return () => {}; } };
}

function dispatcherStub(records) {
  let gcCalls = 0;
  let getCalls = 0;
  let listCalls = 0;
  let persistenceCalls = 0;
  return {
    list() {
      listCalls += 1;
      return records;
    },
    get(id) {
      getCalls += 1;
      return records.find((candidate) => candidate.id === id);
    },
    listConvoys: () => [],
    persistenceStatus() {
      persistenceCalls += 1;
      return { degraded: false, targets: [] };
    },
    gc() {
      gcCalls += 1;
      throw new Error("timeline must not call gc");
    },
    onEvent() { return () => {}; },
    counts: () => ({ gcCalls, getCalls, listCalls, persistenceCalls }),
  };
}

function send(port, path, token) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", rejectPromise);
    request.end();
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-timeline-routes-"));
  const stateDir = join(root, "state");
  await mkdir(stateDir);
  const records = Array.from({ length: 101 }, (_, index) => record(index));
  const dispatcher = dispatcherStub(records);
  const server = createServer({
    registry: { version: 1, defaults: {}, groups: [], projects: [] },
    dispatcher,
    atelierStateDir: stateDir,
    boardEvents: boardEventsStub(),
    eventLog: { append() {}, read() { return []; }, close() {} },
  });
  const { port } = await listenLoopback(server, 0);
  const token = mintBearerToken(ensureAuthSecret(stateDir), "api");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { port, token, dispatcher };
}

test("timeline routes are authenticated bounded reads with an unknown-id 404", async (t) => {
  const { port, token, dispatcher } = await fixture(t);

  for (const path of ["/api/timeline", "/api/timeline/dispatch-000"]) {
    const response = await send(port, path);
    assert.equal(response.status, 401);
  }

  const index = await send(port, "/api/timeline?limit=999", token);
  assert.equal(index.status, 200);
  assert.equal(index.body.items.length, TIMELINE_LIMIT);
  assert.equal(index.body.counts.total, 202);
  assert.equal(index.body.truncated, true);
  assert.ok(index.body.limits.some(({ topic }) => topic === "full_history_read"));

  const empty = await send(port, "/api/timeline?limit=0", token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, []);
  assert.equal(empty.body.truncated, true);

  const beforeDrillDown = dispatcher.counts();
  const drillDown = await send(port, "/api/timeline/dispatch-000", token);
  assert.equal(drillDown.status, 200);
  assert.equal(drillDown.body.dispatchId, "dispatch-000");
  assert.deepEqual(drillDown.body.items.map(({ stage }) => stage), ["work", "execution"]);
  const afterDrillDown = dispatcher.counts();
  assert.equal(afterDrillDown.listCalls - beforeDrillDown.listCalls, 1);
  assert.equal(afterDrillDown.getCalls - beforeDrillDown.getCalls, 0);
  assert.equal(afterDrillDown.persistenceCalls - beforeDrillDown.persistenceCalls, 1);

  const missing = await send(port, "/api/timeline/missing", token);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Unknown dispatch: missing/);
  assert.deepEqual(dispatcher.counts(), {
    gcCalls: 0,
    getCalls: 0,
    listCalls: 5,
    persistenceCalls: 3,
  });
});

test("timeline limit validation matches the other bounded projections", async (t) => {
  const { port, token } = await fixture(t);
  for (const query of ["?limit=-1", "?limit=1.5", "?limit=invalid", "?limit="]) {
    const response = await send(port, `/api/timeline${query}`, token);
    assert.equal(response.status, 400);
    assert.match(response.body.error, /limit must be a non-negative integer/);
  }
});

test("timeline drill-down returns 400 for malformed percent encoding", async (t) => {
  const { port, token } = await fixture(t);
  const response = await send(port, "/api/timeline/%", token);
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Malformed timeline dispatch id/);
});
