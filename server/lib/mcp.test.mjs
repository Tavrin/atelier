import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { MCP_PROTOCOL_VERSION, MCP_TOOLS, MUTABLE_SETTINGS, runMcpServer } from "./mcp.mjs";
import { AGENT_UI_CAPABILITY_MANIFEST } from "./parity.mjs";

async function exchange(messages, fetchImpl = async () => {
  throw new Error("unexpected fetch");
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk;
  });

  const done = runMcpServer({
    input,
    output,
    fetchImpl,
    baseUrl: "http://127.0.0.1:55170",
    authToken: "fixture-token",
  });
  input.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  await done;
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function handshake(...requests) {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...requests,
  ];
}

function toolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

test("MCP stdio handshake negotiates a known version, accepts initialized, and pings", async () => {
  const responses = await exchange(handshake({ jsonrpc: "2.0", id: 2, method: "ping" }));

  assert.deepEqual(responses, [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "atelier", version: "0.3.0" },
        capabilities: { tools: {} },
      },
    },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);

  const fallback = await exchange([{
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: { protocolVersion: "future-version", capabilities: {}, clientInfo: {} },
  }]);
  assert.equal(fallback[0].result.protocolVersion, MCP_PROTOCOL_VERSION);
});

test("MCP tool inventory and annotations match the shared agent/UI parity manifest", async () => {
  const responses = await exchange(handshake({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }));
  const tools = responses[1].result.tools;

  assert.deepEqual(tools, MCP_TOOLS);
  assert.deepEqual(
    tools.map(({ name, annotations }) => ({
      tool: name,
      readOnlyHint: annotations.readOnlyHint,
      destructiveHint: annotations.destructiveHint,
    })),
    AGENT_UI_CAPABILITY_MANIFEST.map(({ tool, readOnlyHint, destructiveHint }) => ({
      tool,
      readOnlyHint,
      destructiveHint,
    })),
  );
  assert.ok(tools.every(({ title, description, inputSchema, annotations }) =>
    typeof title === "string" &&
    typeof description === "string" &&
    inputSchema?.type === "object" &&
    typeof annotations?.readOnlyHint === "boolean" &&
    typeof annotations?.destructiveHint === "boolean"
  ));
  assert.equal(tools.find(({ name }) => name === "atelier_merge").annotations.destructiveHint, false);
  assert.equal(tools.find(({ name }) => name === "atelier_review").annotations.destructiveHint, false);
  assert.equal(
    tools.find(({ name }) => name === "atelier_review_disposition").annotations.destructiveHint,
    false,
  );
  assert.match(
    tools.find(({ name }) => name === "atelier_settings_patch")
      .inputSchema.properties.fields.description,
    /queueFailureLimit/,
  );
  for (const name of [
    "atelier_dispatch_start",
    "atelier_bakeoff_start",
    "atelier_reply",
    "atelier_plan_action",
    "atelier_review",
    "atelier_merge",
  ]) {
    assert.equal(
      Object.hasOwn(tools.find((tool) => tool.name === name).inputSchema.properties, "force"),
      false,
      `${name} must not advertise force authority`,
    );
    assert.deepEqual(
      AGENT_UI_CAPABILITY_MANIFEST.find((capability) => capability.tool === name).mcpExcluded,
      ["force"],
    );
  }
});

test("atelier_settings_patch fields schema covers every MUTABLE_SETTINGS key (atelier-def anti-drift)", async () => {
  const responses = await exchange(handshake({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }));
  const tools = responses[1].result.tools;
  const fieldsSchema = tools.find(({ name }) => name === "atelier_settings_patch")
    .inputSchema.properties.fields;

  // Both sides must name the exact same key set - not a hand-maintained
  // duplicate list, but MUTABLE_SETTINGS itself (the same array that also
  // drives the generated description text above). If either the schema or
  // MUTABLE_SETTINGS gains or drops a key without the other, this fails.
  assert.deepEqual(
    Object.keys(fieldsSchema.properties).sort(),
    [...MUTABLE_SETTINGS].sort(),
  );
});

test("atelier_settings_patch round-trips queueFailureLimit (atelier-def: schema previously omitted it)", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_settings_patch", {
      project: "atelier",
      fields: { queueFailureLimit: 5 },
    }),
    toolCall(3, "atelier_settings_patch", {
      project: "atelier",
      fields: { queueFailureLimit: null },
    }),
    toolCall(4, "atelier_settings_patch", {
      project: "atelier",
      fields: { queueFailureLimit: 0 },
    }),
  ), async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ name: "atelier", queueFailureLimit: 5 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  // A valid value and an explicit null (remove the ceiling) both reach HTTP.
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].options.body), { queueFailureLimit: 5 });
  assert.deepEqual(JSON.parse(requests[1].options.body), { queueFailureLimit: null });
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].result.isError, false);
  // A non-positive value is still rejected before HTTP - the schema fix does
  // not loosen the minimum, it only stops omitting the field entirely.
  assert.equal(responses[3].error.code, -32602);
  assert.match(responses[3].error.message, /fields\.queueFailureLimit must be at least 1/);
});

test("atelier_settings_patch exposes and validates the per-project review policy", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_settings_patch", {
      project: "atelier",
      fields: { reviewPolicy: "tiered" },
    }),
    toolCall(3, "atelier_settings_patch", {
      project: "atelier",
      fields: { reviewPolicy: "permissive" },
    }),
  ), async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ name: "atelier", reviewPolicy: "tiered" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), { reviewPolicy: "tiered" });
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].error.code, -32602);
  assert.match(responses[2].error.message, /fields\.reviewPolicy must be one of/);
});

test("parity tools proxy chronicle, ticket action, bake-off, main-health, agents, and diff routes", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_agents"),
    toolCall(3, "atelier_chronicle", { project: "atelier fixture" }),
    toolCall(4, "atelier_dispatch_diff", { id: "dispatch one" }),
    toolCall(5, "atelier_dispatch_diff", { id: "dispatch one", patch: false }),
    toolCall(6, "atelier_ticket_action", {
      project: "atelier fixture",
      id: "atelier-1",
      action: "claim",
      actor: "reviewer",
    }),
    toolCall(7, "atelier_ticket_action", {
      project: "atelier fixture",
      id: "atelier-2",
      action: "promote",
    }),
    toolCall(8, "atelier_bakeoff_start", {
      project: "atelier fixture",
      ticketId: "atelier-3",
    }),
    toolCall(9, "atelier_main_health_ack", { id: "dispatch one" }),
  ), async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(requests.map(({ url, options }) => ({
    path: `${new URL(url).pathname}${new URL(url).search}`,
    method: options.method,
    body: options.body === undefined ? undefined : JSON.parse(options.body),
  })), [
    { path: "/api/agents", method: "GET", body: undefined },
    {
      path: "/api/projects/atelier%20fixture/chronicle",
      method: "GET",
      body: undefined,
    },
    { path: "/api/dispatch/dispatch%20one/diff?patch=1", method: "GET", body: undefined },
    { path: "/api/dispatch/dispatch%20one/diff", method: "GET", body: undefined },
    {
      path: "/api/projects/atelier%20fixture/claim",
      method: "POST",
      body: { id: "atelier-1", actor: "reviewer" },
    },
    {
      path: "/api/projects/atelier%20fixture/promote",
      method: "POST",
      body: { id: "atelier-2" },
    },
    {
      path: "/api/dispatch",
      method: "POST",
      body: {
        project: "atelier fixture",
        ticketId: "atelier-3",
        lanes: ["claude", "codex"],
      },
    },
    {
      path: "/api/dispatch/dispatch%20one/ack-main-health",
      method: "POST",
      body: {},
    },
  ]);
  assert.ok(responses.slice(1).every((response) => response.result?.isError === false));
});

test("atelier_chronicle defaults to aggregate and validates its optional project argument", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_chronicle"),
    toolCall(3, "atelier_chronicle", { project: "atelier fixture" }),
    toolCall(4, "atelier_chronicle", { project: 42 }),
    toolCall(5, "atelier_chronicle", { project: "atelier", extra: true }),
  ), async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ generatedAt: "2026-07-30T08:00:00.000Z" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    "/api/chronicle",
    "/api/projects/atelier%20fixture/chronicle",
  ]);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].result.isError, false);
  assert.equal(responses[3].error.code, -32602);
  assert.match(responses[3].error.message, /project must be a string/);
  assert.equal(responses[4].error.code, -32602);
  assert.match(responses[4].error.message, /Unknown argument field: extra/);
});

test("parity tools proxy queue, convoy, GC, project, tracker, and editor operations", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = url.endsWith("/api/convoys")
      ? [{ id: "convoy-1", project: "atelier fixture" }]
      : { ok: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const registration = {
    name: "new-project",
    path: "/srv/new-project",
    archetype: "git-only",
    mainBranch: "main",
    tracker: "none",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: ["node --test"],
  };
  const responses = await exchange(handshake(
    toolCall(2, "atelier_queue", { project: "atelier fixture" }),
    toolCall(3, "atelier_convoys", { project: "atelier fixture", id: "convoy-1" }),
    toolCall(4, "atelier_queue_set", { project: "atelier fixture", enabled: false }),
    toolCall(5, "atelier_convoy_create", {
      project: "atelier fixture",
      ticketIds: ["atelier-1", "atelier-2"],
    }),
    toolCall(6, "atelier_convoy_resume", { id: "convoy-1" }),
    toolCall(7, "atelier_convoy_cancel", { id: "convoy-1" }),
    toolCall(8, "atelier_doctor_gc", { olderThanDays: 14, dryRun: true }),
    toolCall(9, "atelier_project_add", { registration }),
    toolCall(10, "atelier_project_remove", { project: "old project" }),
    toolCall(11, "atelier_tracker_move", { project: "atelier fixture", to: "external" }),
    toolCall(12, "atelier_open_editor", { project: "atelier fixture" }),
    toolCall(13, "atelier_open_editor", { id: "dispatch-1" }),
    toolCall(14, "atelier_main_health", { project: "atelier fixture" }),
    toolCall(15, "atelier_queue_resume", { project: "atelier fixture", resumeTicketId: "atelier-9" }),
  ), fetchImpl);

  assert.deepEqual(requests.map(({ url, options }) => ({
    path: new URL(url).pathname,
    method: options.method,
    body: options.body === undefined ? undefined : JSON.parse(options.body),
  })), [
    { path: "/api/projects/atelier%20fixture/queue", method: "GET", body: undefined },
    { path: "/api/convoys", method: "GET", body: undefined },
    {
      path: "/api/projects/atelier%20fixture/queue",
      method: "POST",
      body: { enabled: false },
    },
    {
      path: "/api/projects/atelier%20fixture/convoy",
      method: "POST",
      body: { ticketIds: ["atelier-1", "atelier-2"] },
    },
    { path: "/api/convoys/convoy-1/resume", method: "POST", body: {} },
    { path: "/api/convoys/convoy-1/cancel", method: "POST", body: {} },
    {
      path: "/api/doctor/gc",
      method: "POST",
      body: { olderThanDays: 14, dryRun: true },
    },
    { path: "/api/projects", method: "POST", body: registration },
    { path: "/api/projects/old%20project", method: "DELETE", body: undefined },
    {
      path: "/api/projects/atelier%20fixture/move-tracker",
      method: "POST",
      body: { to: "external" },
    },
    { path: "/api/projects/atelier%20fixture/open-editor", method: "POST", body: {} },
    { path: "/api/dispatch/dispatch-1/open-editor", method: "POST", body: {} },
    { path: "/api/projects/atelier%20fixture/main-health", method: "GET", body: undefined },
    {
      path: "/api/projects/atelier%20fixture/queue",
      method: "POST",
      body: { resumeTicketId: "atelier-9" },
    },
  ]);
  assert.ok(responses.slice(1).every((response) => response.result?.isError === false));
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), [
    { id: "convoy-1", project: "atelier fixture" },
  ]);
});

test("tools/call rejects unknown, missing, and mistyped fields before HTTP", async () => {
  let fetches = 0;
  const responses = await exchange(handshake(
    toolCall(2, "atelier_settings_patch", {
      project: "atelier",
      patch: { notes: "wrong argument name" },
    }),
    toolCall(3, "atelier_settings_patch", { project: "atelier" }),
    toolCall(4, "atelier_settings_patch", { project: "atelier", fields: "wrong type" }),
    toolCall(5, "atelier_settings_patch", { project: "atelier", fields: { surprise: true } }),
    toolCall(6, "atelier_queue_set", { project: "atelier", enabled: "yes" }),
    toolCall(7, "atelier_open_editor", {}),
    toolCall(8, "atelier_open_editor", { project: "atelier", id: "dispatch-1" }),
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "atelier_rollup", arguments: null },
    },
    toolCall(10, "atelier_ticket_action", {
      project: "atelier",
      id: "atelier-1",
      action: "claim",
    }),
    toolCall(11, "atelier_ticket_action", {
      project: "atelier",
      id: "atelier-1",
      action: "promote",
      actor: "surplus",
    }),
    toolCall(12, "atelier_bakeoff_start", {
      project: "atelier",
      ticketId: "atelier-1",
      lanes: ["claude", "claude"],
    }),
    toolCall(13, "atelier_dispatch_diff", { id: "dispatch-1", patch: "yes" }),
    toolCall(14, "atelier_queue_resume", { project: "atelier" }),
    toolCall(15, "atelier_main_health", {}),
  ), async () => {
    fetches += 1;
    throw new Error("invalid arguments must not reach fetch");
  });

  assert.equal(fetches, 0);
  assert.deepEqual(responses.slice(1).map(({ error }) => error.code), Array(14).fill(-32602));
  assert.match(responses[1].error.message, /Unknown argument field: patch/);
  assert.match(responses[2].error.message, /Missing required argument field: fields/);
  assert.match(responses[3].error.message, /fields must be an object/);
  assert.match(responses[4].error.message, /Unknown argument field: fields\.surprise/);
  assert.match(responses[5].error.message, /enabled must be a boolean/);
  assert.match(responses[6].error.message, /project or id/);
  assert.match(responses[7].error.message, /project or id/);
  assert.match(responses[8].error.message, /must be an object/);
  assert.match(responses[9].error.message, /Missing required argument field: actor/);
  assert.match(responses[10].error.message, /actor is only valid/);
  assert.match(responses[11].error.message, /lanes must not contain duplicates/);
  assert.match(responses[12].error.message, /patch must be a boolean/);
  assert.match(responses[13].error.message, /Missing required argument field: resumeTicketId/);
  assert.match(responses[14].error.message, /Missing required argument field: project/);
});

test("atelier_verify_rerun proxies the verification re-run endpoint and validates its arguments", async () => {
  const requests = [];
  const responses = await exchange(
    handshake(
      toolCall(2, "atelier_verify_rerun", { id: "dispatch 1" }),
      toolCall(3, "atelier_verify_rerun", {}),
      toolCall(4, "atelier_verify_rerun", { id: "dispatch-1", force: true }),
    ),
    async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({ id: "dispatch-1", state: "verifying", verify: { state: "running", attempt: 2 } }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:55170/api/dispatch/dispatch%201/verify");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(responses[1].result.isError, false);
  assert.match(responses[1].result.content[0].text, /"attempt": 2/);
  // A re-run takes no force: the gate it clears is the verdict itself.
  assert.match(responses[2].error.message, /Missing required argument field: id/);
  assert.match(responses[3].error.message, /Unknown argument field: force/);
});

test("atelier_review proxies normally and rejects force before HTTP", async () => {
  const requests = [];
  const responses = await exchange(
    handshake(
      toolCall(2, "atelier_review", { id: "dispatch-1" }),
      toolCall(3, "atelier_review", { id: "dispatch-1", force: true }),
    ),
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: "review-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(requests[0].url, "http://127.0.0.1:55170/api/dispatch/dispatch-1/review");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].error.code, -32602);
  assert.match(responses[2].error.message, /Unknown argument field: force/);
});

test("atelier_review_disposition round-trips the mandatory actor and append payload", async () => {
  const requests = [];
  const disposition = {
    ref: "disposition-1",
    findingRef: "round-2:finding-3",
    disposition: "waived",
    note: "The architect explicitly waives this finding.",
    actor: "maintainer",
    at: "2026-07-31T00:00:00.000Z",
  };
  const responses = await exchange(
    handshake(
      toolCall(2, "atelier_review_disposition", {
        id: "dispatch-1",
        findingRef: disposition.findingRef,
        disposition: disposition.disposition,
        note: disposition.note,
        actor: disposition.actor,
      }),
      toolCall(3, "atelier_review_disposition", {
        id: "dispatch-1",
        findingRef: disposition.findingRef,
        disposition: "accepted",
        note: "Missing actor must fail schema validation.",
      }),
    ),
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        id: "dispatch-1",
        reviewDispositions: [disposition],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "http://127.0.0.1:55170/api/dispatch/dispatch-1/review-disposition",
  );
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    findingRef: disposition.findingRef,
    disposition: disposition.disposition,
    note: disposition.note,
    actor: disposition.actor,
  });
  assert.deepEqual(
    JSON.parse(responses[1].result.content[0].text).reviewDispositions,
    [disposition],
  );
  assert.match(responses[2].error.message, /Missing required argument field: actor/);
});

test("atelier_merge proxies ordinary merges and rejects force before HTTP", async () => {
  const requests = [];
  const responses = await exchange(
    handshake(
      toolCall(2, "atelier_merge", { id: "dispatch-1" }),
      toolCall(3, "atelier_merge", { id: "dispatch-1", force: true }),
    ),
    async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        id: "dispatch-1",
        merged: { commit: "merged" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  assert.equal(requests[0].url, "http://127.0.0.1:55170/api/dispatch/dispatch-1/merge");
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].error.code, -32602);
  assert.match(responses[2].error.message, /Unknown argument field: force/);
});

test("tools/call proxies successful JSON requests to the running loopback service", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ id: "atelier-123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const responses = await exchange(handshake(toolCall(2, "atelier_ticket_create", {
    project: "atelier fixture",
    title: "MCP bridge",
    description: "Proxy the service",
    type: "task",
    priority: 1,
  })), fetchImpl);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:55170/api/projects/atelier%20fixture/create");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["Content-Type"], "application/json");
  assert.equal(requests[0].options.headers.Authorization, "Bearer fixture-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    title: "MCP bridge",
    desc: "Proxy the service",
    type: "task",
    priority: 1,
  });
  assert.deepEqual(responses[1].result, {
    content: [{ type: "text", text: '{\n  "id": "atelier-123"\n}' }],
    isError: false,
  });
});

test("settings tools expose and patch the unpriced dispatch cap", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_settings", { project: "atelier" }),
    toolCall(3, "atelier_settings_patch", {
      project: "atelier",
      fields: { unpricedDispatchCapPerDay: 3 },
    }),
  ), async (url, options) => {
    requests.push({ url, options });
    if (options?.method === "PATCH") {
      return new Response(JSON.stringify({ name: "atelier", unpricedDispatchCapPerDay: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      projects: [{ name: "atelier", unpricedDispatchCapPerDay: 2 }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), {
    project: "atelier",
    unpricedDispatchCapPerDay: 2,
  });
  assert.equal(requests[1].url, "http://127.0.0.1:55170/api/projects/atelier");
  assert.equal(requests[1].options.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[1].options.body), { unpricedDispatchCapPerDay: 3 });
  assert.equal(responses[2].result.isError, false);
});

test("tool errors preserve service messages verbatim and explain service startup", async () => {
  const conflict = await exchange(
    handshake(toolCall(2, "atelier_merge", { id: "dispatch-1" })),
    async () => new Response(JSON.stringify({ error: "Verification has not passed" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.deepEqual(conflict[1].result, {
    content: [{ type: "text", text: "Verification has not passed" }],
    isError: true,
  });

  const unavailable = await exchange(
    handshake(toolCall(2, "atelier_rollup")),
    async () => {
      throw new TypeError("fetch failed");
    },
  );
  assert.equal(unavailable[1].result.isError, true);
  assert.match(unavailable[1].result.content[0].text, /systemctl --user start atelier/);

  const budget = await exchange(
    handshake(toolCall(2, "atelier_bakeoff_start", {
      project: "atelier",
      ticketId: "atelier-1",
    })),
    async () => new Response(JSON.stringify({
      error: "daily budget reached",
      budgetExceeded: true,
      spentUSD: 4.5,
      budgetUSD: 4,
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.deepEqual(JSON.parse(budget[1].result.content[0].text), {
    error: "daily budget reached",
    budgetExceeded: true,
    spentUSD: 4.5,
    budgetUSD: 4,
  });
});

test("dispatch tail slices replayed SSE events and closes the stream at the heartbeat", async () => {
  let iteratorReturned = false;
  let requestSignal;
  const eventText = [
    'id: 1\nevent: status\ndata: {"seq":1,"type":"status"}\n\n',
    'id: 2\nevent: message\ndata: {"seq":2,"type":"message"}\n\n',
    'id: 3\nevent: usage\ndata: {"seq":3,"type":"usage"}\n\n',
    ": heartbeat\n\n",
  ].join("");
  const body = {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (sent) return new Promise(() => {});
          sent = true;
          return { done: false, value: new TextEncoder().encode(eventText) };
        },
        async return() {
          iteratorReturned = true;
          return { done: true };
        },
      };
    },
  };
  const fetchImpl = async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, status: 200, body };
  };
  const responses = await exchange(
    handshake(toolCall(2, "atelier_dispatch_tail", { id: "dispatch-1", lines: 2 })),
    fetchImpl,
  );

  assert.equal(requestSignal.aborted, true);
  assert.equal(iteratorReturned, true);
  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), [
    { seq: 2, type: "message" },
    { seq: 3, type: "usage" },
  ]);
});

test("atelier_logs proxies the event-log route with its filters and rejects bad fields", async () => {
  const requests = [];
  const responses = await exchange(handshake(
    toolCall(2, "atelier_logs"),
    toolCall(3, "atelier_logs", {
      kind: "queue.drain,queue.settings",
      project: "atelier fixture",
      dispatchId: "dispatch one",
      actor: "circuit-breaker",
      since: "2026-07-30T00:00:00.000Z",
      limit: 25,
    }),
    toolCall(4, "atelier_logs", { limit: 5_000 }),
    toolCall(5, "atelier_logs", { unknownFilter: "x" }),
  ), async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ events: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(
    requests.map(({ url, options }) => ({
      path: `${new URL(url).pathname}${new URL(url).search}`,
      method: options.method,
      actor: options.headers["X-Atelier-Actor"],
    })),
    [
      { path: "/api/logs", method: "GET", actor: "mcp" },
      {
        path: "/api/logs?kind=queue.drain%2Cqueue.settings&project=atelier+fixture&dispatchId=dispatch+one&actor=circuit-breaker&since=2026-07-30T00%3A00%3A00.000Z&limit=25",
        method: "GET",
        actor: "mcp",
      },
    ],
    "an out-of-range limit and an unknown filter are rejected before any HTTP call",
  );
  assert.equal(responses[3].error.code, -32602);
  assert.match(responses[3].error.message, /limit must be at most 1000/);
  assert.equal(responses[4].error.code, -32602);
  assert.match(responses[4].error.message, /Unknown argument field: unknownFilter/);
  assert.equal(responses[1].result.isError, false);
  assert.equal(responses[2].result.isError, false);
});
