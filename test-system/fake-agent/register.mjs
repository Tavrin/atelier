import { agents } from "../../server/lib/agents/index.mjs";
import { fakeAgent } from "./adapter.mjs";

if (process.env.ATELIER_TEST_NO_REAL_PROVIDER !== "1") {
  throw new Error("fake-agent registration requires ATELIER_TEST_NO_REAL_PROVIDER=1");
}
agents.set(fakeAgent.id, fakeAgent);
