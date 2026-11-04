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
const http = require("http");
const fs = require("fs");
const path = require("path");
const { sanitizeState, defaultState } = require("./state");
const { sanitizeCounter, sanitizeCounterSettings, defaultCounter, applyAction } = require("./counter");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
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

  const clients = new Set();
  function payload() { return JSON.stringify({ rev, state }); }
  function counterPayload() { return JSON.stringify({ rev: crev, counter }); }
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

    if (req.method !== "GET") return send(res, 405, "method not allowed");
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
