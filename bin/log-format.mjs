export function formatLogEvent(event) {
  return event?.gap === true
    ? "-- gap: events lost to rotation --"
    : JSON.stringify(event);
}
