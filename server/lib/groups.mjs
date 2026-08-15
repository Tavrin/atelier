import { loadIssues } from "./tracker.mjs";

export function resolveGroup(registry, name) {
  const group = registry.groups.find((candidate) => candidate.name === name);
  if (!group) throw new Error(`Unknown group: ${name}`);

  const projects = new Map(registry.projects.map((project) => [project.name, project]));
  return group.projects.map((projectName) => {
    const project = projects.get(projectName);
    if (!project) throw new Error(`Group ${name} references unknown project ${projectName}`);
    return project;
  });
}

export async function dispatchGroup(dispatcher, group, opts) {
  if (!opts?.ticketId) throw new Error("Group dispatch requires ticketId");
  return Promise.all(
    group.map((project) => dispatcher.dispatch({ ...opts, project: project.name })),
  );
}

export async function unionIssues(projects) {
  const groups = await Promise.all(
    projects.map(async (project) => {
      if (project.tracker === "none") return [];
      const issues = await loadIssues(project);
      return issues.map((issue) => ({ ...issue, projectName: project.name }));
    }),
  );
  return groups.flat();
}
