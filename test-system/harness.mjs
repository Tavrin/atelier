import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { clientBearerToken } from "../server/lib/auth.mjs";
import { REAL_PROVIDER_DISABLED_CODE } from "./fake-agent/poison-adapter.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT = resolve(REPO_ROOT, "bin/atelier.mjs");
const REGISTER_FAKE = resolve(REPO_ROOT, "test-system/fake-agent/register.mjs");
const DIRECT_DISPATCHER_ATTEMPT = resolve(REPO_ROOT, "test-system/direct-dispatcher-attempt.mjs");
export const FAKE_AGENT = resolve(REPO_ROOT, "test-system/fake-agent/fake-agent.mjs");

function hermeticEnvironment(home, overrides = {}) {
  const env = {
    HOME: home,
    PATH: overrides.PATH ?? process.env.PATH ?? "",
    LC_ALL: "C",
    ATELIER_TEST_NO_REAL_PROVIDER: "1",
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ATELIER_TEST_")) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      key === "PATH" ||
      key === "ATELIER_CONFIG_DIR" ||
      key === "ATELIER_STATE_DIR" ||
      key === "PORT" ||
      key.startsWith("ATELIER_TEST_")
    ) env[key] = value;
  }
  env.HOME = home;
  env.LC_ALL = "C";
  env.ATELIER_TEST_NO_REAL_PROVIDER = "1";
  return env;
}

function gitEnvironment(home) {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function gitArgs(args) {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Atelier Golden",
    "-c", "user.email=golden@atelier.invalid",
    ...args,
  ];
}

function runGit(cwd, home, args) {
  return execFileAsync("git", gitArgs(args), { cwd, env: gitEnvironment(home) });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return port;
}

async function waitFor(probe, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function processExit(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error("process exit timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function terminatePid(pid) {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  try {
    await waitFor(() => !processExists(pid), `PID ${pid} to exit after SIGTERM`, 2_000);
    return;
  } catch {
    if (processExists(pid)) process.kill(pid, "SIGKILL");
  }
  await waitFor(() => !processExists(pid), `PID ${pid} to exit after SIGKILL`, 2_000);
}

export async function createGoldenHarness(t, {
  scenario,
  verifyCommands = ["node -e process.exit(0)"],
  projectName = "fixture",
  forceRegistrationFailure = false,
  onDaemonSpawn,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "atelier-golden-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const projectPath = join(root, "project");
  const tempHome = join(root, "home");
  const scenarioPath = join(root, "scenario.json");
  const childReceiptsPath = join(stateDir, "fake-child-pids.jsonl");
  const port = await freePort();
  const env = hermeticEnvironment(tempHome, {
    ATELIER_CONFIG_DIR: configDir,
    ATELIER_STATE_DIR: stateDir,
    ATELIER_TEST_CHILD_RECEIPTS: childReceiptsPath,
    PORT: String(port),
  });
  const trackedDispatches = new Set();
  let daemon;
  let daemonStdout = "";
  let daemonStderr = "";
  let projectInitialized = false;
  let tornDown = false;

  async function rawApi(path, { method = "GET", body } = {}) {
    // The daemon writes its auth secret at startup; authenticate once it exists
    // (the pre-registration readiness probe runs before it and stays unauthenticated).
    let authorization;
    try {
      authorization = `Bearer ${clientBearerToken("cli", { directory: stateDir, env: {} })}`;
    } catch {
      authorization = undefined;
    }
    const headers = {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authorization ? { Authorization: authorization } : {}),
    };
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      value = { text };
    }
    return { ok: response.ok, status: response.status, value };
  }

  async function api(path, options) {
    const response = await rawApi(path, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${path}: ${response.value.error || response.value.text}`);
    }
    return response.value;
  }

  async function childPids() {
    const contents = await readFile(childReceiptsPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line).pid);
  }

  async function teardown() {
    if (tornDown) return;
    tornDown = true;
    let teardownError;
    try {
      if (daemon && processExists(daemon.pid)) {
        const records = await rawApi("/api/dispatches").then(({ value }) => value, () => []);
        if (Array.isArray(records)) {
          for (const record of records) {
            trackedDispatches.add(record.id);
            if (!record.merged && !record.dismissed && [
              "completed", "completed_empty", "needs_input", "failed", "prepare_failed", "rejected", "stopped",
            ].includes(record.state)) {
              await rawApi(`/api/dispatch/${encodeURIComponent(record.id)}/dismiss`, {
                method: "POST",
                body: {},
              }).catch(() => {});
            }
          }
        }
      }

      const scenarioPids = await childPids();
      for (const pid of scenarioPids) await terminatePid(pid);

      if (daemon && processExists(daemon.pid)) {
        try {
          process.kill(-daemon.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      if (daemon) {
        try {
          await processExit(daemon);
        } catch {
          if (processExists(daemon.pid)) process.kill(-daemon.pid, "SIGKILL");
          await processExit(daemon);
        }
        assert.equal(processExists(daemon.pid), false, "golden harness leaked the Atelier daemon");
      }
      for (const pid of scenarioPids) {
        assert.equal(processExists(pid), false, `golden harness leaked fake-agent child PID ${pid}`);
      }
      if (projectInitialized) {
        const worktrees = (await runGit(projectPath, tempHome, ["worktree", "list", "--porcelain"]))
          .stdout.match(/^worktree /gm) || [];
        assert.equal(worktrees.length, 1, "golden harness leaked a dispatch worktree");
      }
      const processList = (await execFileAsync("ps", ["-eo", "pid=,args="])).stdout;
      assert.doesNotMatch(processList, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "golden harness leaked a fake-agent or daemon process");
      const worktreeRoot = join(stateDir, "worktrees");
      const remaining = await readdir(worktreeRoot, { recursive: true }).catch(() => []);
      assert.equal(remaining.filter((entry) => entry && !entry.endsWith(projectName)).length, 0,
        "golden harness left files under the disposable worktree root");
    } catch (error) {
      teardownError = error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    if (teardownError) throw teardownError;
  }

  t.after(teardown);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    await mkdir(tempHome, { recursive: true });
    await runGit(projectPath, tempHome, ["init", "-q", "--initial-branch=main"]);
    projectInitialized = true;
    await runGit(projectPath, tempHome, ["config", "user.name", "Atelier Golden"]);
    await runGit(projectPath, tempHome, ["config", "user.email", "golden@atelier.invalid"]);
    await writeFile(join(projectPath, "README.md"), "golden fixture\n");
    await runGit(projectPath, tempHome, ["add", "README.md"]);
    await runGit(projectPath, tempHome, ["commit", "-qm", "initial fixture"]);
    await writeFile(join(configDir, "projects.json"), `${JSON.stringify({
      version: 1,
      defaults: { concurrentDispatchCap: 4 },
      groups: [],
      projects: [],
    })}\n`);
    await writeFile(scenarioPath, `${JSON.stringify(scenario || { steps: [] })}\n`);

    daemon = spawn(
      process.execPath,
      ["--import", REGISTER_FAKE, ENTRYPOINT, "serve", "--port", String(port)],
      { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    daemon.stdout.on("data", (chunk) => { daemonStdout += chunk; });
    daemon.stderr.on("data", (chunk) => { daemonStderr += chunk; });
    onDaemonSpawn?.(daemon.pid);

    await waitFor(async () => {
      const response = await rawApi("/api/projects");
      return response.ok;
    }, "real Atelier daemon readiness").catch((error) => {
      throw new Error(`${error.message}\ndaemon stdout:\n${daemonStdout}\ndaemon stderr:\n${daemonStderr}`);
    });

    await api("/api/projects", {
      method: "POST",
      body: {
        name: projectName,
        path: forceRegistrationFailure ? join(root, "missing-project") : projectPath,
        mainBranch: "main",
        tracker: "none",
        archetype: "git-only",
        containerized: false,
        verifyMode: "worktree",
        verifyCommands,
        defaultAgent: "fake",
        dispatchEnv: { ATELIER_FAKE_SCENARIO: scenarioPath },
      },
    });
  } catch (error) {
    try {
      await teardown();
    } catch (teardownFailure) {
      error.message = `${error.message}\nteardown failure: ${teardownFailure.message}`;
    }
    throw error;
  }

  return {
    root,
    configDir,
    stateDir,
    projectPath,
    projectName,
    scenarioPath,
    childReceiptsPath,
    port,
    daemon,
    daemonPid: daemon.pid,
    env,
    api,
    rawApi,
    teardown,
    childPids,
    trackDispatch(id) {
      trackedDispatches.add(id);
      return id;
    },
    async dispatch(body = {}) {
      const requestedLane = body.lane ?? body.agent;
      if (["claude", "codex"].includes(requestedLane)) {
        const error = new Error(
          `${REAL_PROVIDER_DISABLED_CODE}: golden harness dispatch only permits the fake provider`,
        );
        error.code = REAL_PROVIDER_DISABLED_CODE;
        throw error;
      }
      if (requestedLane !== undefined && requestedLane !== "fake") {
        throw new Error(`golden harness only permits lane fake, got ${requestedLane}`);
      }
      const { lane: _lane, agent: _agent, model: _model, ...request } = body;
      const record = await api("/api/dispatch", {
        method: "POST",
        body: {
          ...request,
          project: projectName,
          prompt: request.prompt ?? "golden fixture",
          lane: "fake",
          model: "fake",
        },
      });
      trackedDispatches.add(record.id);
      return record;
    },
    waitRecord(id, predicate = (record) => [
      "completed", "completed_empty", "needs_input", "failed", "prepare_failed", "rejected", "stopped",
    ].includes(record.state), label = `dispatch ${id}`) {
      return waitFor(async () => {
        const record = await api(`/api/dispatch/${encodeURIComponent(id)}`);
        return predicate(record) ? record : false;
      }, label, 20_000);
    },
    async runCli(args) {
      const child = spawn(process.execPath, ["--import", REGISTER_FAKE, ENTRYPOINT, ...args], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      await once(child, "close");
      return { pid: child.pid, code: child.exitCode, signal: child.signalCode, stdout, stderr };
    },
    async attemptDirectDispatcher() {
      const child = spawn(
        process.execPath,
        ["--import", REGISTER_FAKE, DIRECT_DISPATCHER_ATTEMPT],
        { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      await once(child, "close");
      return { code: child.exitCode, stdout, stderr };
    },
    async events(id) {
      const path = join(stateDir, "dispatches", `${id}.jsonl`);
      const contents = await readFile(path, "utf8");
      return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

export async function runStandaloneFake(worktreePath, scenarioPath) {
  return execFileAsync(FAKE_AGENT, [scenarioPath], {
    cwd: worktreePath,
    env: hermeticEnvironment(dirname(scenarioPath)),
  });
}
