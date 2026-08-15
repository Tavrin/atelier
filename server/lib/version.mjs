import { readFileSync } from "node:fs";

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8"));
  return packageJson.version;
}

export function createBootStamp({ version, bootedAt } = {}) {
  return {
    version: version ?? readPackageVersion(),
    bootedAt: bootedAt ?? new Date().toISOString(),
  };
}
