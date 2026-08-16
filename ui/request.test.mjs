import assert from "node:assert/strict";
import test from "node:test";

import {
  createThemeActionClient,
  atelierRequestOptions,
  setAtelierCsrfToken,
} from "./request.mjs";

test("UI request wrapper attributes every mutating method and leaves reads unattributed", () => {
  setAtelierCsrfToken("csrf-fixture");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    const request = atelierRequestOptions({ method, body: { ok: true } });
    assert.equal(request.headers.get("X-Atelier-Actor"), "ui");
    assert.equal(request.headers.get("X-Atelier-CSRF"), "csrf-fixture");
    assert.equal(request.headers.get("Content-Type"), "application/json");
    assert.equal(request.body, '{"ok":true}');
  }

  const read = atelierRequestOptions();
  assert.equal(read.headers.has("X-Atelier-Actor"), false, "GET is the negative control");
  assert.equal(read.headers.has("X-Atelier-CSRF"), false);
  assert.equal(read.headers.has("Content-Type"), false);
});

test("theme action client reuses Atelier request encoding and attributes mutations to theme:<id>", async () => {
  const calls = [];
  const client = createThemeActionClient("forest-town", {
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    },
  });

  await client("/api/dispatch/one/merge", {
    method: "POST",
    body: { force: false },
  });
  await client("/api/projects");

  assert.equal(calls[0].path, "/api/dispatch/one/merge");
  assert.equal(calls[0].options.headers.get("X-Atelier-Actor"), "theme:forest-town");
  assert.equal(calls[0].options.headers.get("X-Atelier-CSRF"), "csrf-fixture");
  assert.equal(calls[0].options.headers.get("Content-Type"), "application/json");
  assert.equal(calls[0].options.body, '{"force":false}');
  assert.equal(
    calls[1].options.headers.has("X-Atelier-Actor"),
    false,
    "read-only theme requests remain unattributed",
  );
  assert.throws(
    () => client("https://example.invalid/api/merge", { method: "POST" }),
    /same-origin/,
  );
  assert.throws(() => createThemeActionClient("../escape"), /Invalid theme id/);
});

test("theme action client uses the shared bounded theme-id corpus", () => {
  const fetchImpl = async () => new Response("{}");
  for (const id of ["a", "forest-2", "a".repeat(40)]) {
    assert.doesNotThrow(() => createThemeActionClient(id, { fetchImpl }), id);
  }
  for (const id of ["", "-forest", "Forest", "forest_town", "a".repeat(41)]) {
    assert.throws(
      () => createThemeActionClient(id, { fetchImpl }),
      /Invalid theme id/,
      id || "empty id",
    );
  }
});
