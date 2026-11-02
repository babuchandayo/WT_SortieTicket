"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../src/server");
const { sanitizeState } = require("../src/state");

const PORT = 47631;
const base = "http://127.0.0.1:" + PORT;

function readSSE(onEvent) {
  return new Promise((resolve) => {
    const req = http.get(base + "/events", (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) onEvent(JSON.parse(data));
        }
      });
      resolve(req);
    });
  });
}

test("sanitizeState は不正な値を補正する", () => {
  const s = sanitizeState({
    queue: [
      { id: "a", kind: "ground", br: "9.3", slots: 7, games: 0, played: 5, live: "yes", memo: "  フレンド\n枠 " },
      { id: "b", kind: "x", br: "abc" },
      { id: "a", kind: "air", br: "1" },
      { id: "<c>", kind: "air", br: 14 },
    ],
    settings: { showLegend: false, defaultGames: 99 },
  });
  assert.deepStrictEqual(s.queue, [
    { id: "a", kind: "ground", br: "9.3", slots: 3, games: 1, played: 0, live: false, memo: "フレンド枠" },
    { id: "c", kind: "air", br: "14.0", slots: 0, games: 2, played: 0, live: false, memo: "" },
  ]);
  assert.deepStrictEqual(s.settings, { showLegend: false, defaultGames: 9, defaultSlots: 3 });
});

test("サーバー: 状態の更新・配信・保存", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortie-"));
  const srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  t.after(() => srv.close());

  // ページとフォント
  for (const p of ["/", "/control", "/fonts/oswald/700.css", "/fonts/noto/900.css", "/fonts/oswald/files/oswald-latin-700-normal.woff2"]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
  }
  // 公開ディレクトリ外は読めない
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/fonts/oswald/package.json", "/fonts/noto/../../../package.json"]) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 404, p);
  }

  const events = [];
  const sse = await readSSE((e) => events.push(e));
  t.after(() => sse.destroy());

  const state = { queue: [{ id: "x1", kind: "air", br: "15.0", slots: 3, games: 2, played: 0, live: true, memo: "〇〇さん" }], settings: { showLegend: true, defaultGames: 2, defaultSlots: 3 } };
  const r = await fetch(base + "/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).rev, 1);

  await new Promise((res) => setTimeout(res, 100));
  assert.strictEqual(events.length, 2); // 接続直後の1回 + 更新
  assert.deepStrictEqual(events[1].state, state);

  // 他サイトからの書き換えは拒否
  const bad = await fetch(base + "/api/state", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: JSON.stringify({ state }) });
  assert.strictEqual(bad.status, 403);
  const form = await fetch(base + "/api/state", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ state }) });
  assert.strictEqual(form.status, 415);

  // 保存されたものが次回起動時に読まれる
  await srv.close();
  await new Promise((res) => setTimeout(res, 50)); // 古い接続がクライアント側で破棄されるのを待つ
  const srv2 = createServer({ port: PORT, dataDir: dir });
  await srv2.listen();
  t.after(() => srv2.close());
  const g = await (await fetch(base + "/api/state")).json();
  assert.deepStrictEqual(g.state, state);
});
