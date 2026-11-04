"use strict";
// 告知スライドショーの状態と検査。
// 分隊ランク（state.js）・勝敗カウンター（counter.js）とは別の promo.json に保存する。

const TEMPLATES = ["text", "sns", "image", "imagetext"];
const COLORS = ["dark", "air", "ground", "green", "yellow", "red", "purple"];
const SERVICES = ["discord", "x", "youtube", "twitch", "tiktok", "other"];
const STYLES = ["plain", "plate"];
const TRANSITIONS = ["fade", "slide", "none"];
const H_ALIGN = ["left", "center", "right"];
const V_ALIGN = ["top", "middle", "bottom"];
const LIMITS = {
  maxSlides: 30,
  minSec: 3, maxSec: 300,
  maxGap: 3600,
  minScale: 30, maxScale: 300,
  minSize: 20, maxSize: 300,
  title: 60, body: 300, sub: 60,
  imageBytes: 10 * 1024 * 1024,
};

// アップロード画像のファイル名（サーバーが中身のハッシュから付ける）
const IMAGE_RE = /^[0-9a-f]{16}\.(?:png|jpg|gif|webp)$/;

function defaultPromoSettings() {
  return {
    on: true,             // スライドショーを配信に出す
    transition: "fade",   // 切り替え方
    gap: 0,               // 1周したあと何秒隠すか（0 = 隠さず続けて流す）
    showBar: true,        // 残り時間の黄色いバー
    scale: 100,           // 全体の大きさ（%）
    hAlign: "left",       // ブラウザソース内の配置（横）
    vAlign: "bottom",     // ブラウザソース内の配置（縦）
  };
}

function defaultPromo() {
  return { slides: [], settings: defaultPromoSettings() };
}

function int(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function pick(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

// 1行のテキスト（改行・制御文字を除く）
function line(v, max) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}
// 複数行のテキスト（改行だけ残す。最大6行）
function lines(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .split("\n").slice(0, 6).map((s) => s.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "").slice(0, max);
}

function sanitizeSlide(s) {
  if (!s || typeof s !== "object") return null;
  const id = String(s.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  if (!id) return null;
  return {
    id,
    on: s.on !== false,
    tpl: pick(s.tpl, TEMPLATES, "text"),
    sec: int(s.sec, LIMITS.minSec, LIMITS.maxSec, 10),
    title: line(s.title, LIMITS.title),
    body: lines(s.body, LIMITS.body),
    sub: line(s.sub, LIMITS.sub),
    service: pick(s.service, SERVICES, "discord"),
    style: pick(s.style, STYLES, "plain"),
    color: pick(s.color, COLORS, "dark"),
    image: typeof s.image === "string" && IMAGE_RE.test(s.image) ? s.image : "",
    size: int(s.size, LIMITS.minSize, LIMITS.maxSize, 100),
    frame: s.frame === true,
  };
}

function sanitizePromoSettings(st) {
  const d = defaultPromoSettings();
  const s = st && typeof st === "object" ? st : {};
  return {
    on: typeof s.on === "boolean" ? s.on : d.on,
    transition: pick(s.transition, TRANSITIONS, d.transition),
    gap: int(s.gap, 0, LIMITS.maxGap, d.gap),
    showBar: typeof s.showBar === "boolean" ? s.showBar : d.showBar,
    scale: int(s.scale, LIMITS.minScale, LIMITS.maxScale, d.scale),
    hAlign: pick(s.hAlign, H_ALIGN, d.hAlign),
    vAlign: pick(s.vAlign, V_ALIGN, d.vAlign),
  };
}

function sanitizePromo(p) {
  if (!p || typeof p !== "object") throw new Error("promo must be an object");
  const seen = new Set();
  const slides = (Array.isArray(p.slides) ? p.slides : [])
    .map(sanitizeSlide)
    .filter((s) => s && !seen.has(s.id) && seen.add(s.id))
    .slice(0, LIMITS.maxSlides);
  return { slides, settings: sanitizePromoSettings(p.settings) };
}

// 画像の種類はファイルの先頭のバイトで判定する（拡張子や Content-Type は信用しない）
function imageExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

function usedImages(promo) {
  const set = new Set();
  for (const s of promo.slides) if (s.image) set.add(s.image);
  return set;
}

module.exports = {
  TEMPLATES, COLORS, SERVICES, LIMITS, IMAGE_RE,
  defaultPromo, defaultPromoSettings, sanitizePromo, sanitizeSlide, imageExt, usedImages,
};
