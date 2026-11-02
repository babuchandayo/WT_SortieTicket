"use strict";
// Electron のエントリーポイント。ローカルサーバーを起動し、操作画面をウィンドウで開く。
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { createServer } = require("./server");

const DEFAULT_PORT = 4630;

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; }
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
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ port }, null, 2));
    }

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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // 外部リンクは既定のブラウザで開く
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.loadURL(srv.url + "control?app=1");
    win.on("closed", () => { win = null; });
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { if (srv) srv.close(); });
}
