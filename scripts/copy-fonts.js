"use strict";
// 必要なフォント（Oswald 700 / Noto Sans JP 900 の woff2 と CSS）だけを src/public/fonts へコピーする。
// フォントパッケージ全体（Noto Sans JP は約85MB）をアプリに同梱しないため。
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "src", "public", "fonts");
const sets = [
  { name: "oswald", pkg: "@fontsource/oswald", css: "700.css", weight: 700 },
  { name: "noto", pkg: "@fontsource/noto-sans-jp", css: "900.css", weight: 900 },
];

for (const s of sets) {
  const src = path.dirname(require.resolve(s.pkg + "/package.json", { paths: [root] }));
  const dst = path.join(out, s.name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.join(dst, "files"), { recursive: true });
  // woff 版の指定は外して woff2 だけを参照させる
  const css = fs.readFileSync(path.join(src, s.css), "utf8").replace(/,\s*url\([^)]*\.woff\) format\('woff'\)/g, "");
  fs.writeFileSync(path.join(dst, s.css), css);
  const re = new RegExp("-" + s.weight + "-normal\\.woff2$");
  let n = 0;
  for (const f of fs.readdirSync(path.join(src, "files"))) {
    if (re.test(f)) { fs.copyFileSync(path.join(src, "files", f), path.join(dst, "files", f)); n++; }
  }
  console.log(s.name + ": " + n + " files");
}
