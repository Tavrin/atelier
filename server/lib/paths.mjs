import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export function configDir() {
  if (process.env.ATELIER_CONFIG_DIR) return process.env.ATELIER_CONFIG_DIR;
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "atelier");
  }
  return join(homedir(), ".config", "atelier");
}

export function stateDir() {
  if (process.env.ATELIER_STATE_DIR) return process.env.ATELIER_STATE_DIR;
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "atelier",
    );
  }
  return join(homedir(), ".local", "state", "atelier");
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
