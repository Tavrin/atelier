import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.name.endsWith(".test.mjs")) files.push(path);
  }
  return files;
}

// Node 22 treats `node --test test-system/` as a module path instead of
// discovering beneath it. Enumerating files preserves the intended scoped gate
// and works on every supported platform without shell glob semantics.
const files = (await testFiles(resolve("test-system"))).sort();
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
