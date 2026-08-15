/**
 * COZY VILLAGE — accessible chrome for the seven-station world.
 *
 * Every contract string enters through textContent. The 2D surfaces mirror
 * the same station, parcel, warning, and archive facts shown in 3D.
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
};

export function formatUSD(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value)
    : "unreported";
}

function formatDate(value) {
  const date = new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function line(list, label, value) {
  const row = el("div", "cv-card-line");
  row.append(el("dt", null, label), el("dd", null, value ?? "—"));
  list.appendChild(row);
}

function button(label, onClick, { primary = false, className = "" } = {}) {
  const node = el("button", `cv-btn ${className}`.trim(), label);
  if (primary) node.dataset.primary = "true";
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function gateStrip(strip) {
  const wrap = el("div", "cv-gate-strip");
  const track = el("div", "cv-strip");
  for (const slot of strip?.slots ?? []) {
    const gate = el("span", "cv-gate");
    gate.dataset.state = slot.state;
    gate.dataset.detail = slot.detail ?? "";
    gate.title = `${slot.gate}: ${slot.state}${slot.says ? ` — ${slot.says}` : ""}`;
    track.appendChild(gate);
  }
  wrap.appendChild(track);
  const names = el("div", "cv-strip-legend");
  for (const name of ["changes", "verify", "review", "merge", "main"]) {
    names.appendChild(el("span", null, name));
  }
  wrap.appendChild(names);
  return wrap;
}

function stationSummary(station) {
  if (station.id === "notice") {
    if (station.data.warning) return `${station.data.papers.length} ready · warning ribbon`;
    return `${station.data.papers.length} ready ticket${station.data.papers.length === 1 ? "" : "s"}`;
  }
  if (station.id === "workshop") {
    const retained = station.data.parcels.filter((parcel) => parcel.retained).length;
    return `${station.data.parcels.length} on benches${retained ? ` · ${retained} retained` : ""}`;
  }
  if (station.id === "assay") {
    return `${station.data.verify.length} verify · ${station.data.review.length} review`;
  }
  if (station.id === "cottage") return `${station.data.visitors.length} at the porch`;
  if (station.id === "hall") {
    return `${station.data.mergeQueue.length} awaiting merge · main ${station.data.dock.state}`;
  }
  if (station.id === "granary") {
    return `${station.data.records.length} archived · ${station.data.vestibule.length} awaiting archive`;
  }
  return `${station.data.counts.specs} specs · ${station.data.counts.designs} designs`;
}

function parcelName(parcel) {
  return parcel.title ?? parcel.ticketId ?? parcel.id;
}

export function buildCard(entity) {
  const card = el("div");
  if (!entity) return card;
  const data = entity.data ?? entity;
  if (entity.kind === "station") {
    card.append(
      el("div", "cv-card-name", `${data.icon} ${data.name}`),
      el("div", "cv-card-sub", data.sign),
      el("p", "cv-card-copy", stationSummary(data)),
      el("p", "cv-card-hint", "Click to open this station."),
    );
    return card;
  }
  if (entity.kind === "paper") {
    card.append(
      el("div", "cv-card-name", data.ticketId ?? data.id),
      el("div", "cv-card-sub", "Ready on the real notice-board projection"),
      el("p", "cv-card-copy", data.title),
    );
    return card;
  }
  if (entity.kind === "dock") {
    card.append(
      el("div", "cv-card-name", "Test dock"),
      el("div", "cv-card-sub", `Main ${data.state ?? "unknown"}`),
      el("p", "cv-card-copy", `${data.failures?.length ?? 0} unresolved · ${data.running?.length ?? 0} running`),
    );
    return card;
  }
  if (entity.kind === "parcel" || entity.kind === "dock-parcel" || entity.kind === "vestibule-parcel") {
    card.append(
      el("div", "cv-card-name", parcelName(data)),
      el(
        "div",
        "cv-card-sub",
        data.label ??
          (data.stationId ? `${data.villager?.name ?? "Agent"} · ${data.stationId}` : data.state),
      ),
    );
    if (data.kind === "parcel") card.appendChild(gateStrip(data.strip));
    if (data.marked) card.appendChild(el("p", "cv-card-alert", "Marked parcel — retained until dismissed."));
    if (data.activity) card.appendChild(el("p", "cv-activity-label", data.activity.label));
    return card;
  }
  return card;
}

function stationRow(station, onSelect) {
  const row = button("", () => onSelect?.({ kind: "station", data: station }), {
    className: "cv-station-row",
  });
  row.setAttribute("aria-label", `Open ${station.name}`);
  const head = el("span", "cv-station-row-head");
  head.append(
    el("span", "cv-station-icon", station.icon),
    el("b", null, station.name),
  );
  row.append(head, el("span", "cv-station-status", stationSummary(station)));
  return row;
}

export function buildStationList(village, { onSelect } = {}) {
  const list = el("div", "cv-station-list");
  for (const station of village.stations) list.appendChild(stationRow(station, onSelect));
  return list;
}

function parcelRow(parcel, onSelect) {
  const row = button("", () => onSelect?.({ kind: "parcel", data: parcel }), {
    className: "cv-row",
  });
  row.dataset.marked = String(Boolean(parcel.marked));
  const layout = el("span", "cv-row-layout");
  const head = el("span", "cv-row-head");
  head.append(
    el("span", "cv-row-name", parcel.ticketId ?? parcel.id),
    el("span", "cv-row-age", parcel.stationId),
  );
  layout.append(
    head,
    el("span", "cv-row-what", parcelName(parcel)),
    el(
      "span",
      "cv-row-ticket",
      `${parcel.villager?.name ?? "Agent"} · ${parcel.state}${parcel.retained ? " · retained" : ""}`,
    ),
    gateStrip(parcel.strip),
  );
  row.appendChild(layout);
  return row;
}

export function buildParcelList(village, { onSelect } = {}) {
  const list = el("div", "cv-parcel-list");
  for (const parcel of village.parcels) list.appendChild(parcelRow(parcel, onSelect));
  return list;
}

export function buildNoticeList(village, { onSelect } = {}) {
  const list = el("div", "cv-parcel-list");
  for (const paper of village.board.papers) {
    const row = button("", () => onSelect?.({ kind: "paper", data: paper }), {
      className: "cv-row cv-notice-row",
    });
    const layout = el("span", "cv-row-layout");
    const head = el("span", "cv-row-head");
    head.append(
      el("span", "cv-row-name", paper.ticketId),
      el(
        "span",
        "cv-row-priority",
        paper.priority == null ? "priority unknown" : `P${paper.priority}`,
      ),
    );
    layout.append(
      head,
      el("span", "cv-row-what", paper.title),
    );
    row.appendChild(layout);
    list.appendChild(row);
  }
  return list;
}

export function buildLedger(village) {
  const box = el("section", "cv-ledger");
  box.appendChild(el("p", "cv-eyebrow", "Village ledger"));
  const hero = el("div", "cv-hero-stat");
  hero.append(
    el("b", null, village.stats.merges ?? 0),
    el("span", null, "merges in the archive projection"),
  );
  box.appendChild(hero);
  for (const [label, value] of [
    ["Ready tickets", village.stats.ready],
    ["Parcels in flight", village.stats.inFlight],
    ["Retained failures", village.stats.retainedFailures],
    ["Awaiting archive", village.stats.awaitingArchive],
    ["R&D artifacts", village.stats.artifacts],
    ["Cost per merge", formatUSD(village.stats.costPerMergeUSD)],
  ]) {
    const row = el("div", "cv-stat-row");
    row.append(el("span", "cv-stat-label", label), el("b", "cv-stat-value", value));
    box.appendChild(row);
  }
  return box;
}

export function buildLegend() {
  const details = el("details", "cv-world-legend");
  details.open = true;
  const summary = el("summary", null, "Village key");
  details.appendChild(summary);
  const stations = el("div", "cv-world-legend-grid");
  for (const [icon, name] of [
    ["✉", "Notice · ready work"],
    ["⚒", "Workshop · build / retained return"],
    ["⚖", "Assay · verify / review"],
    ["☕", "Porch · human input"],
    ["♜", "Hall · merge / main checks"],
    ["▤", "Granary · archive"],
    ["⚗", "R&D · specs / designs"],
  ]) {
    const item = el("span");
    item.append(el("b", null, icon), document.createTextNode(` ${name}`));
    stations.appendChild(item);
  }
  const parcel = el("div", "cv-parcel-key");
  parcel.append(
    el("span", null, "▣ Parcel = dispatch"),
    el("span", null, "▧ Marked = failed/stopped, retained"),
    el("span", null, "→ Villager carrying = observed transition"),
  );
  details.append(stations, parcel);
  return details;
}

function section(title) {
  const block = el("section", "cv-section");
  block.appendChild(el("h4", null, title));
  return block;
}

function searchableList(items, {
  placeholder,
  render,
} = {}) {
  const wrap = el("div", "cv-search-list");
  const search = el("input", "cv-search");
  search.type = "search";
  search.placeholder = placeholder;
  search.setAttribute("aria-label", placeholder);
  const list = el("div", "cv-search-results");
  const paint = () => {
    const query = search.value.trim().toLocaleLowerCase();
    list.replaceChildren();
    const matches = items.filter((item) =>
      !query ||
      `${item.title ?? ""} ${item.ticketId ?? ""} ${item.path ?? ""}`
        .toLocaleLowerCase()
        .includes(query));
    if (!matches.length) list.appendChild(el("p", "cv-empty", "No matching records."));
    for (const item of matches) list.appendChild(render(item));
  };
  search.addEventListener("input", paint);
  wrap.append(search, list);
  paint();
  return wrap;
}

function archiveRecord(record) {
  const row = el("article", "cv-archive-row");
  row.append(
    el("b", null, record.ticketId ?? record.id ?? "merge"),
    el("span", null, record.title ?? "Untitled merged work"),
  );
  const facts = el("small");
  const diff = record.diff
    ? `${record.diff.files} files · +${record.diff.insertions} −${record.diff.deletions}`
    : "diff unmeasured";
  facts.textContent = `${diff} · ${formatUSD(record.costUSD)} · ${record.rounds ?? 0} review rounds`;
  row.appendChild(facts);
  const merged = record?.record?.merged ?? record?.merged;
  const forcedBy = merged?.forcedBy ?? record?.forcedBy;
  if (forcedBy) {
    row.appendChild(el(
      "small",
      "cv-card-alert",
      `Override by ${forcedBy}: ${merged?.reason ?? record.reason ?? "reason unavailable"} · ` +
        `${merged?.dispositionRef ?? record.dispositionRef ?? "reference unavailable"}`,
    ));
  }
  return row;
}

function artifactRecord(artifact) {
  const row = el("article", "cv-archive-row");
  row.append(
    el("b", null, artifact.kind === "spec" ? "SPEC" : "DESIGN"),
    el("span", null, artifact.title),
    el("small", null, `${artifact.path} · ${formatDate(artifact.updatedAt)}`),
  );
  return row;
}

function renderStationBody(station) {
  const body = el("div", "cv-panel-sections");
  const intro = section("Right now");
  intro.appendChild(el("p", "cv-panel-copy", stationSummary(station)));
  body.appendChild(intro);

  if (station.id === "notice") {
    if (station.data.warning) {
      const warning = section("Warning ribbon");
      for (const message of station.data.warnings) {
        warning.appendChild(el("p", "cv-card-alert", message));
      }
      body.appendChild(warning);
    }
    const papers = section("Ready papers");
    for (const paper of station.data.papers) papers.appendChild(archiveRecord(paper));
    if (!station.data.papers.length) papers.appendChild(el("p", "cv-empty", "No ready tickets."));
    body.appendChild(papers);
  }

  if (station.id === "workshop") {
    for (const hut of station.data.huts) {
      const block = section(`${hut.name} bench`);
      if (!hut.parcels.length) block.appendChild(el("p", "cv-empty", "Bench clear."));
      for (const parcel of hut.parcels) block.appendChild(archiveRecord(parcel));
      body.appendChild(block);
    }
  }

  if (station.id === "assay") {
    for (const [label, parcels] of [
      ["Verify bay", station.data.verify],
      ["Review bay", station.data.review],
    ]) {
      const bay = section(label);
      if (!parcels.length) bay.appendChild(el("p", "cv-empty", "Bay clear."));
      for (const parcel of parcels) bay.appendChild(archiveRecord(parcel));
      body.appendChild(bay);
    }
  }

  if (station.id === "cottage") {
    const visitors = section("At the porch");
    if (!station.data.visitors.length) visitors.appendChild(el("p", "cv-empty", "Nobody is waiting."));
    for (const parcel of station.data.visitors) {
      const item = el("article", "cv-archive-row");
      item.append(
        el("b", null, parcel.ticketId ?? parcel.id),
        el("span", null, parcelName(parcel)),
      );
      if (parcel.question) item.appendChild(el("blockquote", "cv-card-quote", parcel.question));
      if (parcel.plan) item.appendChild(el("blockquote", "cv-card-quote", parcel.plan));
      visitors.appendChild(item);
    }
    body.appendChild(visitors);
  }

  if (station.id === "hall") {
    const queue = section("Human merge queue");
    if (!station.data.mergeQueue.length) queue.appendChild(el("p", "cv-empty", "Nothing awaits merge."));
    for (const parcel of station.data.mergeQueue) queue.appendChild(archiveRecord(parcel));
    const overrides = section("Human override register");
    if (!station.data.overrides.length) {
      overrides.appendChild(el("p", "cv-empty", "No forced merges in the current archive window."));
    }
    for (const record of station.data.overrides) overrides.appendChild(archiveRecord(record));
    const dock = section("Main test dock");
    dock.appendChild(
      el(
        "p",
        "cv-panel-copy",
        `${station.data.dock.state} · ${station.data.dock.checksTotal} checks · ` +
          `${station.data.dock.failures.length} unresolved · ${station.data.dock.running.length} running`,
      ),
    );
    if (station.data.dock.failures.length) {
      dock.appendChild(
        el(
          "p",
          "cv-card-alert",
          "Acknowledgement quiets the bell; the marked parcel and scaffold remain.",
        ),
      );
    }
    body.append(queue, overrides, dock);
  }

  if (station.id === "granary") {
    const vestibule = section("Loading-dock vestibule");
    if (!station.data.vestibule.length) {
      vestibule.appendChild(el("p", "cv-empty", "No local merges await the next archive snapshot."));
    }
    for (const parcel of station.data.vestibule) {
      const item = archiveRecord(parcel);
      item.dataset.vestibule = "true";
      item.appendChild(el("strong", "cv-honesty-label", "AWAITING ARCHIVE"));
      vestibule.appendChild(item);
    }
    const archive = section("Wall of works");
    archive.appendChild(searchableList(station.data.records, {
      placeholder: "Search archived work",
      render: archiveRecord,
    }));
    const growth = section("Aggregate growth");
    growth.append(
      el("p", "cv-panel-copy", station.data.growth.plaque),
      el(
        "p",
        "cv-panel-copy",
        station.data.growth.next
          ? `Next exterior threshold: ${station.data.growth.next} merges.`
          : "All labelled exterior thresholds reached.",
      ),
    );
    body.append(vestibule, archive, growth);
  }

  if (station.id === "rnd") {
    const inventory = section("Artifact index");
    inventory.append(
      el(
        "p",
        "cv-panel-copy",
        `${station.data.counts.specs} specifications · ${station.data.counts.designs} designs · ` +
          `snapshot ${formatDate(station.data.generatedAt)}`,
      ),
      searchableList(station.data.artifacts, {
        placeholder: "Search specs and designs",
        render: artifactRecord,
      }),
    );
    body.appendChild(inventory);
  }
  return body;
}

function renderParcelBody(parcel) {
  const body = el("div", "cv-panel-sections");
  const facts = section("Dispatch");
  const list = el("dl");
  line(list, "Ticket", parcel.ticketId ?? parcel.id);
  line(list, "Station", parcel.stationId ?? parcel.state);
  line(list, "Agent", `${parcel.villager?.name ?? "unknown"} · ${parcel.record?.lane ?? "unknown"} / ${parcel.record?.model ?? "unknown"}`);
  line(list, "State", parcel.state);
  line(list, "Cost", formatUSD(parcel.costUSD));
  line(list, "Turns", parcel.turns ?? "unreported");
  line(list, "Verify attempts", parcel.attempts ?? 0);
  line(list, "Review rounds", parcel.rounds ?? 0);
  facts.append(list, gateStrip(parcel.strip));
  body.appendChild(facts);
  if (parcel.question || parcel.plan) {
    const human = section(parcel.question ? "Real question" : "Real plan");
    human.appendChild(el("blockquote", "cv-card-quote", parcel.question ?? parcel.plan));
    body.appendChild(human);
  }
  if (parcel.marked) {
    const retained = section("Marked parcel");
    retained.appendChild(
      el(
        "p",
        "cv-card-alert",
        parcel.returned
          ? "Inspection failed or became stale. This parcel returned to its workshop bench."
          : "This terminal parcel remains visible until it is dismissed.",
      ),
    );
    if (parcel.failure) {
      retained.appendChild(
        el(
          "pre",
          "cv-card-machine",
          `${parcel.failure.command ?? "command unavailable"}\nexit ${parcel.failure.exitCode ?? "unknown"}\n${parcel.failure.tail ?? ""}`,
        ),
      );
    }
    body.appendChild(retained);
  }
  if (parcel.activity) {
    const activity = section("Observed activity");
    activity.appendChild(
      el(
        "p",
        "cv-activity-label",
        `${parcel.activity.label} · settles after 3.2 seconds`,
      ),
    );
    body.appendChild(activity);
  }
  return body;
}

export function buildPanel({ onAction, dashboardHref } = {}) {
  const element = el("aside", "cv-panel");
  element.setAttribute("aria-label", "Village detail");
  element.dataset.open = "false";
  let current = null;
  let context = {};

  const close = () => {
    element.dataset.open = "false";
    current = null;
    element.replaceChildren();
  };

  const paint = () => {
    if (!current) return;
    const data = current.data ?? current;
    element.replaceChildren();
    const head = el("header", "cv-panel-head");
    const title = current.kind === "station"
      ? `${data.icon} ${data.name}`
      : parcelName(data);
    head.append(
      el("p", "cv-eyebrow", current.kind === "station" ? data.sign : "Dispatch parcel"),
      el("h3", null, title),
      button("Close", close, { className: "cv-panel-close" }),
    );
    const body = el("div", "cv-panel-body");
    if (context.error) body.appendChild(el("p", "cv-card-alert", context.error));
    body.appendChild(
      current.kind === "station"
        ? renderStationBody(data)
        : renderParcelBody(data),
    );
    const foot = el("footer", "cv-panel-foot");
    if (current.kind === "parcel") {
      if (data.stationId === "hall") {
        const merge = button("Merge parcel", () => onAction?.("merge", data), { primary: true });
        merge.disabled = Boolean(context.busy);
        foot.appendChild(merge);
      }
      if (data.stationId === "cottage") {
        const reply = button("Reply", () => onAction?.("reply", data), { primary: true });
        reply.disabled = Boolean(context.busy);
        foot.appendChild(reply);
      }
      if (data.marked || data.retained) {
        const dismiss = button("Dismiss retained parcel", () => onAction?.("dismiss", data));
        dismiss.disabled = Boolean(context.busy);
        foot.appendChild(dismiss);
      }
      const href = dashboardHref?.(data.dispatchId);
      if (href) {
        const dashboard = el("a", "cv-btn cv-btn-ghost", "Open in dashboard");
        dashboard.href = href;
        foot.appendChild(dashboard);
      }
    }
    if (current.kind === "station" && data.id === "hall") {
      const unresolved = data.data.dock.failures.find((failure) => !failure.acknowledged);
      if (unresolved?.dispatchId) {
        const acknowledge = button(
          "Quiet main-health bell",
          () => onAction?.("ack", unresolved),
        );
        acknowledge.disabled = Boolean(context.busy);
        foot.appendChild(acknowledge);
      }
    }
    element.append(head, body, foot);
  };

  return {
    element,
    get current() {
      return current;
    },
    open(entity, nextContext = {}) {
      current = entity;
      context = nextContext;
      element.dataset.open = "true";
      paint();
    },
    update(nextContext = {}) {
      context = { ...context, ...nextContext };
      paint();
    },
    close,
  };
}

export function buildTour() {
  const overlay = el("div", "cv-tour");
  overlay.dataset.open = "false";
  const card = el("div", "cv-tour-card");
  card.append(
    el("p", "cv-eyebrow", "How to read this place"),
    el("h3", null, "The village is Atelier's lifecycle."),
    el(
      "p",
      null,
      "Seven permanent stations hold real projections. Work is a parcel, not a building.",
    ),
  );
  const list = el("ul", "cv-tour-list");
  for (const [icon, title, copy] of [
    ["✉", "Ready work starts at the board.", "Only issues in the server's state.readyIssues projection are pinned."],
    ["⚒", "Agents work at permanent benches.", "Failed and stopped parcels stay marked on the bench until dismissed."],
    ["⚖", "Verify and review have separate bays.", "A failed or stale inspection returns the parcel to the workshop."],
    ["☕", "Only real questions and plans wait at the porch.", "A reply sends the parcel back to work."],
    ["♜", "The hall is the human merge gate.", "Accepted parcels cross to the attached main-check dock."],
    ["▤", "History lives inside one granary.", "This-boot merges wait honestly in the vestibule until a later boot archive contains them."],
    ["⚗", "R&D browses real specs and designs.", "Props grow only from the boot-snapshotted artifact count; no title heuristics."],
  ]) {
    const item = el("li");
    item.append(el("span", null, icon));
    const words = el("span");
    words.append(el("b", null, title), document.createTextNode(` ${copy}`));
    item.appendChild(words);
    list.appendChild(item);
  }
  card.appendChild(list);
  const controls = el("div", "cv-tour-actions");
  controls.appendChild(button("Close", () => {
    overlay.dataset.open = "false";
  }, { primary: true }));
  card.appendChild(controls);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.dataset.open = "false";
  });
  return {
    element: overlay,
    open() {
      overlay.dataset.open = "true";
    },
    close() {
      overlay.dataset.open = "false";
    },
  };
}
