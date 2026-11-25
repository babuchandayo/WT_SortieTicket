// YouTube Studio のページで動く。「現在の登録者数」のカウンターがあれば、表示中の数を数秒ごとに読んで送る。
// 読むだけで、ページの操作やほかの情報の取得はしない。
(function () {
  "use strict";
  var EVERY = 5000;
  var last = null, pending = null;

  // カウンターの中の数字のうち「枠の中に見えているもの」だけを左から並べる
  // （数字が回るアニメーション用に、見えていない数字が並んでいても拾わないように位置で判定する）
  function readCounter() {
    var root = document.querySelector("yta-smooth-counter #counter") || document.querySelector("yta-smooth-counter");
    if (!root) return null;
    var box = root.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    var chars = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var t = n.nodeValue;
      for (var i = 0; i < t.length; i++) {
        if (!/[0-9]/.test(t[i])) continue;
        range.setStart(n, i); range.setEnd(n, i + 1);
        var r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2, vis = true;
        for (var p = n.parentElement; p && p !== root.parentElement; p = p.parentElement) {
          var cs = getComputedStyle(p);
          if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") { vis = false; break; }
          if (cs.overflow !== "visible" || cs.overflowY !== "visible") {
            var pr = p.getBoundingClientRect();
            if (cy < pr.top || cy > pr.bottom || cx < pr.left || cx > pr.right) { vis = false; break; }
          }
        }
        if (!vis || cy < box.top || cy > box.bottom) continue;
        chars.push({ x: cx, c: t[i] });
      }
    }
    chars.sort(function (a, b) { return a.x - b.x; });
    var s = chars.map(function (c) { return c.c; }).join("");
    return /^[0-9]{1,12}$/.test(s) ? Number(s) : null;
  }

  function tick() {
    var n = null;
    try { n = readCounter(); } catch (e) { n = null; }
    if (n === null) { pending = null; return; }
    // 数字が切り替わる途中を拾わないよう、新しい数は 2 回続けて同じだったら採用する
    if (n !== last && n !== pending) { pending = n; return; }
    last = n; pending = null;
    try { chrome.runtime.sendMessage({ type: "subs", count: n }); } catch (e) { /* 拡張機能が更新された直後など */ }
  }
  setInterval(tick, EVERY);
  tick();
})();
