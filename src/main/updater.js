'use strict';

/**
 * updater.js — 版本检查与更新（dsh / difish）
 *
 * difish 只是 dsh 的壳：真正的"功能更新"来自 npm 上的 @deepseek-ai/dsh。
 * 这里负责：
 *   1. 读本地已装的 dsh 版本（全局 npm 包 package.json）
 *   2. 查 npm registry 最新版本
 *   3. 执行 `npm install -g @deepseek-ai/dsh@latest` 升级 dsh
 *
 * 不依赖 electron，纯 Node 内置模块，方便单独测试。
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG = '@deepseek-ai/dsh';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}/latest`;
const CHECK_TIMEOUT_MS = 10 * 1000;      // 查版本超时
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000; // 升级 npm 包（可能很慢，给 10 分钟）

/** 全局 npm 目录下 dsh 的 package.json（候选路径，和 backend.js 一致） */
function installedDshPackageJson() {
  const appData = process.env.APPDATA || '';
  const p = path.join(appData, 'npm', 'node_modules', PKG, 'package.json');
  return fs.existsSync(p) ? p : null;
}

/** 已安装的 dsh 版本（读不到返回 null） */
function installedDshVersion() {
  try {
    const p = installedDshPackageJson();
    if (!p) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** 解析版本号："1.2.3-rc.1" → { major:1, minor:2, patch:3, pre:'rc.1' } */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' } : null;
}

/** 比较版本：a<b → -1，a>b → 1，相等 → 0（正式版 > 预发布） */
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  if (!A || !B) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  if (!A.pre && !B.pre) return 0;   // 都是正式版
  if (!A.pre) return 1;             // 正式版 > 预发布
  if (!B.pre) return -1;            // 预发布 < 正式版
  return A.pre === B.pre ? 0 : (A.pre < B.pre ? -1 : 1);
}

/** 查 npm registry 最新版本（失败抛错） */
async function latestDshVersion() {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`npm registry 返回 ${res.status}`);
  const data = await res.json();
  return (data && data.version) || null;
}

/**
 * 检查更新汇总（IPC difish:check-updates 用）。
 * @param {string} difishVersion difish 壳自身版本（app.getVersion()）
 * @returns {Promise<{difishVersion, installedDshVersion, latestDshVersion, hasUpdate, error}>}
 */
async function checkUpdates(difishVersion) {
  let latest = null, installed = null, error = null;
  try { latest = await latestDshVersion(); } catch (e) { error = e.message; }
  installed = installedDshVersion();
  const hasUpdate = !!(latest && installed && compareVersions(latest, installed) > 0);
  return { difishVersion, installedDshVersion: installed, latestDshVersion: latest, hasUpdate, error };
}

/** 找到 npm.cmd（Windows）完整路径 */
function npmCommand() {
  try {
    const out = execFileSync('where', ['npm.cmd'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('.cmd'));
    if (first) return first.trim();
  } catch { /* 忽略，走兜底 */ }
  const p = path.join(process.env.APPDATA || '', 'npm', 'npm.cmd');
  return fs.existsSync(p) ? p : 'npm';
}

/**
 * 把 dsh 升级到最新（IPC difish:update-dsh 用）。
 * @param {(line:string)=>void} [onLog] 实时输出回调
 * @returns {Promise<{ok:boolean, message:string, output:string}>}
 */
function updateDsh(onLog) {
  return new Promise((resolve) => {
    const npm = npmCommand();
    const cmd = `"${npm}" install -g ${PKG}@latest`;
    let output = '';
    let settled = false;
    let proc;
    try {
      proc = spawn('cmd.exe', ['/d', '/s', '/c', cmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, message: '无法启动 npm: ' + e.message, output });
      return;
    }
    const feed = (chunk) => {
      const t = chunk.toString();
      output += t;
      if (onLog) onLog(t);
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* 忽略 */ }
      resolve({ ok: false, message: `升级超时（${UPDATE_TIMEOUT_MS / 60000} 分钟）`, output: output.trim().split(/\r?\n/).slice(-8).join('\n') });
    }, UPDATE_TIMEOUT_MS);
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: 'npm 启动失败: ' + e.message, output });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = output.trim().split(/\r?\n/).slice(-8).join('\n');
      if (code === 0) resolve({ ok: true, message: 'dsh 已升级到最新版', output: tail });
      else resolve({ ok: false, message: `npm 升级失败（退出码 ${code}）`, output: tail });
    });
  });
}

module.exports = { installedDshVersion, latestDshVersion, compareVersions, checkUpdates, updateDsh, parseVersion, npmCommand };
