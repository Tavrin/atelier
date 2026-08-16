#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

function log(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function workspacePath(workspace, candidate, label = "path") {
  if (typeof candidate !== "string" || !candidate) throw new Error(`${label} must be a string`);
  const target = resolve(workspace, candidate);
  const segment = relative(workspace, target);
  if (segment === "" || segment.startsWith("..") || isAbsolute(segment)) {
    throw new Error(`${label} escapes the fake-agent workspace: ${candidate}`);
  }
  return target;
}

function filesFor(step) {
  if (Array.isArray(step.files)) return step.files;
  if (typeof step.path === "string" && typeof step.content === "string") {
    return [{ path: step.path, content: step.content }];
  }
  throw new Error(`${step.type} requires path+content or files`);
}

async function writeFiles(workspace, step) {
  for (const file of filesFor(step)) {
    const target = workspacePath(workspace, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

function git(workspace, args) {
  execFileSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Atelier Fake",
    "-c", "user.email=fake@atelier.invalid",
    ...args,
  ], {
    cwd: workspace,
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function recordChild(child, detached) {
  const receiptPath = process.env.ATELIER_TEST_CHILD_RECEIPTS;
  if (!receiptPath || !isAbsolute(receiptPath)) {
    throw new Error("ATELIER_TEST_CHILD_RECEIPTS must be an absolute path for child scenarios");
  }
  await mkdir(dirname(receiptPath), { recursive: true });
  await appendFile(receiptPath, `${JSON.stringify({ pid: child.pid, detached })}\n`, "utf8");
}

async function stdinLine() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) return line;
    throw new Error("stdin closed while fake agent was waiting for input");
  } finally {
    input.close();
  }
}

function validateScenario(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scenario must be an object");
  }
  if (!Array.isArray(value.steps)) throw new Error("scenario.steps must be an array");
  for (const [index, step] of value.steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`scenario.steps[${index}] must be an object`);
    }
    if (typeof step.type !== "string") {
      throw new Error(`scenario.steps[${index}].type must be a string`);
    }
  }
}

async function main() {
  const [scenarioArgument, ...args] = process.argv.slice(2);
  if (!scenarioArgument || !isAbsolute(scenarioArgument)) {
    throw new Error("fake-agent scenario path must be absolute");
  }
  const resumeIndex = args.indexOf("--resume");
  const resumedSession = resumeIndex === -1 ? null : args[resumeIndex + 1];
  const scenario = JSON.parse(await readFile(scenarioArgument, "utf8"));
  validateScenario(scenario);
  const workspace = resolve(process.cwd());
  const sessionRef = scenario.sessionRef || `fake-${process.pid}`;

  log({ type: "system", subtype: "init", model: "fake", session_id: sessionRef });
  log({ type: "fake.start", pid: process.pid, ppid: process.ppid, workspace, sessionRef });

  for (const [index, step] of scenario.steps.entries()) {
    log({ type: "fake.step", index, step: step.type, phase: "start" });
    switch (step.type) {
      case "write":
      case "leave_dirty":
        await writeFiles(workspace, step);
        break;
      case "stage":
        git(workspace, ["add", "--", ...(step.paths?.length ? step.paths : ["."])]);
        break;
      case "commit":
        git(workspace, ["commit", "-m", step.message || "fake-agent commit"]);
        break;
      case "amend":
        git(workspace, step.message
          ? ["commit", "--amend", "-m", step.message]
          : ["commit", "--amend", "--no-edit"]);
        break;
      case "reset":
        git(workspace, ["reset", `--${step.mode || "mixed"}`, step.ref || "HEAD~1"]);
        break;
      case "request_input": {
        log({ type: "fake.waiting", prompt: step.message || "fake agent waiting for input" });
        const line = await stdinLine();
        log({ type: "fake.input", line });
        break;
      }
      case "sleep":
        await new Promise((resolvePromise) => setTimeout(resolvePromise, step.ms || 0));
        break;
      case "spawn_child":
      case "spawn_detached": {
        const detached = step.type === "spawn_detached";
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached,
          stdio: "ignore",
        });
        try {
          await recordChild(child, detached);
        } catch (error) {
          child.kill("SIGKILL");
          throw error;
        }
        log({ type: "fake.child", pid: child.pid, detached });
        child.unref();
        break;
      }
      case "crash":
        if (step.signal) process.kill(process.pid, step.signal);
        process.exit(step.code || 1);
        break;
      case "resume_marker": {
        const expected = step.sessionRef || sessionRef;
        if (resumedSession !== null && resumedSession !== expected) {
          throw new Error(`resume session mismatch: expected ${expected}, got ${resumedSession}`);
        }
        log({ type: "fake.resume", expected, resumedSession });
        break;
      }
      case "mutate_during_verify": {
        const target = workspacePath(workspace, step.watcherPath || ".fake-verify-watcher.json");
        await writeFile(target, `${JSON.stringify({
          writes: step.writes || [],
          receiptPath: step.receiptPath || ".fake-verify-receipt.json",
        })}\n`, "utf8");
        log({ type: "fake.verify-armed", path: relative(workspace, target) });
        break;
      }
      case "emit":
        log(step.event ?? { type: "fake.emit" });
        break;
      case "forge_review":
        log({ type: "fake.review", result: step.result ?? "{forged-review" });
        break;
      case "report_usage":
        log({
          type: "fake.usage",
          turns: Number(step.turns ?? 0),
          costUSD: Number(step.costUSD ?? 0),
          inputTokens: Number(step.inputTokens ?? 0),
          outputTokens: Number(step.outputTokens ?? 0),
        });
        break;
      default:
        throw new Error(`unsupported fake-agent step: ${step.type}`);
    }
    log({ type: "fake.step", index, step: step.type, phase: "end" });
  }

  log({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "fake-agent scenario completed",
    num_turns: 1,
    total_cost_usd: 0,
  });
}

main().catch((error) => {
  log({ type: "fake.error", message: error.message });
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
