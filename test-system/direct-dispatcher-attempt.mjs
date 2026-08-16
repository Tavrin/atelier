import { createDispatcher } from "../server/lib/dispatch.mjs";
import { stateDir } from "../server/lib/paths.mjs";
import { loadRegistry } from "../server/lib/registry.mjs";

try {
  const dispatcher = createDispatcher({
    registry: await loadRegistry(),
    stateDir: stateDir(),
  });
  await dispatcher.shutdown();
  process.stderr.write("direct non-observer Dispatcher unexpectedly acquired the live state dir\n");
  process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
  process.exitCode = error.code === "EATELIERLOCKED" ? 0 : 2;
}
