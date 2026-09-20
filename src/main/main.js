'use strict';

/**
 * main.js — difish 主进程入口
 *
 * 职责（一句话版）：
 *   1. 拉起 dsh web 后端（见 backend.js）
 *   2. 建一个无边框 + 毛玻璃的壳窗口（自绘标题栏，见 src/renderer/shell.html）
 *   3. 用 WebContentsView 把 dsh web 页面嵌进内容区
 *   4. 系统集成：托盘常驻 / 最小化到托盘 / 全局快捷键 / 开机自启 / 完成通知
 *
 * 想自己改：文件里每个功能块都有中文注释，从上往下读即可。
 */

const { app, BrowserWindow, WebContentsView, Tray, Menu, globalShortcut, Notification, ipcMain, nativeImage, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { findFreePort, startDsh, stopDsh } = require('./backend');
const bg = require('./background');
const { ensureDifishPlugin } = require('./plugin');
const updater = require('./updater');
const upgrade = require('./upgrade');
const snapshot = require('./snapshot');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const APP_NAME = 'difish';
/** 自绘标题栏高度（像素），必须和 shell.css 里的 #titlebar 高度一致 */
const TITLEBAR_HEIGHT = 38;
/** 后端"安静"多久算一次任务完成（毫秒） */
const IDLE_NOTIFY_MS = 25 * 1000;

/**
 * 点标题栏 ⚙ 时在 dsh 页面里打开设置面板的脚本（尽力而为，多策略）：
 * 1) 找设置区域的按钮/trigger 直接 click
 * 2) 兜底：找文本恰为「设置」的叶子元素，向上找可点击祖先
 */
const OPEN_SETTINGS_JS = `(function(){
  function fire(el){ try{ el.click(); return true; }catch(e){ return false; } }
  var sels = [
    '[class*="settingsArea"] [role="button"]',
    '[class*="settingsArea"] button',
    '[class*="settingsTrigger"]',
  ];
  for (var i = 0; i < sels.length; i++) {
    var els = document.querySelectorAll(sels[i]);
    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      if (el.offsetParent !== null) { if (fire(el)) return true; }
    }
  }
  var all = document.querySelectorAll('div,span,button,[role="button"]');
  for (var k = 0; k < all.length; k++) {
    var n = all[k];
    if (n.children.length === 0 && /^\\s*设置\\s*$/.test(n.textContent || '')) {
      var c = n.closest('[role="button"],button,[class*="trigger"]') || n;
      if (fire(c)) return true;
    }
  }
  return false;
})()`;

/**
 * 注入到 dsh 页面的 UI 修正 CSS（始终生效，与背景无关）：
 *  - 去掉侧边栏会话列表底部的渐隐黑边（dsh 的 .qDHVXG_fade：从透明渐变到侧边栏深色的 24px 条）
 */
const UI_FIX_CSS = `
  /* 隐藏侧边栏列表底部的渐隐条（[class$="_fade"] 兼容 hash 前缀变化） */
  [class$="_fade"] { display: none !important; }
`;

// ---------------------------------------------------------------------------
// 运行状态
// ---------------------------------------------------------------------------
let mainWindow = null;    // 壳窗口（无边框 + 毛玻璃）
let contentView = null;   // 承载 dsh web 的 WebContentsView
let tray = null;
let dshProcess = null;    // 后端子进程
let port = null;          // 后端实际端口
let quitting = false;     // 是否正在退出（退出时关窗不再收进托盘）
let currentBackendUrl = null; // 后端 URL（窗口重建后重新挂载用）
let lastBackendActivity = 0;  // 后端最后一次输出日志的时间
let activitySinceNotify = false; // 自上次通知后是否有过活动
let notifiedForCycle = false;    // 本轮空闲是否已通知过

// ---------------------------------------------------------------------------
// 设置（持久化到 userData/settings.json）
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  theme: 'dark',        // 外观主题：'dark' | 'light'
  glass: 'acrylic',     // 毛玻璃档位：'acrylic' | 'mica' | 'tabbed' | 'none'（仅 Win11）
  minimizeToTray: true, // 关窗时收进托盘（而不是退出）
  launchAtLogin: false, // 开机自启
  notifyOnComplete: true, // 后端任务完成通知
  globalShortcut: 'CommandOrControl+Shift+D', // 唤出窗口的全局快捷键
  autoCheckUpdates: true, // 启动时静默检查 dsh 新版本，有新版就通知一次
  background: {         // 背景：'none' | 'image' | 'video' | 'transparent'
    type: 'none',
    filePath: '',       // 图片/视频文件的完整路径
    opacity: 0.4,       // 透明程度 0~1（页面遮罩厚度：0=完全透明，1=不透明）
    blur: 0,            // 图片/视频背景的模糊 0~50 px
    filter: 'glass',    // 透明模式的滤镜：'none'（纯透明，直接透出壁纸）| 'glass'（毛玻璃，壁纸模糊透出）
  },
};
let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    console.log('[difish] 设置已保存到', settingsPath());
  } catch (err) {
    console.error('[difish] 保存设置失败:', settingsPath(), err);
  }
}
function setSetting(key, value) {
  if (!(key in settings)) return;
  settings[key] = value;
  saveSettings();
}

// ---------------------------------------------------------------------------
// 资源路径（开发时在项目里，打包后在 app.asar 里）
// ---------------------------------------------------------------------------
function iconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'icon.ico');
}
function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'preload.js');
}
/** 注入到 dsh 页面（WebContentsView）的桥 preload：暴露 window.difishBridge */
function difishBridgePreloadPath() {
  return path.join(__dirname, '..', 'preload', 'difish-bridge.js');
}
function shellPath() {
  return path.join(__dirname, '..', 'renderer', 'shell.html');
}

// ---------------------------------------------------------------------------
// 后端生命周期
// ---------------------------------------------------------------------------
async function bootBackend() {
  if (dshProcess) return;
  try {
    port = await findFreePort();
  } catch (e) {
    sendBackendStatus('error', '找不到空闲端口: ' + e.message);
    return;
  }
  sendBackendStatus('starting', '正在启动后端...');
  // 确保 difish 设置插件就绪（junction + patch），让 dsh 设置里有 difish 页
  const patch = ensureDifishPlugin(app.getPath('userData'));
  dshProcess = startDsh({
    port,
    patch,
    onLog(text) {
      lastBackendActivity = Date.now();
      activitySinceNotify = true;
      const t = text.trim();
      if (t) console.log('[dsh]', t.slice(0, 400));
    },
    onReady({ url, port: p }) {
      // 关键：url 里带着 dsh 的进程令牌，必须原样加载一次
      // （dsh 会用 token 换一个签名 cookie 再 302 到干净的 /）。
      // 以前这里只拼 http://127.0.0.1:端口，token 丢了 → 页面报
      // "dsh web authentication required; reopen the URL printed by dsh web."
      currentBackendUrl = url;
      port = p; // dsh 可能没用我们给的端口（被占），以就绪行为准
      mountContentView(currentBackendUrl);
      sendBackendStatus('ready', `http://127.0.0.1:${p}`);
    },
    onExit(code) {
      dshProcess = null;
      if (!quitting) sendBackendStatus('stopped', `后端已退出 (code=${code})`);
    },
    onError(err) {
      console.error('[difish] 后端启动失败:', err.message);
      sendBackendStatus('error', err.message);
    },
  });
}

/** 重启后端：停掉旧的（连窗口内容一起清掉），重新拉一个 */
async function restartBackend() {
  if (dshProcess) {
    stopDsh(dshProcess);
    dshProcess = null;
  }
  if (contentView) {
    mainWindow && mainWindow.contentView.removeChildView(contentView);
    try { contentView.webContents.close(); } catch { /* 忽略 */ }
    contentView = null;
  }
  currentBackendUrl = null;
  await bootBackend();
}

// ---------------------------------------------------------------------------
// 窗口：壳 + 内容区（WebContentsView）
// ---------------------------------------------------------------------------
function createWindow() {
  // 透明模式：透明程度（页面遮罩）与滤镜（无/毛玻璃）独立控制
  //  - filter 'glass'：窗口不透明 + Acrylic 材质（壁纸模糊透出）
  //  - filter 'none' ：真透明窗口（transparent:true，壁纸清晰透出，无玻璃感）
  // 窗口的 transparent/材质必须在构造时设置，所以切换滤镜/进出透明模式都要重建窗口。
  const transparent = settings.background && settings.background.type === 'transparent';
  const glassFilter = transparent && settings.background.filter === 'glass';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    frame: false, // 无系统边框，标题栏自己画（shell.html）
    show: false,  // 等 ready-to-show 再显示，避免白屏闪烁
    icon: iconPath(),
    backgroundColor: transparent ? '#00000000' : (settings.theme === 'dark' ? '#10131a' : '#eef1f6'),
    transparent: transparent && !glassFilter, // 毛玻璃滤镜用材质承载；无滤镜才是真透明窗口
    backgroundMaterial: glassFilter ? 'acrylic' : (transparent ? 'none' : settings.glass),
    hasShadow: !transparent,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(shellPath());

  // 诊断：壳页面加载失败/渲染进程退出时打日志（平时不会输出）
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[difish] 壳页面加载失败:', code, desc, url);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[difish] 壳渲染进程退出:', details.reason, details.exitCode);
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    // 窗口**真正显示之后**才让壳页面开始播开机动画 ——
    // 否则页面在 show:false 期间就把 4 秒素材播完了，用户什么也看不到。
    mainWindow.webContents
      .executeJavaScript('window.__wvStartBoot && window.__wvStartBoot()')
      .catch(() => { /* 忽略 */ });
  });
  mainWindow.on('page-title-updated', (_e, title) => {
    console.log('[difish] 窗口标题变为:', title);
  });
  mainWindow.on('resize', layout);
  mainWindow.on('maximize', layout);
  mainWindow.on('unmaximize', layout);

  // 关窗行为：默认收进托盘；只有真正退出（quitting）才销毁
  mainWindow.on('close', (e) => {
    if (!quitting && settings.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    contentView = null;
  });
}

/** 布局：标题栏 38px 在上，WebContentsView 填满剩余区域 */
function layout() {
  if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
  const [w, h] = mainWindow.getContentSize();
  contentView.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: w,
    height: Math.max(0, h - TITLEBAR_HEIGHT),
  });
}

/** 把 dsh web 页面挂进壳窗口的内容区 */
function mountContentView(url) {
  if (!mainWindow) return;
  try {
    // 清掉旧的 view（避免重复挂载）
    if (contentView) {
      mainWindow.contentView.removeChildView(contentView);
      try { contentView.webContents.close(); } catch { /* 忽略 */ }
      contentView = null;
    }
    contentView = new WebContentsView({
      webPreferences: {
        preload: difishBridgePreloadPath(), // 给 dsh 页面注入 window.difishBridge
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.contentView.addChildView(contentView);
    // 透明玻璃模式：WebContentsView 必须设透明背景，否则在透明窗口上是黑块（Bigfish 同款坑）
    if (settings.background && settings.background.type === 'transparent') {
      try { contentView.setBackgroundColor('#00000000'); } catch { /* 忽略 */ }
    }
    layout();
    // 加载失败/崩溃时打日志（平时不输出）
    contentView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      console.error('[difish] 内容视图加载失败:', code, desc, url, 'isMainFrame=' + isMainFrame);
    });
    contentView.webContents.on('render-process-gone', (_e, details) => {
      console.error('[difish] 内容渲染进程退出:', details.reason, details.exitCode);
    });
    // 诊断：把 dsh 页面的 console 转发到主进程（Electron 44 新签名）
    contentView.webContents.on('console-message', (event) => {
      console.log('[dsh-page]', event.level, event.message);
    });
    contentView.webContents.on('preload-error', (_e, preloadPath, error) => {
      console.error('[difish] preload 错误:', preloadPath, error.message);
    });
    contentView.webContents.loadURL(url);
    // 页面加载完成后：应用上次保存的背景（如果有）、注入 UI 修正 CSS、同步透明窗口状态
    contentView.webContents.once('did-finish-load', () => {
      contentView.webContents.insertCSS(UI_FIX_CSS).catch(() => {});
      // ⚠️ 必须用 setBackground 而不是 applyBackground：
      // background.js 里的 `current` 默认是 type:'none'，只有 setBackground 会把
      // 真正的设置灌进去。直接调 applyBackground 会走「无背景」分支 ——
      // 表现就是「设置里明明选了壁纸，每次启动却都没有，得手动再选一次」。
      const b = settings.background || DEFAULT_SETTINGS.background;
      bg.setBackground(contentView.webContents, b);
      applyTransparency();
    });
  } catch (e) {
    console.error('[difish] mountContentView 异常:', e);
  }
}

/** 外观档位（毛玻璃）动态应用：非透明时即时切换材质（标题栏玻璃用） */
function applyGlassSetting() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 透明玻璃模式固定用构造时的 Acrylic，不在这里改材质
    if (settings.background && settings.background.type === 'transparent') return;
    try { mainWindow.setBackgroundMaterial(settings.glass); } catch { /* Win10 不支持，忽略 */ }
  }
}

/** 记录透明模式 + 滤镜组合，变化时重建窗口（transparent/材质必须构造时设置） */
let lastTransparentKey = '';

/**
 * 透明模式：
 *   - 透明程度（opacity，页面遮罩厚度）变化 → 只重注入页面遮罩，不重建窗口
 *   - 滤镜（filter）或进出透明模式 → 重建窗口让构造时参数生效
 * filter 'glass' = Acrylic 毛玻璃（壁纸模糊透出）；'none' = 纯透明（壁纸清晰透出）
 */
function applyTransparency() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const t = settings.background && settings.background.type === 'transparent';
  const key = t ? ('transparent:' + (settings.background.filter || 'glass')) : '';
  if (key !== lastTransparentKey) {
    lastTransparentKey = key;
    recreateMainWindow();
  }
}

/**
 * 重建主窗口：透明玻璃进入/退出、主题/毛玻璃大改时用。
 * 后端保持运行，重建后按 currentBackendUrl 重新挂载内容区。
 */
function recreateMainWindow() {
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
  createWindow();
  if (bounds) mainWindow.setBounds(bounds);
  // 后端若已就绪，重新挂载内容
  if (currentBackendUrl) mountContentView(currentBackendUrl);
  sendThemeToShell();
}

// ---------------------------------------------------------------------------
// 窗口控制（给标题栏按钮用）
// ---------------------------------------------------------------------------
function toggleMaximize() {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
}
function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}
function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  rebuildTrayMenu();
  tray.on('click', showWindow); // 单击唤回
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开 ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => setLaunchAtLogin(item.checked),
    },
    {
      label: '完成通知',
      type: 'checkbox',
      checked: settings.notifyOnComplete,
      click: (item) => setSetting('notifyOnComplete', item.checked),
    },
    { type: 'separator' },
    { label: '重启后端', click: () => restartBackend() },
    { label: '退出', click: quitApp },
  ]));
}

// ---------------------------------------------------------------------------
// 系统集成：开机自启 / 全局快捷键 / 通知
// ---------------------------------------------------------------------------

/**
 * 登录项参数。
 *
 * name —— 注册表里的「值名」。不指定时 Electron 用 AppUserModelId，
 *         difish 是 com.difish.desktop，在「任务管理器 → 启动」里显示成一串包名，
 *         很难认。显式给个友好名。
 * path —— 开发模式（npm start）下 process.execPath 是 electron.exe，
 *         必须把应用目录作为参数传进去，否则开机启动的是一个没有应用的 Electron。
 */
function loginItemOptions() {
  const base = { name: 'difish' };
  return app.isPackaged
    ? { ...base, path: process.execPath }
    : { ...base, path: process.execPath, args: [app.getAppPath()] };
}

/**
 * 把开机自启设置应用到系统（幂等，可重复调用）。
 *
 * 为什么需要一个独立的"应用"函数：
 *   早期实现只在用户切换开关时写注册表，**启动时从不重新应用**。
 *   于是"设置里是 true、系统里却没有"这种不一致会永久保持 ——
 *   比如从别的机器把 settings.json 带过来（注册表是机器本地的，不会跟着走），
 *   或者注册表项被安全软件/系统优化工具清掉。
 *   表现就是：开关看着是开的，开机就是不启动。
 */
function applyLaunchAtLogin(value) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!value,
      ...loginItemOptions(),
    });
    return true;
  } catch (e) {
    console.error('[difish] 应用开机自启失败:', e.message);
    return false;
  }
}

/** 用户切换开关：存设置 + 立即应用 */
function setLaunchAtLogin(value) {
  setSetting('launchAtLogin', value);
  applyLaunchAtLogin(value);
}

/**
 * 启动时对账：设置说 true 但系统里没有 → 补上；说 false 但系统里有 → 清掉。
 * 只在真的不一致时才动注册表，避免每次启动都白写一遍。
 */
function reconcileLaunchAtLogin() {
  const want = !!settings.launchAtLogin;
  let actual = false;
  try {
    actual = !!app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch (e) {
    // 读不到状态就按设置补一次 —— 宁可多写，不可漏写
    console.warn('[difish] 读取开机自启状态失败，按设置补写:', e.message);
    applyLaunchAtLogin(want);
    return;
  }
  if (want !== actual) {
    console.log(`[difish] 开机自启对账：设置=${want} 系统=${actual} → 修正为 ${want}`);
    applyLaunchAtLogin(want);
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(settings.globalShortcut, toggleWindow);
    if (!ok) console.warn('[difish] 快捷键注册失败（可能被占用）:', settings.globalShortcut);
  } catch (e) {
    console.warn('[difish] 快捷键注册异常:', e.message);
  }
}

function notify(title, body) {
  try {
    new Notification({ title, body, icon: iconPath() }).show();
  } catch (e) {
    console.error('[difish] 通知失败:', e.message);
  }
}

/** 完成通知（启发式）：后端刚忙过一阵，然后安静超过 IDLE_NOTIFY_MS，通知一次 */
function startCompletionWatcher() {
  setInterval(() => {
    if (!settings.notifyOnComplete) return;
    const idle = Date.now() - lastBackendActivity;
    if (idle > IDLE_NOTIFY_MS && activitySinceNotify && !notifiedForCycle) {
      notifiedForCycle = true;
      activitySinceNotify = false;
      notify(APP_NAME, '后端任务已完成');
    } else if (idle < IDLE_NOTIFY_MS) {
      notifiedForCycle = false; // 又有活动了，允许下次再通知
    }
  }, 5000);
}

/**
 * 冷启动处理 dsh 升级：修复被中断的状态 + 执行 pending 的 应用/回滚。
 * 必须在 bootBackend() 之前调用。
 */
async function recoverDshUpgrade() {
  const st = upgrade.upgradeStatus();
  const needsWork = !st.installedVersion || st.pendingAction;
  if (!needsWork) {
    // 没有待办也要顺手清理旧备份：每升一次 +214MB，不清理会一直堆
    try {
      const pr = snapshot.pruneBackups({ keep: 3 });
      if (pr.removed && pr.removed.length) console.log('[difish-backup]', pr.message);
    } catch (e) {
      console.error('[difish-backup] 清理失败:', e && e.message);
    }
    return;
  }
  const result = await upgrade.recoverAndApply({
    onLog: (line) => console.log('[difish-upgrade]', line.slice(0, 300)),
  });
  if (!result || result.action === 'none') return;
  console.log('[difish-upgrade]', result.action, result.ok ? 'OK' : 'FAILED', result.message);
  if (result.ok) {
    notify(APP_NAME, result.message);
  } else {
    notify(APP_NAME, 'dsh 升级/回滚失败：' + result.message);
  }
  // 升级/回滚完成后清理旧备份（保留最近 3 个）
  try {
    const pr = snapshot.pruneBackups({ keep: 3 });
    if (pr.removed && pr.removed.length) {
      console.log('[difish-backup]', pr.message);
      notify(APP_NAME, pr.message);
    }
  } catch (e) {
    console.error('[difish-backup] 清理失败:', e && e.message);
  }
}

/** 启动后静默检查一次 dsh 更新，发现新版就通知（不打扰） */
function maybeAutoCheckUpdates() {  if (!settings.autoCheckUpdates) return;
  setTimeout(() => {
    updater.checkUpdates(app.getVersion())
      .then((info) => {
        if (info.hasUpdate && info.latestDshVersion) {
          notify(APP_NAME, `发现 dsh 新版本 ${info.latestDshVersion}（当前 ${info.installedDshVersion}）\n在 difish 设置 → 更新 里可一键升级`);
        }
      })
      .catch(() => { /* 静默失败，不打扰用户 */ });
  }, 20 * 1000);
}

// ---------------------------------------------------------------------------
// 给壳页面（shell.html）发状态 / 收指令
// ---------------------------------------------------------------------------
function sendBackendStatus(status, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('difish:backend-status', { status, detail: detail || '' });
  }
}
function sendThemeToShell() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('difish:theme', settings.theme);
  }
}

function registerIpc() {
  ipcMain.handle('difish:get-state', () => ({
    port,
    backendUp: !!contentView,
    settings,
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle('difish:set-setting', (_e, key, value) => {
    setSetting(key, value);
    // 按设置项做即时生效的处理
    if (key === 'theme') sendThemeToShell();
    if (key === 'glass') applyGlassSetting();
    if (key === 'launchAtLogin') setLaunchAtLogin(value);
    if (key === 'globalShortcut') registerShortcuts();
    if (key === 'minimizeToTray' || key === 'notifyOnComplete') rebuildTrayMenu();
    return settings;
  });

  ipcMain.handle('difish:window-action', (_e, action) => {
    if (action === 'close') mainWindow && mainWindow.close();
    else if (action === 'min') mainWindow && mainWindow.minimize();
    else if (action === 'max') toggleMaximize();
    else if (action === 'recreate') recreateMainWindow(); // 预留：极端情况重建
  });

  // 打开 dsh 的设置面板（点标题栏 ⚙）：尽力在 dsh 页面里点开设置入口
  ipcMain.handle('difish:open-dsh-settings', async () => {
    if (!contentView || contentView.webContents.isDestroyed()) return false;
    try {
      await contentView.webContents.executeJavaScript(OPEN_SETTINGS_JS);
      return true;
    } catch (e) {
      console.error('[difish] 打开 dsh 设置失败:', e.message);
      return false;
    }
  });

  // ---------- 背景（difishBridge 调用） ----------
  ipcMain.handle('difish:bg-get', () => settings.background || DEFAULT_SETTINGS.background);

  ipcMain.handle('difish:bg-set', async (_e, next) => {
    const cur = settings.background || DEFAULT_SETTINGS.background;
    const merged = {
      type: next.type || 'none',
      filePath: typeof next.filePath === 'string' && next.filePath ? next.filePath : cur.filePath,
      opacity: next.opacity == null ? cur.opacity : Number(next.opacity),
      blur: next.blur == null ? cur.blur : Number(next.blur),
      filter: (next.filter === 'none' || next.filter === 'glass') ? next.filter : (cur.filter || 'glass'),
    };
    settings.background = merged;
    saveSettings();
    applyTransparency(); // 滤镜/进出透明模式变化会重建窗口；仅 opacity 变化则不动窗口
    const wc = contentView && contentView.webContents;
    await bg.setBackground(wc, merged);
    return merged;
  });

  ipcMain.handle('difish:bg-choose', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择背景图片或视频',
      properties: ['openFile'],
      filters: [
        { name: '图片 / 视频', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov', 'mkv'] },
        { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('difish:restart-backend', async () => {
    await restartBackend();
    return true;
  });

  ipcMain.handle('difish:open-external', (_e, url) => {
    shell.openExternal(url);
  });

  // ---------- 更新（difishBridge 调用） ----------
  // 返回 { difishVersion, installedDshVersion, latestDshVersion, hasUpdate, error }
  ipcMain.handle('difish:check-updates', async () => {
    return updater.checkUpdates(app.getVersion());
  });

  // 升级 dsh：{ ok, message, output }（旧路径：直接在现网原地 npm i -g，不推荐）
  ipcMain.handle('difish:update-dsh', async () => {
    return updater.updateDsh((line) => console.log('[difish-update]', line.slice(0, 200)));
  });

  // ---------- 安全升级（备份 + 校验 + 可回滚） ----------
  // 查询：当前/暂存版本、可用备份、pending 动作
  ipcMain.handle('difish:upgrade-status', () => upgrade.upgradeStatus());

  // 第一步：下载到 staging 并校验（不碰现网，可在 dsh 运行时进行）
  ipcMain.handle('difish:upgrade-download', async (_e, mirror) => {
    const res = await upgrade.stageInstall({
      mirror,
      onLog: (line) => {
        console.log('[difish-upgrade]', line.slice(0, 300));
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('difish:upgrade-log', line);
        }
      },
    });
    return res;
  });

  // 第二步：安排应用（写 pending，下次冷启动切换）
  ipcMain.handle('difish:upgrade-apply', () => upgrade.markPendingApply());

  // 回滚：写 pending，下次冷启动切回备份
  ipcMain.handle('difish:upgrade-rollback', (_e, backupDir) => upgrade.markPendingRollback(backupDir));

  // 放弃暂存的新版
  ipcMain.handle('difish:upgrade-discard', () => upgrade.discardStaged());

  // 重启 difish 自身（应用/回滚需要冷启动）
  ipcMain.handle('difish:relaunch', () => {
    app.relaunch();
    setTimeout(() => quitApp(), 200);
    return true;
  });

  // ---------- 用户数据快照 / 备份清理 ----------
  // 概览：要导出什么、多大（不打包）
  ipcMain.handle('difish:snapshot-overview', () => snapshot.snapshotOverview());

  // 导出快照（记忆 + 会话 + 配置 + 自装插件）
  ipcMain.handle('difish:snapshot-export', async (_e, opts) => {
    return snapshot.exportSnapshot({
      label: (opts && opts.label) || '',
      includeSessions: !(opts && opts.includeSessions === false),
      onLog: (line) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('difish:upgrade-log', line);
      },
    });
  });

  // 列出已有快照
  ipcMain.handle('difish:snapshot-list', () => snapshot.listSnapshots());

  // 在资源管理器中打开快照目录
  ipcMain.handle('difish:snapshot-reveal', async () => {
    const dir = snapshot.snapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return dir;
  });

  // 备份列表 + 清理
  ipcMain.handle('difish:backup-list', () => snapshot.listBackups());
  ipcMain.handle('difish:backup-prune', (_e, keep) => snapshot.pruneBackups({ keep: keep || 3 }));
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
function quitApp() {
  quitting = true;
  app.quit();
}

// 单实例：重复双击只唤出已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.difish.desktop'); // Windows 通知必须
    loadSettings();
    { // 初始化透明模式 key（启动即按保存的状态，避免启动时多余重建）
      const t = settings.background && settings.background.type === 'transparent';
      lastTransparentKey = t ? ('transparent:' + (settings.background.filter || 'glass')) : '';
    }
    registerIpc();
    createWindow();
    createTray();
    registerShortcuts();
    startCompletionWatcher();
    // 开机自启对账：settings.json 可能是从别的机器带过来的，
    // 而注册表项是机器本地的 —— 启动时补一次，避免"开关开着但不开机启动"
    reconcileLaunchAtLogin();
    // 冷启动时先修复/应用被中断的 dsh 升级（必须在 bootBackend 之前：
    // 此刻没有任何 dsh 进程持有 node-pty/koffi 等原生文件，rename 必然成功）
    // 兜底：无论升级流程出什么问题（含卡死），都必须把后端拉起来，不能让界面一直空着。
    Promise.race([
      recoverDshUpgrade().catch((e) => console.error('[difish-upgrade] 冷启动处理失败:', e && e.message)),
      new Promise((r) => setTimeout(() => {
        console.error('[difish-upgrade] 冷启动处理超时，先启动后端');
        r(null);
      }, 120000)),
    ]).finally(() => bootBackend());
    maybeAutoCheckUpdates(); // 启动后静默检查 dsh 更新
  });
}

app.on('before-quit', () => { quitting = true; });
// 托盘常驻：所有窗口关掉也不退出
app.on('window-all-closed', () => { /* 留空 */ });
app.on('will-quit', () => {
  if (dshProcess) stopDsh(dshProcess);
  globalShortcut.unregisterAll();
});
