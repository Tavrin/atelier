import assert from "node:assert/strict";
import test from "node:test";

import {
  _extractUsage,
  _parseCompanionLogLines,
  _recordUsage,
  _setLogFileOps,
  _setLogPath,
  _setModelFileOps,
  _tailLogOnce,
  codexAgent,
} from "./codex.mjs";

test("codex companion parser emits typed command, result, file, and raw events", () => {
  assert.deepEqual(_parseCompanionLogLines([
    '[2026-07-21T10:00:00Z] Running command: /usr/bin/zsh -lc "node --test"',
    "[2026-07-21T10:00:01Z] Command completed: node --test (exit 0)",
    "Applying 2 file changes",
    "File changes completed",
    "unmatched companion detail",
  ]), [
    {
      type: "message",
      kind: "tool_use",
      name: "Bash",
      inputPreview: JSON.stringify({ command: "node --test" }),
      caption: "2026-07-21T10:00:00Z",
    },
    {
      type: "message",
      kind: "tool_result",
      preview: "Exit 0",
      exitCode: 0,
      caption: "2026-07-21T10:00:01Z",
    },
    {
      type: "message",
      kind: "files",
      phase: "applying",
      count: 2,
      text: "Applying 2 file changes",
    },
    {
      type: "message",
      kind: "files",
      phase: "completed",
      text: "File changes completed",
    },
    { type: "message", kind: "raw", text: "unmatched companion detail" },
  ]);
});

test("codex companion parser joins clear multiline commands and leaves ambiguity raw", () => {
  assert.deepEqual(_parseCompanionLogLines([
    '[2026-07-21T10:02:00Z] Running command: /usr/bin/zsh -lc "printf \'one',
    'two\\n\'"',
  ]), [{
    type: "message",
    kind: "tool_use",
    name: "Bash",
    inputPreview: JSON.stringify({ command: "printf 'one\ntwo\\n'" }),
    caption: "2026-07-21T10:02:00Z",
  }]);

  const ambiguous = '[2026-07-21T10:03:00Z] Running command: /usr/bin/zsh -lc "echo "unclear""';
  assert.deepEqual(_parseCompanionLogLines([ambiguous]), [
    { type: "message", kind: "raw", text: ambiguous },
  ]);
});

test("codex companion parser types truncated commands and failed results", () => {
  assert.deepEqual(_parseCompanionLogLines([
    "[2026-07-21T10:03:59Z] Running command: /usr/bin/zsh -lc 'br show atelier-54u'",
    "[2026-07-21T10:04:00Z] Running command: /usr/bin/zsh -lc 'rg -n \\\"transcript\\\" ui/app.js...",
    '[2026-07-21T10:04:00.500Z] Running command: /usr/bin/zsh -lc "node --test server/lib/agents/codex.test.mjs...',
    "[2026-07-21T10:04:01Z] Command failed: /usr/bin/zsh -lc 'node --test' (exit 7)",
  ]), [
    {
      type: "message",
      kind: "tool_use",
      name: "Bash",
      inputPreview: JSON.stringify({ command: "br show atelier-54u" }),
      caption: "2026-07-21T10:03:59Z",
    },
    {
      type: "message",
      kind: "tool_use",
      name: "Bash",
      inputPreview: JSON.stringify({ command: "rg -n \\\"transcript\\\" ui/app.js" }),
      caption: "2026-07-21T10:04:00Z",
      truncated: true,
    },
    {
      type: "message",
      kind: "tool_use",
      name: "Bash",
      inputPreview: JSON.stringify({ command: "node --test server/lib/agents/codex.test.mjs" }),
      caption: "2026-07-21T10:04:00.500Z",
      truncated: true,
    },
    {
      type: "message",
      kind: "tool_result",
      preview: "Exit 7",
      exitCode: 7,
      caption: "2026-07-21T10:04:01Z",
    },
  ]);
});

test("codex companion parser leaves ambiguous truncated commands raw", () => {
  const ambiguousDouble =
    '[2026-07-21T10:05:00Z] Running command: /usr/bin/zsh -lc "echo "unclear...';
  const ambiguousSingle =
    "[2026-07-21T10:05:01Z] Running command: /usr/bin/zsh -lc 'printf 'unclear...";

  assert.deepEqual(_parseCompanionLogLines([
    ambiguousDouble,
    ambiguousSingle,
  ]), [
    { type: "message", kind: "raw", text: ambiguousDouble },
    { type: "message", kind: "raw", text: ambiguousSingle },
  ]);
});

test("codex model resolution ignores requested Claude models and reads local config", (t) => {
  _setModelFileOps({
    readFileSync: () => 'model = "gpt-5.6-fixture" # selected by Codex\n',
  });
  t.after(() => _setModelFileOps());

  assert.equal(
    codexAgent.resolveModel({
      requested: "sonnet",
      profile: { model: "haiku", defaultModel: "opus" },
    }),
    "gpt-5.6-fixture",
  );

  _setModelFileOps({ readFileSync: () => "model = 'unsupported TOML shape'\n" });
  assert.equal(codexAgent.resolveModel(), "codex-default");
  _setModelFileOps({ readFileSync: () => { throw new Error("missing config"); } });
  assert.equal(codexAgent.resolveModel(), "codex-default");
});

test("codex log tail reads appended bytes once and preserves partial lines", async (t) => {
  let contents = Buffer.from("first line\npartial", "utf8");
  const reads = [];
  _setLogFileOps({
    stat: async () => ({ size: contents.length }),
    open: async () => 7,
    read: async (_fd, buffer, offset, length, position) => {
      reads.push(position);
      const bytesRead = Math.min(length, contents.length - position);
      if (bytesRead > 0) contents.copy(buffer, offset, position, position + bytesRead);
      return bytesRead;
    },
    close: async () => {},
  });
  t.after(() => _setLogFileOps());

  const entry = { stderrLines: [] };
  const events = [];
  const callbacks = { emit: (_entry, event) => events.push(event) };
  _setLogPath(entry, { logFile: "/fixture/job.log" });

  await _tailLogOnce(entry, callbacks);
  assert.deepEqual(events.map(({ text }) => text), ["first line"]);

  contents = Buffer.concat([contents, Buffer.from(" line\nsecond line\n", "utf8")]);
  await _tailLogOnce(entry, callbacks);
  await _tailLogOnce(entry, callbacks);

  assert.deepEqual(events.map(({ text }) => text), [
    "first line",
    "partial line",
    "second line",
  ]);
  assert.deepEqual(reads, [0, Buffer.byteLength("first line\npartial")]);
  assert.equal(entry.codexLogOffset, contents.length);
});

test("codex usage extraction maps only usage numbers exposed by job JSON", () => {
  const fixture = {
    job: { status: "completed" },
    storedJob: {
      result: {
        usage: {
          num_turns: 4,
          input_tokens: 1_250,
          output_tokens: 375,
          total_tokens: 1_625,
          total_cost_usd: 0.42,
        },
      },
    },
  };
  assert.deepEqual(_extractUsage(fixture), {
    turns: 4,
    costUSD: 0.42,
    inputTokens: 1_250,
    outputTokens: 375,
    totalTokens: 1_625,
  });

  const entry = { record: { turns: 0, costUSD: 0, warnings: [] } };
  const events = [];
  _recordUsage(entry, fixture, { emit: (_entry, event) => events.push(event) });
  assert.equal(entry.record.turns, 4);
  assert.equal(entry.record.costUSD, 0.42);
  assert.deepEqual(events, [{
    type: "usage",
    turns: 4,
    costUSD: 0.42,
    inputTokens: 1_250,
    outputTokens: 375,
    totalTokens: 1_625,
  }]);
});

test("codex completion warns once when companion artifacts have no usage data", () => {
  const entry = { record: { turns: 0, costUSD: 0, warnings: [] } };
  _recordUsage(entry, { job: { status: "completed", turnId: "opaque-id" } }, undefined, {
    final: true,
  });
  _recordUsage(entry, undefined, undefined, { final: true });

  assert.deepEqual(entry.record.warnings, ["codex lane reports no usage data"]);
  assert.equal(entry.record.turns, 0);
  assert.equal(entry.record.costUSD, 0);
  assert.equal(codexAgent.capabilities.liveStream, true);
  assert.equal(codexAgent.capabilities.reportsCost, false);
  assert.equal(codexAgent.capabilities.commitsOwnWork, false);
});
