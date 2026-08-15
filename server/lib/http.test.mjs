import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  HttpError,
  optionalString,
  parsePriority,
  readJsonBody,
  requiredString,
} from "./http.mjs";

function request(body, contentType = "application/json") {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = { "content-type": contentType };
  return stream;
}

test("readJsonBody rejects a non-JSON content type with 415", () => {
  assert.throws(
    () => readJsonBody(request("{}", "text/plain")),
    (error) => error instanceof HttpError && error.status === 415,
  );
});

test("readJsonBody rejects bodies over 256KB with 413", async () => {
  const oversized = "x".repeat(256 * 1024 + 1);
  await assert.rejects(
    readJsonBody(request(oversized)),
    (error) => error instanceof HttpError && error.status === 413,
  );
});

test("string guards trim values and reject leading dashes", () => {
  assert.equal(requiredString({ title: "  task  " }, "title"), "task");
  assert.equal(optionalString({ note: "  note  " }, "note"), "note");
  assert.equal(optionalString({}, "note"), undefined);
  assert.throws(() => requiredString({ title: "--help" }, "title"), /must not start/);
  assert.throws(() => optionalString({ note: " -fsecret" }, "note"), /must not start/);
});

test("parsePriority accepts only priorities zero through four", () => {
  assert.equal(parsePriority(undefined), undefined);
  assert.equal(parsePriority(" p0 "), "0");
  assert.equal(parsePriority(4), "4");
  for (const invalid of [-1, 5, "P9", "high"]) {
    assert.throws(() => parsePriority(invalid), /between 0 and 4/);
  }
});
