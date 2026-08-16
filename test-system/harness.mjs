import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT = resolve(REPO_ROOT, "bin/atelier.mjs");
const REGISTER_FAKE = resolve(REPO_ROOT, "test-system/fake-agent/register.mjs");
export const FAKE_AGENT = resolve(REPO_ROOT, "test-system/fake-agent/fake-agent.mjs");

function scrubbedEnvironment(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/key|token|secret|password|credential/i.test(key)) env[key] = value;
  }
  return { ...env, ...overrides, ATELIER_TEST_NO_REAL_PROVIDER: "1" };
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
  if (child.exitCode !== null || child.signalCode !== null) return;
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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function createGoldenHarness(t, {
  scenario,
  verifyCommands = ["node -e process.exit(0)"],
  projectName = "fixture",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "atelier-golden-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const projectPath = join(root, "project");
  const scenarioPath = join(root, "scenario.json");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await execFileAsync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  await execFileAsync("git", ["config", "user.name", "Atelier Golden"], { cwd: projectPath });
  await execFileAsync("git", ["config", "user.email", "golden@atelier.invalid"], { cwd: projectPath });
  await writeFile(join(projectPath, "README.md"), "golden fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: projectPath });
  await execFileAsync("git", ["commit", "-qm", "initial fixture"], { cwd: projectPath });
  await writeFile(join(configDir, "projects.json"), `${JSON.stringify({
    version: 1,
    defaults: { concurrentDispatchCap: 4 },
    groups: [],
    projects: [],
  })}\n`);
  await writeFile(scenarioPath, `${JSON.stringify(scenario || { steps: [] })}\n`);
  const port = await freePort();
  const env = scrubbedEnvironment({
    ATELIER_CONFIG_DIR: configDir,
    ATELIER_STATE_DIR: stateDir,
    PORT: String(port),
  });
  const daemon = spawn(
    process.execPath,
    ["--import", REGISTER_FAKE, ENTRYPOINT, "serve", "--port", String(port)],
    { cwd: REPO_ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.on("data", (chunk) => { daemonStdout += chunk; });
  daemon.stderr.on("data", (chunk) => { daemonStderr += chunk; });

  async function rawApi(path, { method = "GET", body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
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
      path: projectPath,
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
  // The HTTP writer currently materializes false tracker booleans that the
  // registry reload validator rejects for tracker:none. Remove only those
  // derived defaults so CLI subprocesses can reach the production dispatch
  // seam this harness is meant to test.
  const persistedRegistryPath = join(configDir, "projects.json");
  const persistedRegistry = JSON.parse(await readFile(persistedRegistryPath, "utf8"));
  for (const project of persistedRegistry.projects) {
    if (project.tracker !== "none") continue;
    if (project.autoCommitTracker === false) delete project.autoCommitTracker;
    if (project.autoCloseOnMerge === false) delete project.autoCloseOnMerge;
  }
  await writeFile(persistedRegistryPath, `${JSON.stringify(persistedRegistry, null, 2)}\n`);

  const trackedDispatches = new Set();
  const harness = {
    root,
    configDir,
    stateDir,
    projectPath,
    projectName,
    scenarioPath,
    port,
    daemon,
    daemonPid: daemon.pid,
    env,
    api,
    rawApi,
    trackDispatch(id) {
      trackedDispatches.add(id);
      return id;
    },
    async dispatch(body = {}) {
      const record = await api("/api/dispatch", {
        method: "POST",
        body: { project: projectName, prompt: "golden fixture", lane: "fake", model: "fake", ...body },
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
    async events(id) {
      const path = join(stateDir, "dispatches", `${id}.jsonl`);
      const contents = await readFile(path, "utf8");
      return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };

  let tornDown = false;
  harness.teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    try {
      const records = (await rawApi("/api/dispatches")).value;
      if (Array.isArray(records)) {
        for (const record of records) {
          trackedDispatches.add(record.id);
          if (!record.merged && !record.dismissed && [
            "completed", "completed_empty", "needs_input", "failed", "prepare_failed", "rejected", "stopped",
          ].includes(record.state)) {
            await rawApi(`/api/dispatch/${encodeURIComponent(record.id)}/dismiss`, {
              method: "POST",
              body: {},
            });
          }
        }
      }
    } finally {
      if (processExists(daemon.pid)) {
        try {
          process.kill(-daemon.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      try {
        await processExit(daemon);
      } catch {
        if (processExists(daemon.pid)) process.kill(-daemon.pid, "SIGKILL");
        await processExit(daemon);
      }
    }
    assert.equal(processExists(daemon.pid), false, "golden harness leaked the Atelier daemon");
    const worktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectPath,
    })).stdout.match(/^worktree /gm) || [];
    assert.equal(worktrees.length, 1, "golden harness leaked a dispatch worktree");
    const processList = (await execFileAsync("ps", ["-eo", "pid=,args="])).stdout;
    assert.doesNotMatch(processList, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "golden harness leaked a fake-agent or daemon process");
    const worktreeRoot = join(stateDir, "worktrees");
    const remaining = await readdir(worktreeRoot, { recursive: true }).catch(() => []);
    assert.equal(remaining.filter((entry) => entry && !entry.endsWith(projectName)).length, 0,
      "golden harness left files under the disposable worktree root");
    await rm(root, { recursive: true, force: true });
  };
  t.after(() => harness.teardown());
  return harness;
}

export async function runStandaloneFake(worktreePath, scenarioPath) {
  return execFileAsync(FAKE_AGENT, [scenarioPath], {
    cwd: worktreePath,
    env: scrubbedEnvironment(),
  });
}
