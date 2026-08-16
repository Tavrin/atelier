import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedDispatchEnvKey,
  minimalChildPath,
  sanitizeChildEnv,
} from "./environment-policy.mjs";

test("environment policy classifies the required execution controls", () => {
  for (const key of [
    "PATH", "HOME", "XDG_CONFIG_HOME", "GIT_DIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "ELECTRON_RUN_AS_NODE", "PYTHONPATH",
    "PERL5LIB", "RUBYOPT", "BASH_ENV", "ENV", "ZDOTDIR", "IFS", "http_proxy",
    "HTTPS_PROXY", "all_proxy", "No_PrOxY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS", "CLAUDE_CONFIG_DIR", "ANTHROPIC_HOME", "OPENAI_CONFIG_FILE",
    "CODEX_HOME",
  ]) {
    assert.throws(
      () => assertAllowedDispatchEnvKey(key),
      /controls execution; not permitted in dispatchEnv/,
      key,
    );
  }
  assert.equal(assertAllowedDispatchEnvKey("MY_APP_FLAG"), "MY_APP_FLAG");
});

test("provider sanitization replaces hostile controls with trusted process baselines", () => {
  const hostile = {
    PATH: "/hostile/bin",
    HOME: "/hostile/home",
    GIT_DIR: "/hostile/repository",
    NODE_OPTIONS: "--require=/hostile/loader.cjs",
    http_proxy: "http://hostile.invalid",
    MY_APP_FLAG: "enabled",
  };
  const clean = sanitizeChildEnv(hostile, { class: "provider" });

  assert.equal(clean.PATH, minimalChildPath());
  assert.notEqual(clean.HOME, "/hostile/home");
  assert.equal(clean.GIT_DIR, undefined);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.http_proxy, undefined);
  assert.equal(clean.MY_APP_FLAG, "enabled");
});
