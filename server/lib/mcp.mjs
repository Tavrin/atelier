import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { clientBearerToken } from "./auth.mjs";
import { assertAgentUiParity } from "./parity.mjs";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  MCP_PROTOCOL_VERSION,
]);
const PACKAGE_JSON = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
export const MUTABLE_SETTINGS = [
  "notes",
  "warn",
  "dispatchProfile",
  "defaultAgent",
  "autoCommitTracker",
  "autoCloseOnMerge",
  "maxFixRounds",
  "budgetUSDPerDay",
  "queueFailureLimit",
  "unpricedDispatchCapPerDay",
  "legacyCodexCompanion",
];

const stringProperty = (description) => ({ type: "string", minLength: 1, description });
const booleanProperty = (description) => ({ type: "boolean", description });
const stringArrayProperty = (description, options = {}) => ({
  type: "array",
  items: { type: "string" },
  description,
  ...options,
});
const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

function tool(name, title, description, inputSchema, readOnlyHint, destructiveHint = false) {
  return Object.freeze({
    name,
    title,
    description,
    inputSchema,
    annotations: { readOnlyHint, destructiveHint },
  });
}

const projectProperty = stringProperty("Registered Atelier project name.");
const dispatchIdProperty = stringProperty("Atelier dispatch id.");
const ticketIdProperty = stringProperty("Tracker ticket id.");
const convoyIdProperty = stringProperty("Atelier convoy id.");
const dispatchProfileSchema = objectSchema({
  model: stringProperty("Agent model selection."),
  defaultModel: stringProperty("Fallback agent model selection."),
  effort: stringProperty("Agent reasoning effort selection."),
  maxTurns: {
    type: "integer",
    minimum: 1,
    description: "Maximum agent turns.",
  },
  allowedTools: stringArrayProperty("Agent tool allowlist."),
  lane: stringProperty("Registered agent lane."),
  agent: stringProperty("Legacy registered agent lane."),
  dispatchEnv: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Non-secret environment variables for the dispatch.",
  },
});
const nullablePositiveBudget = {
  type: ["number", "null"],
  exclusiveMinimum: 0,
  description: "Positive daily USD budget, or null to remove the ceiling.",
};
const settingsFieldsSchema = {
  ...objectSchema({
    notes: { type: "string", description: "Human project context." },
    warn: { type: "string", description: "Agent warning text." },
    dispatchProfile: dispatchProfileSchema,
    defaultAgent: stringProperty("Registered default agent lane."),
    autoCommitTracker: booleanProperty("Auto-commit Atelier tracker mutations."),
    autoCloseOnMerge: booleanProperty("Close the tracker ticket after merge."),
    maxFixRounds: {
      type: ["integer", "null"],
      minimum: 1,
      description: "Review-round hard backstop, or null to inherit the default of four.",
    },
    budgetUSDPerDay: nullablePositiveBudget,
    queueFailureLimit: {
      type: ["integer", "null"],
      minimum: 1,
      description: "Consecutive queue failures before a ticket parks, or null to remove.",
    },
    unpricedDispatchCapPerDay: {
      type: ["integer", "null"],
      minimum: 1,
      description: "Daily dispatch-count ceiling for lanes without reported cost, or null to remove.",
    },
    legacyCodexCompanion: booleanProperty(
      "Use the deprecated Codex companion adapter instead of the supported app-server adapter.",
    ),
  }),
  minProperties: 1,
  description: `Mutable fields: ${MUTABLE_SETTINGS.join(", ")}.`,
};

// Anti-drift guard (atelier-def): the fields schema above and MUTABLE_SETTINGS
// (which also drives the generated description text) must name exactly the
// same keys. Without this, a key can be added to one and not the other -
// the schema silently rejects a field its own description advertises, or
// MUTABLE_SETTINGS advertises a field atelier_settings never reads back. This
// runs at import time, the same enforcement style as assertAgentUiParity.
function assertSettingsPatchSchemaCoversMutableSettings(schema, mutableKeys) {
  const schemaKeys = Object.keys(schema.properties).sort();
  const expectedKeys = [...mutableKeys].sort();
  if (JSON.stringify(schemaKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      "atelier_settings_patch fields schema does not match MUTABLE_SETTINGS: " +
        `schema=[${schemaKeys.join(", ")}] mutable=[${expectedKeys.join(", ")}]`,
    );
  }
  return true;
}
assertSettingsPatchSchemaCoversMutableSettings(settingsFieldsSchema, MUTABLE_SETTINGS);
const projectRegistrationSchema = objectSchema({
  name: {
    ...projectProperty,
    pattern: "^[a-z0-9][a-z0-9._-]*$",
  },
  path: stringProperty("Absolute project directory; optional for tracker-only projects."),
  archetype: {
    type: "string",
    enum: ["full", "git-only", "tracker-only"],
    description: "Atelier project archetype.",
  },
  mainBranch: {
    type: ["string", "null"],
    description: "Clean dispatch base branch, or null for probe resolution.",
  },
  tracker: {
    type: "string",
    enum: ["committed", "personal", "none"],
    description: "Tracker placement mode.",
  },
  trackerLocation: {
    type: "string",
    enum: ["external", "in-repo"],
    description: "Tracker location for a new full project.",
  },
  trackerPath: stringProperty("Absolute external tracker directory."),
  containerized: booleanProperty("Whether verification uses a container."),
  verifyMode: {
    type: "string",
    enum: ["worktree", "container-primary", "primary-postmerge", "advisory"],
    description: "Verification posture.",
  },
  verifyCommands: stringArrayProperty("Verification commands."),
  smokeCommand: { type: "string", description: "Optional smoke command." },
  warn: { type: "string", description: "Agent warning text." },
  group: { type: "string", description: "Project group name." },
  notes: { type: "string", description: "Human project context." },
  defaultAgent: stringProperty("Registered default agent lane."),
  dispatchProfile: dispatchProfileSchema,
  dispatchEnv: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Non-secret project environment variables.",
  },
  autoCommitTracker: booleanProperty("Auto-commit Atelier tracker mutations."),
  autoCloseOnMerge: booleanProperty("Close the tracker ticket after merge."),
  requireReview: booleanProperty("Require a passing linked review before merge."),
  reviewPolicy: {
    type: "string",
    enum: ["strict", "tiered", "advisory"],
    description: "Review finding merge policy; strict is the default.",
  },
  maxFixRounds: {
    type: "integer",
    minimum: 1,
    description: "Review-round hard backstop.",
  },
  budgetUSDPerDay: {
    type: "number",
    exclusiveMinimum: 0,
    description: "Positive daily USD budget.",
  },
}, [
  "name",
  "archetype",
  "mainBranch",
  "tracker",
  "containerized",
  "verifyMode",
  "verifyCommands",
]);

export const MCP_TOOLS = Object.freeze([
  tool(
    "atelier_projects",
    "Atelier Projects",
    "List registered Atelier projects, including archetype and automation flags.",
    objectSchema(),
    true,
  ),
  tool(
    "atelier_agents",
    "Atelier Agents",
    "List registered agent adapters, capabilities, and dispatch options.",
    objectSchema(),
    true,
  ),
  tool(
    "atelier_board",
    "Atelier Board",
    "Read a project's ticket columns using Atelier's board state.",
    objectSchema({ project: projectProperty }, ["project"]),
    true,
  ),
  tool(
    "atelier_ticket",
    "Atelier Ticket",
    "Read one ticket, including its description, status, and comments.",
    objectSchema({ project: projectProperty, id: ticketIdProperty }, ["project", "id"]),
    true,
  ),
  tool(
    "atelier_chronicle",
    "Atelier Chronicle",
    "Read the aggregate bounded merged-work chronicle, or one project's chronicle and scorecard.",
    objectSchema({ project: projectProperty }),
    true,
  ),
  tool(
    "atelier_dispatches",
    "Atelier Dispatches",
    "List dispatch records, optionally filtered by project and state.",
    objectSchema({
      project: projectProperty,
      state: stringProperty("Dispatch lifecycle state."),
    }),
    true,
  ),
  tool(
    "atelier_dispatch",
    "Atelier Dispatch",
    "Read the full record for one dispatch.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    true,
  ),
  tool(
    "atelier_dispatch_tail",
    "Atelier Dispatch Tail",
    "Read the last N replayed transcript events without following the live stream.",
    objectSchema({
      id: dispatchIdProperty,
      lines: {
        type: "integer",
        minimum: 1,
        default: 50,
        description: "Number of transcript events to return.",
      },
    }, ["id"]),
    true,
  ),
  tool(
    "atelier_dispatch_diff",
    "Atelier Dispatch Diff",
    "Read a dispatch's file statistics and optionally its bounded patch.",
    objectSchema({
      id: dispatchIdProperty,
      patch: {
        type: "boolean",
        default: true,
        description: "Include the bounded unified patch.",
      },
    }, ["id"]),
    true,
  ),
  tool(
    "atelier_rollup",
    "Atelier Cost Rollup",
    "Read Atelier's aggregate dispatch cost rollup.",
    objectSchema(),
    true,
  ),
  tool(
    "atelier_logs",
    "Atelier Event Log",
    [
      "Read Atelier's structured operational event log: queue drain decisions",
      "(picked/skipped with a machine-readable reason), dispatch state",
      "transitions with failure kinds, settings and registry changes with actor",
      "and field diffs, budget verdicts, park/un-park, review/merge/dismiss and",
      "service lifecycle. Filters are exact matches; kind accepts a",
      "comma-separated list. Newest matching events are returned in",
      "chronological order.",
    ].join(" "),
    objectSchema({
      kind: stringProperty(
        "Exact event kind, or a comma-separated list: queue.drain, queue.settings, queue.park, queue.unpark, dispatch.transition, dispatch.review, dispatch.review-disposition, dispatch.merge, dispatch.dismiss, budget.evaluation, registry.change, service.start, service.stop, service.shutdown.",
      ),
      project: projectProperty,
      dispatchId: dispatchIdProperty,
      ticketId: ticketIdProperty,
      actor: stringProperty("Exact actor provenance, such as ui, mcp, cli, api or circuit-breaker."),
      source: stringProperty('Exact event source, "server" today.'),
      since: stringProperty("ISO-8601 lower bound on the event timestamp."),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1_000,
        default: 200,
        description: "Maximum number of newest matching events to return.",
      },
    }),
    true,
  ),
  tool(
    "atelier_settings",
    "Atelier Project Settings",
    "Read the mutable settings view for one project.",
    objectSchema({ project: projectProperty }, ["project"]),
    true,
  ),
  tool(
    "atelier_queue",
    "Atelier Ready Queue",
    "Read ready-queue autonomy state, including breaker failures and the last error.",
    objectSchema({ project: projectProperty }, ["project"]),
    true,
  ),
  tool(
    "atelier_main_health",
    "Atelier Main Health",
    "Read a project's post-merge verification banner state, including unresolved failures.",
    objectSchema({ project: projectProperty }, ["project"]),
    true,
  ),
  tool(
    "atelier_convoys",
    "Atelier Convoys",
    "List convoy status, optionally filtered by project or convoy id.",
    objectSchema({ project: projectProperty, id: convoyIdProperty }),
    true,
  ),
  tool(
    "atelier_ticket_create",
    "Create Atelier Ticket",
    "Create a ticket in a project's configured tracker.",
    objectSchema({
      project: projectProperty,
      title: stringProperty("Ticket title."),
      description: stringProperty("Ticket description."),
      type: {
        type: "string",
        enum: ["task", "bug", "chore"],
        description: "Tracker ticket type.",
      },
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "Tracker priority from 0 (highest) to 4 (lowest).",
      },
    }, ["project", "title", "description", "type", "priority"]),
    false,
  ),
  tool(
    "atelier_ticket_comment",
    "Comment on Atelier Ticket",
    "Add a comment to a tracker ticket.",
    objectSchema({
      project: projectProperty,
      id: ticketIdProperty,
      text: stringProperty("Comment text."),
    }, ["project", "id", "text"]),
    false,
  ),
  tool(
    "atelier_ticket_action",
    "Claim or Promote Atelier Ticket",
    "Claim a tracker ticket for an actor or promote a triage ticket.",
    objectSchema({
      project: projectProperty,
      id: ticketIdProperty,
      action: {
        type: "string",
        enum: ["claim", "promote"],
        description: "Tracker ticket action.",
      },
      actor: stringProperty("Actor claiming the ticket; required only for claim."),
    }, ["project", "id", "action"]),
    false,
  ),
  tool(
    "atelier_ticket_close",
    "Close Atelier Ticket",
    "Close a tracker ticket with a reason.",
    objectSchema({
      project: projectProperty,
      id: ticketIdProperty,
      reason: stringProperty("Reason for closing the ticket."),
    }, ["project", "id", "reason"]),
    false,
    true,
  ),
  tool(
    "atelier_dispatch_start",
    "Start Atelier Dispatch",
    "Start an isolated Atelier dispatch for a ticket or prompt.",
    objectSchema({
      project: projectProperty,
      ticketId: ticketIdProperty,
      prompt: stringProperty("Standalone dispatch prompt."),
      lane: stringProperty("Registered agent lane."),
      model: stringProperty("Agent model selection."),
      effort: stringProperty("Agent reasoning effort selection."),
      maxTurns: {
        type: "integer",
        minimum: 1,
        description: "Maximum agent turns.",
      },
      planFirst: booleanProperty("Pause after a read-only planning pass."),
    }, ["project"]),
    false,
  ),
  tool(
    "atelier_bakeoff_start",
    "Start Atelier Bake-off",
    "Dispatch one ticket into two isolated worktrees on distinct agent lanes.",
    objectSchema({
      project: projectProperty,
      ticketId: ticketIdProperty,
      lanes: stringArrayProperty("Two distinct registered agent lanes.", {
        minItems: 2,
        maxItems: 2,
        uniqueItems: true,
        default: ["claude", "codex"],
      }),
    }, ["project", "ticketId"]),
    false,
  ),
  tool(
    "atelier_reply",
    "Reply to Atelier Dispatch",
    "Send text to a live dispatch or resume a supported terminal dispatch.",
    objectSchema({
      id: dispatchIdProperty,
      text: stringProperty("Reply text."),
    }, ["id", "text"]),
    false,
  ),
  tool(
    "atelier_plan_action",
    "Act on Atelier Plan",
    "Approve a plan or request a revision on a plan-ready dispatch.",
    objectSchema({
      id: dispatchIdProperty,
      action: {
        type: "string",
        enum: ["approve", "revise"],
        description: "Plan action.",
      },
      text: stringProperty("Revision feedback."),
    }, ["id", "action"]),
    false,
  ),
  tool(
    "atelier_review",
    "Review Atelier Dispatch",
    "Start a linked read-only spec-audit dispatch for a completed dispatch.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    false,
  ),
  tool(
    "atelier_review_disposition",
    "Record Review Disposition",
    "Append a disposition for one structured review finding.",
    objectSchema({
      id: dispatchIdProperty,
      findingRef: stringProperty("Stable finding ref from review.current.findings."),
      disposition: {
        type: "string",
        enum: ["accepted", "refuted", "redirected", "waived"],
        description: "Human adjudication of the finding.",
      },
      redirectTicket: ticketIdProperty,
      note: stringProperty("Human rationale or refutation evidence; required and bounded."),
    }, ["id", "findingRef", "disposition", "note"]),
    false,
  ),
  tool(
    "atelier_verify_rerun",
    "Re-run Atelier Verification",
    "Re-run a completed dispatch's worktree verification after a failed verdict (flaky suite recovery). Every attempt is retained; the latest verdict is the one the merge gate reads.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    false,
  ),
  tool(
    "atelier_merge",
    "Merge Atelier Dispatch",
    "Run Atelier's gated merge for a completed dispatch.",
    objectSchema({
      id: dispatchIdProperty,
      forcedBy: stringProperty("Human identity responsible for a forced merge."),
      reason: stringProperty("Human rationale for overriding open findings."),
      dispositionRef: stringProperty("Disposition, ticket comment, or adjudication reference."),
    }, ["id"]),
    false,
  ),
  tool(
    "atelier_main_health_ack",
    "Acknowledge Atelier Main Failure",
    "Acknowledge a dispatch's unresolved post-merge verification failure.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    false,
  ),
  tool(
    "atelier_dismiss",
    "Dismiss Atelier Dispatch",
    "Remove a terminal dispatch's worktree and branch while retaining its history.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    false,
    true,
  ),
  tool(
    "atelier_stop",
    "Stop Atelier Dispatch",
    "Stop an active dispatch and its agent process group.",
    objectSchema({ id: dispatchIdProperty }, ["id"]),
    false,
    true,
  ),
  tool(
    "atelier_settings_patch",
    "Update Atelier Project Settings",
    "Patch mutable settings for one registered project; Atelier validates the fields.",
    objectSchema({
      project: projectProperty,
      fields: settingsFieldsSchema,
    }, ["project", "fields"]),
    false,
  ),
  tool(
    "atelier_queue_set",
    "Set Atelier Ready Queue",
    "Enable or pause ready-queue autonomy for one project.",
    objectSchema({
      project: projectProperty,
      enabled: booleanProperty("Whether ready-queue autonomy is enabled."),
    }, ["project", "enabled"]),
    false,
  ),
  tool(
    "atelier_queue_resume",
    "Resume Atelier Queue Ticket",
    "Un-park a ready-queue ticket that hit its consecutive-failure limit.",
    objectSchema({
      project: projectProperty,
      resumeTicketId: ticketIdProperty,
    }, ["project", "resumeTicketId"]),
    false,
  ),
  tool(
    "atelier_convoy_create",
    "Create Atelier Convoy",
    "Start an ordered convoy of two to twenty ready tracker tickets.",
    objectSchema({
      project: projectProperty,
      ticketIds: stringArrayProperty("Ordered tracker ticket ids.", {
        minItems: 2,
        maxItems: 20,
        uniqueItems: true,
      }),
    }, ["project", "ticketIds"]),
    false,
  ),
  tool(
    "atelier_convoy_resume",
    "Resume Atelier Convoy",
    "Resume a paused convoy at its current ticket.",
    objectSchema({ id: convoyIdProperty }, ["id"]),
    false,
  ),
  tool(
    "atelier_convoy_cancel",
    "Cancel Atelier Convoy",
    "Cancel future convoy progression without stopping its in-flight dispatch.",
    objectSchema({ id: convoyIdProperty }, ["id"]),
    false,
    true,
  ),
  tool(
    "atelier_doctor_gc",
    "Garbage Collect Atelier Worktrees",
    "Dismiss old terminal dispatches and remove orphan Atelier worktrees; use dryRun to inspect first.",
    objectSchema({
      olderThanDays: {
        type: "integer",
        minimum: 0,
        default: 7,
        description: "Minimum terminal-dispatch age in days.",
      },
      dryRun: {
        type: "boolean",
        default: false,
        description: "Report candidates without removing anything.",
      },
    }),
    false,
    true,
  ),
  tool(
    "atelier_project_add",
    "Add Atelier Project",
    "Register a project through the same validated and atomic API used by onboarding.",
    objectSchema({ registration: projectRegistrationSchema }, ["registration"]),
    false,
  ),
  tool(
    "atelier_project_remove",
    "Remove Atelier Project",
    "Remove a project from Atelier's registry without deleting its repository or tracker files.",
    objectSchema({ project: projectProperty }, ["project"]),
    false,
    true,
  ),
  tool(
    "atelier_tracker_move",
    "Move Atelier Tracker",
    "Move a project's complete tracker between Atelier-managed state and its repository.",
    objectSchema({
      project: projectProperty,
      to: {
        type: "string",
        enum: ["external", "in-repo"],
        description: "Destination tracker placement.",
      },
    }, ["project", "to"]),
    false,
    true,
  ),
  tool(
    "atelier_open_editor",
    "Open Atelier Path in Editor",
    "Open either a registered project or a dispatch worktree using Atelier's configured editor.",
    {
      ...objectSchema({
        project: projectProperty,
        id: dispatchIdProperty,
      }),
      oneOf: [
        { required: ["project"], not: { required: ["id"] } },
        { required: ["id"], not: { required: ["project"] } },
      ],
    },
    false,
  ),
]);

assertAgentUiParity(MCP_TOOLS);

const TOOL_NAMES = new Set(MCP_TOOLS.map(({ name }) => name));
const TOOL_SCHEMAS = new Map(MCP_TOOLS.map(({ name, inputSchema }) => [name, inputSchema]));

class ToolExecutionError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}
class ToolArgumentError extends Error {}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function readableTypes(types) {
  const values = Array.isArray(types) ? types : [types];
  return values.map((type) => type === "integer" ? "an integer" : `a${/^[aeiou]/.test(type) ? "n" : ""} ${type}`)
    .join(" or ");
}

function validateValue(value, schema, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && !types.some((type) => typeMatches(value, type))) {
    throw new ToolArgumentError(`Argument field ${path} must be ${readableTypes(types)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolArgumentError(
      `Argument field ${path} must be one of: ${schema.enum.map(String).join(", ")}`,
    );
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ToolArgumentError(`Argument field ${path} must not be empty`);
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern)).test(value)) {
      throw new ToolArgumentError(`Argument field ${path} must match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ToolArgumentError(`Argument field ${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ToolArgumentError(`Argument field ${path} must be at most ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      throw new ToolArgumentError(`Argument field ${path} must be greater than ${schema.exclusiveMinimum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ToolArgumentError(`Argument field ${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ToolArgumentError(`Argument field ${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      throw new ToolArgumentError(`Argument field ${path} must not contain duplicates`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateValue(entry, schema.items, `${path}[${index}]`));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (Object.hasOwn(properties, key)) {
        validateValue(value[key], properties[key], childPath);
      } else if (schema.additionalProperties === false) {
        throw new ToolArgumentError(`Unknown argument field: ${childPath}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateValue(value[key], schema.additionalProperties, childPath);
      }
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        throw new ToolArgumentError(`Missing required argument field: ${path ? `${path}.` : ""}${required}`);
      }
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      throw new ToolArgumentError(`Argument field ${path} must contain at least one field`);
    }
  }
}

function validateToolArguments(name, args) {
  validateValue(args, TOOL_SCHEMAS.get(name), "");
  if (name === "atelier_ticket_action") {
    if (args.action === "claim" && args.actor === undefined) {
      throw new ToolArgumentError("Missing required argument field: actor");
    }
    if (args.action === "promote" && args.actor !== undefined) {
      throw new ToolArgumentError("Argument field actor is only valid when action is claim");
    }
  }
  if (name === "atelier_open_editor") {
    const targets = [args.project, args.id].filter((value) => value !== undefined);
    if (targets.length !== 1) {
      throw new ToolArgumentError("Exactly one argument field is required: project or id");
    }
  }
}

function encoded(value) {
  return encodeURIComponent(value);
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function toolSuccess(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function toolFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof ToolExecutionError ? error.details : undefined;
  const hasStructuredDetails = details && typeof details === "object" && !Array.isArray(details) &&
    Object.keys(details).some((key) => key !== "error");
  return {
    content: [{
      type: "text",
      text: hasStructuredDetails ? JSON.stringify(details, null, 2) : message,
    }],
    isError: true,
  };
}

function serviceUnavailable(baseUrl) {
  return `Atelier service is unavailable at ${baseUrl}. Start it with: systemctl --user start atelier`;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serviceErrorMessage(response, body) {
  if (body && typeof body === "object" && typeof body.error === "string") return body.error;
  if (typeof body === "string" && body) return body;
  return `Atelier server returned HTTP ${response.status}`;
}

function proxyClient(fetchImpl, baseUrl, authToken) {
  async function request(path, { method = "GET", body, headers = {}, signal } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${authToken}`,
          // Optional display provenance only. The server derives the MCP
          // identity from the signed bearer and never trusts this header.
          "X-Atelier-Actor": "mcp",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new ToolExecutionError(serviceUnavailable(baseUrl));
    }
    return response;
  }

  async function json(path, options) {
    const response = await request(path, options);
    const body = await responseBody(response);
    if (!response.ok) throw new ToolExecutionError(serviceErrorMessage(response, body), body);
    return body;
  }

  return { json, request };
}

function projectsFrom(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.projects)) return value.projects;
  return [];
}

function findProject(value, name) {
  const project = projectsFrom(value).find((candidate) => candidate.name === name);
  if (!project) throw new ToolExecutionError(`Unknown project: ${name}`);
  return project;
}

function parseSseFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return data ? JSON.parse(data) : undefined;
}

async function replayEvents(client, id) {
  const controller = new AbortController();
  const events = [];
  let reachedHeartbeat = false;
  try {
    const response = await client.request(`/api/dispatch/${encoded(id)}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await responseBody(response);
      throw new ToolExecutionError(serviceErrorMessage(response, body));
    }
    if (!response.body) throw new ToolExecutionError("Atelier event stream returned no body");

    const decoder = new TextDecoder();
    let buffer = "";
    eventStream: for await (const chunk of response.body) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.split("\n").some((line) => line.startsWith(":"))) {
          reachedHeartbeat = true;
          controller.abort();
          break eventStream;
        }
        const event = parseSseFrame(frame);
        if (event !== undefined) events.push(event);
      }
    }
    return events;
  } catch (error) {
    if (error.name === "AbortError" && reachedHeartbeat) return events;
    throw error;
  } finally {
    controller.abort();
  }
}

async function invokeTool(client, name, args) {
  switch (name) {
    case "atelier_projects": {
      return projectsFrom(await client.json("/api/projects"));
    }
    case "atelier_agents": {
      return client.json("/api/agents");
    }
    case "atelier_board": {
      return client.json(`/api/projects/${encoded(args.project)}/state`);
    }
    case "atelier_ticket": {
      const board = await client.json(`/api/projects/${encoded(args.project)}/state`);
      const ticket = board?.issues?.find((candidate) => candidate.id === args.id);
      if (!ticket) throw new ToolExecutionError(`Unknown ticket: ${args.id}`);
      return ticket;
    }
    case "atelier_chronicle": {
      return client.json(
        args.project === undefined
          ? "/api/chronicle"
          : `/api/projects/${encoded(args.project)}/chronicle`,
      );
    }
    case "atelier_dispatches": {
      const records = await client.json("/api/dispatches");
      return (Array.isArray(records) ? records : []).filter((record) =>
        (args.project === undefined || record.project === args.project) &&
        (args.state === undefined || record.state === args.state)
      );
    }
    case "atelier_dispatch": {
      return client.json(`/api/dispatch/${encoded(args.id)}`);
    }
    case "atelier_dispatch_tail": {
      const events = await replayEvents(client, args.id);
      return events.slice(-(args.lines ?? 50));
    }
    case "atelier_dispatch_diff": {
      const query = args.patch === false ? "" : "?patch=1";
      return client.json(`/api/dispatch/${encoded(args.id)}/diff${query}`);
    }
    case "atelier_rollup": {
      return client.json("/api/rollup");
    }
    case "atelier_logs": {
      const query = new URLSearchParams(withoutUndefined({
        kind: args.kind,
        project: args.project,
        dispatchId: args.dispatchId,
        ticketId: args.ticketId,
        actor: args.actor,
        source: args.source,
        since: args.since,
        limit: args.limit === undefined ? undefined : String(args.limit),
      }));
      const suffix = query.size > 0 ? `?${query}` : "";
      return client.json(`/api/logs${suffix}`);
    }
    case "atelier_settings": {
      const project = findProject(await client.json("/api/projects"), args.project);
      const settings = { project: project.name };
      for (const field of MUTABLE_SETTINGS) {
        if (Object.hasOwn(project, field)) settings[field] = project[field];
      }
      return settings;
    }
    case "atelier_queue": {
      return client.json(`/api/projects/${encoded(args.project)}/queue`);
    }
    case "atelier_main_health": {
      return client.json(`/api/projects/${encoded(args.project)}/main-health`);
    }
    case "atelier_convoys": {
      const convoys = await client.json("/api/convoys");
      return (Array.isArray(convoys) ? convoys : []).filter((convoy) =>
        (args.project === undefined || convoy.project === args.project) &&
        (args.id === undefined || convoy.id === args.id)
      );
    }
    case "atelier_ticket_create": {
      return client.json(`/api/projects/${encoded(args.project)}/create`, {
        method: "POST",
        body: {
          title: args.title,
          desc: args.description,
          type: args.type,
          priority: args.priority,
        },
      });
    }
    case "atelier_ticket_comment": {
      return client.json(`/api/projects/${encoded(args.project)}/comment`, {
        method: "POST",
        body: { id: args.id, text: args.text },
      });
    }
    case "atelier_ticket_action": {
      return client.json(
        `/api/projects/${encoded(args.project)}/${args.action}`,
        {
          method: "POST",
          body: {
            id: args.id,
            ...(args.action === "claim" ? { actor: args.actor } : {}),
          },
        },
      );
    }
    case "atelier_ticket_close": {
      return client.json(`/api/projects/${encoded(args.project)}/close`, {
        method: "POST",
        body: { id: args.id, reason: args.reason },
      });
    }
    case "atelier_dispatch_start": {
      return client.json("/api/dispatch", {
        method: "POST",
        body: withoutUndefined({
          project: args.project,
          ticketId: args.ticketId,
          prompt: args.prompt,
          lane: args.lane,
          model: args.model,
          effort: args.effort,
          maxTurns: args.maxTurns,
          planFirst: args.planFirst,
        }),
      });
    }
    case "atelier_bakeoff_start": {
      return client.json("/api/dispatch", {
        method: "POST",
        body: withoutUndefined({
          project: args.project,
          ticketId: args.ticketId,
          lanes: args.lanes ?? ["claude", "codex"],
        }),
      });
    }
    case "atelier_reply": {
      return client.json(`/api/dispatch/${encoded(args.id)}/reply`, {
        method: "POST",
        body: { text: args.text },
      });
    }
    case "atelier_plan_action": {
      return client.json(`/api/dispatch/${encoded(args.id)}/plan`, {
        method: "POST",
        body: withoutUndefined({ action: args.action, text: args.text }),
      });
    }
    case "atelier_review": {
      return client.json(`/api/dispatch/${encoded(args.id)}/review`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_review_disposition": {
      return client.json(`/api/dispatch/${encoded(args.id)}/review-disposition`, {
        method: "POST",
        body: withoutUndefined({
          findingRef: args.findingRef,
          disposition: args.disposition,
          redirectTicket: args.redirectTicket,
          note: args.note,
        }),
      });
    }
    case "atelier_verify_rerun": {
      return client.json(`/api/dispatch/${encoded(args.id)}/verify`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_merge": {
      return client.json(`/api/dispatch/${encoded(args.id)}/merge`, {
        method: "POST",
        body: withoutUndefined({
          forcedBy: args.forcedBy,
          reason: args.reason,
          dispositionRef: args.dispositionRef,
        }),
      });
    }
    case "atelier_main_health_ack": {
      return client.json(`/api/dispatch/${encoded(args.id)}/ack-main-health`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_dismiss": {
      return client.json(`/api/dispatch/${encoded(args.id)}/dismiss`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_stop": {
      return client.json(`/api/dispatch/${encoded(args.id)}/stop`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_settings_patch": {
      return client.json(`/api/projects/${encoded(args.project)}`, {
        method: "PATCH",
        body: args.fields,
      });
    }
    case "atelier_queue_set": {
      return client.json(`/api/projects/${encoded(args.project)}/queue`, {
        method: "POST",
        body: { enabled: args.enabled },
      });
    }
    case "atelier_queue_resume": {
      return client.json(`/api/projects/${encoded(args.project)}/queue`, {
        method: "POST",
        body: { resumeTicketId: args.resumeTicketId },
      });
    }
    case "atelier_convoy_create": {
      return client.json(`/api/projects/${encoded(args.project)}/convoy`, {
        method: "POST",
        body: { ticketIds: args.ticketIds },
      });
    }
    case "atelier_convoy_resume": {
      return client.json(`/api/convoys/${encoded(args.id)}/resume`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_convoy_cancel": {
      return client.json(`/api/convoys/${encoded(args.id)}/cancel`, {
        method: "POST",
        body: {},
      });
    }
    case "atelier_doctor_gc": {
      return client.json("/api/doctor/gc", {
        method: "POST",
        body: withoutUndefined({
          olderThanDays: args.olderThanDays,
          dryRun: args.dryRun,
        }),
      });
    }
    case "atelier_project_add": {
      return client.json("/api/projects", {
        method: "POST",
        body: args.registration,
      });
    }
    case "atelier_project_remove": {
      return client.json(`/api/projects/${encoded(args.project)}`, {
        method: "DELETE",
      });
    }
    case "atelier_tracker_move": {
      return client.json(`/api/projects/${encoded(args.project)}/move-tracker`, {
        method: "POST",
        body: { to: args.to },
      });
    }
    case "atelier_open_editor": {
      const path = args.project === undefined
        ? `/api/dispatch/${encoded(args.id)}/open-editor`
        : `/api/projects/${encoded(args.project)}/open-editor`;
      return client.json(path, { method: "POST", body: {} });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function writeMessage(output, message) {
  if (output.write(`${JSON.stringify(message)}\n`)) return;
  await once(output, "drain");
}

function negotiatedProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
}

export async function runMcpServer({
  input = process.stdin,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  port = Number(process.env.PORT || 5170),
  baseUrl,
  authToken,
} = {}) {
  if (baseUrl === undefined) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("port must be an integer between 1 and 65535");
    }
    baseUrl = `http://127.0.0.1:${port}`;
  }
  baseUrl = String(baseUrl).replace(/\/$/, "");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  authToken ??= clientBearerToken("mcp");
  const client = proxyClient(fetchImpl, baseUrl, authToken);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  let initialized = false;
  let ready = false;

  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      await writeMessage(output, rpcError(null, -32700, "Parse error"));
      continue;
    }

    const hasId = message && Object.hasOwn(message, "id");
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      if (hasId) await writeMessage(output, rpcError(message.id, -32600, "Invalid Request"));
      continue;
    }

    if (message.method === "initialize") {
      if (!hasId) continue;
      if (initialized) {
        await writeMessage(output, rpcError(message.id, -32600, "Server already initialized"));
        continue;
      }
      initialized = true;
      const protocolVersion = negotiatedProtocolVersion(message.params?.protocolVersion);
      await writeMessage(output, result(message.id, {
        protocolVersion,
        serverInfo: { name: "atelier", version: PACKAGE_JSON.version },
        capabilities: { tools: {} },
      }));
      continue;
    }

    if (message.method === "notifications/initialized") {
      if (initialized) ready = true;
      continue;
    }

    if (message.method === "ping") {
      if (hasId) await writeMessage(output, result(message.id, {}));
      continue;
    }

    if (!hasId) continue;
    if (!ready) {
      await writeMessage(output, rpcError(message.id, -32002, "Server not initialized"));
      continue;
    }

    if (message.method === "tools/list") {
      await writeMessage(output, result(message.id, { tools: MCP_TOOLS }));
      continue;
    }

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const suppliedArgs = message.params?.arguments;
      const args = suppliedArgs === undefined ? {} : suppliedArgs;
      if (typeof name !== "string" || !TOOL_NAMES.has(name)) {
        await writeMessage(output, rpcError(message.id, -32602, `Unknown tool: ${name}`));
        continue;
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        await writeMessage(output, rpcError(message.id, -32602, "Tool arguments must be an object"));
        continue;
      }
      try {
        validateToolArguments(name, args);
      } catch (error) {
        if (!(error instanceof ToolArgumentError)) throw error;
        await writeMessage(output, rpcError(message.id, -32602, error.message));
        continue;
      }
      try {
        await writeMessage(output, result(message.id, toolSuccess(await invokeTool(client, name, args))));
      } catch (error) {
        await writeMessage(output, result(message.id, toolFailure(error)));
      }
      continue;
    }

    await writeMessage(output, rpcError(message.id, -32601, "Method not found"));
  }

  output.end?.();
}
