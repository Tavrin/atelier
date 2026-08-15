import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLine,
  questionShapedText,
  questionTail,
  REDACT_TEXT_PATTERNS,
  redactText,
  redactValue,
  retrievedFinalOutput,
  unavailableFinalOutput,
  userMessageLine,
} from "./stream.mjs";

test("redactText masks supported credential shapes without mangling benign key substrings", () => {
  const cases = [
    ["sk-ABCDEFGHIJKLMNOP", "[redacted]"],
    ["ghp_abcdefghijklmnopqrst", "[redacted]"],
    ["github_pat_abcdefghijklmnopqrst_uv", "[redacted]"],
    ["AKIAABCDEFGHIJKL", "[redacted]"],
    ["xoxb-abcdefghij", "[redacted]"],
    [`eyJ${"A".repeat(20)}.${"B".repeat(10)}.${"C".repeat(10)}`, "[redacted]"],
    [
      '{"OPENAI_API_KEY": "sk-live-json-value"}',
      '{"OPENAI_API_KEY": "[redacted]"}',
    ],
    ["openai_api_key=supersecretvalue", "openai_api_key=[redacted]"],
    ["Bearer abcdefghijklmnop", "Bearer [redacted]"],
  ];
  assert.equal(REDACT_TEXT_PATTERNS.length, cases.length);
  for (const [input, expected] of cases) assert.equal(redactText(input), expected);
  assert.equal(redactText("monkey business stays visible"), "monkey business stays visible");
});

test("userMessageLine emits the Claude stream-json input envelope", () => {
  assert.equal(
    userMessageLine("steer now"),
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"steer now"}]}}\n',
  );
});

test("normalizeLine maps Claude NDJSON and redacts nested tool secrets", () => {
  assert.deepEqual(
    normalizeLine(JSON.stringify({
      type: "system",
      subtype: "init",
      model: "sonnet",
      session_id: "session-123",
    })),
    [{ type: "status", state: "running", model: "sonnet", sessionId: "session-123" }],
  );

  const events = normalizeLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Working" },
          {
            type: "tool_use",
            name: "Fetch",
            input: {
              url: "https://example.invalid",
              apiKey: "sensitive",
              awsCredential: "also-sensitive-creds",
              nested: {
                password: "also-sensitive",
                keep: "visible",
                note: "credential sk-ABCDEFGHIJKLMNOP",
              },
            },
          },
        ],
      },
    }),
  );
  assert.equal(events[0].kind, "text");
  assert.equal(events[1].kind, "tool_use");
  assert.match(events[1].inputPreview, /"apiKey":"\*\*\*"/);
  assert.match(events[1].inputPreview, /"awsCredential":"\*\*\*"/);
  assert.match(events[1].inputPreview, /"password":"\*\*\*"/);
  assert.doesNotMatch(events[1].inputPreview, /sensitive/);
  assert.doesNotMatch(events[1].inputPreview, /sk-ABCDEFGHIJKLMNOP/);
  assert.match(events[1].inputPreview, /\[redacted\]/);
  assert.match(events[1].inputPreview, /visible/);
});

test("normalizeLine maps tool results, usage and exits", () => {
  assert.deepEqual(
    normalizeLine(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "done" }] },
      }),
    ),
    [{ type: "message", kind: "tool_result", preview: "done" }],
  );

  assert.deepEqual(
    normalizeLine(
      JSON.stringify({
        type: "result",
        num_turns: 3,
        total_cost_usd: 1.25,
        usage: { input_tokens: 12, output_tokens: 34 },
        result: "Complete",
        is_error: false,
      }),
    ),
    [
      {
        type: "usage",
        turns: 3,
        costUSD: 1.25,
        inputTokens: 12,
        outputTokens: 34,
      },
      { type: "exit", success: true, summary: "Complete" },
    ],
  );
});

test("normalizeLine ignores unknown records and preserves malformed lines safely", () => {
  assert.deepEqual(normalizeLine('{"type":"future"}'), []);
  const raw = normalizeLine("not-json");
  assert.deepEqual(raw, [{ type: "message", kind: "raw", text: "not-json" }]);
});

test("questionShapedText judges how a message ENDED, not whether it contains a question", () => {
  assert.equal(questionShapedText("Want me to go with (1) or (2)?"), true);
  assert.equal(questionShapedText("Done.\n\nShould I also update the docs?\n\n"), true);
  assert.equal(questionShapedText('Which one?\r\n"Is it (a) or (b)?"'), true);
  assert.equal(questionShapedText("Ready. (Should I proceed?)"), true);
  // A question earlier in the message that the agent then answered itself is not
  // an unanswered question - the run did not stop to ask.
  assert.equal(
    questionShapedText("Should I use A or B? I picked A and implemented it."),
    false,
  );
  assert.equal(questionShapedText("Implemented and verified."), false);
  assert.equal(questionShapedText(""), false);
  assert.equal(questionShapedText("   \n \n "), false);
  assert.equal(questionShapedText(undefined), false);
});

test("questionShapedText reads the trailing block, so a question above its options counts", () => {
  // The most common real shape: ask, then list the choices.
  assert.equal(
    questionShapedText("Which approach do you prefer?\n1. Use the RTS kit\n2. Use the colony kit"),
    true,
  );
  // Full-width question mark - agents emit it and every carrier passes it through.
  assert.equal(questionShapedText("どちらにしますか？"), true);
  assert.equal(questionShapedText("Pick one？\n- a\n- b"), true);
  // The narrow phrase list: asking without a question mark.
  assert.equal(questionShapedText("I stopped here. Let me know how to proceed."), true);
  assert.equal(questionShapedText("Please confirm the migration before I continue."), true);
  assert.equal(questionShapedText("Blocked on which option you want."), true);
  // Six lines is the window, so a question above a realistic option list still
  // counts - three, four and five choices are all ordinary.
  assert.equal(
    questionShapedText("Which approach?\n1. a\n2. b\n3. c"),
    true,
  );
  assert.equal(
    questionShapedText("Which approach?\n1. a\n2. b\n3. c\n4. d\n5. e"),
    true,
  );
  // And it IS a window: a question the agent then answered itself, six lines of
  // work later, is out of range.
  assert.equal(
    questionShapedText(
      "Should I refactor it?\nI did.\nTests pass.\nLinted.\nCommitted.\nPushed.\nDone.",
    ),
    false,
  );
});

test("questionShapedText does not fire on mid-line question marks or incidental noise", () => {
  // A "?" inside prose is not a question the run stopped on.
  assert.equal(
    questionShapedText("Implemented the parser.\nNote: kept config? defaults untouched.\nAll tests pass."),
    false,
  );
  assert.equal(
    questionShapedText("Fixed the ?? operator handling in the tokenizer.\nDone."),
    false,
  );
  assert.equal(
    questionShapedText("Added a regex for /foo\\?bar/ and verified it.\nSuite green."),
    false,
  );
  // A completed summary that merely mentions options is not a question either.
  assert.equal(
    questionShapedText("Compared both approaches and implemented the simpler one.\nSuite green."),
    false,
  );
  assert.equal(
    questionShapedText("The user asked which option was faster; benchmarked and documented it."),
    false,
  );
  // Quoted speech is not this agent asking. The phrase belongs to the copy it
  // wrote, and the run finished.
  assert.equal(
    questionShapedText('Updated the copy to say "Please confirm your email."'),
    false,
  );
  assert.equal(
    questionShapedText('Added the string “Let me know if this helps.” to the template.\nSuite green.'),
    false,
  );
  assert.equal(
    questionShapedText('Renamed the button from "Which option?" to "Choose".\nDone.'),
    false,
  );
  // But a line that ENDS in a question mark is asking, whatever it quoted on the
  // way there - the quote filter must not become an escape hatch.
  assert.equal(
    questionShapedText('The spec says "pick one" - which one do you want?'),
    true,
  );
});

test("questionTail prefers the line that actually asked over the last option under it", () => {
  assert.equal(
    questionTail("Which approach do you prefer?\n1. RTS kit\n2. Colony kit"),
    "Which approach do you prefer?",
  );
  assert.equal(questionTail("Blocked.\nLet me know how to proceed."), "Let me know how to proceed.");
  // Symmetric with the ?-line preference: a phrase-asking line above its options
  // is the question, not the trailing option.
  assert.equal(
    questionTail("Let me know which kit to use.\n- rts\n- colony"),
    "Let me know which kit to use.",
  );
  // A quoted phrase is not the question, so the tail falls back to the last line.
  assert.equal(
    questionTail('Shipped the banner "Please confirm your email."\nSuite green.'),
    "Suite green.",
  );
});

test("questionTail returns the bounded trailing line", () => {
  assert.equal(questionTail("first line\n  Which option?  "), "Which option?");
  const long = `${"x".repeat(500)}?`;
  const tail = questionTail(long, 50);
  assert.equal(tail.length, 50);
  assert.equal(tail.startsWith("…"), true);
  assert.equal(tail.endsWith("?"), true);
  assert.equal(questionTail(""), "");
});

test("final-output retrieval has exactly two shapes: retrieved, or an explicit failure", () => {
  const retrieved = retrievedFinalOutput("all done");
  assert.deepEqual(retrieved, { retrieved: true, tail: "all done", detail: null });

  // The tail is kept, never the head: a trailing question on a long message is
  // the whole signal classification reads.
  const long = `${"y".repeat(3_000)}\nWhich option?`;
  const bounded = retrievedFinalOutput(long);
  assert.equal(bounded.retrieved, true);
  assert.equal(bounded.tail.length, 2_000);
  assert.equal(questionShapedText(bounded.tail), true);

  // Absent, blank, and non-string payloads are retrieval FAILURES, not empty
  // answers - there is deliberately no third "best-effort" shape to fall back to.
  for (const absent of [undefined, null, "", "   \n", 42, {}]) {
    const value = retrievedFinalOutput(absent, "nothing came back");
    assert.equal(value.retrieved, false);
    assert.equal(value.tail, "");
    assert.equal(value.detail, "nothing came back");
  }
  assert.deepEqual(unavailableFinalOutput("companion result unreadable"), {
    retrieved: false,
    tail: "",
    detail: "companion result unreadable",
  });
  assert.equal(unavailableFinalOutput("").detail.length > 0, true);
});

test("redaction covers segment-anchored assignments and JSON keys case-insensitively", () => {
  assert.equal(
    redactText("ANTHROPIC_API_KEY=sk-live-abcdefghijklmnopqrstu"),
    "ANTHROPIC_API_KEY=[redacted]",
  );
  assert.equal(redactText("GH_TOKEN: ghp-not-a-real-token-value"), "GH_TOKEN: [redacted]");
  assert.equal(
    redactText("AWS_SECRET_ACCESS_KEY = abcdefghijklmnop"),
    "AWS_SECRET_ACCESS_KEY = [redacted]",
  );
  assert.equal(redactText("openai_api_key=lowercase-value"), "openai_api_key=[redacted]");
  assert.equal(redactText("api-key: hyphen-value"), "api-key: [redacted]");
  assert.equal(
    redactText('embedded {"access_token": "json-secret-value"} here'),
    'embedded {"access_token": "[redacted]"} here',
  );
});

test("PROMPT-FIDELITY: legitimate key/token prose and assignments survive verbatim", () => {
  const prompt = [
    "MONKEY=bananas123",
    "keyboard: qwerty",
    "DEBUG_MODE=1",
    "Use mode=token when the parser key appears after the assignment.",
    "The key point = preserve this prose; the token position is descriptive.",
  ].join("\n");
  assert.equal(redactText(prompt), prompt);
  assert.equal(redactValue({ prompt }).prompt, prompt, "structured prompt redaction keeps the same negatives");
});

test("structured redaction blanks secret-shaped keys and redacts string leaves", () => {
  assert.deepEqual(
    redactValue({
      env: { ANTHROPIC_API_KEY: "sk-abcdefghijklmnopqrstuvwx", SAFE: "visible" },
      notes: ["bearer token is Bearer abcdefghijklmnop"],
    }),
    {
      env: { ANTHROPIC_API_KEY: "***", SAFE: "visible" },
      notes: ["bearer token is Bearer [redacted]"],
    },
  );
});
