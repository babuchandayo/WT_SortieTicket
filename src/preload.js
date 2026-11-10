"use strict";
// 操作画面（アプリのウィンドウ）にだけ公開する機能
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sortieApp", {
  getAlwaysOnTop: () => ipcRenderer.invoke("always-on-top:get"),
  setAlwaysOnTop: (on) => ipcRenderer.invoke("always-on-top:set", on === true),
  getHotkeyStatus: () => ipcRenderer.invoke("hotkeys:status"),
  pauseHotkeys: (on) => ipcRenderer.invoke("hotkeys:pause", on === true),
  onHotkeyStatus: (fn) => { ipcRenderer.on("hotkeys:status", (e, s) => fn(s)); },
});
