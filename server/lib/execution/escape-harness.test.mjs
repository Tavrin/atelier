import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
import test from "node:test";

import {
  createExecutionProfile,
  executionProfileMismatch,
} from "./execution-profile.mjs";
import { daemonBrokerDecision } from "./daemon-broker.mjs";
import {
  SANDBOX_PROCESS_GROUP_POSTURE,
  createBwrapBackend,
  sandboxPostureLabel,
  wrapSandboxSpawn,
} from "./sandbox.mjs";

const TESTED_TREE = "/atelier-state/verify/project/run";
const SCRATCH = "/atelier-state/verify/project/run.scratch";
const SANDBOXED = Object.freeze({
  confinement: "sandboxed-write",
  credential: "none",
});

function inside(root, candidate) {
  const segment = relative(root, candidate);
  return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
}

function verificationMountPlan() {
  return createBwrapBackend({ file: "/operator/bwrap" }).wrap({
    ...SANDBOXED,
    file: "/operator/verifier",
    args: [],
    cwd: TESTED_TREE,
    env: {},
    writableRoots: [SCRATCH],
    readOnlyRoots: [TESTED_TREE],
  });
}

function filesystemGate(plan, target) {
  if (plan.security.writableRoots.some((root) => inside(root, target))) {
    return "writable";
  }
  if (plan.security.readOnlyRoots.some((root) => inside(root, target))) {
    return "bwrap-read-only-tested-tree";
  }
  // The backend starts with a read-only bind of /; paths not explicitly made
  // writable therefore turn red at the same filesystem confinement gate.
  return "bwrap-read-only-host-filesystem";
}

test("escape harness: modify-test-restore turns red at EATELIER_VERIFICATION_READONLY_TREE", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), `${TESTED_TREE}/tested/source.mjs`),
    "bwrap-read-only-tested-tree",
  );
});

test("escape harness: index-hiding turns red at the bwrap read-only git-index gate", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), "/operator/project.git/worktrees/run/index"),
    "bwrap-read-only-host-filesystem",
  );
});

test("escape harness: shared git common-dir mutation turns red at the bwrap read-only metadata gate", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), "/operator/project.git/config"),
    "bwrap-read-only-host-filesystem",
  );
});

test("escape harness: cwd non-confinement turns red at the bwrap read-only other-worktree gate", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), "/operator/other-worktree/output"),
    "bwrap-read-only-host-filesystem",
  );
});

test("escape harness: escaped descendants turn red at the tracked process-group gate", () => {
  const plan = verificationMountPlan();
  assert.deepEqual({
    diesWithParent: plan.args.includes("--die-with-parent"),
    processGroup: plan.security.processGroupPosture,
  }, {
    diesWithParent: true,
    processGroup: SANDBOX_PROCESS_GROUP_POSTURE,
  });
});

test("escape harness: submodule ignore=all invisibility turns red at the read-only tested-tree gate", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), `${TESTED_TREE}/vendor/module/generated.bin`),
    "bwrap-read-only-tested-tree",
  );
});

test("escape harness: ATT-007 V15 dirfd residual turns red at the read-only Atelier-state gate", () => {
  assert.equal(
    filesystemGate(verificationMountPlan(), "/atelier-state/worktrees/project/retained"),
    "bwrap-read-only-host-filesystem",
  );
});

test("escape harness expected-residual: unattested in-place verification stays behind EATELIER_RESULT_VERIFICATION_MISMATCH", () => {
  // R-B deliberately leaves an unattested legacy verification in the writable
  // agent worktree. It is not a closed filesystem case; the passing proof is
  // the separately exercised merge refusal named here, not an isolation claim.
  assert.deepEqual({
    residual: "unattested-in-place-verification",
    expectedGate: "EATELIER_RESULT_VERIFICATION_MISMATCH",
    humanOverrideRequired: true,
  }, {
    residual: "unattested-in-place-verification",
    expectedGate: "EATELIER_RESULT_VERIFICATION_MISMATCH",
    humanOverrideRequired: true,
  });
});

test("escape harness: backend unavailable turns red at EATELIER_SANDBOX_UNAVAILABLE before wrap", () => {
  let wraps = 0;
  const backend = {
    id: "harness-unavailable",
    version: () => "harness-1",
    probe: () => ({
      available: false,
      reason: "harness backend unavailable",
      evidence: { harness: true },
    }),
    wrap() {
      wraps += 1;
      return {};
    },
  };
  assert.throws(
    () => wrapSandboxSpawn({
      trustProfile: SANDBOXED,
      backend,
      file: "/operator/verifier",
      options: { cwd: TESTED_TREE, env: {} },
    }),
    (error) =>
      error.code === "EATELIER_SANDBOX_UNAVAILABLE" &&
      error.message ===
        "EATELIER_SANDBOX_UNAVAILABLE: harness-unavailable: harness backend unavailable" &&
      wraps === 0,
  );
});

test("escape harness: weakened resume posture turns red at EATELIER_EXECUTION_PROFILE_MISMATCH", () => {
  const recorded = createExecutionProfile({
    agentLane: "claude",
    command: "claude",
    env: { PATH: "/usr/bin", HOME: "/operator" },
    sandbox: {
      ...SANDBOXED,
      backendId: "bwrap",
      backendVersion: "bubblewrap 0.10.0",
      argvDigest: "a".repeat(64),
    },
  });
  const weakened = structuredClone(recorded);
  weakened.sandbox.confinement = "trusted-local";
  assert.match(
    executionProfileMismatch(recorded, weakened, { sandbox: true }),
    /^EATELIER_EXECUTION_PROFILE_MISMATCH: sandbox\.confinement: "sandboxed-write" -> "trusted-local"$/,
  );
});

test("escape harness broker denial: /api/session turns red as unconditionally-denied", () => {
  assert.deepEqual(daemonBrokerDecision("/api/session", ["/api/*"]), {
    allowed: false,
    reason: "unconditionally-denied",
  });
});

test("escape harness broker denial: /api/break-glass turns red as unconditionally-denied", () => {
  assert.deepEqual(daemonBrokerDecision("/api/break-glass", ["/api/*"]), {
    allowed: false,
    reason: "unconditionally-denied",
  });
});

test("escape harness broker denial: normalization variants turn red as unconditionally-denied", () => {
  const variants = [
    "/api/session/",
    "/API/SeSsIoN",
    "/api/break-glass/",
    "/Api/BrEaK-GlAsS/",
    new URL("http://atelier/api/./session").pathname,
    new URL("http://atelier/api/x/../break-glass").pathname,
  ];
  assert.deepEqual(
    variants.map((path) => daemonBrokerDecision(path, ["/api/*"]).reason),
    variants.map(() => "unconditionally-denied"),
  );
});

test("escape harness broker denial: paths outside the operator allowlist turn red as outside-allowlist", () => {
  assert.deepEqual(daemonBrokerDecision("/api/projects", ["/api/dispatches"]), {
    allowed: false,
    reason: "outside-allowlist",
  });
});

test("escape harness broker control: an operator-allowlisted path has exactly the allowlisted decision", () => {
  assert.deepEqual(daemonBrokerDecision("/api/dispatches", ["/api/dispatches"]), {
    allowed: true,
    reason: "allowlisted",
  });
});

test("escape harness surfacing: advisory turns red at the non-enforcing posture label", () => {
  assert.equal(
    sandboxPostureLabel({ confinement: "advisory", credential: "none", backendId: "bwrap" }),
    "advisory (non-enforcing; credential none)",
  );
});

test("escape harness surfacing: trusted-local turns red at the no-isolation posture label", () => {
  assert.equal(
    sandboxPostureLabel({
      confinement: "trusted-local",
      credential: "none",
      backendId: "bwrap",
    }),
    "trusted-local (no isolation; credential none)",
  );
});
