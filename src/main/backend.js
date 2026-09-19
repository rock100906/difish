'use strict';

/**
 * backend.js — dsh 后端（DeepSeek Harness Web 服务）的生命周期管理
 *
 * 职责：
 *   1. 找一个空闲端口（系统自动分配，永不和 3080 冲突）
 *   2. 用 Node 拉起 dsh 的 web profile（`dsh --profile web --port <端口>`）
 *   3. 监听输出，直到出现就绪行 `dsh web: http://127.0.0.1:<端口>/?token=<令牌>`
 *      （就绪行里带 dsh 的进程令牌，必须整条 URL 交给调用方，见 feed() 注释）
 *   4. 提供停止 / 重启
 *
 * 想自己改：这个文件只负责"把后端跑起来"，界面相关的一律不管。
 */

const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

/** 后端就绪最长等待时间（毫秒）。dsh 首次启动要编译/加载插件，给足 90 秒。 */
const READY_TIMEOUT_MS = 90 * 1000;

/** 找空闲端口：让系统从 0 号端口分配一个可用的（net 监听 0 即为"随机空闲端口"） */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref(); // 不阻止进程退出
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

/** 拿到系统的 node.exe 完整路径（Windows 上 spawn 裸 'node' 可能找不到） */
function nodeExePath() {
  // 打包版：捆绑在 resources/node-runtime/node.exe
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // 开发版：用 PATH 里的 node（where node 取第一个 .exe）
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('.exe'));
    if (first) return first.trim();
  } catch { /* 找不到就退回裸名字，让系统再找一次 */ }
  return 'node';
}

/** 拿到 dsh CLI 的入口文件 bin.js 完整路径 */
function dshBinPath() {
  // 打包版：捆绑在 resources/dsh/
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(bundled)) return bundled;
  }
  // 开发版：npm 全局安装的 @deepseek-ai/dsh
  // Windows 上 npm 全局目录通常是 %APPDATA%\npm；用环境变量直接拼，避开 cmd/shell。
  const appData = process.env.APPDATA || '';
  const candidates = [
    path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  // 兜底：`npm root -g`（用 cmd /c 避免 shell:true 的参数拼接告警）
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm root -g'], { encoding: 'utf8' }).trim();
    if (out) {
      const p = path.join(out, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* 继续往下走 */ }
  return null;
}

/**
 * 启动 dsh web 后端。
 * @param {object} opts
 *   - port    要监听的端口（来自 findFreePort）
 *   - onLog   收到后端输出时回调 (text, isStderr)
 *   - onReady 就绪回调 ({ url, port })：url 是带进程令牌的完整根地址
 *   - onExit  进程退出回调 (code, signal)
 *   - onError 启动失败/超时回调 (Error)
 *   - patch   可选：--patch 覆盖文件路径（注入 difish 设置插件）
 * @returns {import('node:child_process').ChildProcess | {error: string}}
 */
function startDsh({ port, onLog, onReady, onExit, onError, patch }) {
  const bin = dshBinPath();
  if (!bin) {
    const err = new Error('找不到 dsh CLI（@deepseek-ai/dsh）。开发模式请先 `npm i -g @deepseek-ai/dsh`。');
    onError && onError(err);
    return { error: err.message };
  }
  const node = nodeExePath();
  // 注入 difish 设置插件（--patch 是 launcher flag，必须放在 web app 参数 --port 之前）
  const args = [bin, '--profile', 'web'];
  if (patch) args.push('--patch', patch);
  // --no-open：别让 dsh 去弹系统默认浏览器——difish 自己就是那个浏览器
  // （不加这个，每次开 difish 都会额外弹一个系统浏览器窗口）
  args.push('--port', String(port), '--host', '127.0.0.1', '--no-open');
  let proc;
  try {
    proc = spawn(node, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    onError && onError(e);
    return { error: e.message };
  }

  let buffer = '';      // 累积 stdout，直到匹配到就绪行
  let settled = false;  // 只认第一次就绪
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      onError && onError(new Error(`dsh web 启动超时（${READY_TIMEOUT_MS / 1000}s）。看日志里有没有 Traceback。`));
    }
  }, READY_TIMEOUT_MS);

  function feed(chunk, isErr) {
    const text = chunk.toString();
    buffer += text;
    if (onLog) onLog(text, isErr);
    if (!settled) {
      // 就绪行形如：dsh web: http://127.0.0.1:63025/?token=<进程令牌> (LAN: ...)
      // 必须把整条 URL（含 token）交给调用方：
      //   dsh 的 / 只认两种凭据——URL 上的进程 token，或它换来的签名 cookie。
      //   只拿 host:port 去加载，两边都没有，就会收到 401
      //   "dsh web authentication required; reopen the URL printed by dsh web."
      const m = buffer.match(/dsh web:\s+(https?:\/\/\S+)/);
      if (m) {
        settled = true;
        clearTimeout(timer);
        const url = m[1];
        let realPort = 0;
        try { realPort = Number(new URL(url).port) || 0; } catch { /* 解析不了就报 0 */ }
        onReady && onReady({ url, port: realPort });
      }
    }
  }

  proc.stdout.on('data', (d) => feed(d, false));
  proc.stderr.on('data', (d) => feed(d, true));
  proc.on('error', (e) => {
    if (!settled) { settled = true; clearTimeout(timer); onError && onError(e); }
  });
  proc.on('exit', (code, signal) => {
    clearTimeout(timer);
    onExit && onExit(code, signal);
  });
  return proc;
}

/** 停止后端进程（先发 SIGTERM 优雅停，5 秒后还活着就强杀） */
function stopDsh(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill(); } catch { /* 已退出 */ }
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  }, 5000);
  if (typeof proc.unref === 'function') proc.unref();
  killer.unref && killer.unref();
}

module.exports = { findFreePort, startDsh, stopDsh, dshBinPath, nodeExePath, READY_TIMEOUT_MS };
