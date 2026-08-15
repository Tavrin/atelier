import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dispatchGroup, resolveGroup, unionIssues } from "./groups.mjs";

test("groups resolve, fan out a ticket, and tag unioned issues", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = join(root, "one");
  await mkdir(join(one, ".beads"), { recursive: true });
  await writeFile(join(one, ".beads", "issues.jsonl"), '{"id":"one-1"}\n');
  const projects = [
    { name: "one", path: one, tracker: "committed" },
    { name: "two", path: join(root, "two"), tracker: "none" },
  ];
  const registry = { projects, groups: [{ name: "all", projects: ["one", "two"] }] };

  const group = resolveGroup(registry, "all");
  assert.deepEqual(group, projects);
  const calls = [];
  const results = await dispatchGroup(
    { dispatch: async (opts) => (calls.push(opts), { id: opts.project }) },
    group,
    { ticketId: "shared-1", lane: "claude" },
  );
  assert.deepEqual(results, [{ id: "one" }, { id: "two" }]);
  assert.ok(calls.every((call) => call.ticketId === "shared-1"));
  assert.deepEqual(await unionIssues(group), [{ id: "one-1", projectName: "one" }]);
});
