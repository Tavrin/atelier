import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function parseJsonl(raw, source) {
  const records = new Map();
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let issue;
    try {
      issue = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source} line ${index + 1}: ${error.message}`);
    }
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
      throw new Error(`${source} line ${index + 1}: issue is not an object`);
    }
    if (typeof issue.id !== "string" || !issue.id) {
      throw new Error(`${source} line ${index + 1}: issue id is missing`);
    }
    if (records.has(issue.id)) {
      throw new Error(`${source} line ${index + 1}: duplicate issue id ${issue.id}`);
    }
    records.set(issue.id, { issue, line });
  }
  return records;
}

function newest(ours, theirs) {
  const oursTime = Date.parse(ours.issue.updated_at ?? "");
  const theirsTime = Date.parse(theirs.issue.updated_at ?? "");
  if (Number.isNaN(oursTime)) return Number.isNaN(theirsTime) ? ours : theirs;
  if (Number.isNaN(theirsTime)) return ours;
  return theirsTime > oursTime ? theirs : ours;
}

export function mergeJsonl(baseRaw, oursRaw, theirsRaw) {
  const base = parseJsonl(baseRaw, "base");
  const ours = parseJsonl(oursRaw, "ours");
  const theirs = parseJsonl(theirsRaw, "theirs");
  const ids = new Set([...ours.keys(), ...theirs.keys()]);
  const merged = [];

  for (const id of [...ids].sort()) {
    const oursRecord = ours.get(id);
    const theirsRecord = theirs.get(id);
    if (!oursRecord || !theirsRecord) {
      merged.push(oursRecord ?? theirsRecord);
      continue;
    }
    if (oursRecord.line === theirsRecord.line) {
      merged.push(oursRecord);
      continue;
    }
    const baseRecord = base.get(id);
    if (baseRecord) {
      const oursChanged = oursRecord.line !== baseRecord.line;
      const theirsChanged = theirsRecord.line !== baseRecord.line;
      if (oursChanged && !theirsChanged) {
        merged.push(oursRecord);
        continue;
      }
      if (!oursChanged && theirsChanged) {
        merged.push(theirsRecord);
        continue;
      }
    }
    merged.push(newest(oursRecord, theirsRecord));
  }

  return merged.length > 0 ? `${merged.map((record) => record.line).join("\n")}\n` : "";
}

function main() {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) {
    throw new Error("usage: beads-merge.mjs <base> <ours> <theirs>");
  }
  const merged = mergeJsonl(
    readFileSync(basePath, "utf8"),
    readFileSync(oursPath, "utf8"),
    readFileSync(theirsPath, "utf8"),
  );
  writeFileSync(oursPath, merged, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`beads merge failed: ${error.message}`);
    process.exitCode = 1;
  }
}
