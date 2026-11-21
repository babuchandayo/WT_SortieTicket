"use strict";
// YouTube Studio の「現在の登録者数」ページをアプリの中で裏に開き、表示されている数を読み取る（Electron のメインプロセス専用）。
// OBS のブラウザソースで Studio を開いてカスタム CSS で切り抜く方法と同じページを使う。API キーは使わない。
// ログインは「ログイン」ボタンで開くウィンドウで行い、ログイン状態はアプリ専用の保存領域（persist:yt-studio）に残る。
const { BrowserWindow, session } = require("electron");
const { parseCount } = require("./subs");

const PARTITION = "persist:yt-studio";
const READ_EVERY = 5000;          // 読み取る間隔
const RELOAD_EVERY = 15 * 60e3;   // ページを開き直す間隔（長時間開きっぱなしで止まるのを防ぐ）
const LOAD_TIMEOUT = 60e3;

// ページ内で実行する。カウンターの中の数字のうち「枠の中に見えているもの」だけを左から並べて返す。
// （数字が回るアニメーション用に、見えていない数字が並んでいても拾わないように位置で判定する）
const READ_SCRIPT = `(function () {
  var root = document.querySelector("yta-smooth-counter #counter") || document.querySelector("yta-smooth-counter");
  if (!root) return { found: false, host: location.host, path: location.pathname };
  var box = root.getBoundingClientRect();
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
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var el = n.parentElement, vis = true;
      // 祖先の overflow で切られている（枠の外にある）数字は除く
      for (var p = el; p && p !== root.parentElement; p = p.parentElement) {
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
  return { found: true, text: chars.map(function (c) { return c.c; }).join(""), raw: (root.innerText || "").slice(0, 60) };
})()`;

function chromeLikeUA(ua) {
  // Google のログイン画面は埋め込みブラウザを嫌うことがあるため、アプリ名・Electron の表記を外す
  return ua.replace(/\s(?:Electron|SortieTicket|wt-sortieticket)\/\S+/gi, "");
}

function createSubsReader(srv, opts) {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(chromeLikeUA(ses.getUserAgent()));
  let win = null;           // 裏で開いている Studio
  let loginWin = null;      // ログイン用に見せるウィンドウ
  let readTimer = null, reloadTimer = null, loadTimer = null;
  let pending = null;       // 2 回続けて同じ数が読めたら採用する（数字が切り替わる途中を拾わないため）
  let lastOkAt = 0;
  let loadFailed = false;   // ページを開けなかった（その間は「待っています」で上書きしない）
  let stopped = true;

  function status(state, msg) { srv.setSubsStatus(state, msg); }
  function settings() { return srv.getSubs().subs; }

  function clearTimers() {
    clearTimeout(readTimer); clearTimeout(reloadTimer); clearTimeout(loadTimer);
    readTimer = reloadTimer = loadTimer = null;
  }

  function stop(state, msg) {
    stopped = true;
    clearTimers();
    pending = null;
    if (win) { win.destroy(); win = null; }
    if (state) status(state, msg);
  }

  function start() {
    stop();
    const s = settings();
    if (s.source !== "studio") { status("off", "手入力の数を使っています"); return; }
    if (!s.url) { status("off", "YouTube Studio の URL を設定してください"); return; }
    stopped = false;
    status("loading", "YouTube Studio を開いています…");
    win = new BrowserWindow({
      show: false, width: 1280, height: 900,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("did-finish-load", () => { loadFailed = false; });
    load(s.url);
    loadTimer = setTimeout(() => { if (!lastOkAt && !stopped) status("error", "読み込みに時間がかかっています。URL が「現在の登録者数」のページか確認してください"); }, LOAD_TIMEOUT);
    readTimer = setTimeout(readLoop, 3000);
    scheduleReload(RELOAD_EVERY);
  }

  // ページを開く。開けなかったときは 1 分後に開き直す
  function load(url) {
    loadFailed = false;
    pending = null;
    win.loadURL(url).catch((e) => {
      const msg = String(e && e.message);
      if (stopped || /ERR_ABORTED/.test(msg)) return;   // 開き直しなどで中止しただけ
      loadFailed = true;
      const m = /(ERR_[A-Z_]+)/.exec(msg);
      status("error", "ページを開けませんでした（" + (m ? m[1] : "不明なエラー") + "）。ネットにつながっているか確認してください");
      scheduleReload(60e3);
    });
  }

  function scheduleReload(ms) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { if (!stopped && win) { load(settings().url); scheduleReload(RELOAD_EVERY); } }, ms);
  }

  async function readLoop() {
    if (stopped || !win) return;
    if (loadFailed) { readTimer = setTimeout(readLoop, READ_EVERY); return; }
    try {
      const url = win.webContents.getURL();
      if (/^https:\/\/accounts\.google\.com\//.test(url) || /ServiceLogin|signin/i.test(url)) {
        status("login", "ログインが必要です。「ログイン」から YouTube にログインしてください");
      } else {
        const r = await win.webContents.executeJavaScript(READ_SCRIPT, true);
        if (!r || !r.found) {
          if (!win.webContents.isLoading()) status(lastOkAt ? "error" : "loading", lastOkAt
            ? "数が見つかりません。ログアウトされたか、Studio の画面が変わった可能性があります"
            : "数が表示されるのを待っています…（ずっとこのままなら URL かログインを確認してください）");
        } else {
          const n = parseCount(r.text);
          if (n === null) status("error", "数を読み取れませんでした（表示: " + (r.raw || "空") + "）");
          else if (pending === n) {
            lastOkAt = Date.now();
            clearTimeout(loadTimer);
            srv.setSubsReading(n);
            status("ok", "");
          } else pending = n;
        }
      }
    } catch (e) {
      // ページの読み込み中などは失敗することがある。次の回に任せる
    }
    if (!stopped) readTimer = setTimeout(readLoop, READ_EVERY);
  }

  function openLogin() {
    const s = settings();
    if (loginWin) { loginWin.focus(); return; }
    loginWin = new BrowserWindow({
      width: 1100, height: 820, title: "YouTube にログイン（終わったらこのウィンドウを閉じてください）",
      parent: opts && opts.parent ? opts.parent() : undefined,
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    loginWin.setMenuBarVisibility(false);
    loginWin.webContents.setWindowOpenHandler(({ url }) => { loginWin.loadURL(url); return { action: "deny" }; });
    loginWin.loadURL(s.url || "https://studio.youtube.com/").catch(() => {});
    loginWin.on("closed", () => { loginWin = null; start(); });
  }

  srv.onSubsChange((s, info) => { if (info.sourceChanged || info.urlChanged) start(); });

  return {
    start,
    openLogin,
    reload: start,
    async logout() { stop(); await ses.clearStorageData(); start(); },
    close() { stop(); if (loginWin) { loginWin.destroy(); loginWin = null; } },
  };
}

module.exports = { createSubsReader, chromeLikeUA };
