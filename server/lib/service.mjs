import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { runFile } from "./exec.mjs";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function renderServiceUnit({ nodePath, scriptPath }) {
  return [
    "[Unit]",
    "Description=Atelier agent cockpit",
    "",
    "[Service]",
    `Environment=PATH=${dirname(nodePath)}:%h/.local/bin:%h/.cargo/bin:/usr/local/bin:/usr/bin:/bin`,
    `ExecStart=${nodePath} ${scriptPath} serve`,
    // atelier-tzw: NOT "mixed". Per systemd.kill(5), "mixed" SIGTERMs the main
    // process but still SIGKILLs every other process left in the unit's
    // control group (either once the main process exits, or at
    // TimeoutStopSec, whichever comes first) - that kills a detached Codex
    // companion worker at the exact moment it needs to survive. "process"
    // signals only the tracked main PID and leaves the rest of the cgroup
    // completely alone, which is what lets dispatch.mjs's shutdown() detach
    // a running codex job instead of killing it. See
    // docs/lessons/killmode-mixed-kills-detached-codex-workers.md.
    "KillMode=process",
    "TimeoutStopSec=20",
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// Talks to an ALREADY-RUNNING atelier.service over its own loopback API rather
// than instantiating a second Dispatcher: a fresh Dispatcher's own boot
// recovery would treat every genuinely active dispatch as a restart failure,
// which is exactly the wrong answer while checking whether it is safe to
// restart. The drain lease closes the check-then-restart race: once granted,
// the live dispatcher refuses dispatch()/reply()-resume/plan() until this
// call releases it (on abort) or the service actually restarts (the lease
// dies with the process, same as every other in-memory dispatcher state).
export async function restartServiceSafely({
  platform = process.platform,
  // Evaluated fresh on every call (a default parameter expression, not a
  // module-load-time constant) so a caller relying on process.env.PORT
  // always sees the CURRENT value, and a non-default-port server is never
  // wrongly reported unreachable just because something imported this
  // module before PORT was set.
  baseUrl = `http://127.0.0.1:${process.env.PORT || 5170}`,
  ttlMs = 10_000,
  dryRun = false,
  fetcher = globalThis.fetch,
  runner = runFile,
  print = console.log,
} = {}) {
  if (platform !== "linux") {
    throw new Error(`Safe service restart is not supported on ${platform}`);
  }
  const requestOptions = (body) => ({
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  let leaseResponse;
  try {
    leaseResponse = await fetcher(
      `${baseUrl}/api/dispatches/drain-lease`,
      requestOptions({ ttlMs }),
    );
  } catch (error) {
    throw new Error(
      `Refusing restart: atelier.service is not reachable at ${baseUrl} (${error.message})`,
    );
  }
  let leaseBody;
  try {
    leaseBody = await leaseResponse.json();
  } catch (error) {
    throw new Error(`Refusing restart: Atelier returned an invalid drain-lease response (${error.message})`);
  }
  if (!leaseResponse.ok || typeof leaseBody?.token !== "string" || !leaseBody.token) {
    throw new Error(
      `Refusing restart: ${leaseBody?.error ?? `drain lease returned HTTP ${leaseResponse.status}`}`,
    );
  }
  let restarted = false;
  try {
    if (dryRun) {
      print("Safe to restart atelier.service: no active dispatches");
      return { dryRun: true };
    }
    await runner("systemctl", ["--user", "restart", "atelier.service"]);
    restarted = true;
    print("Restarted atelier.service safely (no active dispatches)");
    return { dryRun: false };
  } finally {
    if (!restarted) {
      try {
        await fetcher(
          `${baseUrl}/api/dispatches/drain-lease/release`,
          requestOptions({ token: leaseBody.token }),
        );
      } catch {
        // The lease expires on its own; release here is only a fast-path cleanup.
      }
    }
  }
}

export function windowsTaskArgs({ nodePath, scriptPath }) {
  // schtasks processes inherit the selected user's environment by default, so
  // Windows needs no explicit PATH equivalent to the systemd unit setting.
  return [
    "/Create",
    "/TN",
    "Atelier",
    "/SC",
    "ONLOGON",
    "/TR",
    `${nodePath} ${scriptPath} serve`,
    "/F",
  ];
}

export async function installService({
  platform = process.platform,
  nodePath = process.execPath,
  scriptPath,
  homePath = homedir(),
  username = userInfo().username,
  dryRun = false,
  runner = runFile,
  makeDirectory = mkdir,
  writeText = writeFile,
  removeFile = unlink,
  fileExists = pathExists,
  print = console.log,
} = {}) {
  if (platform === "linux") {
    const unit = renderServiceUnit({ nodePath, scriptPath });
    const unitPath = join(homePath, ".config", "systemd", "user", "atelier.service");
    if (dryRun) {
      print(unit);
      return { platform, unitPath, unit };
    }

    await makeDirectory(dirname(unitPath), { recursive: true });
    const unitExisted = await fileExists(unitPath);
    await writeText(unitPath, unit, "utf8");
    try {
      await runner("systemctl", ["--user", "daemon-reload"]);
      // atelier-tzw constraint: applying a unit change must never itself
      // restart a server that may have active dispatches - daemon-reload
      // alone does not affect the running instance. A fresh install has
      // nothing running yet, so starting it is safe.
      if (!unitExisted) {
        await runner("systemctl", ["--user", "enable", "--now", "atelier.service"]);
      }
    } catch (error) {
      if (!unitExisted) {
        try {
          await removeFile(unitPath);
        } catch (rollbackError) {
          throw new Error(
            `Service installation failed: ${error.message}; rollback failed: ${rollbackError.message}`,
          );
        }
      }
      throw new Error(`Service installation failed: ${error.message}`);
    }

    print(`${unitExisted ? "Updated" : "Installed"} ${unitPath}`);
    if (unitExisted) {
      print("Unit change staged but NOT activated - run: atelier doctor --safe-restart");
    }
    print(`For boot-without-login persistence, run: loginctl enable-linger ${username}`);
    return { platform, unitPath, unit };
  }

  if (platform === "win32") {
    const args = windowsTaskArgs({ nodePath, scriptPath });
    if (dryRun) {
      print(`schtasks argv: ${JSON.stringify(args)}`);
      return { platform, args };
    }
    try {
      await runner("schtasks", args);
    } catch (error) {
      throw new Error(`Service installation failed: ${error.message}`);
    }
    print("Registered Atelier ONLOGON task");
    return { platform, args };
  }

  throw new Error(`Service installation is not supported on ${platform}`);
}
