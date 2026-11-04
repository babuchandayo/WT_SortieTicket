"use strict";
// 勝敗カウンターの状態と操作。
// 分隊ランクの状態（state.js）とは別に持つ。操作画面は分隊ランクの状態を丸ごと PUT するため、
// 同じ所に置くとホットキーで増やした勝敗が上書きされてしまうから。

const RESULTS = ["W", "L", "D"];
const ACTIONS = { win: "W", loss: "L", draw: "D" };
const DESIGNS = ["plate", "wide", "split"];
const HOTKEY_NAMES = ["win", "loss", "draw", "undo"];
const LIMITS = { maxResults: 10000, minRecent: 5, maxRecent: 20 };

function defaultHotkeys() {
  return { win: "Ctrl+Alt+W", loss: "Ctrl+Alt+L", draw: "Ctrl+Alt+D", undo: "Ctrl+Alt+Z" };
}

function defaultCounterSettings() {
  return {
    design: "plate",       // 見た目の草案（plate / wide / split）
    showRate: true,        // 勝率を表示
    showRateLabel: true,   // 「WIN RATE」の文字を表示
    showRecent: true,      // 直近の戦績を表示
    recentCount: 10,       // 直近の戦績の試合数
    hotkeys: defaultHotkeys(),
  };
}

function defaultCounter() {
  return { results: [], backup: null, last: null, settings: defaultCounterSettings() };
}

function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Electron のアクセラレータ表記（例: Ctrl+Alt+W）だけを通す。空文字は「割り当てなし」
const KEY_RE = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Tab|Space|num[0-9]|numadd|numsub|nummult|numdiv|numdec|[-=[\]\\;',./`])$/;
const MODS = ["Ctrl", "Alt", "Shift", "Super"];
function sanitizeHotkey(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return "";
  const parts = s.split("+");
  // 「+」キーそのものは扱わない（区切りと紛らわしいため）
  if (parts.some((p) => p === "")) return null;
  const key = parts.pop();
  if (!KEY_RE.test(key)) return null;
  const mods = [];
  for (const p of parts) {
    if (MODS.indexOf(p) < 0 || mods.indexOf(p) >= 0) return null;
    mods.push(p);
  }
  // 修飾キーなしの文字キーは、全アプリでその文字が打てなくなるので許可しない
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  mods.sort((a, b) => MODS.indexOf(a) - MODS.indexOf(b));
  return mods.concat(key).join("+");
}

function sanitizeHotkeys(h) {
  const d = defaultHotkeys();
  const src = h && typeof h === "object" ? h : {};
  const out = {};
  for (const k of HOTKEY_NAMES) {
    const v = sanitizeHotkey(src[k]);
    out[k] = v === null ? d[k] : v;
  }
  return out;
}

function sanitizeCounterSettings(st) {
  const d = defaultCounterSettings();
  const s = st && typeof st === "object" ? st : {};
  const bool = (k) => (typeof s[k] === "boolean" ? s[k] : d[k]);
  return {
    design: DESIGNS.indexOf(s.design) >= 0 ? s.design : d.design,
    showRate: bool("showRate"),
    showRateLabel: bool("showRateLabel"),
    showRecent: bool("showRecent"),
    recentCount: int(s.recentCount, LIMITS.minRecent, LIMITS.maxRecent, d.recentCount),
    hotkeys: sanitizeHotkeys(s.hotkeys),
  };
}

function sanitizeResults(a) {
  if (!Array.isArray(a)) return [];
  return a.filter((r) => RESULTS.indexOf(r) >= 0).slice(-LIMITS.maxResults);
}

function sanitizeLast(l) {
  if (!l || typeof l !== "object") return null;
  const op = ["add", "undo", "reset"].indexOf(l.op) >= 0 ? l.op : null;
  if (!op) return null;
  return {
    op,
    r: RESULTS.indexOf(l.r) >= 0 ? l.r : null,
    src: l.src === "hotkey" ? "hotkey" : "button",
  };
}

function sanitizeCounter(c) {
  const s = c && typeof c === "object" ? c : {};
  return {
    results: sanitizeResults(s.results),
    backup: Array.isArray(s.backup) ? sanitizeResults(s.backup) : null,
    last: sanitizeLast(s.last),
    settings: sanitizeCounterSettings(s.settings),
  };
}

// 操作を適用した新しい状態を返す。知らない操作なら null
function applyAction(c, action, src) {
  src = src === "hotkey" ? "hotkey" : "button";
  const next = { results: c.results.slice(), backup: c.backup, last: c.last, settings: c.settings };
  if (ACTIONS[action]) {
    const r = ACTIONS[action];
    next.results.push(r);
    if (next.results.length > LIMITS.maxResults) next.results.shift();
    next.backup = null;
    next.last = { op: "add", r, src };
    return next;
  }
  if (action === "undo") {
    if (next.results.length) {
      next.last = { op: "undo", r: next.results.pop(), src };
    } else if (next.backup) {
      // リセット直後の取り消しは、リセット前の戦績に戻す
      next.results = next.backup;
      next.backup = null;
      next.last = { op: "undo", r: null, src };
    }
    return next;
  }
  if (action === "reset") {
    if (next.results.length) next.backup = next.results;
    next.results = [];
    next.last = { op: "reset", r: null, src };
    return next;
  }
  return null;
}

function summarize(results) {
  let w = 0, l = 0, d = 0;
  for (const r of results) { if (r === "W") w++; else if (r === "L") l++; else d++; }
  return { wins: w, losses: l, draws: d, rate: w + l > 0 ? w / (w + l) : null };
}

module.exports = {
  ACTIONS, DESIGNS, HOTKEY_NAMES, LIMITS,
  defaultCounter, defaultCounterSettings, defaultHotkeys,
  sanitizeCounter, sanitizeCounterSettings, sanitizeHotkey, applyAction, summarize,
};
