export const REAL_PROVIDER_DISABLED_CODE = "EATELIERREALPROVIDERDISABLED";

function disabledError(id) {
  const error = new Error(
    `${REAL_PROVIDER_DISABLED_CODE}: real provider ${id} is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1`,
  );
  error.code = REAL_PROVIDER_DISABLED_CODE;
  error.status = 409;
  return error;
}

export function poisonAgent(id) {
  const refuse = () => {
    throw disabledError(id);
  };
  return Object.freeze({
    id,
    displayName: `${id} (disabled in tests)`,
    capabilities: Object.freeze({
      liveStream: false,
      liveInput: false,
      canResume: false,
      reportsCost: false,
      commitsOwnWork: false,
    }),
    options: () => ({ models: [], efforts: [] }),
    resolveModel: refuse,
    validate: refuse,
    preLaunchChecks: refuse,
    start: refuse,
    launch: refuse,
    resume: refuse,
    stop: async () => ({ finish: true }),
  });
}
