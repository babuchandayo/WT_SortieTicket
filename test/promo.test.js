"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../src/server");
const { sanitizePromo, imageExt } = require("../src/promo");

const PORT = 47633;
const base = "http://127.0.0.1:" + PORT;

// 最小の PNG（1x1 透明）
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("sanitizePromo は不正な値を補正する", () => {
  const p = sanitizePromo({
    slides: [
      { id: "a", tpl: "sns", service: "discord", sec: 1, title: " Discord\n", body: "1\n2\n3\n4\n5\n6\n7\n", sub: "招待リンクは概要欄へ", image: "../../etc/passwd", size: 999 },
      { id: "a", tpl: "text" },
      { id: "<b>", tpl: "???", on: false, color: "pink", style: "x", image: "0123456789abcdef.png", frame: "yes" },
      { tpl: "text" },
    ],
    settings: { on: "yes", transition: "spin", gap: -5, scale: 1000, hAlign: "center", vAlign: "nope" },
  });
  assert.deepStrictEqual(p.slides, [
    { id: "a", on: true, tpl: "sns", sec: 3, title: "Discord", body: "1\n2\n3\n4\n5\n6", sub: "招待リンクは概要欄へ", service: "discord", style: "plain", color: "dark", image: "", size: 300, frame: false },
    { id: "b", on: false, tpl: "text", sec: 10, title: "", body: "", sub: "", service: "discord", style: "plain", color: "dark", image: "0123456789abcdef.png", size: 100, frame: false },
  ]);
  assert.deepStrictEqual(p.settings, { on: true, transition: "fade", gap: 0, showBar: true, scale: 300, hAlign: "center", vAlign: "bottom" });
  assert.throws(() => sanitizePromo(null));
});

test("画像の種類は中身で判定する", () => {
  assert.strictEqual(imageExt(PNG), "png");
  assert.strictEqual(imageExt(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.strictEqual(imageExt(Buffer.from("GIF89a\0\0\0\0\0\0")), "gif");
});

test("サーバー: 告知スライドの更新・画像・今すぐ表示", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sortie-"));
  const srv = createServer({ port: PORT, dataDir: dir });
  await srv.listen();
  t.after(() => srv.close());

  assert.strictEqual((await fetch(base + "/promo")).status, 200);

  // 画像のアップロード
  const up = await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG });
  assert.strictEqual(up.status, 200);
  const { name } = await up.json();
  assert.match(name, /^[0-9a-f]{16}\.png$/);
  const g = await fetch(base + "/promo-img/" + name);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.headers.get("content-type"), "image/png");
  assert.deepStrictEqual(Buffer.from(await g.arrayBuffer()), PNG);
  // 画像以外・他サイトからは受け付けない
  assert.strictEqual((await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/svg+xml" }, body: "<svg/>" })).status, 415);
  assert.strictEqual((await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/png", Origin: "https://example.com" }, body: PNG })).status, 403);
  assert.strictEqual((await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.alloc(11 * 1024 * 1024, 1) })).status, 413);
  assert.strictEqual((await fetch(base + "/promo-img/..%2fpromo.json")).status, 404);

  // 状態の更新と保存
  const promo = sanitizePromo({ slides: [{ id: "s1", tpl: "image", image: name }, { id: "s2", tpl: "text", title: "分隊参加はお気軽に!!" }], settings: {} });
  const r = await fetch(base + "/api/promo", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promo }) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await (await fetch(base + "/api/promo")).json()).promo, promo);

  assert.strictEqual((await fetch(base + "/api/promo/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "s2" }) })).status, 200);
  assert.strictEqual((await fetch(base + "/api/promo/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "zz" }) })).status, 404);

  // 使われていない画像は次回起動時に片付けられ、使われている画像は残る
  const up2 = await fetch(base + "/api/promo/image", { method: "POST", headers: { "Content-Type": "image/gif" }, body: Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1") });
  const unused = (await up2.json()).name;
  await srv.close();
  await new Promise((res) => setTimeout(res, 50));
  const srv2 = createServer({ port: PORT, dataDir: dir });
  await srv2.listen();
  t.after(() => srv2.close());
  assert.deepStrictEqual((await (await fetch(base + "/api/promo")).json()).promo, promo);
  assert.strictEqual((await fetch(base + "/promo-img/" + name)).status, 200);
  assert.strictEqual((await fetch(base + "/promo-img/" + unused)).status, 404);
});
