'use strict';

/**
 * difish-bridge.js — 注入到 dsh 页面（WebContentsView）的 preload
 *
 * 在 dsh 页面加载前注入 window.difishBridge，让 dsh 里跑的
 * difish 设置插件能调用 difish 壳的原生能力（背景、设置、重启后端）。
 *
 * 只有 difish 壳启动的 dsh 页面才有这个桥；普通 dsh web 没有。
 * 插件侧应先判断 window.difishBridge 是否存在，不存在就自动隐藏/禁用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('difishBridge', {
  /** 读当前背景设置 { type, filePath, opacity, blur } */
  getBackground: () => ipcRenderer.invoke('difish:bg-get'),

  /** 设置背景并应用：{ type, filePath, opacity, blur } */
  setBackground: (bg) => ipcRenderer.invoke('difish:bg-set', bg),

  /** 弹出文件选择框，返回所选图片/视频路径（取消返回 null） */
  chooseBackgroundFile: () => ipcRenderer.invoke('difish:bg-choose'),

  /** 读 difish 壳状态：{ port, backendUp, settings, version } */
  getShellState: () => ipcRenderer.invoke('difish:get-state'),

  /** 改一项 difish 壳设置（自启/通知/托盘/毛玻璃等） */
  setShellSetting: (key, value) => ipcRenderer.invoke('difish:set-setting', key, value),

  /** 重启 dsh 后端 */
  restartBackend: () => ipcRenderer.invoke('difish:restart-backend'),

  /** 检查更新：{ difishVersion, installedDshVersion, latestDshVersion, hasUpdate, error } */
  checkUpdates: () => ipcRenderer.invoke('difish:check-updates'),

  /** 升级 dsh 到最新：{ ok, message, output } */
  updateDsh: () => ipcRenderer.invoke('difish:update-dsh'),

  // ---------- 安全升级（备份 + 校验 + 可回滚） ----------
  /** 查询升级状态：{ installedVersion, stagedVersion, stageReady, pendingAction, mirrors, backups, paths } */
  upgradeStatus: () => ipcRenderer.invoke('difish:upgrade-status'),

  /** 第一步：下载新版到暂存区并校验（不碰现网，dsh 运行中也能做） */
  upgradeDownload: (mirror) => ipcRenderer.invoke('difish:upgrade-download', mirror),

  /** 第二步：安排应用（写标记，重启 difish 后冷启动切换） */
  upgradeApply: () => ipcRenderer.invoke('difish:upgrade-apply'),

  /** 安排回滚到指定备份（不传则用最近一次备份） */
  upgradeRollback: (backupDir) => ipcRenderer.invoke('difish:upgrade-rollback', backupDir),

  /** 放弃已暂存的新版 */
  upgradeDiscard: () => ipcRenderer.invoke('difish:upgrade-discard'),

  /** 重启 difish 自身（应用/回滚需要冷启动） */
  relaunch: () => ipcRenderer.invoke('difish:relaunch'),

  /** 订阅升级日志（返回取消订阅函数） */
  onUpgradeLog: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on('difish:upgrade-log', listener);
    return () => ipcRenderer.removeListener('difish:upgrade-log', listener);
  },

  // ---------- 用户数据快照 / 备份清理 ----------
  /** 概览：要导出哪些内容、多大（不打包） */
  snapshotOverview: () => ipcRenderer.invoke('difish:snapshot-overview'),

  /** 导出快照（记忆 + 会话 + 配置 + 自装插件）→ { ok, file, sizeMB, totalFiles, message } */
  snapshotExport: (opts) => ipcRenderer.invoke('difish:snapshot-export', opts || {}),

  /** 列出已有快照 */
  snapshotList: () => ipcRenderer.invoke('difish:snapshot-list'),

  /** 在资源管理器中打开快照目录 */
  snapshotReveal: () => ipcRenderer.invoke('difish:snapshot-reveal'),

  /** 列出 dsh 备份 */
  backupList: () => ipcRenderer.invoke('difish:backup-list'),

  /** 清理旧备份，只保留最近 keep 个 */
  backupPrune: (keep) => ipcRenderer.invoke('difish:backup-prune', keep),
});
