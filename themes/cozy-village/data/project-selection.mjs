export const LAST_PROJECT_KEY = "cozy-village:last-project";

function projectNamed(projects, name) {
  if (!name) return null;
  return projects.find((project) => project?.name === name) ?? null;
}

export function storedProject(storage, key = LAST_PROJECT_KEY) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

export function rememberProject(storage, name, key = LAST_PROJECT_KEY) {
  try {
    storage?.setItem?.(key, name);
  } catch {
    // A disabled or full localStorage must not stop the live village loading.
  }
}

/**
 * The adjudicated project order: URL, remembered choice, richest chronicle.
 * Ties preserve registry order, making the fallback stable across reloads.
 */
export function selectVillageProject({
  projects = [],
  chronicles = new Map(),
  search = "",
  storage,
  contextProject,
} = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const queryName = new URLSearchParams(search).get("project") ?? contextProject ?? null;
  const query = projectNamed(list, queryName);
  if (query) return { project: query, reason: "query" };

  const remembered = projectNamed(list, storedProject(storage));
  if (remembered) return { project: remembered, reason: "remembered" };

  let richest = list[0] ?? null;
  let richestCount = -1;
  for (const project of list) {
    const chronicle = chronicles.get(project.name);
    const count = Array.isArray(chronicle?.records) ? chronicle.records.length : 0;
    if (count > richestCount) {
      richest = project;
      richestCount = count;
    }
  }
  return { project: richest, reason: "richest" };
}
