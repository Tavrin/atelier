/**
 * THE CAST — who a villager actually is.
 *
 * Atelier has NO persistent agent identity. Every dispatch is a fresh process,
 * so nothing recurs across dispatches except the pair you called on: there are
 * exactly two lanes (claude, codex) and five claude models. Six recurring
 * hands. A villager is a lane+model pair - the only agent identity Atelier has.
 *
 * Personality is not flavour text. Every trait below points at a capability
 * flag in server/lib/agents/{claude,codex}.mjs:
 *
 *   liveInput      claude true / codex false  → can you call through the window
 *   reportsCost    claude true / codex false  → do they keep a tab
 *   commitsOwnWork claude true / codex false  → do they put their tools away
 *
 * Villager paint is IDENTITY ONLY. The identity palette deliberately shares no
 * hue with any status signal - no grass green, no lamp gold, no tarp slate.
 * You can never mistake WHO for HOW IT IS GOING.
 *
 * This module is pure: no DOM, no three.js, no imports.
 */

export const VILLAGERS = {
  wren: {
    id: "wren",
    name: "Wren",
    trade: "joiner",
    lane: "claude",
    model: "opus",
    modelLabel: "Opus",
    paint: "#5A7796",
    paintDeep: "#3F5872",
    height: 1.0,
    build: "tall",
    note: "Slow, costly, exact. Keeps a written tab.",
    caps: { liveInput: true, reportsCost: true, commitsOwnWork: true },
  },
  marisol: {
    id: "marisol",
    name: "Marisol",
    trade: "joiner · long memory",
    lane: "claude",
    model: "opus[1m]",
    modelLabel: "Opus · 1M context",
    paint: "#8A5F7A",
    paintDeep: "#67425A",
    height: 1.02,
    build: "tall",
    note: "Remembers where every beam in the town came from.",
    caps: { liveInput: true, reportsCost: true, commitsOwnWork: true },
  },
  tobin: {
    id: "tobin",
    name: "Tobin",
    trade: "carpenter",
    lane: "claude",
    model: "sonnet",
    modelLabel: "Sonnet",
    paint: "#C2924A",
    paintDeep: "#966C31",
    height: 0.97,
    build: "square",
    note: "Built most of this town. Quick hands, ordinary jobs.",
    caps: { liveInput: true, reportsCost: true, commitsOwnWork: true },
  },
  juniper: {
    id: "juniper",
    name: "Juniper",
    trade: "carpenter · long memory",
    lane: "claude",
    model: "sonnet[1m]",
    modelLabel: "Sonnet · 1M context",
    paint: "#A8737F",
    paintDeep: "#7F5059",
    height: 0.95,
    build: "square",
    note: "Takes the big untidy jobs nobody wants to hold in their head.",
    caps: { liveInput: true, reportsCost: true, commitsOwnWork: true },
  },
  pell: {
    id: "pell",
    name: "Pell",
    trade: "errand-runner",
    lane: "claude",
    model: "haiku",
    modelLabel: "Haiku",
    paint: "#9A6446",
    paintDeep: "#734730",
    height: 0.86,
    build: "small",
    note: "Small jobs, fast, back before you notice they left.",
    caps: { liveInput: true, reportsCost: true, commitsOwnWork: true },
  },
  alder: {
    id: "alder",
    name: "Alder",
    trade: "mason, from over the hill",
    lane: "codex",
    model: "gpt-5.4-codex",
    modelLabel: "Codex",
    paint: "#414A6B",
    paintDeep: "#2B3149",
    height: 1.04,
    build: "tall",
    // All three clauses are boolean capability flags, not characterisation.
    note:
      "Works with the shutters closed. Never says what it cost. " +
      "Leaves the work loose on the bench for someone else to put away.",
    caps: { liveInput: false, reportsCost: false, commitsOwnWork: false },
  },
};

/** The capability facts, phrased as the card shows them. */
export const CAPABILITY_NOTES = {
  liveInput: {
    true: { field: "liveInput", says: "You can call through while they work." },
    false: { field: "liveInput", says: "Shutters closed — no live input to this lane." },
  },
  reportsCost: {
    true: { field: "reportsCost", says: "Keeps a tab you can read." },
    false: { field: "reportsCost", says: "Cost not reported by this lane." },
  },
  commitsOwnWork: {
    true: { field: "commitsOwnWork", says: "Puts the work away in a commit." },
    false: { field: "commitsOwnWork", says: "Leaves the work loose on the bench." },
  },
};

const BY_PAIR = new Map();
for (const v of Object.values(VILLAGERS)) BY_PAIR.set(`${v.lane}/${v.model}`, v);

/**
 * Resolve a record to its villager by the ONLY identity Atelier has: lane+model.
 * `record.villager` is honoured when a fixture states it, but lane+model wins
 * whenever it resolves, so live data never depends on a field the server has
 * no reason to send.
 */
export function villagerFor(record) {
  const paired = BY_PAIR.get(`${record?.lane}/${record?.model}`);
  if (paired) return paired;
  if (record?.villager && VILLAGERS[record.villager]) return VILLAGERS[record.villager];
  if (record?.lane === "codex") return VILLAGERS.alder;
  return VILLAGERS.tobin;
}

/** Every capability fact for a villager, ready to print. */
export function capabilitiesOf(villager) {
  return Object.entries(villager.caps).map(([key, value]) => ({
    key,
    value,
    ...CAPABILITY_NOTES[key][String(value)],
  }));
}

export const CAST_LIST = Object.values(VILLAGERS);
