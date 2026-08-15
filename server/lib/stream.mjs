const SECRET_KEY = /key|token|secret|password|credential/i;
const PREVIEW_LIMIT = 400;
// How much of an agent's last message classification keeps. Detection only ever
// reads the TAIL (a trailing question), so a bounded tail is the whole signal -
// and unlike normalizeLine's head-first summary slice it cannot lose the very
// characters the classifier exists to read.
const FINAL_MESSAGE_TAIL_LIMIT = 2_000;

// Add newly observed credential shapes here so every text surface shares one list.
export const REDACT_TEXT_PATTERNS = [
  { pattern: /sk-[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: "[redacted]" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted]" },
  { pattern: /AKIA[A-Z0-9]{12,}/g, replacement: "[redacted]" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted]" },
  {
    pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g,
    replacement: "[redacted]",
  },
  {
    // JSON keys use the same terminal underscore/hyphen segment rule as plain
    // assignments, but preserve valid JSON string quoting around the value.
    pattern:
      /(^|[^A-Za-z0-9])("(?:[A-Za-z0-9]+[_-])*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)"\s*:\s*)"(?:\\.|[^"\\])*"/gim,
    replacement: '$1$2"[redacted]"',
  },
  // Assignment-shaped names (OPENAI_API_KEY=..., api-key: ...). The secret
  // word must be the final, complete underscore/hyphen-delimited segment. That
  // keeps MONKEY, keyboard and DEBUG_MODE intact while covering lowercase text.
  {
    pattern:
      /(^|[^A-Za-z0-9"'])((?:[A-Za-z0-9]+[_-])*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))(\s*[=:]\s*)\S+/gim,
    replacement: "$1$2$3[redacted]",
  },
  { pattern: /(Bearer\s+)\S{12,}/gi, replacement: "$1[redacted]" },
];

export function redactText(text) {
  let redacted = String(text ?? "");
  for (const { pattern, replacement } of REDACT_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// The classification-grade view of an agent's final message (atelier-8r6).
//
// Lane adapters build one of these two shapes and NOTHING else: a retrieved
// final message, or an explicit retrieval failure. There is deliberately no
// third "best-effort" shape, because that is exactly the bug this replaces - a
// failed result fetch that silently degraded to a shorter, different source let
// a run ending in a question be classified as a clean success. `retrieved:
// false` is a hard signal the dispatcher must treat conservatively; it must
// never be papered over with a weaker source.
export function retrievedFinalOutput(text, absentDetail) {
  if (typeof text !== "string" || !text.trim()) {
    return unavailableFinalOutput(
      absentDetail || "the agent reported no final message",
    );
  }
  return { retrieved: true, tail: text.slice(-FINAL_MESSAGE_TAIL_LIMIT), detail: null };
}

export function unavailableFinalOutput(detail) {
  return { retrieved: false, tail: "", detail: String(detail || "the agent's final message could not be retrieved") };
}

// The trailing BLOCK, not just the final line: agents routinely ask and then list
// the options ("Which approach? / 1. … / 2. …"), so a last-line-only test misses
// the most common real shape. Six lines is the deliberate limit - wide enough for a
// question plus a realistic option list (three to five choices), narrow enough that
// a question the agent answered earlier in the same message stays out of range.
const QUESTION_BLOCK_LINES = 6;
// End-of-LINE only, so a "?" in the middle of prose ("kept config? defaults",
// "Should I use A or B? I picked A.") is not a question the run stopped on.
// Full-width ？ counts: agents emit it, and git/ntfy carry it unchanged.
const QUESTION_LINE = /[?？]["'”’)\]]*\s*$/;
// A narrow, closed list of hand-off phrases that ask without a question mark.
// Additions belong here only with a matching false-positive test.
//
// The imperative forms are safe unanchored - prose rarely commands the reader. A
// bare "which option/approach/one" is NOT: it appears in ordinary narration ("the
// user asked which option was faster; I benchmarked it"), so it counts only when it
// opens a sentence or is followed by a second-person cue in the same sentence.
const QUESTION_PHRASES = [
  /\b(?:let me know|please (?:choose|confirm|clarify|specify))\b/i,
  /(?:^|[.;:!?]\s+)which (?:option|approach|one)\b/im,
  /\bwhich (?:option|approach|one)\b[^.\n]*\b(?:do you|would you|you want|you prefer|should i)\b/i,
];

function trailingBlock(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-QUESTION_BLOCK_LINES);
}

// Quoted spans are QUOTED SPEECH, not this agent asking: a run that reports
// `Updated the copy to say "Please confirm your email."` did not stop for an
// answer. Blanking them before the phrase test is what keeps that a completion.
// Double quotes only (straight and curly) - apostrophes are contractions far more
// often than quotes. The ?-line test is deliberately NOT filtered this way: a line
// that ENDS in a question mark is asking whatever it quotes along the way.
function withoutQuotedSpans(line) {
  return line.replace(/"[^"\n]*"/g, " ").replace(/“[^”\n]*”/g, " ");
}

function phraseAsks(line) {
  const unquoted = withoutQuotedSpans(line);
  return QUESTION_PHRASES.some((phrase) => phrase.test(unquoted));
}

// The observable shape of "the agent stopped to ask". Deliberately syntactic: it
// judges only how the run ENDED, never what it was about.
export function questionShapedText(value) {
  const block = trailingBlock(value);
  if (block.length === 0) return false;
  return block.some((line) => QUESTION_LINE.test(line) || phraseAsks(line));
}

// The trailing question itself, for the record/notification/UI. Prefers the line
// that actually asked - by mark, then by phrase - over the literal last line, so
// the operator is shown the question rather than the last option under it.
// Bounded; redacted by the caller's usual outbound path.
export function questionTail(value, limit = PREVIEW_LIMIT) {
  const block = trailingBlock(value);
  const reversed = [...block].reverse();
  const asked = reversed.find((line) => QUESTION_LINE.test(line)) ??
    reversed.find((line) => phraseAsks(line));
  const text = asked ?? block.at(-1) ?? "";
  return text.length <= limit ? text : `…${text.slice(-(limit - 1))}`;
}

export function userMessageLine(text) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  })}\n`;
}

/**
 * Redact a structured value: secret-shaped KEYS are blanked wholesale, string
 * leaves run through {@link redactText}'s credential shapes.
 *
 * Exported because the event log persists structured payloads (settings diffs,
 * dispatch env, prompts) and must redact them with THIS pattern list rather than
 * a second copy that drifts (atelier-e5x).
 *
 * @param {*} value value to redact
 * @param {string} [key] the key this value was found under
 * @returns {*} redacted copy
 */
export function redactValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "***";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

function preview(value, limit = PREVIEW_LIMIT) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, limit);
}

function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (Array.isArray(message?.message?.content)) return message.message.content;
  return [];
}

export function normalizeLine(jsonLine) {
  let value;
  try {
    value = JSON.parse(jsonLine);
  } catch {
    return [{ type: "message", kind: "raw", text: preview(jsonLine) }];
  }

  if (value?.type === "system" && value?.subtype === "init") {
    return [{
      type: "status",
      state: "running",
      model: value.model,
      sessionId: typeof value.session_id === "string" ? value.session_id : null,
    }];
  }

  if (value?.type === "assistant") {
    const events = [];
    for (const block of contentBlocks(value)) {
      if (block?.type === "text") {
        events.push({ type: "message", kind: "text", text: String(block.text ?? "") });
      } else if (block?.type === "tool_use") {
        events.push({
          type: "message",
          kind: "tool_use",
          name: String(block.name ?? ""),
          inputPreview: preview(redactValue(block.input)),
        });
      }
    }
    return events;
  }

  if (value?.type === "user") {
    return contentBlocks(value)
      .filter((block) => block?.type === "tool_result")
      .map((block) => ({
        type: "message",
        kind: "tool_result",
        preview: preview(block.content),
      }));
  }

  if (value?.type === "result") {
    const inputTokens =
      value.input_tokens ?? value.usage?.input_tokens ?? value.usage?.inputTokens;
    const outputTokens =
      value.output_tokens ?? value.usage?.output_tokens ?? value.usage?.outputTokens;
    const success = value.is_error !== true && value.subtype !== "error";
    return [
      {
        type: "usage",
        turns: Number(value.num_turns ?? 0),
        costUSD: Number(value.total_cost_usd ?? 0),
        inputTokens: Number(inputTokens ?? 0),
        outputTokens: Number(outputTokens ?? 0),
      },
      {
        type: "exit",
        success,
        summary: String(value.result ?? "").slice(0, 2_000),
      },
    ];
  }

  return [];
}
