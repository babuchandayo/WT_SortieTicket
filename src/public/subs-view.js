// 登録者カウンター（告知スライド・スロット告知で共通）。subs-view.css と組で使う。
//   SubsView.build(look, opt) … 表示部品を作る（look: plate / drum / goal / big / red / split）
//   SubsView.set(view)        … 新しい数（{ count, goal, delta }）を、ページ内のすべての部品に反映する
(function () {
  "use strict";
  var view = { count: null, goal: 0, delta: null };

  function h(tag, cls, text) { var el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
  function fmt(n) { return n == null ? "----" : Number(n).toLocaleString("en-US"); }
  function icon() { return h("span", "yt"); }

  var DEFAULT_LABEL = { plate: "チャンネル登録者", drum: "チャンネル登録者数", goal: "チャンネル登録者", big: "チャンネル登録者", red: "チャンネル登録者", split: "CHANNEL SUBSCRIBERS" };

  function build(look, opt) {
    opt = opt || {};
    var root = h("div", "sv sv-" + look);
    root.dataset.sv = look;
    var label = opt.label || DEFAULT_LABEL[look] || "";
    if (look === "plate") {
      root.classList.add("pl");
      var head = root.appendChild(h("div", "head un"));
      head.appendChild(icon());
      head.appendChild(h("span", "n num"));
      root.appendChild(h("div", "pill")).appendChild(h("span", "jp un", label));
    } else if (look === "drum") {
      var lbl = root.appendChild(h("div", "lbl jp ol"));
      lbl.appendChild(icon()); lbl.appendChild(document.createTextNode(label));
      root.appendChild(h("div", "row digits"));
    } else if (look === "goal") {
      var p = root.appendChild(h("div", "p pl"));
      p.appendChild(h("span", "yt un"));
      var nums = p.appendChild(h("span", "nums un"));
      nums.appendChild(h("span", "n num"));
      nums.appendChild(h("span", "goal"));
      var g = root.appendChild(h("div", "gauge"));
      for (var i = 0; i < 10; i++) g.appendChild(h("i")).appendChild(h("b"));
      root.appendChild(h("div", "left jp ol"));
      root.dataset.label = label;
    } else if (look === "big") {
      root.appendChild(h("div", "t jp ol", label));
      var row = root.appendChild(h("div", "row"));
      row.appendChild(h("span", "n num big ol"));
      var d = row.appendChild(h("span", "delta"));
      var ds = d.appendChild(h("span"));
      ds.appendChild(h("span", "dn"));
      ds.appendChild(h("span", "jp", opt.sub || "今日"));
    } else if (look === "red") {
      root.classList.add("sv-card");
      var t = root.appendChild(h("div", "t jp ol"));
      t.appendChild(icon()); t.appendChild(document.createTextNode(label));
      root.appendChild(h("div", "numwrap")).appendChild(h("span", "n num big ol"));
      root.appendChild(h("div", "bar")).appendChild(h("b"));
      root.appendChild(h("div", "sub jp ol"));
      root.dataset.sub = opt.sub || "";
    } else if (look === "split") {
      root.classList.add("sv-card");
      root.appendChild(h("div", "edge"));
      root.appendChild(h("div", "band"));
      root.appendChild(icon());
      var inn = root.appendChild(h("div", "in"));
      inn.appendChild(h("div", "t", label));
      inn.appendChild(h("div", "numwrap")).appendChild(h("span", "n num big ol"));
      inn.appendChild(h("div", "sub jp", opt.sub || "チャンネル登録 よろしく！"));
    }
    update(root, view, null);
    return root;
  }

  // 数字を前の数から今の数まで数え上げる
  function countUp(el, from, to) {
    if (el._raf) cancelAnimationFrame(el._raf);
    if (from == null || to == null || from === to || Math.abs(to - from) > 5000) { el.textContent = fmt(to); return; }
    var t0 = performance.now(), dur = 900;
    (function step(t) {
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) el._raf = requestAnimationFrame(step); else el._raf = null;
    })(t0);
  }
  function bump(el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  function plus(host, d) {
    if (!host || !(d > 0)) return;
    var p = host.appendChild(h("span", "plus", "+" + d.toLocaleString("en-US")));
    setTimeout(function () { p.remove(); }, 1700);
  }

  function drawDrum(root, v, prev) {
    var row = root.querySelector(".digits");
    var s = fmt(v.count), old = row.dataset.s || "";
    if (old.length !== s.length || !prev) {
      row.textContent = "";
      for (var i = 0; i < s.length; i++) {
        if (s[i] === ",") { row.appendChild(h("span", "comma", ",")); continue; }
        var d = row.appendChild(h("div", "d pl"));
        d.appendChild(h("div", "roll")).appendChild(h("span", "n", s[i]));
      }
    } else {
      var tiles = row.children;
      for (var j = 0; j < s.length; j++) {
        if (s[j] === old[j] || s[j] === ",") continue;
        var tile = tiles[j], roll = tile.querySelector(".roll"), cur = roll.lastChild;
        // 前の数字は下へ抜け、新しい数字が上から入る。変わった桁はしばらく黄色にする
        Array.prototype.forEach.call(roll.querySelectorAll(".out"), function (x) { x.remove(); });
        cur.classList.remove("in"); cur.classList.add("out");
        (function (c) { setTimeout(function () { c.remove(); }, 600); })(cur);
        roll.appendChild(h("span", "n in", s[j]));
        tile.classList.add("hot");
        clearTimeout(tile._hot);
        tile._hot = setTimeout(function (t) { t.classList.remove("hot"); }.bind(null, tile), 4000);
      }
    }
    row.dataset.s = s;
  }

  function update(root, v, prev) {
    var look = root.dataset.sv;
    var grew = prev && prev.count != null && v.count != null ? v.count - prev.count : 0;
    var num = root.querySelector(".num");
    if (look === "drum") drawDrum(root, v, prev);
    else if (num) {
      if (prev) countUp(num, prev.count, v.count); else num.textContent = fmt(v.count);
      if (grew > 0) bump(num);
    }
    var hasGoal = v.goal > 0 && v.count != null;
    var left = hasGoal ? Math.max(0, v.goal - v.count) : 0;
    var frac = hasGoal ? Math.min(1, v.count / v.goal) : 0;
    if (look === "goal") {
      root.querySelector(".goal").textContent = hasGoal ? "/ " + fmt(v.goal) : "";
      root.querySelector(".gauge").style.display = hasGoal ? "" : "none";
      Array.prototype.forEach.call(root.querySelectorAll(".gauge b"), function (b, i) { b.style.width = Math.max(0, Math.min(1, frac * 10 - i)) * 100 + "%"; });
      root.classList.toggle("done", hasGoal && left === 0);
      var lt = root.querySelector(".left");
      lt.textContent = "";
      if (!hasGoal) lt.textContent = root.dataset.label;
      else if (left === 0) lt.textContent = "目標 " + fmt(v.goal) + " 人 達成！";
      else { lt.appendChild(document.createTextNode("目標まで あと ")); lt.appendChild(h("span", "n", fmt(left))); lt.appendChild(document.createTextNode(" 人！")); }
    } else if (look === "big") {
      var dl = root.querySelector(".delta");
      dl.style.display = v.delta == null ? "none" : "";
      if (v.delta != null) root.querySelector(".dn").textContent = (v.delta < 0 ? "−" + fmt(-v.delta) : "+" + fmt(v.delta));
    } else if (look === "red") {
      root.querySelector(".bar").style.display = hasGoal ? "" : "none";
      root.querySelector(".bar b").style.width = frac * 100 + "%";
      var sub = root.querySelector(".sub");
      sub.textContent = hasGoal ? (left === 0 ? "目標 " + fmt(v.goal) + " 人 達成！" : "目標 " + fmt(v.goal) + " 人まで あと " + fmt(left) + " 人") : root.dataset.sub;
      sub.style.display = sub.textContent ? "" : "none";
    }
    if (grew > 0) plus(look === "drum" ? root.querySelector(".digits") : num && num.parentNode, grew);
  }

  function set(v) {
    if (!v) return;
    var prev = view;
    view = { count: v.count == null ? null : v.count, goal: v.goal || 0, delta: v.delta == null ? null : v.delta };
    if (prev.count === view.count && prev.goal === view.goal && prev.delta === view.delta) return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-sv]"), function (el) { update(el, view, prev); });
  }

  window.SubsView = { build: build, set: set, fmt: fmt, get view() { return view; } };
})();
