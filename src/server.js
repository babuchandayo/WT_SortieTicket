"use strict";
// ローカル専用の HTTP サーバー。
//   GET  /           … OBS のブラウザソースに貼るオーバーレイ
//   GET  /control    … 操作画面（アプリのウィンドウ、または普通のブラウザ／OBSドックでも開ける）
//   GET  /events     … 状態の配信（Server-Sent Events）
//   GET  /api/state  … 現在の状態
//   PUT  /api/state  … 状態の更新（操作画面から）
const http = require("http");
const fs = require("fs");
const path = require("path");
const { sanitizeState, defaultState } = require("./state");

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

  let saveTimer = null;
  function persist() {
    if (!stateFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, stateFile);
    }, 200);
  }

  const clients = new Set();
  function payload() { return JSON.stringify({ rev, state }); }
  function broadcast() {
    const msg = "event: state\ndata: " + payload() + "\n\n";
    for (const res of clients) res.write(msg);
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
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (p === "/api/state") {
      if (req.method === "GET") return send(res, 200, payload(), "application/json");
      if (req.method === "PUT") {
        if (!originOk(req)) return send(res, 403, "forbidden");
        if (!/^application\/json/.test(req.headers["content-type"] || "")) return send(res, 415, "json only");
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
        req.on("end", () => {
          let next;
          try { next = sanitizeState(JSON.parse(body).state); } catch (e) { return send(res, 400, "bad request"); }
          state = next; rev++;
          persist(); broadcast();
          send(res, 200, JSON.stringify({ rev }), "application/json");
        });
        return;
      }
      return send(res, 405, "method not allowed");
    }

    if (req.method !== "GET") return send(res, 405, "method not allowed");
    if (p === "/" || p === "/overlay") return serveFile(res, path.join(publicDir, "overlay.html"));
    if (p === "/control") return serveFile(res, path.join(publicDir, "control.html"));
    return serveFile(res, safeJoin(publicDir, decodeURIComponent(p.slice(1))));
  });

  // プロキシ等で切られないよう、定期的に空行を送る
  const ping = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 15000);

  return {
    server,
    get url() { return "http://127.0.0.1:" + port + "/"; },
    getState: () => ({ rev, state }),
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
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
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
