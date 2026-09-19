# difish — 小鲸鱼桌面版 🐟

把dsh装进一个真正的 Windows 桌面窗口。

不用开终端敲命令、不用手动管端口、不用记 URL——双击就进。

> **difish 只是壳。** 真正的能力来自 `dsh`；difish 负责把它拉起来、给它一个好看的窗口、加上托盘/快捷键/背景这些桌面端该有的东西。

---

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 🚀 **自动启动后端** | 自己找空闲端口、拉起 `dsh web`、就绪后自动加载页面。**端口每次随机**，永不和别的程序撞车 |
| 🖥 **自绘标题栏** | 无边框窗口 + 毛玻璃（Win11 Acrylic / Mica），带状态点：灰=启动中 · 青=就绪 · 红=出错 |
| ⚙️ **设置整合进 dsh** | difish 的设置出现在 **dsh 自己的设置界面**里（侧边栏 → 设置 → 「difish」），风格完全统一，没有独立的设置窗口 |
| 🎨 **背景** | 静态图片 / 动态视频 / 透明玻璃三种模式，透明度与模糊度可调 |
| 🧊 **系统托盘** | 常驻右下角，单击唤回；右键菜单：开机自启 / 完成通知 / 重启后端 / 退出 |
| ⌨️ **全局快捷键** | 默认 `Ctrl+Shift+D` 唤出 / 隐藏 |
| 🚪 **关窗收进托盘** | 点 ✕ 不退出，程序继续在后台跑（托盘菜单「退出」才真退） |
| 🔔 **完成通知** | 后端忙完一阵安静下来后，弹系统通知提醒 |
| 🛡 **安全升级 dsh** | 升级前自动备份、装完先试跑校验、起不来自动回滚；旧版本随时可回退 |
| 💾 **数据快照** | 一键把记忆库 / 会话 / 配置 / 自装插件打包备份 |

---

## 🚀 快速开始

### 前置要求

1. **Windows 10 / 11**
2. **Node.js 22.19+**（推荐 24）—— [下载](https://nodejs.org/)
3. **dsh 本体**：
   ```powershell
   npm install -g @deepseek-ai/dsh
   ```

### 从源码运行

```powershell
git clone https://github.com/rock100906/difish.git
cd difish
npm install
npm start
```

### 打包成安装包

```powershell
npm run dist     # 产出 dist/ 下的 NSIS 安装器
npm run pack     # 只产出免安装目录 dist/win-unpacked/
```

> ⚠️ **当前版本不捆绑 dsh**——装完 difish 之后，仍需自行 `npm i -g @deepseek-ai/dsh`。
> 后续版本会考虑把 dsh + Node 运行时一起打包（双击即用，无需装 Node）。

---

## 📁 目录结构

```
difish/
├── package.json              # 项目配置 + electron-builder 打包配置
├── assets/
│   ├── icon.ico              # 应用 / 窗口 / 托盘图标
│   ├── title-icon.png        # 标题栏图标
│   └── whale.png             # 小图标
├── difish-settings-plugin/   # 注入 dsh 的设置插件（在 dsh 设置里显示「difish」页）
│   ├── package.json          #   dsh.client 声明（client bundle 入口）
│   ├── src/index.js          #   Host 侧
│   └── client/client.js      #   Client 侧（设置页 UI，调 window.difishBridge）
└── src/
    ├── main/
    │   ├── main.js           # 主进程：窗口、托盘、快捷键、自启、通知、IPC
    │   ├── backend.js        # dsh 生命周期：找端口、拉起、等就绪
    │   ├── background.js     # 背景渲染：图片/视频/透明 + 透明度 + 模糊
    │   ├── plugin.js         # 把 difish-settings-plugin 接进 web profile
    │   ├── updater.js        # 查 dsh 新版本
    │   ├── upgrade.js        # 安全升级：暂存 → 校验 → 冷启动切换 → 备份/回滚
    │   └── snapshot.js       # 用户数据快照 + 备份清理
    ├── preload/
    │   ├── preload.js        # 壳页面 ↔ 主进程（window.difish）
    │   └── difish-bridge.js  # dsh 页面 ↔ 主进程（window.difishBridge）
    └── renderer/
        ├── shell.html        # 主壳页面：标题栏骨架
        ├── shell.css         # 主壳样式（主题变量在这改）
        └── shell.js          # 主壳交互
```

---

## 🔧 想自己改？照着这里改

### 1. 改标题栏高度
`src/main/main.js` 顶部 `TITLEBAR_HEIGHT`、`shell.css` 里 `#titlebar { height }` 和 `#content { top }`
—— **三处要一致**。

### 2. 改配色 / 毛玻璃
- **配色**：`src/renderer/shell.css` 顶部的 `:root` 变量，改一处全变
- **毛玻璃**：dsh 设置 → difish 里切，或改 `main.js` 的 `DEFAULT_SETTINGS.glass`
  （`acrylic` / `mica` / `tabbed` / `none`，仅 Win11 生效）

### 3. 改全局快捷键
`DEFAULT_SETTINGS.globalShortcut`，语法见
[Electron Accelerator](https://www.electronjs.org/docs/latest/api/accelerator)。

### 4. 加一个新的「壳能力」（三步）
以「打开某个网页」为例：
1. `main.js` 的 `registerIpc()` 里加 `ipcMain.handle('difish:open-x', ...)`
2. `preload.js` 里暴露 `openX: () => ipcRenderer.invoke('difish:open-x')`
3. `shell.html` 加按钮 + `shell.js` 里绑事件

> 💡 **给 dsh 设置页加新设置项**：改 `difish-settings-plugin/client/client.js`
> （React + dsh 的 `--dsw-alias-*` 主题变量）；要调壳能力就在 `main.js` 加 IPC
> 并在 `difish-bridge.js` 暴露。

### 5. 换图标
替换 `assets/icon.ico`（打包自动用）和 `assets/whale.png`。

---

## 🧠 架构

```
difish 壳窗口（无边框 + 毛玻璃 + 自绘标题栏）
   └─ WebContentsView ──►  dsh web（http://127.0.0.1:<随机端口>）
                              └─ 由 backend.js spawn 的 `dsh --profile web` 提供
```

- **端口随机**（`--port 0`），永不冲突
- **壳与页面完全隔离**（sandbox + contextIsolation）—— dsh 崩了壳还活着
- **difish 的设置插件**通过 `--patch` 注入，不污染 dsh 的全局安装

---

## ⚠️ 已知限制

- 目前**不捆绑 dsh 和 Node**，用户需自行安装
- 毛玻璃效果仅 Windows 11 有效
- 仅支持 Windows（macOS / Linux 未测试）

---

## 📄 License

[MIT](LICENSE)

图标为本项目所有。本项目不包含任何第三方游戏素材。
