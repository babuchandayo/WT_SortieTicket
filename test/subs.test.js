"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/server");
const { sanitizeSubs, parseCount, ensureBase, publicSubs, dayOf } = require("../src/subs");

const PORT = 47635;
const base = "http://127.0.0.1:" + PORT;
const put = (body) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

test("parseCount は数字だけのものを数にし、読み間違いは null にする", () => {
  assert.strictEqual(parseCount("1,234"), 1234);
  assert.strictEqual(parseCount(" 12 345 "), 12345);
  assert.strictEqual(parseCount("1.234.567"), 1234567);
  assert.strictEqual(parseCount("0"), 0);
  assert.strictEqual(parseCount("1.2万"), null);
  assert.strictEqual(parseCount("1.2K"), null);
  assert.strictEqual(parseCount(""), null);
  assert.strictEqual(parseCount("1234567890123"), null);
  assert.strictEqual(parseCount(null), null);
});

test("sanitizeSubs は不正な値を補正する", () => {
  const s = sanitizeSubs({ source: "api", url: "https://evil.example/", manual: -5, goal: "1500", read: "x", readAt: -1, base: { count: 10, at: 5, day: "2026-11-19" } });
  assert.deepStrictEqual(s, { source: "studio", url: "", manual: 0, goal: 1500, read: null, readAt: 0, base: { count: 10, at: 5, day: "2026-11-19" } });
  assert.strictEqual(sanitizeSubs({ url: "https://studio.youtube.com/channel/UCxx/analytics" }).url, "https://studio.youtube.com/channel/UCxx/analytics");
  assert.strictEqual(sanitizeSubs({ url: "http://studio.youtube.com/x" }).url, "");
});

test("増加数の基準は日付が変わると取り直す", () => {
  const t0 = new Date(2026, 10, 19, 12, 0).getTime();
  let s = sanitizeSubs({ source: "manual", manual: 100 });
  s = ensureBase(s, t0);
  assert.strictEqual(s.base.count, 100);
  s = ensureBase(Object.assign({}, s, { manual: 112 }), t0 + 3600e3);
  assert.strictEqual(publicSubs(s).delta, 12);
  s = ensureBase(s, new Date(2026, 10, 20, 0, 1).getTime());
  assert.strictEqual(s.base.day, dayOf(new Date(2026, 10, 20).getTime()));
  assert.strictEqual(publicSubs(s).delta, 0);
  // まだ数がないときは基準を作らない
  assert.strictEqual(ensureBase(sanitizeSubs({}), t0).base, null);
});

test("サーバー: 設定・読み取り・基準のリセット・保存", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortie-subs-"));
  let srv = createServer({ port: PORT, dataDir: dir, subsReader: true });
  await srv.listen();
  try {
    let j = await (await fetch(base + "/api/subs")).json();
    assert.strictEqual(j.view.count, null);
    assert.strictEqual(j.status.state, "off");

    const seen = [];
    srv.onSubsChange((s, info) => seen.push(info));
    let r = await fetch(base + "/api/subs", put({ settings: { url: "https://studio.youtube.com/channel/UCabc/analytics/tab-overview", goal: 1500 } }));
    assert.strictEqual(r.status, 200); await r.text();
    assert.strictEqual(seen.pop().urlChanged, true);

    srv.setSubsReading(1200);
    srv.setSubsReading(1234);
    j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.view.count, j.view.goal, j.view.delta], [1234, 1500, 34]);

    r = await fetch(base + "/api/subs/base", post);
    assert.strictEqual(r.status, 200); await r.text();
    j = await (await fetch(base + "/api/subs")).json();
    assert.strictEqual(j.view.delta, 0);

    srv.setSubsStatus("login", "ログインしてください");
    j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual(j.status, { state: "login", message: "ログインしてください" });

    // 手入力に切り替えると、増加数は手入力の数から数え直す
    await (await fetch(base + "/api/subs", put({ settings: { source: "manual", manual: 50 } }))).text();
    j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.view.count, j.view.delta], [50, 0]);

    // 他のサイトからは書き換えられない
    const code = await new Promise((resolve, reject) => {
      const req = http.request(base + "/api/subs", { method: "PUT", agent: false, headers: { "Content-Type": "application/json", Origin: "https://evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end(JSON.stringify({ settings: { manual: 1 } }));
    });
    assert.strictEqual(code, 403);
  } finally { await srv.close(); }

  srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  await new Promise((r) => setTimeout(r, 50));   // 前のサーバーで使っていた接続が閉じられるのを待つ
  try {
    const j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.subs.source, j.subs.manual, j.subs.goal, j.subs.read], ["manual", 50, 1500, 1234]);
    assert.strictEqual(j.status.state, "noapp");
  } finally { await srv.close(); }
});
