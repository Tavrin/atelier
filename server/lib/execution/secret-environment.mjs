export const SECRET_ENV_KEY_FRAGMENTS = Object.freeze([
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
]);

export const SECRET_ENV_EXACT_KEYS = Object.freeze([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
]);

const EXACT_KEYS = new Set(SECRET_ENV_EXACT_KEYS);

export function isSecretEnvKey(key) {
  const normalized = String(key).toUpperCase();
  return EXACT_KEYS.has(normalized) ||
    SECRET_ENV_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

// Compatibility for the existing call sites that intentionally consume a
// RegExp-like classifier. The implementation remains the single table above.
export const SECRET_ENV_KEY = Object.freeze({ test: isSecretEnvKey });
