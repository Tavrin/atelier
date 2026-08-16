import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createGoldenHarness, runStandaloneFake } from "./harness.mjs";

const execFileAsync = promisify(execFile);
const VERIFY_HOOK = resolve("test-system/fake-agent/verification-hook.mjs");

function committedScenario(path = "implemented.txt", content = "implemented\n") {
  return {
    sessionRef: `session-${path}`,
    steps: [
      { type: "write", path, content },
      { type: "stage", paths: [path] },
      { type: "commit", message: `implement ${path}` },
    ],
  };
}

test("golden production path onboards, dispatches, verifies, and merges fake-agent work", async (t) => {
  const harness = await createGoldenHarness(t, { scenario: committedScenario() });
  const admitted = await harness.dispatch({ prompt: "implement the golden result" });
  const completed = await harness.waitRecord(admitted.id);
  assert.equal(completed.state, "completed");
  assert.equal(completed.verify.state, "passed");

  const merged = await harness.api(`/api/dispatch/${admitted.id}/merge`, {
    method: "POST",
    body: {},
  });
  assert.ok(merged.merged?.commit);
  await execFileAsync("git", ["cat-file", "-e", `${merged.merged.commit}^{commit}`], {
    cwd: harness.projectPath,
  });
  assert.equal(await readFile(join(harness.projectPath, "implemented.txt"), "utf8"), "implemented\n");
});

test("R1 production CLI does not create a second mutating Dispatcher", { todo: true }, async (t) => {
  const harness = await createGoldenHarness(t, { scenario: committedScenario("r1.txt", "r1\n") });
  const cli = await harness.runCli([
    "dispatch", harness.projectName, "--prompt", "exercise R1", "--lane", "fake", "--model", "fake", "--follow",
  ]);
  const id = cli.stdout.match(/^[0-9a-f]{8}$/m)?.[0];
  if (id) {
    harness.trackDispatch(id);
    await harness.waitRecord(id);
  }
  const events = id ? await harness.events(id) : [];
  const started = events
    .filter((event) => event.kind === "fake.start")
    .map((event) => JSON.parse(event.text))
    .at(-1);
  const refused = cli.code !== 0;
  const routedThroughDaemon = started?.ppid === harness.daemonPid;
  t.diagnostic(`R1 observed CLI exit=${cli.code}, fake ppid=${started?.ppid ?? "none"}, daemon pid=${harness.daemonPid}, CLI pid=${cli.pid}, stderr=${JSON.stringify(cli.stderr.trim())}`);
  assert.ok(
    refused || routedThroughDaemon,
    `R1 second-writer audit defect: production dispatch CLI created a second mutating Dispatcher (fake parent ${started?.ppid}, daemon ${harness.daemonPid}, CLI ${cli.pid})`,
  );
});

test("R2 dirty intended work is never verified and then discarded by merge", { todo: true }, async (t) => {
  const harness = await createGoldenHarness(t, {
    scenario: {
      sessionRef: "dirty-result",
      steps: [
        { type: "write", path: "partial.txt", content: "committed subset\n" },
        { type: "stage", paths: ["partial.txt"] },
        { type: "commit", message: "commit only part of the result" },
        { type: "leave_dirty", path: "dirty-intended.txt", content: "must land\n" },
      ],
    },
  });
  const admitted = await harness.dispatch({ prompt: "leave intended work dirty" });
  const completed = await harness.waitRecord(admitted.id);
  assert.equal(completed.verify.state, "passed", "R2 fixture did not reach its tested-dirty defect path");
  const merge = await harness.rawApi(`/api/dispatch/${admitted.id}/merge`, {
    method: "POST",
    body: {},
  });
  const landed = await readFile(join(harness.projectPath, "dirty-intended.txt"), "utf8")
    .then((contents) => contents === "must land\n", () => false);
  t.diagnostic(`R2 observed merge HTTP=${merge.status}, verify=${completed.verify.state}, intended bytes landed=${landed}, error=${JSON.stringify(merge.value.error || "")}`);
  assert.ok(
    !merge.ok || landed,
    "R2 dirty-result-loss audit defect: merge accepted a verified dirty tree but discarded the tested intended bytes",
  );
});

test("R3 verification cannot attest mutation or a stale branch HEAD", { todo: true }, async (t) => {
  const failures = [];

  const mutationHarness = await createGoldenHarness(t, {
    scenario: {
      sessionRef: "verifier-mutation",
      steps: [
        { type: "write", path: "agent.txt", content: "agent\n" },
        { type: "stage", paths: ["agent.txt"] },
        { type: "commit", message: "agent work" },
        {
          type: "mutate_during_verify",
          watcherPath: ".fake-verify-watcher.json",
          writes: [{ path: "verifier-mutated.txt", content: "mutation\n" }],
        },
      ],
    },
    verifyCommands: [`${VERIFY_HOOK} .fake-verify-watcher.json`],
    projectName: "mutation-fixture",
  });
  const mutationDispatch = await mutationHarness.dispatch({ prompt: "exercise verifier mutation" });
  const mutationRecord = await mutationHarness.waitRecord(mutationDispatch.id);
  if (mutationRecord.verify?.state === "passed") {
    failures.push("zero-exit verifier mutation was recorded as passed");
  }

  const staleHarness = await createGoldenHarness(t, {
    scenario: committedScenario("verified.txt", "verified\n"),
    projectName: "stale-fixture",
  });
  const staleDispatch = await staleHarness.dispatch({ prompt: "verify before moving HEAD" });
  const verifiedRecord = await staleHarness.waitRecord(staleDispatch.id);
  assert.equal(verifiedRecord.verify.state, "passed", "R3 stale-head fixture did not first verify");
  const branchMoveScenario = join(staleHarness.root, "move-head.json");
  await writeFile(branchMoveScenario, JSON.stringify(committedScenario("after-verify.txt", "later\n")));
  await runStandaloneFake(verifiedRecord.worktreePath, branchMoveScenario);
  const staleMerge = await staleHarness.rawApi(`/api/dispatch/${staleDispatch.id}/merge`, {
    method: "POST",
    body: {},
  });
  if (staleMerge.ok) failures.push("merge accepted a branch HEAD that moved after verification");
  t.diagnostic(`R3 observed mutation verify=${mutationRecord.verify?.state}, stale-head merge HTTP=${staleMerge.status}`);

  assert.deepEqual(
    failures,
    [],
    `R3 verifier-mutation/stale-branch audit defect: ${failures.join("; ")}`,
  );
});
