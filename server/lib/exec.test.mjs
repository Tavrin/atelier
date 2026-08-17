import assert from "node:assert/strict";
import { once } from "node:events";
import { delimiter, join } from "node:path";
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
  assert.equal(calls[2].options.env.PATH, process.env.PATH);
  assert.equal(calls[2].options.env.HOME, process.env.HOME);
});

test("runFile strips denied caller Git env while preserving allowed overrides and trusted HOME/PATH", async (t) => {
  const previous = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_DIR: process.env.GIT_DIR,
    LD_AUDIT: process.env.LD_AUDIT,
    SSH_ASKPASS: process.env.SSH_ASKPASS,
  };
  process.env.HOME = "/trusted/operator";
  process.env.PATH = `${join(process.env.HOME, ".local", "bin")}${delimiter}/usr/bin`;
  process.env.GIT_CONFIG_GLOBAL = "/hostile/global-config";
  process.env.GIT_DIR = "/hostile/repository";
  process.env.LD_AUDIT = "/hostile/audit.so";
  process.env.SSH_ASKPASS = "/hostile/askpass";
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _setExecFileRunner();
  });

  const captured = [];
  _setExecFileRunner((_file, _args, options, callback) => {
    captured.push(options.env);
    callback(null, "ok\n", "");
  });
  await runFile("git", ["status"], {
    env: {
      MY_APP_FLAG: "enabled",
      GIT_CONFIG_COUNT: "0",
      HOME: "/project/home",
      PATH: "/project/bin",
    },
  });
  await runFile("git", ["status"], {
    env: { GIT_CONFIG_COUNT: "0" },
    allowDenied: ["GIT_CONFIG_COUNT"],
  });

  assert.equal(captured[0].GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(captured[0].GIT_DIR, undefined);
  assert.equal(captured[0].LD_AUDIT, undefined);
  assert.equal(captured[0].SSH_ASKPASS, undefined);
  assert.equal(captured[0].MY_APP_FLAG, "enabled");
  assert.equal(captured[0].GIT_CONFIG_COUNT, "1");
  assert.equal(captured[0].GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(captured[0].GIT_CONFIG_VALUE_0, "/dev/null");
  assert.equal(captured[0].GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(captured[0].GIT_PAGER, "cat");
  assert.equal(captured[0].HOME, process.env.HOME);
  assert.equal(captured[0].PATH, process.env.PATH);
  assert.equal(captured[0].LC_ALL, "C");
  assert.equal(captured[1].GIT_CONFIG_COUNT, "1");
});

test("runFile sanitizes the default tracker child environment", async (t) => {
  const keys = ["HOME", "PATH", "GIT_DIR", "LD_AUDIT", "MY_SERVICE_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _setExecFileRunner();
  });
  process.env.HOME = "/trusted/operator";
  process.env.PATH = `${join(process.env.HOME, ".local", "bin")}${delimiter}/usr/bin`;
  process.env.GIT_DIR = "/hostile/repository";
  process.env.LD_AUDIT = "/hostile/audit.so";
  process.env.MY_SERVICE_TOKEN = "secret";

  let captured;
  _setExecFileRunner((_file, _args, options, callback) => {
    captured = options.env;
    callback(null, "ok\n", "");
  });
  await runFile("br", ["ready"]);

  assert.equal(captured.HOME, process.env.HOME);
  assert.equal(captured.PATH, process.env.PATH);
  assert.equal(captured.GIT_DIR, undefined);
  assert.equal(captured.LD_AUDIT, undefined);
  assert.equal(captured.MY_SERVICE_TOKEN, undefined);
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
