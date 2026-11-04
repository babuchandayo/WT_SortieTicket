"use strict";
// Electron のエントリーポイント。ローカルサーバーを起動し、操作画面をウィンドウで開く。
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");
const { createServer } = require("./server");

const DEFAULT_PORT = 4630;

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; }
}

function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let srv = null;

  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath("userData");
    const configFile = path.join(dataDir, "config.json");
    const config = readConfig(configFile);
    const port = Number(config.port) || DEFAULT_PORT;
    if (!fs.existsSync(configFile)) writeConfig(configFile, { port });

    srv = createServer({ port, dataDir });
    try {
      await srv.listen();
    } catch (e) {
      const msg = e.code === "EADDRINUSE"
        ? "ポート " + port + " は他のアプリが使っています。\n" +
          "SortieTicket がすでに起動していないか確認してください。\n\n" +
          "別のポートを使う場合は、次のファイルの port を書き換えて再起動してください。\n" + configFile
        : String(e && e.message || e);
      dialog.showErrorBox("SortieTicket を起動できません", msg);
      app.quit();
      return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "ファイル", submenu: [
        { label: "設定フォルダを開く", click: () => shell.openPath(dataDir) },
        { type: "separator" },
        { role: "quit", label: "終了" },
      ] },
      { label: "表示", submenu: [
        { role: "reload", label: "再読み込み" },
        { role: "toggleDevTools", label: "開発者ツール" },
        { type: "separator" },
        { role: "resetZoom", label: "等倍" },
        { role: "zoomIn", label: "拡大" },
        { role: "zoomOut", label: "縮小" },
      ] },
    ]));

    win = new BrowserWindow({
      width: 520,
      height: 860,
      minWidth: 380,
      minHeight: 500,
      title: "SortieTicket",
      backgroundColor: "#15181d",
      alwaysOnTop: config.alwaysOnTop === true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "preload.js") },
    });

    // 最前面表示の切り替え（状態は config.json に保存して次回も引き継ぐ）
    const fromWin = (e) => win && e.sender === win.webContents;
    ipcMain.handle("always-on-top:get", (e) => fromWin(e) && win.isAlwaysOnTop());
    ipcMain.handle("always-on-top:set", (e, on) => {
      if (!fromWin(e)) return false;
      win.setAlwaysOnTop(on === true);
      writeConfig(configFile, Object.assign(readConfig(configFile), { alwaysOnTop: win.isAlwaysOnTop() }));
      return win.isAlwaysOnTop();
    });
    // 勝敗カウンターのグローバルホットキー（このウィンドウが前面になくても受け付ける）
    let hotkeyStatus = {};
    function registerHotkeys(keys) {
      globalShortcut.unregisterAll();
      hotkeyStatus = {};
      for (const name of Object.keys(keys)) {
        const acc = keys[name];
        if (!acc) { hotkeyStatus[name] = { key: "", ok: true }; continue; }
        let ok = false;
        try { ok = globalShortcut.register(acc, () => srv.counterAction(name, "hotkey")); } catch (e) { ok = false; }
        hotkeyStatus[name] = { key: acc, ok };
      }
      if (win) win.webContents.send("hotkeys:status", hotkeyStatus);
    }
    registerHotkeys(srv.getCounter().counter.settings.hotkeys);
    srv.onCounterChange((c, info) => { if (info.hotkeysChanged) registerHotkeys(c.settings.hotkeys); });
    ipcMain.handle("hotkeys:status", (e) => (fromWin(e) ? hotkeyStatus : {}));
    // 割り当て変更のキー入力中は、既存のホットキーが反応しないよう一時的に外す
    ipcMain.handle("hotkeys:pause", (e, on) => {
      if (!fromWin(e)) return;
      if (on === true) globalShortcut.unregisterAll(); else registerHotkeys(srv.getCounter().counter.settings.hotkeys);
    });

    // 外部リンクは既定のブラウザで開く
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.loadURL(srv.url + "control?app=1");
    win.on("closed", () => { win = null; });
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("before-quit", () => { if (srv) srv.close(); });
}
