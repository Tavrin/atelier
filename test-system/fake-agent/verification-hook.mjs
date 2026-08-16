#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const workspace = resolve(process.cwd());
const watcher = resolve(workspace, process.argv[2] || ".fake-verify-watcher.json");
const watcherRelative = relative(workspace, watcher);
if (watcherRelative.startsWith("..") || isAbsolute(watcherRelative)) {
  throw new Error("verification watcher escapes the workspace");
}
const scenario = JSON.parse(await readFile(watcher, "utf8"));
for (const file of scenario.writes || []) {
  const target = resolve(workspace, file.path);
  const segment = relative(workspace, target);
  if (!segment || segment.startsWith("..") || isAbsolute(segment)) {
    throw new Error(`verification write escapes the workspace: ${file.path}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content, "utf8");
}
