"use strict";
// YouTube の登録者数（告知スライド・スロット告知のカウンター用）の状態と検査。
// 数は、普段の Chrome で開いた YouTube Studio の「現在の登録者数」ページから、同梱の Chrome 拡張機能（src/extension）が
// 読み取って送ってくる（POST /api/subs/reading）か、手入力する。
// 設定と最後に読めた数は subs.json に保存する。

const SOURCES = ["studio", "manual"];
const MAX_COUNT = 999999999999;   // 12 桁まで
const STALE_MS = 3 * 60e3;         // 拡張機能からこの時間届かなければ「止まっている」とみなす

function defaultSubs() {
  return {
    source: "studio",   // studio = Studio から自動（Chrome 拡張機能） / manual = 手入力
    manual: 0,          // 手入力の数
    goal: 0,            // 目標人数（0 = なし）
    read: null,         // Studio から最後に読めた数
    readAt: 0,          // その時刻（ms）
    base: null,         // 増加数の基準 { count, at, day }。日付が変わると自動で取り直す
  };
}

function count(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;   // Number(null) が 0 になるのを防ぐ
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_COUNT);
}

function sanitizeBase(b) {
  if (!b || typeof b !== "object") return null;
  const c = count(b.count);
  if (c === null) return null;
  return { count: c, at: Math.max(0, Number(b.at) || 0), day: typeof b.day === "string" ? b.day.slice(0, 10) : "" };
}

function sanitizeSubs(p) {
  const d = defaultSubs();
  const s = p && typeof p === "object" ? p : {};
  return {
    source: SOURCES.indexOf(s.source) >= 0 ? s.source : d.source,
    manual: count(s.manual) || 0,
    goal: count(s.goal) || 0,
    read: Number(s.readAt) > 0 ? count(s.read) : null,   // 届いた時刻がない数は使わない（前の版で null が 0 として保存されていたため）
    readAt: Math.max(0, Number(s.readAt) || 0),
    base: sanitizeBase(s.base),
  };
}

// 操作画面から変えられる項目だけを取り出す
function applySubsSettings(subs, st) {
  const s = st && typeof st === "object" ? st : {};
  const next = Object.assign({}, subs);
  if ("source" in s) next.source = SOURCES.indexOf(s.source) >= 0 ? s.source : subs.source;
  if ("manual" in s) next.manual = count(s.manual) || 0;
  if ("goal" in s) next.goal = count(s.goal) || 0;
  return next;
}

// 今使う数（手入力なら手入力の値、自動なら最後に読めた値。まだなければ null）
function currentCount(subs) {
  return subs.source === "manual" ? subs.manual : subs.read;
}

// その日の日付（このパソコンの時刻で）
function dayOf(ms) {
  const t = new Date(ms);
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}

// 増加数の基準を必要なら取り直す。日付が変わった・基準がない・数の取り方を変えたときは今の数を基準にする
function ensureBase(subs, now) {
  const c = currentCount(subs);
  if (c === null) return subs;
  const day = dayOf(now);
  if (subs.base && subs.base.day === day) return subs;
  return Object.assign({}, subs, { base: { count: c, at: now, day } });
}

// オーバーレイに配る形
function publicSubs(subs) {
  const c = currentCount(subs);
  return {
    count: c,
    goal: subs.goal,
    delta: c !== null && subs.base ? c - subs.base.count : null,
    source: subs.source,
    readAt: subs.source === "manual" ? 0 : subs.readAt,
  };
}

// 自動取得の状況（ok = 届いている / wait = まだ届いていない・止まっている / off = 手入力）
function subsStatus(subs, now) {
  if (subs.source === "manual") return { state: "off", message: "手入力の数を表示中" };
  if (!subs.readAt) return { state: "wait", message: "まだ届いていません。Chrome で YouTube Studio の「現在の登録者数」のページを開いてください" };
  if (now - subs.readAt > STALE_MS) return { state: "wait", message: "数が届いていません（最後に届いたのは " + Math.round((now - subs.readAt) / 60e3) + " 分前）。Studio のタブが開いているか確認してください" };
  return { state: "ok", message: "" };
}

// Studio の画面から読み取った文字列を数にする。「1,234」「1 234」「1.234」などを受け付け、
// 数字以外が混じるもの・桁が多すぎるものは null（読み間違いを数として出さないため）
function parseCount(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/[\s  ,.'’]/g, "");
  if (!/^[0-9]{1,12}$/.test(s)) return null;
  return Number(s);
}

module.exports = {
  SOURCES, MAX_COUNT, STALE_MS,
  defaultSubs, sanitizeSubs, applySubsSettings, currentCount, ensureBase, publicSubs, parseCount, dayOf, subsStatus, count,
};
