import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTH_SECRET_FILE,
  clientBearerToken,
  createRequestAuth,
  ensureAuthSecret,
  mintBearerToken,
  verifyBearerToken,
} from "./auth.mjs";

test("auth secret is created owner-only and reused across starts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = ensureAuthSecret(directory);
  const path = join(directory, AUTH_SECRET_FILE);
  assert.equal(readFileSync(path, "utf8"), `${first}\n`);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(ensureAuthSecret(directory), first);
});

test("browser sessions are accepted only within their signed lifetime", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-session-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let currentTime = 1_000;
  const auth = createRequestAuth({
    directory,
    now: () => currentTime,
    sessionTtlMs: 500,
  });
  const session = auth.mintSession();
  const request = {
    method: "GET",
    headers: {
      host: "127.0.0.1:5170",
      cookie: session.cookie.split(";", 1)[0],
    },
    socket: { remoteAddress: "127.0.0.1" },
  };

  assert.equal(auth.guard(request, { path: "/api/projects", port: 5170 }).actor, "human-ui");
  currentTime += 501;
  assert.throws(
    () => auth.guard(request, { path: "/api/projects", port: 5170 }),
    /session is invalid or expired/,
  );
});

test("bearers bind the client label and compare signatures safely", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-token-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = ensureAuthSecret(directory);

  for (const label of ["api", "cli", "mcp"]) {
    const token = mintBearerToken(secret, label);
    assert.equal(verifyBearerToken(secret, token), label);
    assert.equal(clientBearerToken(label, { directory, env: {} }), token);
  }
  assert.equal(verifyBearerToken(secret, `${mintBearerToken(secret, "mcp")}x`), undefined);
  assert.equal(verifyBearerToken(secret, "atelier-v1.human-ui.invalid"), undefined);
});

test("explicit bearer configuration wins and missing installation state is clear", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(
    clientBearerToken("cli", { directory, env: { ATELIER_AUTH_TOKEN: "configured-token" } }),
    "configured-token",
  );
  assert.throws(
    () => clientBearerToken("cli", { directory, env: {} }),
    /start the daemon or set ATELIER_AUTH_TOKEN/,
  );
});

test("auth secret reads refuse symlinks", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-symlink-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "outside-secret");
  writeFileSync(target, `${"a".repeat(43)}\n`, { mode: 0o600 });
  symlinkSync(target, join(directory, AUTH_SECRET_FILE));

  assert.throws(
    () => ensureAuthSecret(directory),
    /refuses non-regular or symlinked state file/,
  );
  assert.throws(
    () => clientBearerToken("cli", { directory, env: {} }),
    /refuses non-regular or symlinked state file/,
  );
});
