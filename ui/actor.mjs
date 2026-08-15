export const THEME_ID_PATTERN_SOURCE = "[a-z0-9][a-z0-9-]{0,39}";

const THEME_ID_PATTERN = new RegExp(`^${THEME_ID_PATTERN_SOURCE}$`);
const REQUEST_ACTOR_PATTERN = new RegExp(
  `^(?:[a-z][a-z0-9_-]{0,31}|theme:${THEME_ID_PATTERN_SOURCE})$`,
);

export function isThemeId(value) {
  return typeof value === "string" && THEME_ID_PATTERN.test(value);
}

// This validates only the bounded persisted shape. It does not authenticate
// the caller or prove that a theme id named in the header sent the request.
export function isRequestActor(value) {
  return typeof value === "string" && REQUEST_ACTOR_PATTERN.test(value);
}
