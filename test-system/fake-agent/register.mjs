import { agents } from "../../server/lib/agents/index.mjs";
import { fakeAgent } from "./adapter.mjs";
import { poisonAgent } from "./poison-adapter.mjs";

if (process.env.ATELIER_TEST_NO_REAL_PROVIDER !== "1") {
  throw new Error("fake-agent registration requires ATELIER_TEST_NO_REAL_PROVIDER=1");
}
agents.set("claude", poisonAgent("claude"));
if (process.env.ATELIER_TEST_ALLOW_CODEX_GUARD_FLOW !== "1") {
  agents.set("codex", poisonAgent("codex"));
}
agents.set(fakeAgent.id, fakeAgent);
