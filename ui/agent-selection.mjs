function supportedAgent(configured, agentList) {
  return agentList.some((agent) => agent.id === configured)
    ? configured
    : agentList[0]?.id || "claude";
}

export function composerAgentId(project, agentList) {
  return supportedAgent(project.resolvedDefaultAgent ?? "claude", agentList);
}

export function settingsAgentId(project, agentList) {
  const configured =
    project.defaultAgent ??
    project.ownDispatchProfile?.lane ??
    project.resolvedDefaultAgent ??
    "claude";
  return supportedAgent(configured, agentList);
}

export function onboardingAgentId(inferred, agentList) {
  const configured = inferred.defaultAgent ?? inferred.dispatchProfile?.lane;
  if (!configured) return "";
  return agentList.some((agent) => agent.id === configured) ? configured : "";
}

export function withOnboardingDefaultAgent(project, selectedAgent) {
  const submitted = { ...project };
  delete submitted.defaultAgent;
  if (selectedAgent) submitted.defaultAgent = selectedAgent;
  return submitted;
}

export function dispatchLanePayload(laneTouched, lane) {
  return laneTouched ? { lane } : {};
}
