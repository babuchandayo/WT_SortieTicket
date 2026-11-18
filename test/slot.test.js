"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/server");
const { sanitizeSlot, pickNext, longRunRates } = require("../src/slot");

const PORT = 47634;
const base = "http://127.0.0.1:" + PORT;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// 再現できる乱数
function seeded(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

test("sanitizeSlot は不正な値を補正する", () => {
  const p = sanitizeSlot({
    slides: [
      { id: "a", weight: 0, title: " Discord\n告知 ", color: "pink", image: "../x.png" },
      { id: "a", weight: 5 },
      { id: "<b>", on: false, weight: 1000, image: "0123456789abcdef.webp", color: "air" },
      { weight: 3 },
    ],
    settings: { on: "yes", spinSec: 99, autoEvery: 3, hold: -1, width: 5, frame: "no", hAlign: "left", vAlign: "x", hotkey: "S" },
    last: "zz",
  });
  assert.deepStrictEqual(p.slides, [
    { id: "a", on: true, weight: 1, title: "Discord告知", color: "dark", image: "" },
    { id: "b", on: false, weight: 100, title: "", color: "air", image: "0123456789abcdef.webp" },
  ]);
  assert.deepStrictEqual(p.settings, { on: true, spinSec: 15, autoEvery: 10, hold: 0, width: 160, frame: true, hAlign: "left", vAlign: "middle", hotkey: "Ctrl+Alt+S" });
  assert.strictEqual(p.last, null);
  assert.strictEqual(sanitizeSlot({ slides: [{ id: "a", title: "x" }], settings: { hotkey: "" }, last: "a" }).last, "a");
  assert.strictEqual(sanitizeSlot({ settings: { hotkey: "" } }).settings.hotkey, "");
  assert.throws(() => sanitizeSlot(null));
});

test("抽選: 同じスライドは連続せず、重みの比で選ばれる", () => {
  const slides = [
    { id: "a", on: true, weight: 60, title: "A", image: "" },
    { id: "b", on: true, weight: 30, title: "B", image: "" },
    { id: "c", on: true, weight: 10, title: "C", image: "" },
    { id: "off", on: false, weight: 100, title: "OFF", image: "" },
    { id: "empty", on: true, weight: 100, title: "", image: "" },
  ];
  const rnd = seeded(1);
  const N = 200000;
  const count = { a: 0, b: 0, c: 0 };
  const afterA = { b: 0, c: 0 };
  let last = null;
  for (let i = 0; i < N; i++) {
    const s = pickNext(slides, last, rnd);
    assert.notStrictEqual(s.id, last);
    assert.ok(s.id in count);
    if (last === "a") afterA[s.id]++;
    count[s.id]++;
    last = s.id;
  }
  // 直前が A のときは B:C = 30:10
  assert.ok(Math.abs(afterA.b / (afterA.b + afterA.c) - 0.75) < 0.01);
  // 長く回したときの実際の出現率は longRunRates の値と一致する
  const rates = longRunRates(slides);
  assert.deepStrictEqual(Object.keys(rates).sort(), ["a", "b", "c"]);
  assert.ok(Math.abs(Object.values(rates).reduce((x, y) => x + y, 0) - 1) < 1e-9);
  for (const id of ["a", "b", "c"]) assert.ok(Math.abs(count[id] / N - rates[id]) < 0.005, id);

  // 1 枚だけなら連続でもそれを返す。2 枚なら交互。0 枚なら null
  assert.strictEqual(pickNext([slides[0]], "a").id, "a");
  assert.strictEqual(pickNext(slides.slice(0, 2), "a").id, "b");
  assert.deepStrictEqual(longRunRates(slides.slice(0, 2)), { a: 0.5, b: 0.5 });
  assert.strictEqual(pickNext(slides.slice(3), null), null);
});

test("サーバー: スロット告知の更新・回す・画像の保持", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortie-"));
  const srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  t.after(() => srv.close());

  assert.strictEqual((await fetch(base + "/slot")).status, 200);
  // スライドがないと回せない
  assert.strictEqual((await fetch(base + "/api/slot/spin", json())).status, 409);

  const up = await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
  const { name } = await up.json();
  const slot = sanitizeSlot({ slides: [{ id: "s1", image: name, weight: 50 }, { id: "s2", title: "分隊参加はお気軽に!!" }], settings: { spinSec: 2 } });
  const r = await fetch(base + "/api/slot", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await (await fetch(base + "/api/slot")).json()).slot, slot);

  const s1 = await fetch(base + "/api/slot/spin", json());
  assert.strictEqual(s1.status, 200);
  const spin1 = await s1.json();
  assert.ok(["s1", "s2"].includes(spin1.id));
  assert.strictEqual(spin1.spinMs, 2000);
  // 回っている間はもう一度回せない
  assert.strictEqual((await fetch(base + "/api/slot/spin", json())).status, 409);
  const st = await (await fetch(base + "/api/slot")).json();
  assert.strictEqual(st.slot.last, spin1.id);
  assert.strictEqual(st.spin.seq, spin1.seq);

  // 操作画面からの更新では、直前の結果（last）は書き換えられない
  await fetch(base + "/api/slot", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slot: Object.assign({}, slot, { last: null }) }) });
  assert.strictEqual((await (await fetch(base + "/api/slot")).json()).slot.last, spin1.id);

  await new Promise((res) => setTimeout(res, 2050));
  const spin2 = await (await fetch(base + "/api/slot/spin", json())).json();
  assert.notStrictEqual(spin2.id, spin1.id);   // 2 枚なので必ず交互

  // スロット告知だけで使っている画像も、次回起動時に消されない
  await srv.close();
  await new Promise((res) => setTimeout(res, 50));
  const srv2 = createServer({ port: PORT, dataDir: dir });
  await srv2.listen();
  t.after(() => srv2.close());
  assert.strictEqual((await fetch(base + "/promo-img/" + name)).status, 200);
  assert.strictEqual((await (await fetch(base + "/api/slot")).json()).slot.last, spin2.id);
});
