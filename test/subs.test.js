"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/server");
const { sanitizeSubs, parseCount, ensureBase, publicSubs, dayOf, subsStatus, STALE_MS } = require("../src/subs");

const PORT = 47635;
const base = "http://127.0.0.1:" + PORT;
const put = (body) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };

// 接続を使い回さずに 1 回だけ送る（Origin を付けたいときなど）
function raw(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, agent: false, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
}

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
  const s = sanitizeSubs({ source: "api", url: "https://studio.youtube.com/old", manual: -5, goal: "1500", read: "x", readAt: -1, base: { count: 10, at: 5, day: "2026-11-19" } });
  assert.deepStrictEqual(s, { source: "studio", manual: 0, goal: 1500, read: null, readAt: 0, base: { count: 10, at: 5, day: "2026-11-19" } });
  // 保存されていた「まだ読めていない」（null）は 0 にしない
  assert.strictEqual(sanitizeSubs(JSON.parse(JSON.stringify({ read: null }))).read, null);
  assert.strictEqual(sanitizeSubs({ read: 0, readAt: 0 }).read, null);
  assert.strictEqual(sanitizeSubs({ read: 1234, readAt: 5 }).read, 1234);
});

test("自動取得の状況: まだ届いていない・届いている・止まっている・手入力", () => {
  const now = 1e12;
  assert.strictEqual(subsStatus(sanitizeSubs({}), now).state, "wait");
  assert.strictEqual(subsStatus(sanitizeSubs({ read: 5, readAt: now - 10e3 }), now).state, "ok");
  assert.strictEqual(subsStatus(sanitizeSubs({ read: 5, readAt: now - STALE_MS - 1 }), now).state, "wait");
  assert.strictEqual(subsStatus(sanitizeSubs({ source: "manual" }), now).state, "off");
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
  let srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  try {
    let j = await (await fetch(base + "/api/subs")).json();
    assert.strictEqual(j.view.count, null);
    assert.strictEqual(j.status.state, "wait");

    let r = await fetch(base + "/api/subs", put({ settings: { goal: 1500 } }));
    assert.strictEqual(r.status, 200); await r.text();

    // Chrome 拡張機能から届く（Origin は chrome-extension://<32 文字>）
    const ext = { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" };
    assert.strictEqual(await raw("POST", "/api/subs/reading", { count: 1200 }, ext), 200);
    assert.strictEqual(await raw("POST", "/api/subs/reading", { count: 1234 }, ext), 200);
    j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.view.count, j.view.goal, j.view.delta, j.status.state], [1234, 1500, 34, "ok"]);
    // 普通の Web サイトからは受け付けない。数でないものも受け付けない
    assert.strictEqual(await raw("POST", "/api/subs/reading", { count: 1 }, { Origin: "https://evil.example" }), 403);
    assert.strictEqual(await raw("POST", "/api/subs/reading", { count: "1,234" }, ext), 400);
    assert.strictEqual(await raw("POST", "/api/subs/reading", { count: -1 }, ext), 400);
    j = await (await fetch(base + "/api/subs")).json();
    assert.strictEqual(j.view.count, 1234);

    r = await fetch(base + "/api/subs/base", post);
    assert.strictEqual(r.status, 200); await r.text();
    j = await (await fetch(base + "/api/subs")).json();
    assert.strictEqual(j.view.delta, 0);

    // 手入力に切り替えると、増加数は手入力の数から数え直す
    await (await fetch(base + "/api/subs", put({ settings: { source: "manual", manual: 50 } }))).text();
    j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.view.count, j.view.delta], [50, 0]);

    // 他のサイトからは書き換えられない
    assert.strictEqual(await raw("PUT", "/api/subs", { settings: { manual: 1 } }, { Origin: "https://evil.example" }), 403);
    assert.strictEqual(await raw("PUT", "/api/subs", { settings: { manual: 1 } }, ext), 403);
  } finally { await srv.close(); }

  srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  await new Promise((r) => setTimeout(r, 50));   // 前のサーバーで使っていた接続が閉じられるのを待つ
  try {
    const j = await (await fetch(base + "/api/subs")).json();
    assert.deepStrictEqual([j.subs.source, j.subs.manual, j.subs.goal, j.subs.read], ["manual", 50, 1500, 1234]);
    assert.strictEqual(j.status.state, "off");
  } finally { await srv.close(); }
});
