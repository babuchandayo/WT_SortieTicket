"use strict";
const st = document.getElementById("st"), portIn = document.getElementById("port");
function draw(v) {
  const l = v.last;
  portIn.value = v.port;
  if (!l) { st.className = "st"; st.textContent = "まだ送っていません。YouTube Studio の「現在の登録者数」のページを開いてください"; return; }
  const t = new Date(l.at).toLocaleTimeString("ja-JP");
  st.className = "st " + (l.ok ? "ok" : "ng");
  st.textContent = l.ok ? "✓ " + l.count.toLocaleString("en-US") + " 人を送りました（" + t + "）" : "✕ " + l.error + "（" + t + "）";
}
chrome.storage.local.get({ port: 4630, last: null }).then(draw);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get({ port: 4630, last: null }).then(draw));
portIn.addEventListener("change", () => {
  const n = Math.round(Number(portIn.value));
  if (n >= 1 && n <= 65535) chrome.storage.local.set({ port: n });
});
