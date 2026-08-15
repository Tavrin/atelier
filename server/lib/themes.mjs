import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isThemeId } from "../../ui/actor.mjs";

export const THEME_CONTRACT_VERSION = "0.4.0";

const SEMVER = new RegExp(
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)" +
  "(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?" +
  "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$",
);
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function fail(bundle, message) {
  throw new Error(`Invalid theme bundle ${bundle}: ${message}`);
}

function relativeEntry(bundle, entry) {
  if (typeof entry !== "string" || !entry.trim() || isAbsolute(entry)) {
    fail(bundle, "entry must be a relative module path");
  }
  const target = resolve(bundle, entry);
  const segment = relative(bundle, target);
  if (!segment || segment.startsWith("..") || isAbsolute(segment)) {
    fail(bundle, "entry must stay inside its theme directory");
  }
  let details;
  let cursor = bundle;
  for (const part of segment.split(sep)) {
    cursor = join(cursor, part);
    try {
      details = lstatSync(cursor);
    } catch {
      fail(bundle, `entry does not exist: ${entry}`);
    }
    if (details.isSymbolicLink()) {
      fail(bundle, "entry must not use symbolic links");
    }
  }
  if (!details.isFile() || ![".js", ".mjs"].includes(extname(target).toLowerCase())) {
    fail(bundle, "entry must name a JavaScript module file");
  }
  return segment;
}

function entryUrl(id, entry) {
  const path = entry.split(/[\\/]+/).map(encodeURIComponent).join("/");
  return `/themes/${id}/${path}`;
}

function validateManifest(bundle, directoryId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(bundle, "manifest.json must contain an object");
  }
  const expected = ["id", "name", "version", "contractVersion", "tier", "adapter", "entry"];
  const missing = expected.filter((field) => typeof value[field] !== "string" || !value[field]);
  if (missing.length > 0) fail(bundle, `missing string fields: ${missing.join(", ")}`);
  if (!isThemeId(value.id) || value.id !== directoryId) {
    fail(bundle, "id must match the directory name and use lowercase letters, digits, or dashes");
  }
  const version = SEMVER.exec(value.version);
  if (!version) fail(bundle, "version must be semantic");
  const contractVersion = SEMVER.exec(value.contractVersion);
  if (!contractVersion) fail(bundle, "contractVersion must be semantic");
  const hostContractVersion = SEMVER.exec(THEME_CONTRACT_VERSION);
  const compatible = hostContractVersion[1] === "0"
    ? contractVersion[1] === hostContractVersion[1] &&
      contractVersion[2] === hostContractVersion[2]
    : contractVersion[1] === hostContractVersion[1];
  if (!compatible) {
    fail(bundle, `contractVersion ${value.contractVersion} is incompatible with ${THEME_CONTRACT_VERSION}`);
  }
  if (value.tier !== "render+actions") fail(bundle, 'tier must be "render+actions"');
  if (!["webgl", "webgpu"].includes(value.adapter)) {
    fail(bundle, 'adapter must be "webgl" or "webgpu"');
  }
  const entry = relativeEntry(bundle, value.entry);
  return Object.freeze({
    id: value.id,
    name: value.name,
    version: value.version,
    contractVersion: value.contractVersion,
    tier: value.tier,
    adapter: value.adapter,
    entry: entry.split(sep).join("/"),
    entryUrl: entryUrl(value.id, entry),
  });
}

function snapshotFiles(directory, id, assets, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filePath = join(directory, entry.name);
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      snapshotFiles(filePath, id, assets, relativePath);
      continue;
    }
    if (!entry.isFile()) continue;
    const route = entryUrl(id, relativePath);
    assets.set(route, {
      body: readFileSync(filePath),
      contentType: CONTENT_TYPES.get(extname(entry.name).toLowerCase()) ??
        "application/octet-stream",
    });
  }
}

export function snapshotThemeBundles(themesDir) {
  const themes = [];
  const assets = new Map();
  let entries;
  try {
    entries = readdirSync(themesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { themes: Object.freeze([]), assets };
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const bundle = join(themesDir, entry.name);
    const manifestPath = join(bundle, "manifest.json");
    let raw;
    try {
      if (lstatSync(manifestPath).isSymbolicLink()) {
        fail(bundle, "manifest.json must not be a symbolic link");
      }
      raw = readFileSync(manifestPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(bundle, `manifest.json is not valid JSON: ${error.message}`);
    }
    themes.push(validateManifest(bundle, entry.name, parsed));
    snapshotFiles(bundle, entry.name, assets);
  }

  return { themes: Object.freeze(themes), assets };
}
