import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  _setExecFileRunner,
  envHygiene,
  GIT_TIMEOUT_MS,
  LONG_GIT_TIMEOUT_MS,
  killTracked,
  runFile,
  spawnTracked,
} from "./exec.mjs";

test("runFile gives git a locale-stable timeout with per-call overrides", async (t) => {
  const calls = [];
  _setExecFileRunner((file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, "ok\n", "");
  });
  t.after(() => _setExecFileRunner());

  await runFile("/usr/bin/git", ["status"], { env: { ATELIER_TEST: "yes", LC_ALL: "fr_FR" } });
  await runFile("git", ["show", "HEAD"], { timeout: LONG_GIT_TIMEOUT_MS });
  await runFile("br", ["ready"]);

  assert.equal(calls[0].options.timeout, GIT_TIMEOUT_MS);
  assert.equal(calls[0].options.env.LC_ALL, "C");
  assert.equal(calls[0].options.env.ATELIER_TEST, "yes");
  assert.equal(calls[1].options.timeout, LONG_GIT_TIMEOUT_MS);
  assert.equal(calls[1].options.env.LC_ALL, "C");
  assert.equal(calls[2].options.timeout, 15_000);
  assert.equal(calls[2].options.env, undefined);
});

test("envHygiene copies the environment without secret-shaped keys", () => {
  const source = {
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
    MY_SERVICE_TOKEN: "service-secret",
    CLAUDE_PLUGIN_DATA: "/atelier/codex-companion",
    KEEP: "visible",
  };
  const clean = envHygiene(source);

  assert.deepEqual(clean, {
    CLAUDE_PLUGIN_DATA: "/atelier/codex-companion",
    KEEP: "visible",
  });
  assert.equal(source.OPENAI_API_KEY, "openai-secret");
  assert.equal(source.MY_SERVICE_TOKEN, "service-secret");
});

test("envHygiene strips every SECRET_ENV_KEY pattern alternative, not only key/token", () => {
  const source = {
    SOME_PASSWORD: "hunter2",
    SERVICE_SECRET: "shh",
    AWS_CREDENTIAL_FILE: "/home/user/.aws/credentials",
    KEEP: "visible",
  };
  const clean = envHygiene(source);

  assert.deepEqual(clean, { KEEP: "visible" });
});

test("envHygiene keeps inherited secrets out of a child process", async () => {
  const child = spawnTracked(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify({
        openai: process.env.OPENAI_API_KEY,
        token: process.env.MY_SERVICE_TOKEN,
        pluginData: process.env.CLAUDE_PLUGIN_DATA,
        ordinary: process.env.ORDINARY_VAR,
      }))`,
    ],
    {
      cwd: process.cwd(),
      env: envHygiene({
        OPENAI_API_KEY: "openai-secret",
        MY_SERVICE_TOKEN: "service-secret",
        CLAUDE_PLUGIN_DATA: "/atelier/codex-companion",
        ORDINARY_VAR: "visible",
      }),
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), {
    pluginData: "/atelier/codex-companion",
    ordinary: "visible",
  });
});

test("envHygiene keeps every SECRET_ENV_KEY pattern alternative out of a child process", async () => {
  const child = spawnTracked(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify({
        password: process.env.SOME_PASSWORD,
        serviceSecret: process.env.SERVICE_SECRET,
        awsCredential: process.env.AWS_CREDENTIAL_FILE,
        ordinary: process.env.ORDINARY_VAR,
      }))`,
    ],
    {
      cwd: process.cwd(),
      env: envHygiene({
        SOME_PASSWORD: "hunter2",
        SERVICE_SECRET: "shh",
        AWS_CREDENTIAL_FILE: "/home/user/.aws/credentials",
        ORDINARY_VAR: "visible",
      }),
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { ordinary: "visible" });
});

test("spawnTracked and killTracked terminate a tracked node child", async () => {
  const child = spawnTracked(
    process.execPath,
    ["-e", "setInterval(() => {}, 1e3)"],
    { cwd: process.cwd(), env: process.env },
  );
  await once(child, "spawn");
  assert.equal(child.stdin, null);

  const exited = once(child, "exit");
  killTracked(child);
  const [code, signal] = await exited;

  if (process.platform !== "win32") {
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
  } else {
    assert.ok(code !== null || signal !== null);
  }
});

test("spawnTracked honors an explicit piped stdin override", async () => {
  const child = spawnTracked(
    process.execPath,
    ["-e", "process.stdin.resume(); setInterval(() => {}, 1e3)"],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(child, "spawn");
  assert.equal(child.stdin.writable, true);

  const exited = once(child, "exit");
  killTracked(child);
  await exited;
});
