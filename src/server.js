"use strict";
// ローカル専用の HTTP サーバー。
//   GET  /           … OBS のブラウザソースに貼るオーバーレイ
//   GET  /control    … 操作画面（アプリのウィンドウ、または普通のブラウザ／OBSドックでも開ける）
//   GET  /events     … 状態の配信（Server-Sent Events）
//   GET  /api/state  … 現在の状態
//   PUT  /api/state  … 状態の更新（操作画面から）
//   GET  /counter                 … 勝敗カウンターのオーバーレイ
//   GET  /api/counter             … 勝敗カウンターの現在の状態
//   POST /api/counter/action      … 勝ち/負け/引分の追加・取り消し・リセット
//   PUT  /api/counter/settings    … 勝敗カウンターの表示設定・ホットキー
//   GET  /promo                   … 告知スライドショーのオーバーレイ
//   GET  /api/promo               … 告知スライドショーの現在の状態
//   PUT  /api/promo               … 告知スライドショーの更新（操作画面から）
//   POST /api/promo/image         … 画像のアップロード（本文は画像そのもの）
//   POST /api/promo/show          … 指定したスライドを今すぐ表示
//   GET  /promo-img/<name>        … アップロードした画像
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { sanitizeState, defaultState } = require("./state");
const { sanitizeCounter, sanitizeCounterSettings, defaultCounter, applyAction } = require("./counter");
const { sanitizePromo, defaultPromo, imageExt, usedImages, IMAGE_RE, LIMITS: PROMO_LIMITS } = require("./promo");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// root 配下にあるファイルだけを返す（パスの抜け出しを防ぐ）
function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root + path.sep) ? p : null;
}

function createServer(opts) {
  const port = opts.port;
  const host = opts.host || "127.0.0.1";
  const publicDir = opts.publicDir || path.join(__dirname, "public");
  const stateFile = opts.dataDir ? path.join(opts.dataDir, "state.json") : null;

  let rev = 0;
  let state = defaultState();
  if (stateFile) {
    try { state = sanitizeState(JSON.parse(fs.readFileSync(stateFile, "utf8"))); } catch (e) { /* 初回起動など */ }
  }

  const counterFile = opts.dataDir ? path.join(opts.dataDir, "counter.json") : null;
  let crev = 0;
  let counter = defaultCounter();
  if (counterFile) {
    try { counter = sanitizeCounter(JSON.parse(fs.readFileSync(counterFile, "utf8"))); } catch (e) { /* 初回起動など */ }
  }

  const promoFile = opts.dataDir ? path.join(opts.dataDir, "promo.json") : null;
  const imageDir = opts.dataDir ? path.join(opts.dataDir, "promo-images") : fs.mkdtempSync(path.join(os.tmpdir(), "sortie-img-"));
  let prev = 0;
  let promo = defaultPromo();
  if (promoFile) {
    try { promo = sanitizePromo(JSON.parse(fs.readFileSync(promoFile, "utf8"))); } catch (e) { /* 初回起動など */ }
  }
  // どのスライドからも使われなくなった画像は起動時に片付ける
  // （起動中は消さない。削除したスライドを作り直したときなどに残っていた方が安全なため）
  try {
    const used = usedImages(promo);
    for (const f of fs.readdirSync(imageDir)) if (IMAGE_RE.test(f) && !used.has(f)) fs.unlinkSync(path.join(imageDir, f));
  } catch (e) { /* フォルダがまだない */ }

  function writeNow(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  const timers = {};
  function saveLater(file, get) {
    if (!file) return;
    clearTimeout(timers[file] && timers[file].t);
    timers[file] = { get, t: setTimeout(() => { delete timers[file]; writeNow(file, get()); }, 200) };
  }
  function flushSaves() {
    for (const file of Object.keys(timers)) { clearTimeout(timers[file].t); writeNow(file, timers[file].get()); delete timers[file]; }
  }
  function persist() { saveLater(stateFile, () => state); }
  function persistCounter() { saveLater(counterFile, () => counter); }
  function persistPromo() { saveLater(promoFile, () => promo); }

  const clients = new Set();
  function payload() { return JSON.stringify({ rev, state }); }
  function counterPayload() { return JSON.stringify({ rev: crev, counter }); }
  function promoPayload() { return JSON.stringify({ rev: prev, promo }); }
  function sendAll(event, data) {
    const msg = "event: " + event + "\ndata: " + data + "\n\n";
    for (const res of clients) res.write(msg);
  }
  function broadcast() {
    const msg = "event: state\ndata: " + payload() + "\n\n";
    for (const res of clients) res.write(msg);
  }
  const counterListeners = new Set();
  function setCounter(next) {
    const hotkeysChanged = JSON.stringify(next.settings.hotkeys) !== JSON.stringify(counter.settings.hotkeys);
    counter = next; crev++;
    persistCounter();
    const msg = "event: counter\ndata: " + counterPayload() + "\n\n";
    for (const res of clients) res.write(msg);
    for (const fn of counterListeners) { try { fn(counter, { hotkeysChanged }); } catch (e) { /* 通知先の不具合で止めない */ } }
  }
  function counterAction(action, src) {
    const next = applyAction(counter, action, src);
    if (!next) return false;
    setCounter(next);
    return true;
  }

  function readJson(req, res, cb) {
    if (!originOk(req)) return send(res, 403, "forbidden");
    if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, "json only");
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on("end", () => {
      let j;
      try { j = JSON.parse(body); } catch (e) { return send(res, 400, "bad request"); }
      cb(j);
    });
  }

  // 他のWebサイトからの書き換えを防ぐため、Origin は自分自身だけ許可する
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    return o === "http://127.0.0.1:" + port || o === "http://localhost:" + port;
  }

  function send(res, code, body, type) {
    res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }

  function serveFile(res, file) {
    if (!file) return send(res, 404, "not found");
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, "not found");
      send(res, 200, buf, MIME[path.extname(file)] || "application/octet-stream");
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("retry: 2000\n");
      res.write("event: state\ndata: " + payload() + "\n\n");
      res.write("event: counter\ndata: " + counterPayload() + "\n\n");
      res.write("event: promo\ndata: " + promoPayload() + "\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (p === "/api/state") {
      if (req.method === "GET") return send(res, 200, payload(), "application/json");
      if (req.method === "PUT") {
        return readJson(req, res, (j) => {
          let next;
          try { next = sanitizeState(j.state); } catch (e) { return send(res, 400, "bad request"); }
          state = next; rev++;
          persist(); broadcast();
          send(res, 200, JSON.stringify({ rev }), "application/json");
        });
      }
      return send(res, 405, "method not allowed");
    }

    if (p === "/api/counter") {
      if (req.method === "GET") return send(res, 200, counterPayload(), "application/json");
      return send(res, 405, "method not allowed");
    }
    if (p === "/api/counter/action") {
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      return readJson(req, res, (j) => {
        if (!j || !counterAction(String(j.action), "button")) return send(res, 400, "bad request");
        send(res, 200, JSON.stringify({ rev: crev }), "application/json");
      });
    }
    if (p === "/api/counter/settings") {
      if (req.method !== "PUT") return send(res, 405, "method not allowed");
      return readJson(req, res, (j) => {
        if (!j || !j.settings || typeof j.settings !== "object") return send(res, 400, "bad request");
        setCounter(Object.assign({}, counter, { settings: sanitizeCounterSettings(j.settings) }));
        send(res, 200, JSON.stringify({ rev: crev }), "application/json");
      });
    }

    if (p === "/api/promo") {
      if (req.method === "GET") return send(res, 200, promoPayload(), "application/json");
      if (req.method === "PUT") {
        return readJson(req, res, (j) => {
          let next;
          try { next = sanitizePromo(j.promo); } catch (e) { return send(res, 400, "bad request"); }
          promo = next; prev++;
          persistPromo(); sendAll("promo", promoPayload());
          send(res, 200, JSON.stringify({ rev: prev }), "application/json");
        });
      }
      return send(res, 405, "method not allowed");
    }
    if (p === "/api/promo/show") {
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      return readJson(req, res, (j) => {
        const id = j && typeof j.id === "string" ? j.id : "";
        if (!promo.slides.some((s) => s.id === id)) return send(res, 404, "not found");
        sendAll("promo-show", JSON.stringify({ id }));
        send(res, 200, "{}", "application/json");
      });
    }
    if (p === "/api/promo/image") {
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      if (!originOk(req)) return send(res, 403, "forbidden");
      if (!/^image\//.test(req.headers["content-type"] || "")) return send(res, 415, "image only");
      const chunks = []; let size = 0, tooBig = false;
      req.on("data", (c) => { size += c.length; if (size > PROMO_LIMITS.imageBytes) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c); });
      req.on("end", () => {
        if (tooBig) return send(res, 413, "too large");
        const buf = Buffer.concat(chunks);
        const ext = imageExt(buf);
        if (!ext) return send(res, 415, "unsupported image");
        const name = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) + "." + ext;
        try {
          fs.mkdirSync(imageDir, { recursive: true });
          const file = path.join(imageDir, name);
          if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
        } catch (e) { return send(res, 500, "save failed"); }
        send(res, 200, JSON.stringify({ name }), "application/json");
      });
      return;
    }

    if (req.method !== "GET") return send(res, 405, "method not allowed");
    if (p.indexOf("/promo-img/") === 0) {
      const name = p.slice("/promo-img/".length);
      if (!IMAGE_RE.test(name)) return send(res, 404, "not found");
      return fs.readFile(path.join(imageDir, name), (err, buf) => {
        if (err) return send(res, 404, "not found");
        // 中身のハッシュが名前なので、内容は変わらない。キャッシュしてよい
        res.writeHead(200, { "Content-Type": MIME[path.extname(name)], "Cache-Control": "max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
        res.end(buf);
      });
    }
    if (p === "/promo") return serveFile(res, path.join(publicDir, "promo.html"));
    if (p === "/" || p === "/overlay") return serveFile(res, path.join(publicDir, "overlay.html"));
    if (p === "/control") return serveFile(res, path.join(publicDir, "control.html"));
    if (p === "/counter") return serveFile(res, path.join(publicDir, "counter.html"));
    return serveFile(res, safeJoin(publicDir, decodeURIComponent(p.slice(1))));
  });

  // プロキシ等で切られないよう、定期的に空行を送る
  const ping = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 15000);

  return {
    server,
    get url() { return "http://127.0.0.1:" + port + "/"; },
    getState: () => ({ rev, state }),
    getCounter: () => ({ rev: crev, counter }),
    getPromo: () => ({ rev: prev, promo }),
    counterAction,
    onCounterChange(fn) { counterListeners.add(fn); return () => counterListeners.delete(fn); },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
    },
    close() {
      clearInterval(ping);
      for (const res of clients) res.end();
      clients.clear();
      flushSaves();
      return new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}

module.exports = { createServer };

// `npm run serve` で Electron なしでも動かせる（開発・確認用）
if (require.main === module) {
  const port = Number(process.env.PORT) || 4630;
  const s = createServer({ port, dataDir: path.join(__dirname, "..", ".data") });
  s.listen().then(() => {
    console.log("overlay: " + s.url);
    console.log("control: " + s.url + "control");
  }, (e) => { console.error(e.message); process.exit(1); });
}
