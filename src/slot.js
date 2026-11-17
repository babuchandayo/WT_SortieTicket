"use strict";
// スロット告知（告知スライドの亜種）の状態と検査。
// 16:9 のスライドを 1 本のリールに並べ、上から下へ回して、重み付きの抽選で 1 枚に止める。
// 同じスライドは連続して出ない。告知スライド（promo.js）とは別の slot.json に保存する。
// 画像は告知スライドと同じ promo-images/ に置き、同じアップロード API を使う。

const { IMAGE_RE } = require("./promo");
const { sanitizeHotkey } = require("./counter");

const COLORS = ["dark", "air", "ground", "green", "yellow", "red", "purple"];
const H_ALIGN = ["left", "center", "right"];
const V_ALIGN = ["top", "middle", "bottom"];
const LIMITS = {
  maxSlides: 30,
  minWeight: 1, maxWeight: 100,
  minSpin: 2, maxSpin: 15,
  maxAuto: 3600,
  maxHold: 3600,
  minWidth: 160, maxWidth: 1920,
  title: 40,
};

function defaultSlotSettings() {
  return {
    on: true,          // 配信に出す
    spinSec: 5,        // 回っている時間（秒）
    autoEvery: 0,      // 自動で回す間隔（秒。0 = 手動だけ）
    hold: 0,           // 止まったあと表示しておく秒数（0 = 次に回すまで出しっぱなし）
    width: 640,        // スライドの幅（px）。高さは 16:9 で決まる
    frame: true,       // 白フチと左右の目印
    hAlign: "center",
    vAlign: "middle",
    hotkey: "Ctrl+Alt+S", // 回すホットキー（"" = なし）
  };
}

function defaultSlot() {
  return { slides: [], settings: defaultSlotSettings(), last: null };
}

function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function pick(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
function line(v, max) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function sanitizeSlotSlide(s) {
  if (!s || typeof s !== "object") return null;
  const id = String(s.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id) return null;
  return {
    id,
    on: s.on !== false,
    weight: int(s.weight, LIMITS.minWeight, LIMITS.maxWeight, 10),
    title: line(s.title, LIMITS.title),
    color: pick(s.color, COLORS, "dark"),
    image: typeof s.image === "string" && IMAGE_RE.test(s.image) ? s.image : "",
  };
}

function sanitizeSlotSettings(st) {
  const d = defaultSlotSettings();
  const s = st && typeof st === "object" ? st : {};
  const auto = int(s.autoEvery, 0, LIMITS.maxAuto, d.autoEvery);
  return {
    on: typeof s.on === "boolean" ? s.on : d.on,
    spinSec: int(s.spinSec, LIMITS.minSpin, LIMITS.maxSpin, d.spinSec),
    // 自動の間隔は「回っている時間＋少し」より短くできない
    autoEvery: auto > 0 ? Math.max(auto, 10) : 0,
    hold: int(s.hold, 0, LIMITS.maxHold, d.hold),
    width: int(s.width, LIMITS.minWidth, LIMITS.maxWidth, d.width),
    frame: typeof s.frame === "boolean" ? s.frame : d.frame,
    hAlign: pick(s.hAlign, H_ALIGN, d.hAlign),
    vAlign: pick(s.vAlign, V_ALIGN, d.vAlign),
    hotkey: sanitizeHotkey(s.hotkey) === null ? d.hotkey : sanitizeHotkey(s.hotkey),
  };
}

function sanitizeSlot(p) {
  if (!p || typeof p !== "object") throw new Error("slot must be an object");
  const seen = new Set();
  const slides = (Array.isArray(p.slides) ? p.slides : [])
    .map(sanitizeSlotSlide)
    .filter((s) => s && !seen.has(s.id) && seen.add(s.id))
    .slice(0, LIMITS.maxSlides);
  const last = typeof p.last === "string" && slides.some((s) => s.id === p.last) ? p.last : null;
  return { slides, settings: sanitizeSlotSettings(p.settings), last };
}

// 抽選の対象（オンで、画像か文字のどちらかがあるもの）
function playable(s) { return s.on && !!(s.image || s.title); }
function candidates(slot) { return slot.slides.filter(playable); }

// 重み付きの抽選。直前に出たスライド（lastId）は除く。
// 対象が 1 枚しかないときは、連続になってもその 1 枚を返す（他に出せるものがないため）。
function pickNext(slides, lastId, rnd) {
  const r = typeof rnd === "function" ? rnd : Math.random;
  const list = slides.filter(playable);
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((s) => s.id !== lastId) : list;
  const total = pool.reduce((a, s) => a + s.weight, 0);
  let x = r() * total;
  for (const s of pool) { x -= s.weight; if (x < 0) return s; }
  return pool[pool.length - 1];
}

// 「同じものは連続しない」を入れたときの、長く回したときの実際の出現率（目安）。
// 直前が i のとき次が j になる確率は w_j / (合計 - w_i)。その定常分布を反復で求める。
function longRunRates(slides) {
  const list = slides.filter(playable);
  const n = list.length;
  if (!n) return {};
  if (n === 1) return { [list[0].id]: 1 };
  const w = list.map((s) => s.weight);
  const W = w.reduce((a, b) => a + b, 0);
  let p = w.map((x) => x / W);
  for (let it = 0; it < 500; it++) {
    const q = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) q[j] += p[i] * w[j] / (W - w[i]);
    // 2 枚だけのときは交互になり振動するので、半分ずつ混ぜて収束させる
    let diff = 0;
    for (let j = 0; j < n; j++) { const v = (p[j] + q[j]) / 2; diff += Math.abs(v - p[j]); q[j] = v; }
    p = q;
    if (diff < 1e-10) break;
  }
  const out = {};
  list.forEach((s, i) => { out[s.id] = p[i]; });
  return out;
}

function usedSlotImages(slot) {
  const set = new Set();
  for (const s of slot.slides) if (s.image) set.add(s.image);
  return set;
}

module.exports = {
  COLORS, LIMITS,
  defaultSlot, defaultSlotSettings, sanitizeSlot, sanitizeSlotSlide, sanitizeSlotSettings,
  playable, candidates, pickNext, longRunRates, usedSlotImages,
};
