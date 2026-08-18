export function trustProfileSummary(value) {
  if (typeof value?.sandboxPosture === "string" && value.sandboxPosture) {
    return value.sandboxPosture;
  }
  const sandbox = value?.executionProfile?.sandbox ?? value?.sandbox ?? value?.trustProfile ?? value;
  const confinement = sandbox?.confinement ?? "trusted-local";
  const credential = sandbox?.credential ?? "none";
  if (confinement === "trusted-local") {
    return `trusted-local · no isolation · credential ${credential}`;
  }
  if (confinement === "advisory") {
    return `advisory · non-enforcing · credential ${credential}`;
  }
  const backend = sandbox?.backendId ?? value?.sandboxBackend ?? "unknown backend";
  const allowlist = value?.sandboxBroker?.allowlist;
  const broker = Array.isArray(allowlist)
    ? ` · daemon API brokered [${allowlist.join(", ") || "deny all"}] · remote provider API unavailable`
    : "";
  return `${confinement} · isolated by ${backend} · credential ${credential}${broker}`;
}
