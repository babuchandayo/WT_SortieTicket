"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/server");
const { applyAction, defaultCounter, sanitizeCounter, sanitizeHotkey, summarize } = require("../src/counter");

const PORT = 47632;
const base = "http://127.0.0.1:" + PORT;

test("勝敗の追加・取り消し・リセット", () => {
  let c = defaultCounter();
  for (const a of ["win", "win", "loss", "draw"]) c = applyAction(c, a, "button");
  assert.deepStrictEqual(c.results, ["W", "W", "L", "D"]);
  assert.deepStrictEqual(summarize(c.results), { wins: 2, losses: 1, draws: 1, rate: 2 / 3 });
  c = applyAction(c, "undo", "hotkey");
  assert.deepStrictEqual(c.results, ["W", "W", "L"]);
  assert.deepStrictEqual(c.last, { op: "undo", r: "D", src: "hotkey" });
  c = applyAction(c, "reset", "button");
  assert.deepStrictEqual(c.results, []);
  // リセット直後の取り消しで戻る
  c = applyAction(c, "undo", "button");
  assert.deepStrictEqual(c.results, ["W", "W", "L"]);
  assert.strictEqual(applyAction(c, "nope"), null);
  assert.strictEqual(summarize([]).rate, null);
});

test("ホットキーと設定の検査", () => {
  assert.strictEqual(sanitizeHotkey("Alt+Ctrl+w".replace("w", "W")), "Ctrl+Alt+W");
  assert.strictEqual(sanitizeHotkey("F9"), "F9");
  assert.strictEqual(sanitizeHotkey(""), "");
  assert.strictEqual(sanitizeHotkey("W"), null);          // 修飾キーなしの文字は不可
  assert.strictEqual(sanitizeHotkey("Ctrl+Ctrl+W"), null);
  assert.strictEqual(sanitizeHotkey("Ctrl+Foo"), null);
  const c = sanitizeCounter({ results: ["W", "x", "L"], settings: { design: "zzz", recentCount: 99, showRate: false, hotkeys: { win: "Shift+F1", loss: "bad" } } });
  assert.deepStrictEqual(c.results, ["W", "L"]);
  assert.strictEqual(c.settings.design, "plate");
  assert.strictEqual(c.settings.recentCount, 20);
  assert.strictEqual(c.settings.showRate, false);
  assert.deepStrictEqual(c.settings.hotkeys, { win: "Shift+F1", loss: "Ctrl+Alt+L", draw: "Ctrl+Alt+D", undo: "Ctrl+Alt+Z" });
});

test("サーバー: 勝敗カウンターの API と保存", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortie-c-"));
  const srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  t.after(() => srv.close());

  assert.strictEqual((await fetch(base + "/counter")).status, 200);
  const post = (body, headers) => fetch(base + "/api/counter/action", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify(body) });
  assert.strictEqual((await post({ action: "win" })).status, 200);
  assert.strictEqual((await post({ action: "bogus" })).status, 400);
  assert.strictEqual((await post({ action: "win" }, { Origin: "https://example.com" })).status, 403);

  // ホットキー経由（main.js から直接呼ぶ）
  const changes = [];
  srv.onCounterChange((c, info) => changes.push(info));
  assert.strictEqual(srv.counterAction("loss", "hotkey"), true);
  const r = await fetch(base + "/api/counter/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { design: "wide", hotkeys: { win: "F8" } } }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(changes, [{ hotkeysChanged: false }, { hotkeysChanged: true }]);

  const g = await (await fetch(base + "/api/counter")).json();
  assert.deepStrictEqual(g.counter.results, ["W", "L"]);
  assert.deepStrictEqual(g.counter.last, { op: "add", r: "L", src: "hotkey" });
  assert.strictEqual(g.counter.settings.design, "wide");
  assert.strictEqual(g.counter.settings.hotkeys.win, "F8");

  // 分隊ランクの状態を PUT しても勝敗は消えない
  await fetch(base + "/api/state", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: { queue: [], settings: {} } }) });
  await srv.close();
  await new Promise((res) => setTimeout(res, 50));
  const srv2 = createServer({ port: PORT, dataDir: dir });
  await srv2.listen();
  t.after(() => srv2.close());
  const g2 = await (await fetch(base + "/api/counter")).json();
  assert.deepStrictEqual(g2.counter.results, ["W", "L"]);
  assert.strictEqual(g2.counter.settings.hotkeys.win, "F8");
});
