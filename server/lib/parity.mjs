function capability(tool, http, readOnlyHint, destructiveHint = false, mcpExcluded = []) {
  return Object.freeze({
    tool,
    http: Object.freeze([...http]),
    readOnlyHint,
    destructiveHint,
    mcpExcluded: Object.freeze([...mcpExcluded]),
  });
}

// This manifest is the reviewable contract between Atelier's UI/API capabilities
// and its MCP tool surface. MCP module initialization and tests both reject
// inventory or annotation drift, so additions cannot silently land on one side.
export const AGENT_UI_CAPABILITY_MANIFEST = Object.freeze([
  capability("atelier_projects", ["GET /api/projects"], true),
  capability("atelier_agents", ["GET /api/agents"], true),
  capability("atelier_board", ["GET /api/projects/:project/state"], true),
  capability("atelier_ticket", ["GET /api/projects/:project/state"], true),
  capability(
    "atelier_chronicle",
    ["GET /api/chronicle", "GET /api/projects/:project/chronicle"],
    true,
  ),
  capability("atelier_dispatches", ["GET /api/dispatches"], true),
  capability("atelier_dispatch", ["GET /api/dispatch/:id"], true),
  capability("atelier_dispatch_tail", ["GET /api/dispatch/:id/events"], true),
  capability("atelier_dispatch_diff", ["GET /api/dispatch/:id/diff"], true),
  capability("atelier_rollup", ["GET /api/rollup"], true),
  capability("atelier_logs", ["GET /api/logs"], true),
  capability("atelier_settings", ["GET /api/projects"], true),
  capability("atelier_queue", ["GET /api/projects/:project/queue"], true),
  capability("atelier_main_health", ["GET /api/projects/:project/main-health"], true),
  capability("atelier_convoys", ["GET /api/convoys"], true),
  capability("atelier_ticket_create", ["POST /api/projects/:project/create"], false),
  capability("atelier_ticket_comment", ["POST /api/projects/:project/comment"], false),
  capability(
    "atelier_ticket_action",
    ["POST /api/projects/:project/claim", "POST /api/projects/:project/promote"],
    false,
  ),
  capability("atelier_ticket_close", ["POST /api/projects/:project/close"], false, true),
  capability("atelier_dispatch_start", ["POST /api/dispatch"], false, false, ["force"]),
  capability("atelier_bakeoff_start", ["POST /api/dispatch"], false, false, ["force"]),
  capability("atelier_reply", ["POST /api/dispatch/:id/reply"], false, false, ["force"]),
  capability("atelier_plan_action", ["POST /api/dispatch/:id/plan"], false, false, ["force"]),
  capability("atelier_review", ["POST /api/dispatch/:id/review"], false, false, ["force"]),
  capability(
    "atelier_review_disposition",
    ["POST /api/dispatch/:id/review-disposition"],
    false,
  ),
  capability("atelier_verify_rerun", ["POST /api/dispatch/:id/verify"], false),
  capability("atelier_merge", ["POST /api/dispatch/:id/merge"], false, false, ["force"]),
  capability("atelier_main_health_ack", ["POST /api/dispatch/:id/ack-main-health"], false),
  capability("atelier_dismiss", ["POST /api/dispatch/:id/dismiss"], false, true),
  capability("atelier_stop", ["POST /api/dispatch/:id/stop"], false, true),
  capability("atelier_settings_patch", ["PATCH /api/projects/:project"], false),
  capability("atelier_queue_set", ["POST /api/projects/:project/queue"], false),
  capability("atelier_queue_resume", ["POST /api/projects/:project/queue"], false),
  capability("atelier_convoy_create", ["POST /api/projects/:project/convoy"], false),
  capability("atelier_convoy_resume", ["POST /api/convoys/:id/resume"], false),
  capability("atelier_convoy_cancel", ["POST /api/convoys/:id/cancel"], false, true),
  capability("atelier_doctor_gc", ["POST /api/doctor/gc"], false, true),
  capability("atelier_project_add", ["POST /api/projects"], false),
  capability("atelier_project_remove", ["DELETE /api/projects/:project"], false, true),
  capability("atelier_tracker_move", ["POST /api/projects/:project/move-tracker"], false, true),
  capability(
    "atelier_open_editor",
    ["POST /api/projects/:project/open-editor", "POST /api/dispatch/:id/open-editor"],
    false,
  ),
]);

export function assertAgentUiParity(tools) {
  const actual = tools.map(({ name, annotations }) => ({
    tool: name,
    readOnlyHint: annotations?.readOnlyHint,
    destructiveHint: annotations?.destructiveHint,
  }));
  const expected = AGENT_UI_CAPABILITY_MANIFEST.map(
    ({ tool, readOnlyHint, destructiveHint }) => ({ tool, readOnlyHint, destructiveHint }),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("MCP tool surface does not match the agent/UI capability manifest");
  }
  for (const entry of AGENT_UI_CAPABILITY_MANIFEST) {
    const schema = tools.find(({ name }) => name === entry.tool)?.inputSchema;
    for (const property of entry.mcpExcluded) {
      if (Object.hasOwn(schema?.properties ?? {}, property)) {
        throw new Error(`MCP tool ${entry.tool} must exclude ${property} authority`);
      }
    }
  }
  return true;
}
