import { claudeAgent } from "./claude.mjs";
import { codexAgent } from "./codex.mjs";

export const agents = new Map([
  ["claude", claudeAgent],
  ["codex", codexAgent],
]);

export function getAgent(lane) {
  const agent = agents.get(lane);
  if (!agent) throw new Error(`Unsupported lane: ${lane}`);
  return agent;
}
