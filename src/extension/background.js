// content.js から受け取った数を、同じパソコンの SortieTicket（http://127.0.0.1:<ポート>/）に送る。
// 送り先はこのパソコンの中だけ。ポートはポップアップで変えられる（既定 4630）。
"use strict";
const DEFAULT_PORT = 4630;

async function port() {
  const v = await chrome.storage.local.get({ port: DEFAULT_PORT });
  const n = Math.round(Number(v.port));
  return n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "subs" || !Number.isInteger(msg.count)) return;
  if (!sender.url || !sender.url.startsWith("https://studio.youtube.com/")) return;
  (async () => {
    const p = await port();
    let ok = false, error = "";
    try {
      const r = await fetch("http://127.0.0.1:" + p + "/api/subs/reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: msg.count }),
      });
      ok = r.ok;
      if (!ok) error = "SortieTicket が受け付けませんでした（" + r.status + "）";
    } catch (e) {
      error = "SortieTicket に届きません。アプリが起動しているか、ポート番号を確認してください";
    }
    await chrome.storage.local.set({ last: { count: msg.count, at: Date.now(), ok, error } });
  })();
});
