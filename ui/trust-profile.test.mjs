import assert from "node:assert/strict";
import test from "node:test";

import { trustProfileSummary } from "./trust-profile.mjs";

test("trust posture surfacing never calls trusted-local or advisory isolated", () => {
  assert.equal(
    trustProfileSummary({ trustProfile: { confinement: "trusted-local", credential: "none" } }),
    "trusted-local · no isolation · credential none",
  );
  assert.equal(
    trustProfileSummary({ trustProfile: { confinement: "advisory", credential: "brokered" } }),
    "advisory · non-enforcing · credential brokered",
  );
});

test("sandbox posture surfacing names the recorded enforcing backend", () => {
  assert.equal(
    trustProfileSummary({
      executionProfile: {
        sandbox: {
          confinement: "sandboxed-review-readonly",
          credential: "none",
          backendId: "bwrap",
        },
      },
    }),
    "sandboxed-review-readonly · isolated by bwrap · credential none",
  );
});

test("sandbox posture surfacing names the daemon allowlist and provider-API boundary", () => {
  assert.equal(
    trustProfileSummary({
      trustProfile: { confinement: "sandboxed-write", credential: "brokered" },
      sandboxBackend: "bwrap",
      sandboxBroker: {
        access: "brokered-daemon-api",
        allowlist: ["/api/dispatches"],
        providerApi: "unavailable",
      },
    }),
    "sandboxed-write · isolated by bwrap · credential brokered · daemon API brokered [/api/dispatches] · remote provider API unavailable",
  );
});
