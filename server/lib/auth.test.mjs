import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTH_SECRET_FILE,
  clientBearerToken,
  createBreakGlassTokenAuthority,
  createRequestAuth,
  ensureAuthSecret,
  mintBearerToken,
  verifyBearerToken,
  verifyBreakGlassToken,
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

  for (const label of ["api", "cli", "mcp", "sandboxed-agent"]) {
    const token = mintBearerToken(secret, label);
    assert.equal(verifyBearerToken(secret, token), label);
    assert.equal(clientBearerToken(label, { directory, env: {} }), token);
  }
  assert.equal(verifyBearerToken(secret, `${mintBearerToken(secret, "mcp")}x`), undefined);
  assert.equal(verifyBearerToken(secret, "atelier-v1.human-ui.invalid"), undefined);
});

test("dispatch-scoped sandbox bearers authenticate as one actor with distinct credential keys", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-dispatch-token-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = ensureAuthSecret(directory);
  const first = mintBearerToken(secret, "sandboxed-agent", "dispatch-one");
  const second = mintBearerToken(secret, "sandboxed-agent", "dispatch-two");
  assert.notEqual(first, second);
  assert.equal(verifyBearerToken(secret, first), "sandboxed-agent");
  assert.equal(verifyBearerToken(secret, second), "sandboxed-agent");

  const auth = createRequestAuth({ directory });
  const contextFor = (token) => auth.guard({
    method: "GET",
    headers: {
      host: "127.0.0.1:5170",
      authorization: `Bearer ${token}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
  }, { path: "/api/events", port: 5170 });
  const firstContext = contextFor(first);
  const secondContext = contextFor(second);
  assert.equal(firstContext.actor, "sandboxed-agent");
  assert.equal(secondContext.actor, "sandboxed-agent");
  assert.notEqual(firstContext.credentialKey, secondContext.credentialKey);
});

test("break-glass tokens use a distinct signed purpose and random identifier", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-auth-break-glass-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = ensureAuthSecret(directory);
  const authority = createBreakGlassTokenAuthority({ directory });
  const minted = authority.mint();

  assert.match(minted.tokenId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authority.verify(minted.token), minted.tokenId);
  assert.equal(verifyBreakGlassToken(secret, minted.token), minted.tokenId);
  assert.equal(verifyBearerToken(secret, minted.token), undefined);
  assert.equal(authority.verify(mintBearerToken(secret, "api")), undefined);
  assert.equal(authority.verify(`${minted.token}x`), undefined);
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
