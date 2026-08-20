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
// A per-test timeout converts a HANG into a FAILURE. atelier-uub: forcing teardown
// assertions to fail across all golden tests made this runner sit past 600s where a
// normal run takes ~5s, and a hanging proof rail is the failure mode that already
// cost this campaign its gate once - the pre-f174e02 CI job sat at 1h13m and gated
// nothing. This does not explain that hang, and is not claimed to fix it; it bounds
// it, so the gate fails loudly instead of disappearing silently.
//
// 600s. The golden suite runs in ~5s, so this is a vast margin - deliberately, after
// the campaign batch's 120s bound turned out to be only 1.9x the slowest single file
// and fired on slowness rather than a hang. A hang is unbounded; slowness is not.
const TEST_TIMEOUT_MS = Number(process.env.ATELIER_GOLDEN_TEST_TIMEOUT_MS || 600_000);
const child = spawn(
  process.execPath,
  ["--test", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files],
  { stdio: "inherit" },
);
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
