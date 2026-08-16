#!/usr/bin/env node

import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { probeProject, probeProjectPath, trackerMode } from "../server/lib/capabilities.mjs";
import { createBoardEvents } from "../server/lib/board-events.mjs";
import { CommandClientError, createCommandClient } from "../server/lib/command-client.mjs";
import { createDispatcher } from "../server/lib/dispatch.mjs";
import { createEventLog } from "../server/lib/event-log.mjs";
import { resolveBrExecutable, runFile } from "../server/lib/exec.mjs";
import { acquireInstanceLock } from "../server/lib/instance-lock.mjs";
import { configDir, stateDir } from "../server/lib/paths.mjs";
import {
  loadRegistry,
  RegistryError,
  STARTER_REGISTRY,
} from "../server/lib/registry.mjs";
import { installService, restartServiceSafely } from "../server/lib/service.mjs";
import { createBootStamp } from "../server/lib/version.mjs";
import {
  createServer,
  listenLoopback,
  shutdownServer,
  trackProject,
} from "../server/server.mjs";
import { formatLogEvent } from "./log-format.mjs";

function usage() {
  return [
    "Usage:",
    "  atelier init",
    "  atelier serve [--port N]",
    "  atelier mcp [--port N]",
    "  atelier projects",
    "  atelier track <project|path> [--yes]",
    "  atelier move-tracker <project> --to external|in-repo",
    "  atelier dispatch <project> (<ticketId>|--prompt \"...\") [--model X] [--effort low|medium|high|xhigh|max] [--lane codex] [--follow]",
    "  atelier reply <dispatchId> <text...> [--follow]",
    "  atelier plan <dispatchId> --approve | --revise \"text\"",
    "  atelier logs [--follow] [--kind K[,K]] [--project NAME] [--dispatch ID] [--ticket ID] [--actor A] [--since ISO] [--limit N]",
    "  atelier doctor [--install-service | --gc [--older-than-days N] [--offline-maintenance] | --safe-restart [--port N]] [--dry-run]",
  ].join("\n");
}

function subcommandUsage(command) {
  const line = usage()
    .split("\n")
    .find((candidate) => candidate.startsWith(`  atelier ${command}`));
  if (!line) return undefined;
  const note = command === "doctor"
    ? "\nStarting the daemon during --offline-maintenance fails the service unit until it is retried."
    : "";
  return `Usage:\n${line}${note}`;
}

async function init(args) {
  if (args.length > 0) throw new Error("init does not accept arguments");
  const directory = configDir();
  const filePath = join(directory, "projects.json");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(filePath, `${JSON.stringify(STARTER_REGISTRY, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing registry: ${filePath}`);
    }
    throw error;
  }
  // Deliberately NOT logged (atelier-e5x): `atelier init` writes the registry file
  // itself, so the file IS the record - and appending an event here would create
  // the state directory as a side effect of a config-only command, before
  // `atelier serve` has ever run. It also made the CLI's own init tests write into
  // the developer's real ~/.local/state/atelier, which is how this was caught.
  console.log(`Wrote Atelier registry to ${filePath}`);
  console.log("Next: run `atelier serve`, then add a project in the UI or with `atelier track <path>`.");
}

function parseOptions(args, valueOptions, booleanOptions = new Set()) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      values[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Unknown option: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    values[name] = value;
    index += 1;
  }
  return { values, positionals };
}

function findProject(registry, name) {
  const project = registry.projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`Unknown project: ${name}`);
  return project;
}

async function serve(args) {
  const { values, positionals } = parseOptions(args, new Set(["port"]));
  if (positionals.length > 0) throw new Error("serve does not accept positional arguments");
  const port = values.port === undefined ? Number(process.env.PORT || 5170) : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  const atelierStateDir = stateDir();
  const urlPath = join(atelierStateDir, "atelier.url");
  const lock = acquireInstanceLock(atelierStateDir);
  let boardEvents;
  let server;
  const eventLog = createEventLog({ stateDir: atelierStateDir });
  let stopReason = "exit";
  try {
    const registry = await loadRegistry();
    const dispatcher = createDispatcher({ registry, stateDir: atelierStateDir, eventLog });
    boardEvents = createBoardEvents({ registry });
    server = createServer({
      registry,
      dispatcher,
      atelierStateDir,
      boardEvents,
      eventLog,
    });
    let address;
    try {
      address = await listenLoopback(server, port);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      console.error(
        `Another Atelier (or other process) is already listening on port ${port} - is the atelier service running? (systemctl --user status atelier)`,
      );
      process.exitCode = 1;
      return;
    }
    const listenUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(urlPath, `${listenUrl}\n`, "utf8");
    console.log(`Atelier listening at ${listenUrl}`);
    eventLog.append("service.start", {
      actor: "cli",
      port: address.port,
      version: createBootStamp().version,
      pid: process.pid,
      projects: registry.projects.length,
    });
    let shutdownPromise;
    const shutdown = (signal) => {
      if (typeof signal === "string") stopReason = signal;
      shutdownPromise ??= shutdownServer(server);
    };
    const onSigint = () => shutdown("SIGINT");
    const onSigterm = () => shutdown("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
      await once(server, "close");
      await shutdownPromise;
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  } finally {
    if (server?.listening) await shutdownServer(server);
    boardEvents?.close();
    // Logged in the finally so an abnormal exit path still records the stop -
    // the pairing with service.start is what makes a restart legible later.
    eventLog.append("service.stop", { actor: "cli", reason: stopReason, pid: process.pid });
    eventLog.shutdown();
    await rm(urlPath, { force: true });
    lock.release();
  }
}

async function mcp(args) {
  const { values, positionals } = parseOptions(args, new Set(["port"]));
  if (positionals.length > 0) throw new Error("mcp does not accept positional arguments");
  const port = values.port === undefined ? Number(process.env.PORT || 5170) : Number(values.port);
  const { runMcpServer } = await import("../server/lib/mcp.mjs");
  await runMcpServer({ port });
}

async function projects(args) {
  if (args.length > 0) throw new Error("projects does not accept arguments");
  const registry = await loadRegistry();
  const rows = await Promise.all(
    registry.projects.map(async (project) => {
      const probe = await probeProject(project);
      const detected = await trackerMode(project, probe);
      return {
        name: project.name,
        tracker: `${project.tracker}/${detected}`,
        branch: probe.git.branch,
        dirty: probe.git.dirtyCount,
        worktrees: probe.git.worktrees,
      };
    }),
  );
  console.table(rows);
}

async function track(args) {
  const { values, positionals } = parseOptions(args, new Set(), new Set(["yes"]));
  if (positionals.length !== 1) throw new Error("track requires exactly one project name or path");
  const registry = await loadRegistry();
  const registered = registry.projects.find((candidate) => candidate.name === positionals[0]);
  if (registered) {
    const result = await trackProject(registered);
    console.log(`${result.name}: tracker=${result.detectedTracker}`);
    return;
  }

  const path = resolve(positionals[0]);
  const statePath = resolve(stateDir());
  const stateRelative = relative(statePath, path);
  if (stateRelative === "" || (!stateRelative.startsWith("..") && !isAbsolute(stateRelative))) {
    throw new Error("Project path must not be inside the Atelier state directory");
  }
  const probe = await probeProjectPath(path);
  const entry = { path: probe.path, ...probe.inferred };
  console.log(JSON.stringify(entry, null, 2));
  if (!values.yes) {
    console.log("Use `atelier track <path> --yes` or the UI to confirm this project.");
    return;
  }
  // Preserve the inferred entry verbatim. `trackerLocation` is an interactive
  // choice; deriving it from detection could relocate an existing personal tracker.
  const created = await createCommandClient().createProject(entry);
  console.log(`Registered ${created.name}`);
}

async function moveTracker(args) {
  const { values, positionals } = parseOptions(args, new Set(["to"]));
  if (positionals.length !== 1) throw new Error("move-tracker requires exactly one project name");
  if (!new Set(["external", "in-repo"]).has(values.to)) {
    throw new Error("move-tracker --to must be external or in-repo");
  }
  const result = await createCommandClient().moveTracker(positionals[0], { to: values.to });
  console.log(`Moved ${positionals[0]} tracker to ${values.to}: ${result.to}`);
  console.log(result.nextSteps);
}

async function follow(dispatcher, id) {
  let lastSeq = 0;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  const consume = (event) => {
    if (event.dispatchId !== id || event.seq <= lastSeq) return;
    lastSeq = event.seq;
    console.log(JSON.stringify(event));
    if (event.type === "status" && [
      "completed",
      "completed_empty",
      "needs_input",
      "failed",
      "stopped",
      "prepare_failed",
      "rejected",
    ].includes(event.state)) {
      settled = true;
      resolveDone();
    }
  };
  const streamEnded = async () => {
    if (settled) return;
    try {
      const record = await dispatcher.get(id);
      if ([
        "completed",
        "completed_empty",
        "needs_input",
        "failed",
        "stopped",
        "prepare_failed",
        "rejected",
      ].includes(record.state)) {
        settled = true;
        resolveDone();
        return;
      }
      rejectDone(new Error("event stream ended before completion (daemon stopped?)"));
    } catch (error) {
      rejectDone(error);
    }
  };
  const removeListener = dispatcher.onEvent(consume, rejectDone, streamEnded);
  try {
    for (const event of dispatcher.getEvents(id) || []) consume(event);
    if (!settled) await done;
    return await dispatcher.get(id);
  } finally {
    removeListener();
  }
}

function serverDispatcher({ followReplies = false } = {}) {
  return createCommandClient({ followReplies });
}

async function dispatch(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(["prompt", "model", "effort", "lane", "max-turns"]),
    new Set(["follow"]),
  );
  const projectName = positionals.shift();
  if (!projectName) throw new Error("dispatch requires a project name");
  if (positionals.length > 1) throw new Error("dispatch accepts only one ticket id");
  if (values.prompt && positionals.length > 0) {
    throw new Error("choose either a ticket id or --prompt");
  }
  const registry = await loadRegistry();
  const dispatcher = createCommandClient();
  let result;
  try {
    result = await dispatcher.dispatch({
      project: projectName,
      ticketId: positionals[0],
      prompt: values.prompt,
      model: values.model,
      effort: values.effort,
      lane: values.lane,
      maxTurns: values["max-turns"],
    });
  } catch (error) {
    const localProject = registry.projects.find((project) => project.name === projectName);
    if (
      error instanceof CommandClientError &&
      error.status === 404 &&
      localProject &&
      existsSync(localProject.path)
    ) {
      throw new Error(
        "project exists in projects.json but the running daemon predates it — restart the daemon (systemctl --user restart atelier) or register via `atelier track --yes`",
      );
    }
    throw error;
  }
  console.log(result.id);
  if (!values.follow) return;
  const record = await follow(dispatcher, result.id);
  process.exitCode = record.state === "completed" ? 0 : 1;
}

async function reply(args) {
  const { values, positionals } = parseOptions(args, new Set(), new Set(["follow"]));
  const dispatchId = positionals.shift();
  if (!dispatchId) throw new Error("reply requires a dispatch id");
  if (positionals.length === 0) throw new Error("reply requires text");
  const dispatcher = serverDispatcher({ followReplies: values.follow === true });
  const record = await dispatcher.reply(dispatchId, { text: positionals.join(" ") });
  console.log(JSON.stringify(record));
  if (!values.follow) return;
  const completed = await follow(dispatcher, dispatchId);
  process.exitCode = completed.state === "completed" ? 0 : 1;
}

async function plan(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(["revise"]),
    new Set(["approve"]),
  );
  const dispatchId = positionals.shift();
  if (!dispatchId || positionals.length > 0) {
    throw new Error("plan requires exactly one dispatch id");
  }
  if (Boolean(values.approve) === (values.revise !== undefined)) {
    throw new Error("choose exactly one of --approve or --revise \"text\"");
  }
  const dispatcher = serverDispatcher();
  const body = values.approve
    ? { action: "approve" }
    : { action: "revise", text: values.revise };
  console.log(JSON.stringify(await dispatcher.plan(dispatchId, body)));
}

const LOG_FOLLOW_INTERVAL_MS = 500;

function printLogEvent(event) {
  console.log(formatLogEvent(event));
}

async function logs(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(["kind", "project", "dispatch", "ticket", "actor", "source", "since", "limit"]),
    new Set(["follow"]),
  );
  if (positionals.length > 0) throw new Error("logs does not accept positional arguments");
  const filters = {
    kind: values.kind,
    project: values.project,
    dispatchId: values.dispatch,
    ticketId: values.ticket,
    actor: values.actor,
    source: values.source,
    since: values.since,
    limit: values.limit,
  };
  const eventLog = createEventLog({ stateDir: stateDir() });
  // The backfill is bounded by --limit; the FOLLOW is not, and must not be.
  // Re-reading the newest `limit` events on every poll (the archived atelier-e5x
  // MAJOR) silently drops whatever scrolled past that window between polls, so
  // the follower advances a byte cursor instead - see event-log.mjs poll().
  const started = eventLog.tail(filters);
  for (const event of started.events) printLogEvent(event);
  if (values.follow !== true) return;
  let cursor = started.cursor;
  await new Promise((resolvePromise) => {
    const drain = () => {
      const next = eventLog.poll(cursor, filters);
      cursor = next.cursor;
      for (const event of next.events) printLogEvent(event);
    };
    const timer = setInterval(drain, LOG_FOLLOW_INTERVAL_MS);
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      // One last pass so a follower that is asked to stop still reports what
      // landed in the interval it was killed in.
      drain();
      resolvePromise();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

async function commandCheck(name, file) {
  try {
    const version = (await runFile(file, ["--version"])).trim().split(/\r?\n/)[0];
    return { name, ok: true, detail: version || "available" };
  } catch (error) {
    return { name, ok: false, detail: error.message };
  }
}

async function doctor(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(["older-than-days", "port"]),
    new Set(["install-service", "gc", "safe-restart", "dry-run", "offline-maintenance"]),
  );
  if (positionals.length > 0) throw new Error("doctor does not accept positional arguments");
  const modes = ["install-service", "gc", "safe-restart"].filter((mode) => values[mode]);
  if (modes.length > 1) {
    throw new Error("choose only one of --install-service, --gc, --safe-restart");
  }
  if (values["dry-run"] && modes.length === 0) {
    throw new Error("--dry-run requires --install-service, --gc, or --safe-restart");
  }
  if (values["older-than-days"] !== undefined && !values.gc) {
    throw new Error("--older-than-days requires --gc");
  }
  if (values.port !== undefined && !values["safe-restart"]) {
    throw new Error("--port requires --safe-restart");
  }
  if (values["offline-maintenance"] && !values.gc) {
    throw new Error("--offline-maintenance requires --gc");
  }
  if (values["install-service"]) {
    await installService({
      scriptPath: fileURLToPath(import.meta.url),
      dryRun: values["dry-run"] === true,
    });
    return;
  }
  if (values["safe-restart"]) {
    // Talks to the ALREADY-RUNNING atelier.service over HTTP (see
    // restartServiceSafely) - this process must never construct its own
    // Dispatcher to answer "is anything active", because that Dispatcher's
    // own boot recovery would honestly (and wrongly, here) fail every
    // dispatch the live server still has active. --port (or PORT read at
    // call time when omitted) so a non-default-port server is never
    // wrongly reported unreachable.
    let port;
    if (values.port !== undefined) {
      port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
    }
    try {
      await restartServiceSafely({
        dryRun: values["dry-run"] === true,
        ...(port === undefined ? {} : { baseUrl: `http://127.0.0.1:${port}` }),
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }
  let registry;
  try {
    registry = await loadRegistry();
    console.log(`registry: ok (${registry.projects.length} projects)`);
  } catch (error) {
    if (error instanceof RegistryError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (values.gc) {
    const olderThanDays = Number(values["older-than-days"] ?? 7);
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
      throw new Error("--older-than-days must be a non-negative integer");
    }
    const dryRun = values["dry-run"] === true;
    if (!dryRun && !values["offline-maintenance"]) {
      throw new Error("non-dry-run --gc requires --offline-maintenance");
    }
    // Observer mode under --dry-run: constructing a Dispatcher is itself an action
    // otherwise (boot orphan fencing signals, post-merge recovery kills children,
    // reattach polls and transitions, queue settlement writes the tracker), and a
    // read-only command must do none of it. The non-dry-run constructor acquires
    // and holds the real instance lock across collection, closing the old probe race.
    const atelierStateDir = stateDir();
    const eventLog = createEventLog({ stateDir: atelierStateDir });
    let dispatcher;
    try {
      dispatcher = createDispatcher({
        registry,
        stateDir: atelierStateDir,
        sweepCodexProcessesAtBoot: false,
        observer: dryRun,
        eventLog,
      });
    } catch (error) {
      eventLog.shutdown();
      if (error.code === "EATELIERLOCKED") {
        console.error(`systemctl --user stop atelier first; ${error.message}.`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    let result;
    try {
      result = await dispatcher.gc({ olderThanDays, dryRun });
    } finally {
      // doctor is a short-lived process; make bulk dismissal events durable
      // before it prints its handoff and exits.
      try {
        await dispatcher.shutdown({ graceMs: 0 });
      } finally {
        eventLog.shutdown();
      }
    }
    const verb = result.dryRun ? "would dismiss" : "dismissed";
    const orphanVerb = result.dryRun ? "would remove orphan" : "removed orphan";
    const processVerb = result.dryRun ? "would reap codex process" : "reaped codex process";
    for (const id of result.dismissed) console.log(`${verb}: ${id}`);
    for (const path of result.orphans) console.log(`${orphanVerb}: ${path}`);
    const codexProcesses = result.codexProcesses ??
      { supported: false, reaped: [], reported: [], errors: [] };
    for (const reaped of codexProcesses.reaped) {
      console.log(`${processVerb}: ${reaped.pid} (${reaped.reason})`);
    }
    // Report-only, never killed: a process Atelier cannot tie to a finished
    // dispatch is an operator's decision, not the reaper's (atelier-za6).
    for (const reported of codexProcesses.reported) {
      console.log(
        `codex process left alone: ${reported.pid} ${reported.command ?? "?"} in ${reported.cwd}${reported.cwdDeleted ? " (deleted)" : ""} - ${reported.reason}`,
      );
    }
    const advisoryDebts = result.advisoryDebts ?? [];
    for (const debt of advisoryDebts) {
      const attemptDetail = `${debt.attempts} attempt${debt.attempts === 1 ? "" : "s"}`;
      const errorDetail = debt.lastError ? `; last error: ${debt.lastError}` : "";
      console.log(
        `review advisory debt: ${debt.dispatchId} ${debt.findingRef ?? "unknown finding"} ` +
        `for ${debt.ticketId ?? "unknown ticket"} (${attemptDetail}${errorDetail})`,
      );
    }
    for (const error of result.errors) console.error(`gc error: ${error}`);
    for (const error of codexProcesses.errors ?? []) {
      console.error(`gc error: codex process sweep: ${error}`);
    }
    // Honest about the platform: identity corroboration is /proc-only, so off
    // Linux there is no sweep to report the results of - saying "0 reaped" would
    // read as "nothing to clean up" (item 8).
    const processSummary = codexProcesses.supported === false
      ? "codex process sweep unavailable on this platform"
      : `${codexProcesses.reaped.length} codex process${codexProcesses.reaped.length === 1 ? "" : "es"} reaped, ${codexProcesses.reported.length} reported`;
    const errorCount = result.errors.length + (codexProcesses.errors?.length ?? 0);
    console.log(
      `gc summary: ${result.dismissed.length} dispatch${result.dismissed.length === 1 ? "" : "es"}, ${result.orphans.length} orphan worktree${result.orphans.length === 1 ? "" : "s"}, ${advisoryDebts.length} review advisory debt${advisoryDebts.length === 1 ? "" : "s"}, ${processSummary}, ${errorCount} error${errorCount === 1 ? "" : "s"}`,
    );
    if (errorCount > 0) process.exitCode = 1;
    return;
  }

  const checks = await Promise.all([
    commandCheck("git", "git"),
    commandCheck("br", resolveBrExecutable()),
    commandCheck("claude", "claude"),
  ]);
  for (const check of checks) {
    console.log(`${check.name}: ${check.ok ? "ok" : "missing"} (${check.detail})`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    const help = subcommandUsage(command);
    if (!help) throw new Error(`Unknown command: ${command}\n${usage()}`);
    console.log(help);
    return;
  }
  if (command === "init") return init(args);
  if (command === "serve") return serve(args);
  if (command === "mcp") return mcp(args);
  if (command === "projects") return projects(args);
  if (command === "track") return track(args);
  if (command === "move-tracker") return moveTracker(args);
  if (command === "dispatch") return dispatch(args);
  if (command === "reply") return reply(args);
  if (command === "plan") return plan(args);
  if (command === "logs") return logs(args);
  if (command === "doctor") return doctor(args);
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
