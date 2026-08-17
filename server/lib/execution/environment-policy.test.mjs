import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertAllowedDispatchEnvKey,
  gitChildEnv,
  minimalChildPath,
  sanitizeChildEnv,
} from "./environment-policy.mjs";

const execFileAsync = promisify(execFile);

test("environment policy classifies the required execution controls", () => {
  for (const key of [
    "PATH", "HOME", "XDG_CONFIG_HOME", "GIT_DIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "ELECTRON_RUN_AS_NODE", "PYTHONPATH",
    "PERL5LIB", "RUBYOPT", "BASH_ENV", "ENV", "ZDOTDIR", "IFS", "http_proxy",
    "HTTPS_PROXY", "all_proxy", "No_PrOxY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS", "CLAUDE_CONFIG_DIR", "ANTHROPIC_HOME", "OPENAI_CONFIG_FILE",
    "CODEX_HOME", "SSH_ASKPASS", "KRB5_CONFIG", "KRB5CCNAME", "GLIBC_TUNABLES",
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

  assert.equal(clean.PATH, process.env.PATH || minimalChildPath());
  assert.notEqual(clean.HOME, "/hostile/home");
  assert.equal(clean.GIT_DIR, undefined);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.http_proxy, undefined);
  assert.equal(clean.MY_APP_FLAG, "enabled");
});

test("trusted parent PATH resolves a provider stub and survives provider, editor and git envs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-provider-path-"));
  const fakeHome = join(root, "home");
  const localBin = join(fakeHome, ".local", "bin");
  await mkdir(localBin, { recursive: true });
  const command = process.platform === "win32" ? "claude.cmd" : "claude";
  const stub = join(localBin, command);
  await writeFile(
    stub,
    process.platform === "win32" ? "@echo off\r\necho resolved\r\n" : "#!/bin/sh\nprintf 'resolved\\n'\n",
  );
  if (process.platform !== "win32") await chmod(stub, 0o755);

  const keys = ["HOME", "PATH", "GIT_DIR", "LD_AUDIT", "SSH_ASKPASS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.HOME = fakeHome;
  process.env.PATH = `${localBin}${delimiter}${previous.PATH || ""}`;
  process.env.GIT_DIR = "/hostile/repository";
  process.env.LD_AUDIT = "/hostile/audit.so";
  process.env.SSH_ASKPASS = "/hostile/askpass";

  const explicit = { ...process.env, PATH: "/project/smuggled/bin" };
  const providerEnv = sanitizeChildEnv(explicit, { class: "provider" });
  const editorEnv = sanitizeChildEnv(explicit, { class: "editor" });
  const gitEnv = gitChildEnv({ PATH: "/project/smuggled/bin" });
  for (const env of [providerEnv, editorEnv, gitEnv]) {
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.LD_AUDIT, undefined);
    assert.equal(env.SSH_ASKPASS, undefined);
  }

  const { stdout } = await execFileAsync("claude", [], { env: providerEnv, windowsHide: true });
  assert.equal(stdout.trim(), "resolved");
});

test("git posture pins cannot be undone by caller env", () => {
  const env = gitChildEnv({
    GIT_CONFIG_GLOBAL: "/hostile/global",
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_PAGER: "hostile-pager",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/hostile/hooks",
    LC_ALL: "hostile-locale",
  }, {
    allowDenied: [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_PAGER",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ],
  });

  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
  assert.equal(env.GIT_CONFIG_VALUE_0, "/dev/null");
  assert.equal(env.LC_ALL, "C");
});

test("git posture neutralizes a hostile repo-local hooksPath", async (t) => {
  if (process.platform === "win32") {
    t.skip("the /dev/null git posture is POSIX-specific");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "atelier-git-posture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const hooks = join(root, "hooks");
  const receipt = join(root, "hook-ran");
  await mkdir(repository);
  await mkdir(hooks);
  await writeFile(join(hooks, "post-commit"), `#!/bin/sh\nprintf ran >'${receipt}'\n`);
  await chmod(join(hooks, "post-commit"), 0o755);
  const env = gitChildEnv();

  await execFileAsync("git", ["init", "-q"], { cwd: repository, env, windowsHide: true });
  await execFileAsync("git", ["config", "--local", "core.hooksPath", hooks], {
    cwd: repository,
    env,
    windowsHide: true,
  });
  await writeFile(join(repository, "tracked.txt"), "safe\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository, env, windowsHide: true });
  await execFileAsync("git", [
    "-c", "user.name=Atelier Test",
    "-c", "user.email=atelier@example.invalid",
    "commit", "-q", "-m", "controlled posture",
  ], { cwd: repository, env, windowsHide: true });

  await assert.rejects(readFile(receipt), (error) => error.code === "ENOENT");
});
