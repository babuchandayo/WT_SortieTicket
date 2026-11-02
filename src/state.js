"use strict";
// 状態の形と、外から来た値の検査・補正

const LIMITS = { maxEntries: 20, maxSlots: 3, maxGames: 9 };

function defaultSettings() {
  return {
    showLegend: true,   // 左端に「見方」枠を出す
    defaultGames: 2,    // 新しい区分の試合数
    defaultSlots: 3,    // 新しい区分の残参加枠（配信者を除いて最大3）
  };
}

function defaultState() {
  return { queue: [], settings: defaultSettings() };
}

function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function fmtBR(v) {
  const n = parseFloat(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > 30) return null;
  return n.toFixed(1);
}

function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const br = fmtBR(e.br);
  if (!br) return null;
  const id = String(e.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id) return null;
  const games = int(e.games, 1, LIMITS.maxGames, 2);
  return {
    id,
    kind: e.kind === "ground" ? "ground" : "air",
    br,
    slots: int(e.slots, 0, LIMITS.maxSlots, 0),
    games,
    played: int(e.played, 0, games - 1, 0),
    live: e.live === true,
    memo: typeof e.memo === "string" ? e.memo.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) : "",
  };
}

function sanitizeState(s) {
  if (!s || typeof s !== "object") throw new Error("state must be an object");
  const d = defaultSettings();
  const st = s.settings && typeof s.settings === "object" ? s.settings : {};
  const seen = new Set();
  const queue = (Array.isArray(s.queue) ? s.queue : [])
    .map(sanitizeEntry)
    .filter((e) => e && !seen.has(e.id) && seen.add(e.id))
    .slice(0, LIMITS.maxEntries);
  return {
    queue,
    settings: {
      showLegend: typeof st.showLegend === "boolean" ? st.showLegend : d.showLegend,
      defaultGames: int(st.defaultGames, 1, LIMITS.maxGames, d.defaultGames),
      defaultSlots: int(st.defaultSlots, 0, LIMITS.maxSlots, d.defaultSlots),
    },
  };
}

module.exports = { LIMITS, defaultState, defaultSettings, sanitizeState, fmtBR };
