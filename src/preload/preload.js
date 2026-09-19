'use strict';

/**
 * preload.js — 渲染层（壳页面）和主进程之间的安全桥
 *
 * 只把"壳页面需要的几个能力"暴露成 window.difish，
 * 不开放 Node 权限（contextIsolation + sandbox 开启的情况下，这里就是唯一通道）。
 *
 * 想自己加新功能：主进程在 registerIpc() 里加一个 ipcMain.handle，
 * 这里加一行对应的暴露方法，壳页面里就能 window.difish.xxx() 调了。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('difish', {
  /** 读一次当前状态（端口/设置/版本等） */
  getState: () => ipcRenderer.invoke('difish:get-state'),

  /** 改一项设置（主题/毛玻璃/自启等），返回最新设置对象 */
  setSetting: (key, value) => ipcRenderer.invoke('difish:set-setting', key, value),

  /** 标题栏按钮：'min' | 'max' | 'close' | 'recreate' */
  windowAction: (action) => ipcRenderer.invoke('difish:window-action', action),

  /** 打开 dsh 的设置面板（设置已整合进 dsh 设置界面） */
  openSettings: () => ipcRenderer.invoke('difish:open-dsh-settings'),

  /** 重启 dsh 后端 */
  restartBackend: () => ipcRenderer.invoke('difish:restart-backend'),

  /** 用系统浏览器打开外部链接 */
  openExternal: (url) => ipcRenderer.invoke('difish:open-external', url),

  /** 订阅后端状态变化（starting/ready/stopped/error），返回取消函数 */
  onBackendStatus: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('difish:backend-status', listener);
    return () => ipcRenderer.removeListener('difish:backend-status', listener);
  },

  /** 订阅主题变化（设置面板里切换主题时，标题栏跟着变） */
  onThemeChange: (callback) => {
    const listener = (_e, theme) => callback(theme);
    ipcRenderer.on('difish:theme', listener);
    return () => ipcRenderer.removeListener('difish:theme', listener);
  },
});
