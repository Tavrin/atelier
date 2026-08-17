import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { clientBearerToken, ensureAuthSecret } from "./lib/auth.mjs";
import { probeProjectPath } from "./lib/capabilities.mjs";
import { createDispatcher } from "./lib/dispatch.mjs";
import { addProject, loadRegistry } from "./lib/registry.mjs";
import {
  _setBrResolver as _setTrackerBrResolver,
  initializeTrackerDirectory,
} from "./lib/tracker.mjs";

const execFileAsync = promisify(execFile);

function authHeaders(setup, extra = {}, label = "cli") {
  const token = clientBearerToken(label, { directory: setup.state, env: {} });
  return { Authorization: `Bearer ${token}`, ...extra };
}

function emptyRegistry(projects = []) {
  return { version: 1, defaults: {}, groups: [], projects };
}

async function fixture(t, projects = []) {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-daemon-"));
  const config = join(root, "config");
  const state = join(root, "state");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "projects.json"), `${JSON.stringify(emptyRegistry(projects))}\n`);
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit").catch(() => {});
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, state, children };
}

function cliEnv(setup, extra = {}) {
  const env = {
    ...process.env,
    ATELIER_CONFIG_DIR: setup.config,
    ATELIER_STATE_DIR: setup.state,
    ...extra,
  };
  if (!Object.hasOwn(extra, "PORT")) delete env.PORT;
  return env;
}

async function startDaemon(setup, extraEnv = {}) {
  const child = spawn(process.execPath, [resolve("bin", "atelier.mjs"), "serve", "--port", "0"], {
    cwd: resolve("."),
    env: cliEnv(setup, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  setup.children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("atelier serve did not listen")), 5_000);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`atelier serve exited (${code ?? signal}): ${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /Atelier listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolvePromise(match[1]);
    });
  });
  assert.equal((await readFile(join(setup.state, "atelier.url"), "utf8")).trim(), url);
  const ready = await fetch(url);
  assert.equal(ready.status, 200);
  return { child, url, stderr: () => stderr };
}

async function stopDaemon(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill("SIGTERM");
  const [code, signal] = await once(handle.child, "exit");
  assert.equal(code, 0, handle.stderr());
  assert.equal(signal, null);
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function gitProject(root, name, { commit = true } = {}) {
  const path = join(root, name);
  await mkdir(path);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: path });
  if (commit) {
    await writeFile(join(path, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: path });
    execFileSync(
      "git",
      ["-c", "user.name=Atelier Test", "-c", "user.email=atelier@example.invalid", "commit", "-q", "-m", "fixture"],
      { cwd: path },
    );
  }
  return {
    name,
    path,
    mainBranch: "main",
    tracker: "none",
    archetype: "git-only",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: [],
    dispatchProfile: {},
  };
}

async function cli(setup, args, extraEnv = {}) {
  return execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), ...args], {
    cwd: resolve("."),
    env: cliEnv(setup, extraEnv),
  });
}

async function fakeBr(root) {
  const directory = join(root, "fake-bin");
  const path = join(directory, "br");
  await mkdir(directory);
  await writeFile(path, [
    "#!/usr/bin/env node",
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'if (process.argv[2] !== "init") process.exit(2);',
    'mkdirSync(".beads", { recursive: true });',
    'writeFileSync(".beads/issues.jsonl", "");',
    "",
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

async function filesystemLayout(root, relative = "") {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const layout = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      layout.push({ path: `${child}/`, type: "directory" });
      layout.push(...await filesystemLayout(root, child));
    } else {
      layout.push({ path: child, type: "file", contents: await readFile(join(root, child), "utf8") });
    }
  }
  return layout;
}

async function waitForTerminal(url, id, headers) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}/api/dispatch/${encodeURIComponent(id)}`, { headers });
    assert.equal(response.status, 200);
    const record = await response.json();
    if (["prepare_failed", "failed", "rejected"].includes(record.state)) return record;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`dispatch ${id} did not fail during prepare`);
}

test("reply CLI advertises the human execution-profile acceptance flag", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "reply", "--help"],
    { cwd: resolve("."), env: process.env },
  );
  assert.match(stdout, /atelier reply .*--accept-execution-profile/);
});

test("live daemon owns simultaneous CLI and HTTP dispatch record creation", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "fixture", { commit: false });
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  const daemon = await startDaemon(setup);

  const cliDispatch = cli(
    setup,
    ["dispatch", "fixture", "--prompt", "cli fixture"],
    { PORT: "0" },
  );
  const httpDispatch = fetch(`${daemon.url}/api/dispatch`, {
    method: "POST",
    headers: authHeaders(setup, { "Content-Type": "application/json", "X-Atelier-Actor": "test" }, "api"),
    body: JSON.stringify({ project: "fixture", prompt: "http fixture" }),
  });
  const [{ stdout }, httpResponse] = await Promise.all([cliDispatch, httpDispatch]);
  assert.equal(httpResponse.status, 202);
  const cliId = stdout.trim();
  const httpId = (await httpResponse.json()).id;
  assert.match(cliId, /^[0-9a-f]{8}$/);
  assert.notEqual(cliId, httpId);

  const [cliRecord, httpRecord] = await Promise.all([
    waitForTerminal(daemon.url, cliId, authHeaders(setup)),
    waitForTerminal(daemon.url, httpId, authHeaders(setup)),
  ]);
  assert.equal(cliRecord.state, "prepare_failed");
  assert.equal(httpRecord.state, "prepare_failed");
  assert.equal(await readFile(join(setup.state, "atelier.lock"), "utf8"), `${daemon.child.pid}\n`);
  const indexPath = join(setup.state, "dispatches", "index.jsonl");
  const indexText = await readFile(indexPath, "utf8");
  const index = indexText
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(index.some((record) => record.id === cliId));
  assert.ok(index.some((record) => record.id === httpId));
  const eventSequences = {};
  for (const id of [cliId, httpId]) {
    const events = (await readFile(join(setup.state, "dispatches", `${id}.jsonl`), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    eventSequences[id] = events.map((event) => event.seq).join(",");
  }
  let secondWriter;
  assert.throws(
    () => {
      try {
        createDispatcher({ registry: emptyRegistry([project]), stateDir: setup.state });
      } catch (error) {
        secondWriter = error;
        throw error;
      }
    },
    (error) => error.code === "EATELIERLOCKED",
  );
  assert.equal(await readFile(indexPath, "utf8"), indexText);
  await stopDaemon(daemon);
  const log = (await readFile(join(setup.state, "logs", "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const creationActors = new Map(
    log
      .filter((event) => event.kind === "dispatch.transition" && event.from === null)
      .map((event) => [event.dispatchId, event.actor]),
  );
  assert.equal(creationActors.get(cliId), "cli");
  // Actor derives from the bearer credential (api), not the spoofed X-Atelier-Actor header.
  assert.equal(creationActors.get(httpId), "api");
  t.diagnostic(
    `ATT-001 proof: daemon PID ${daemon.child.pid}; CLI ${cliId} seq ${eventSequences[cliId]}; ` +
    `HTTP ${httpId} seq ${eventSequences[httpId]}; second writer ${secondWriter.code}, index unchanged`,
  );
});

test("dispatch without daemon leaves the state directory untouched", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "fixture");
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  const port = await unusedPort();
  const failure = await cli(
    setup,
    ["dispatch", "fixture", "--prompt", "must not run"],
    { PORT: String(port) },
  ).catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /no daemon; start it with `atelier serve` \/ systemctl --user start atelier/);
  assert.equal(existsSync(setup.state), false);
  assert.equal(existsSync(join(setup.state, "dispatches")), false);
});

test("dispatch distinguishes a live lock owner from an absent daemon", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "fixture");
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  await mkdir(setup.state, { recursive: true });
  // A real live daemon owns the lock AND has written its auth secret; mirror that
  // so token minting succeeds and the client reaches the reachability check.
  ensureAuthSecret(setup.state);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  await writeFile(join(setup.state, "atelier.lock"), `${process.pid}\n`);
  await writeFile(join(setup.state, "atelier.url"), `${url}\n`);
  const failure = await cli(setup, ["dispatch", "fixture", "--prompt", "must not run"])
    .catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(
    failure.stderr,
    new RegExp(`a daemon \\(PID ${process.pid}\\) owns this state dir but is not reachable at ${url}`),
  );
  assert.doesNotMatch(failure.stderr, /start it with `atelier serve`/);
  assert.equal(existsSync(join(setup.state, "dispatches")), false);
});

test("dispatch ignores and removes atelier.url when no live owner exists", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "fixture");
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  await mkdir(setup.state, { recursive: true });
  let requests = 0;
  const responder = createServer((_request, response) => {
    requests += 1;
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end('{"id":"spoofed"}');
  });
  responder.listen(0, "127.0.0.1");
  await once(responder, "listening");
  t.after(async () => {
    responder.close();
    await once(responder, "close").catch(() => {});
  });
  const urlPath = join(setup.state, "atelier.url");
  await writeFile(urlPath, `http://127.0.0.1:${responder.address().port}\n`);

  const failure = await cli(setup, ["dispatch", "fixture", "--prompt", "must not run"])
    .catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /no daemon; start it with `atelier serve`/);
  assert.equal(requests, 0);
  assert.equal(existsSync(urlPath), false);
});

test("dispatch --follow fails promptly when SSE ends before a nonterminal dispatch completes", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "fixture");
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  await mkdir(setup.state, { recursive: true });
  await writeFile(join(setup.state, "atelier.lock"), `${process.pid}\n`);
  let statusPolls = 0;
  const responder = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/dispatch") {
      request.resume();
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end('{"id":"follow-id"}');
      return;
    }
    if (request.method === "GET" && request.url === "/api/dispatch/follow-id/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('id: 1\ndata: {"type":"status","state":"running","dispatchId":"follow-id","seq":1}\n\n');
      return;
    }
    if (request.method === "GET" && request.url === "/api/dispatch/follow-id") {
      statusPolls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":"follow-id","state":"running"}');
      return;
    }
    response.writeHead(404).end();
  });
  responder.listen(0, "127.0.0.1");
  await once(responder, "listening");
  t.after(async () => {
    responder.close();
    await once(responder, "close").catch(() => {});
  });
  await writeFile(
    join(setup.state, "atelier.url"),
    `http://127.0.0.1:${responder.address().port}\n`,
  );

  const failure = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "dispatch", "fixture", "--prompt", "follow", "--follow"],
    { cwd: resolve("."), env: cliEnv(setup, { ATELIER_AUTH_TOKEN: "follow-test-token" }), timeout: 3_000 },
  ).catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /event stream ended before completion \(daemon stopped\?\)/);
  assert.equal(statusPolls, 1);
});

test("doctor offline maintenance refuses a live daemon, releases its lock, and permits restart", async (t) => {
  const setup = await fixture(t);
  const daemon = await startDaemon(setup);
  const refused = await cli(setup, ["doctor", "--gc", "--offline-maintenance"])
    .catch((error) => error);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^systemctl --user stop atelier first;/);

  await stopDaemon(daemon);
  const collected = await cli(setup, ["doctor", "--gc", "--offline-maintenance"]);
  assert.match(collected.stdout, /gc summary:/);
  assert.equal(existsSync(join(setup.state, "atelier.lock")), false);

  const restarted = await startDaemon(setup);
  assert.equal(await readFile(join(setup.state, "atelier.lock"), "utf8"), `${restarted.child.pid}\n`);
  await stopDaemon(restarted);
});

test("track --yes registers through the daemon with old-path equivalent storage", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "new-project");
  const probe = await probeProjectPath(project.path);
  const entry = { path: probe.path, ...probe.inferred };
  const oldRegistryPath = join(setup.root, "old-projects.json");
  const oldRegistry = await loadRegistry(oldRegistryPath);
  await addProject(oldRegistry, entry, oldRegistryPath);
  const expected = JSON.parse(await readFile(oldRegistryPath, "utf8")).projects[0];

  const daemon = await startDaemon(setup);
  const { stdout } = await cli(setup, ["track", project.path, "--yes"]);
  assert.match(stdout, /Registered new-project/);
  const stored = JSON.parse(await readFile(join(setup.config, "projects.json"), "utf8"));
  assert.deepEqual(stored.projects[0], expected);
  const projects = await fetch(`${daemon.url}/api/projects`, { headers: authHeaders(setup) })
    .then((response) => response.json());
  assert.ok(projects.projects.some((candidate) => candidate.name === "new-project"));
  await stopDaemon(daemon);
});

test("tracker-only track registration initializes missing storage equivalently through the daemon", async (t) => {
  const setup = await fixture(t);
  const trackerPath = join(setup.root, "notes");
  await mkdir(trackerPath);
  const br = await fakeBr(setup.root);
  _setTrackerBrResolver(() => br);
  t.after(() => _setTrackerBrResolver());
  const probe = await probeProjectPath(trackerPath);
  const entry = { path: probe.path, ...probe.inferred };
  const oldRegistryPath = join(setup.root, "old-tracker-only-projects.json");
  const oldRegistry = await loadRegistry(oldRegistryPath);
  await initializeTrackerDirectory(entry);
  await addProject(oldRegistry, entry, oldRegistryPath);
  const expected = JSON.parse(await readFile(oldRegistryPath, "utf8")).projects[0];
  const expectedLayout = await filesystemLayout(trackerPath);
  await rm(join(trackerPath, ".beads"), { recursive: true, force: true });

  const daemon = await startDaemon(setup, {
    PATH: `${dirname(br)}${delimiter}${process.env.PATH || ""}`,
  });
  const { stdout } = await cli(setup, ["track", trackerPath, "--yes"]);
  assert.match(stdout, /Registered notes/);
  const stored = JSON.parse(await readFile(join(setup.config, "projects.json"), "utf8"));
  assert.deepEqual(stored.projects[0], expected);
  assert.deepEqual(await filesystemLayout(trackerPath), expectedLayout);
  await stopDaemon(daemon);
});

test("external trackerLocation registration matches old entry and filesystem layout", async (t) => {
  const setup = await fixture(t);
  const project = await gitProject(setup.root, "external-project");
  const br = await fakeBr(setup.root);
  _setTrackerBrResolver(() => br);
  t.after(() => _setTrackerBrResolver());
  const trackerPath = join(setup.state, "trackers", project.name);
  await mkdir(trackerPath, { recursive: true });
  const oldEntry = {
    ...project,
    archetype: "full",
    tracker: "personal",
    trackerPath,
  };
  const oldRegistryPath = join(setup.root, "old-external-projects.json");
  const oldRegistry = await loadRegistry(oldRegistryPath);
  await initializeTrackerDirectory(oldEntry);
  await addProject(oldRegistry, oldEntry, oldRegistryPath);
  const expected = JSON.parse(await readFile(oldRegistryPath, "utf8")).projects[0];
  const expectedLayout = await filesystemLayout(trackerPath);
  await rm(trackerPath, { recursive: true, force: true });

  const daemon = await startDaemon(setup, {
    PATH: `${dirname(br)}${delimiter}${process.env.PATH || ""}`,
  });
  const response = await fetch(`${daemon.url}/api/projects`, {
    method: "POST",
    headers: authHeaders(setup, { "Content-Type": "application/json", "X-Atelier-Actor": "cli" }),
    body: JSON.stringify({
      ...project,
      archetype: "full",
      tracker: "personal",
      trackerLocation: "external",
    }),
  });
  assert.equal(response.status, 201, await response.text());
  const stored = JSON.parse(await readFile(join(setup.config, "projects.json"), "utf8"));
  assert.deepEqual(stored.projects[0], expected);
  assert.deepEqual(await filesystemLayout(trackerPath), expectedLayout);
  await stopDaemon(daemon);
});

test("dispatch detects a project added after daemon registry load", async (t) => {
  const setup = await fixture(t);
  const daemon = await startDaemon(setup);
  const project = await gitProject(setup.root, "late-project");
  await writeFile(join(setup.config, "projects.json"), `${JSON.stringify(emptyRegistry([project]))}\n`);
  const failure = await cli(setup, ["dispatch", "late-project", "--prompt", "must not run"])
    .catch((error) => error);
  assert.equal(failure.code, 1);
  assert.match(
    failure.stderr,
    /project exists in projects\.json but the running daemon predates it — restart the daemon \(systemctl --user restart atelier\) or register via `atelier track --yes`/,
  );
  await stopDaemon(daemon);
});
