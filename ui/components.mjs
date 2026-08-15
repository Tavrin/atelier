// Primitives are app-state-free and textContent-only. Anything that reads state
// or formats records stays in app.js.

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label, className = "button") {
  const node = element("button", className, label);
  node.type = "button";
  return node;
}

export function badge(text, className = "") {
  return element("span", `badge${className ? ` ${className}` : ""}`, text);
}

export function stateChip(value) {
  const normalized = String(value || "unknown");
  return element("span", `state-chip state-${normalized}`, normalized.replaceAll("_", " "));
}

export function makeActivatable(node, onActivate) {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", onActivate);
  node.addEventListener("keydown", (event) => {
    if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onActivate(event);
  });
  return node;
}

export function boardColumn(kind, title, count) {
  const column = element("section", "column");
  column.dataset.kind = kind;
  const header = element("header", "column-header");
  const countNode = element("span", "count", String(count));
  header.append(element("h2", "column-title", title), countNode);
  const body = element("div", "card-list");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", `${title} tickets`);
  column.append(header, body);
  return { column, body, count: countNode };
}
