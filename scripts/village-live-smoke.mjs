#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertVillageChronicle(
  payload,
  { minimumCount = 40, minimumDiffCoverage = 0.9 } = {},
) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const measured = records.filter((record) => record?.diff != null).length;
  const coverage = records.length > 0 ? measured / records.length : 0;
  assert.ok(
    records.length > minimumCount,
    `expected more than ${minimumCount} chronicle records, received ${records.length}`,
  );
  assert.ok(
    coverage > minimumDiffCoverage,
    `expected diff coverage above ${(minimumDiffCoverage * 100).toFixed(0)}%, received ${(coverage * 100).toFixed(1)}% (${measured}/${records.length})`,
  );
  return { records: records.length, measured, coverage };
}

export function assertVillageArtifacts(
  payload,
  { project, minimumCount = 1 } = {},
) {
  assert.equal(typeof payload?.project, "string", "artifact projection has no project");
  if (project) assert.equal(payload.project, project, "artifact projection project drifted");
  assert.ok(
    Number.isFinite(Date.parse(payload?.generatedAt)),
    "artifact projection generatedAt is not an ISO timestamp",
  );
  assert.ok(Array.isArray(payload?.artifacts), "artifact projection has no artifacts array");
  assert.ok(
    payload.artifacts.length >= minimumCount,
    `expected at least ${minimumCount} artifact, received ${payload.artifacts.length}`,
  );
  for (const artifact of payload.artifacts) {
    assert.ok(
      artifact?.kind === "spec" || artifact?.kind === "design",
      `invalid artifact kind: ${artifact?.kind}`,
    );
    assert.ok(
      typeof artifact?.title === "string" && artifact.title.trim().length > 0,
      `artifact has no title: ${artifact?.path}`,
    );
    assert.match(
      artifact?.path ?? "",
      /^docs\/(specs|design)\/.+\.md$/i,
      `artifact escaped fixed docs roots: ${artifact?.path}`,
    );
    assert.equal(artifact.path.includes(".."), false, `artifact path traverses: ${artifact.path}`);
    assert.equal(artifact.path.includes("\\"), false, `artifact path is not portable: ${artifact.path}`);
    assert.equal(
      artifact.kind,
      artifact.path.startsWith("docs/specs/") ? "spec" : "design",
      `artifact kind disagrees with path: ${artifact.path}`,
    );
    assert.ok(
      Number.isFinite(Date.parse(artifact.updatedAt)),
      `artifact updatedAt is invalid: ${artifact.path}`,
    );
  }
  return {
    artifacts: payload.artifacts.length,
    specs: payload.artifacts.filter(({ kind }) => kind === "spec").length,
    designs: payload.artifacts.filter(({ kind }) => kind === "design").length,
  };
}

function fetchJson(endpoint) {
  const raw = execFileSync(
    "curl",
    ["--request", "GET", "--fail", "--silent", "--show-error", endpoint],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

export function fetchVillageChronicle(
  baseUrl = "http://127.0.0.1:5170",
  project = "atelier",
) {
  const endpoint =
    `${String(baseUrl).replace(/\/$/, "")}/api/projects/${encodeURIComponent(project)}/chronicle`;
  return { endpoint, payload: fetchJson(endpoint) };
}

export function fetchVillageArtifacts(
  baseUrl = "http://127.0.0.1:5170",
  project = "atelier",
) {
  const endpoint =
    `${String(baseUrl).replace(/\/$/, "")}/api/projects/${encodeURIComponent(project)}/artifacts`;
  return { endpoint, payload: fetchJson(endpoint) };
}

function main() {
  const baseUrl = process.argv[2] ?? "http://127.0.0.1:5170";
  const project = process.argv[3] ?? "atelier";
  const chronicle = fetchVillageChronicle(baseUrl, project);
  const artifacts = fetchVillageArtifacts(baseUrl, project);
  const chronicleResult = assertVillageChronicle(chronicle.payload);
  const artifactResult = assertVillageArtifacts(artifacts.payload, { project });
  process.stdout.write(
    `village live smoke passed: ${chronicle.endpoint} returned ${chronicleResult.records} records; ` +
      `${chronicleResult.measured} measured diffs (${(chronicleResult.coverage * 100).toFixed(1)}%); ` +
      `${artifacts.endpoint} returned ${artifactResult.artifacts} artifacts ` +
      `(${artifactResult.specs} specs, ${artifactResult.designs} designs)\n`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
