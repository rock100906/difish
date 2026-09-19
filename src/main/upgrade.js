'use strict';

/**
 * upgrade.js — dsh 安全升级 / 回滚（备份 + 校验 + 原子切换）
 *
 * 设计原则（稳定安全第一）：
 *   1. **绝不在原地覆盖**。新版先装到独立 staging 目录，装完先验证能跑，才动现网。
 *   2. **切换只做 rename**。现网目录整体改名到 backups/，不删除、不拷贝（同盘秒级）。
 *   3. **切换后立刻校验**。跑 `--version` + `--help` 确认新版真能加载依赖；失败自动回滚。
 *   4. **状态落盘**。流程写进 state 文件，断电/崩溃后下次启动能自动修复。
 *   5. **切换在冷启动做**。见下。
 *
 * 为什么切换放在「difish 冷启动」而不是「运行时」：
 *   dsh 运行时会锁定 node-pty / koffi 等原生 .node 文件，Windows 不允许改名一个
 *   含已加载文件的目录（EBUSY/EPERM）。运行中切换需要先停后端，而停后端会把承载
 *   界面的 dsh 页面一起销毁 —— 升级进度和结果就没人显示了，失败也无从提示。
 *   所以拆成两段：
 *     ① 下载 + 校验（运行时进行，完全不碰现网，界面存活、进度可见）
 *     ② 应用（写一个 pending 标记 → 自动重启 difish → 冷启动时切换，此时没有任何
 *        dsh 进程持有文件，rename 必然成功；失败也能在启动阶段直接回滚）
 *
 * 目录约定（prefix 布局与 npm -g 完全一致，故可直接换包目录）：
 *   %APPDATA%\npm\node_modules\@deepseek-ai\dsh                   ← 现网（dsh.cmd 按相对路径找它）
 *   %APPDATA%\difish\dsh-stage\node_modules\@deepseek-ai\dsh      ← 新版暂存
 *   %APPDATA%\difish\dsh-backups\dsh-<版本>-<时间戳>               ← 备份
 *   %APPDATA%\difish\dsh-upgrade-state.json                       ← 流程状态
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PKG = '@deepseek-ai/dsh';
const PKG_PARTS = ['@deepseek-ai', 'dsh'];

/** npm 源：按本机实测速度排序（官方源在部分网络下会直接超时） */
const MIRRORS = [
  { id: 'tencent', label: '腾讯云（推荐 · 实测最快）', url: 'https://mirrors.cloud.tencent.com/npm/' },
  { id: 'huawei', label: '华为云', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
  { id: 'npmmirror', label: 'npmmirror（淘宝源）', url: 'https://registry.npmmirror.com/' },
  { id: 'npmjs', label: 'npm 官方源（可能超时）', url: 'https://registry.npmjs.org/' },
];
const DEFAULT_MIRROR = 'tencent';

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000; // 装包最长 20 分钟
const VERIFY_TIMEOUT_MS = 90 * 1000;       // 校验命令超时

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function livePrefix() { return path.join(process.env.APPDATA || os.homedir(), 'npm'); }
function liveDshDir() { return path.join(livePrefix(), 'node_modules', ...PKG_PARTS); }
function difishDataDir() { return path.join(process.env.APPDATA || os.homedir(), 'difish'); }
function stagePrefix() { return path.join(difishDataDir(), 'dsh-stage'); }
function stageDshDir() { return path.join(stagePrefix(), 'node_modules', ...PKG_PARTS); }
function backupRoot() { return path.join(difishDataDir(), 'dsh-backups'); }
function statePath() { return path.join(difishDataDir(), 'dsh-upgrade-state.json'); }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 读某个 dsh 包目录里的版本号 */
function versionOf(dshDir) {
  const pj = readJson(path.join(dshDir, 'package.json'));
  return (pj && pj.version) || null;
}

function installedVersion() { return versionOf(liveDshDir()); }

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 尽力而为 */ }
}

/** 目录是否像一个完整的 dsh 安装（不需要启动进程，纯结构判断） */
function looksLikeDshInstall(dshDir) {
  try {
    if (!fs.existsSync(path.join(dshDir, 'lib', 'bin.js'))) return false;
    if (!versionOf(dshDir)) return false;
    const nested = path.join(dshDir, 'node_modules');
    if (!fs.existsSync(nested)) return false;
    // 嵌套依赖应是百级（现网 190+）；太少说明装了一半
    return fs.readdirSync(nested).length > 50;
  } catch { return false; }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 目录体积（MB）。会遍历上万个文件，只在明确需要时调用。 */
function dirSizeMB(p) {
  try {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { try { total += fs.statSync(fp).size; } catch { /* 跳过 */ } }
      }
    };
    walk(p);
    return total / (1024 * 1024);
  } catch { return 0; }
}

/** 带重试的 rename（Windows 上锁释放可能有延迟） */
function renameWithRetry(from, to, attempts = 8, delayMs = 700) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return { ok: true, error: null };
    } catch (e) {
      lastErr = e;
      try {
        const until = Date.now() + delayMs;
        while (Date.now() < until) { /* 忙等：升级是串行阻塞流程，简单可靠优先 */ }
      } catch { /* 忽略 */ }
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * 复制目录（跨卷/留底时用）。
 * 比 rename 慢，但**不消耗源目录** —— 回滚时必须用这个，
 * 否则回滚一次就把唯一的备份用掉了，之后再出问题就没退路。
 */
function copyDir(from, to) {
  try {
    fs.cpSync(from, to, { recursive: true, force: true, maxRetries: 3, errorOnExist: false });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  phase: 'idle',          // idle | staging | staged | switching | done | failed
  pendingAction: null,    // null | 'apply' | 'rollback'
  rollbackTarget: null,
  stagedVersion: null,
  installedVersion: null,
  backupDir: null,
  mirror: DEFAULT_MIRROR,
  error: null,
  at: null,
};

function readState() {
  const st = readJson(statePath());
  return Object.assign({}, DEFAULT_STATE, st || {});
}

function writeState(patch) {
  const next = Object.assign(readState(), patch, { at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* 写不进去也不能让流程崩 */ }
  return next;
}

// ---------------------------------------------------------------------------
// 版本比较（与 updater.js 语义一致：正式版 > 预发布）
// ---------------------------------------------------------------------------

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' } : null;
}
function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  if (!A || !B) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre === B.pre ? 0 : (A.pre < B.pre ? -1 : 1);
}

// ---------------------------------------------------------------------------
// 外部命令
// ---------------------------------------------------------------------------

/**
 * 系统 node.exe 路径。
 * 注意：在 Electron 主进程里 process.execPath 是 difish.exe，不是 node！
 * 用它去跑 dsh 的 bin.js 会启动一个 Electron 实例而不是 Node —— 必须用真 node。
 */
function nodeExePath() {
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('.exe'));
    if (first) return first.trim();
  } catch { /* 兜底 */ }
  return 'node';
}

/** 找 npm.cmd */
function npmCommand() {
  try {
    const out = execFileSync('where', ['npm.cmd'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('.cmd'));
    if (first) return first.trim();
  } catch { /* 兜底 */ }
  const p = path.join(livePrefix(), 'npm.cmd');
  return fs.existsSync(p) ? p : 'npm';
}

/**
 * 跑一个命令，返回 {code, stdout, stderr}（不抛错）。
 * spawn 的 options 里没有 timeout，必须自己实现。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let done = false, timer = null;
    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: -1, stdout: '', stderr: e.message });
      return;
    }
    if (opts.timeout > 0) {
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* 已退出 */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* 忽略 */ } }, 3000);
        finish({ code: -1, stdout: out, stderr: err + `\n[超时 ${Math.round(opts.timeout / 1000)}s，已终止]` });
      }, opts.timeout);
    }
    proc.stdout.on('data', (d) => { out += d.toString(); opts.onLog && opts.onLog(d.toString()); });
    proc.stderr.on('data', (d) => { err += d.toString(); opts.onLog && opts.onLog(d.toString()); });
    proc.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.message }));
    proc.on('close', (code) => finish({ code, stdout: out, stderr: err }));
  });
}

/**
 * 校验一个 dsh 安装能否真正启动。
 * --version 不足以证明依赖树完整，所以再跑 --help 强制加载 CLI 与原生模块。
 */
async function verifyInstall(dshDir, opts = {}) {
  const bin = path.join(dshDir, 'lib', 'bin.js');
  if (!fs.existsSync(bin)) return { ok: false, version: null, error: '缺少 lib/bin.js' };
  if (!looksLikeDshInstall(dshDir)) {
    return { ok: false, version: versionOf(dshDir), error: '依赖目录不完整（node_modules 内容过少）' };
  }
  const node = opts.nodeExe || nodeExePath();

  const v = await run(node, [bin, '--version'], { timeout: VERIFY_TIMEOUT_MS });
  const version = (v.stdout || '').trim().split(/\r?\n/).pop() || '';
  if (v.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    return { ok: false, version: null, error: `--version 失败：${(v.stderr || v.stdout || '').trim().slice(0, 300)}` };
  }

  const h = await run(node, [bin, '--help'], { timeout: VERIFY_TIMEOUT_MS });
  const helpText = (h.stdout || '') + (h.stderr || '');
  if (!/Usage:\s*dsh/i.test(helpText)) {
    return { ok: false, version, error: `--help 未输出用法，CLI 可能加载失败：${helpText.trim().slice(0, 300)}` };
  }
  return { ok: true, version, error: null };
}

// ---------------------------------------------------------------------------
// 第一步：下载到 staging（运行时进行，完全不碰现网）
// ---------------------------------------------------------------------------

async function stageInstall({ mirror, onLog } = {}) {
  const m = MIRRORS.find((x) => x.id === (mirror || DEFAULT_MIRROR)) || MIRRORS[0];
  const prefix = stagePrefix();
  const target = stageDshDir();

  writeState({ phase: 'staging', mirror: m.id, error: null, pendingAction: null });
  onLog && onLog(`=== 开始下载 dsh（源：${m.label}）===\n`);

  if (fs.existsSync(prefix)) {
    onLog && onLog('清理上次的暂存目录…\n');
    rmrf(prefix);
  }
  fs.mkdirSync(prefix, { recursive: true });

  const args = [
    'install', '-g',
    '--prefix', prefix,
    '--registry', m.url,
    `${PKG}@latest`,
    '--no-audit', '--no-fund',
    '--loglevel=error',
    '--fetch-retries=5',
    '--fetch-retry-maxtimeout=120000',
  ];
  onLog && onLog(`npm ${args.join(' ')}\n\n`);

  const res = await run(npmCommand(), args, { timeout: INSTALL_TIMEOUT_MS, onLog });

  if (res.code !== 0) {
    const network = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(res.stderr + res.stdout);
    writeState({ phase: 'failed', error: `npm 退出码 ${res.code}` });
    return {
      ok: false, step: 'install',
      message: `下载失败（npm 退出码 ${res.code}）${network ? ' —— 看起来是网络问题，换个源或换个网络再试。' : ''}`,
      output: (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-15).join('\n'),
    };
  }

  onLog && onLog('\n=== 校验新版能否启动 ===\n');
  const check = await verifyInstall(target);
  if (!check.ok) {
    writeState({ phase: 'failed', error: check.error });
    return { ok: false, step: 'verify', message: `新版校验失败，已放弃（现网未改动）：${check.error}`, output: '' };
  }

  const current = installedVersion();
  writeState({ phase: 'staged', stagedVersion: check.version, installedVersion: current, error: null });
  onLog && onLog(`\n✔ 暂存完成：${check.version}（当前现网 ${current}）\n`);

  return {
    ok: true, step: 'staged',
    stagedVersion: check.version,
    currentVersion: current,
    upToDate: !!(current && compareVersions(check.version, current) <= 0),
    message: `已下载并校验 ${check.version}，现网未改动。可以应用了。`,
    output: '',
  };
}

// ---------------------------------------------------------------------------
// 冷启动：修复 + 应用 / 回滚
// ---------------------------------------------------------------------------

/** 找一个可用的备份（按名字倒序 = 最新优先） */
function listBackups() {
  try {
    return fs.readdirSync(backupRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, dir: path.join(backupRoot(), e.name), version: versionOf(path.join(backupRoot(), e.name)) }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

/**
 * 冷启动入口：修复被中断的状态，然后执行 pending 动作。
 * 必须在 bootBackend() **之前**调用（此时没有 dsh 进程持有文件）。
 * @returns {Promise<{action:string, ok:boolean, message:string, from:string, to:string}>}
 */
async function recoverAndApply({ onLog } = {}) {
  const log = (t) => onLog && onLog(t);
  const st = readState();
  const live = liveDshDir();
  const staged = stageDshDir();
  const liveVersion = versionOf(live);
  const stagedVersion = versionOf(staged);
  let recovered = false;

  // ---- 1) 修复：现网目录缺失/不完整 ----
  if (!looksLikeDshInstall(live)) {
    log(`⚠ 现网 dsh 目录不可用（${live}），尝试修复…\n`);
    const candidate = listBackups().find((b) => looksLikeDshInstall(b.dir));
    if (candidate) {
      rmrf(live);
      const r = renameWithRetry(candidate.dir, live);
      if (r.ok) {
        recovered = true;
        log(`✔ 已从备份恢复 ${candidate.version}\n`);
      } else {
        log(`✘ 从备份恢复失败：${r.error.message}\n`);
      }
    } else if (looksLikeDshInstall(staged)) {
      const r = renameWithRetry(staged, live);
      if (r.ok) {
        recovered = true;
        log(`✔ 现网缺失且无备份，已用暂存的新版 ${stagedVersion} 顶上\n`);
      }
    } else {
      const msg = '现网 dsh 目录损坏，且没有可用备份或暂存版本。需要重新安装 dsh（npm i -g @deepseek-ai/dsh）。';
      writeState({ phase: 'failed', pendingAction: null, error: msg });
      log(`✘ ${msg}\n`);
      return { action: 'recover', ok: false, message: msg, from: liveVersion, to: null };
    }
  }

  // ---- 2) 执行 pending 动作 ----
  const pending = st.pendingAction;
  if (!pending) {
    if (recovered) writeState({ phase: 'done', error: null, installedVersion: versionOf(live) });
    return { action: 'none', ok: true, message: recovered ? '已修复被中断的升级' : '', from: liveVersion, to: versionOf(live) };
  }

  if (pending === 'rollback') {
    const target = st.rollbackTarget;
    const result = await rollbackCold({ backupDir: target, onLog });
    return { action: 'rollback', ...result };
  }

  // pending === 'apply'
  if (!looksLikeDshInstall(staged)) {
    const msg = '没有可用的暂存版本，已取消应用。';
    writeState({ phase: 'failed', pendingAction: null, error: msg });
    log(`✘ ${msg}\n`);
    return { action: 'apply', ok: false, message: msg, from: liveVersion, to: null };
  }
  const fromVersion = versionOf(live);
  const toVersion = versionOf(staged);
  if (fromVersion && toVersion && compareVersions(toVersion, fromVersion) <= 0) {
    const msg = `暂存版本 ${toVersion} 不高于现网 ${fromVersion}，已取消应用。`;
    writeState({ phase: 'staged', pendingAction: null, error: msg });
    log(`✘ ${msg}\n`);
    return { action: 'apply', ok: false, message: msg, from: fromVersion, to: toVersion };
  }

  writeState({ phase: 'switching', pendingAction: null, error: null });
  log(`=== 冷启动切换：${fromVersion} → ${toVersion} ===\n`);

  // 备份现网
  fs.mkdirSync(backupRoot(), { recursive: true });
  const backup = path.join(backupRoot(), `dsh-${fromVersion || 'unknown'}-${timestamp()}`);
  {
    const r = renameWithRetry(live, backup);
    if (!r.ok) {
      const msg = `备份现网失败，已中止（现网未被破坏）：${r.error.message}`;
      writeState({ phase: 'failed', error: msg });
      log(`✘ ${msg}\n`);
      return { action: 'apply', ok: false, message: msg, from: fromVersion, to: null };
    }
    log(`备份现网 → ${backup}\n`);
  }

  // 新版就位
  {
    const r = renameWithRetry(staged, live);
    if (!r.ok) {
      log('✘ 新版就位失败，正在回滚…\n');
      renameWithRetry(backup, live);
      const msg = `新版就位失败，已回滚到 ${fromVersion}：${r.error.message}`;
      writeState({ phase: 'failed', error: msg });
      return { action: 'apply', ok: false, message: msg, from: fromVersion, to: null };
    }
    log(`新版就位 → ${live}\n`);
  }

  // 保留 dsh 包目录外的运行时数据
  for (const extra of ['.dsh-project-memory']) {
    const a = path.join(backup, extra), b = path.join(live, extra);
    if (fs.existsSync(a) && !fs.existsSync(b)) {
      try { fs.renameSync(a, b); } catch { /* 非关键 */ }
    }
  }

  // 切换后校验；失败自动回滚
  log('校验新版…\n');
  const check = await verifyInstall(live);
  if (!check.ok) {
    log(`✘ 新版校验失败，自动回滚到 ${fromVersion}…\n`);
    rmrf(live);
    // 用复制而非改名：备份必须留底，否则回滚一次后就没有退路了
    const r = copyDir(backup, live);
    const msg = r.ok
      ? `新版 ${toVersion} 校验失败，已自动回滚到 ${fromVersion}。现网安全，备份仍保留。原因：${check.error}`
      : `新版校验失败，且回滚失败！备份在 ${backup}，请手动恢复。原因：${check.error}`;
    writeState({ phase: 'failed', error: check.error, backupDir: backup });
    log(`✘ ${msg}\n`);
    return { action: 'apply', ok: false, message: msg, from: fromVersion, to: r.ok ? fromVersion : null };
  }

  writeState({ phase: 'done', installedVersion: check.version, stagedVersion: null, backupDir: backup, error: null });
  log(`\n✔ 升级成功：${fromVersion} → ${check.version}（旧版已备份）\n`);
  return {
    action: 'apply', ok: true,
    message: `升级成功：${fromVersion} → ${check.version}。旧版已备份，可随时回滚。`,
    from: fromVersion, to: check.version, backupDir: backup,
  };
}

/** 冷启动回滚（无 dsh 进程在跑） */
async function rollbackCold({ backupDir, onLog } = {}) {
  const log = (t) => onLog && onLog(t);
  const live = liveDshDir();
  let target = backupDir;
  if (!target) {
    const list = listBackups();
    if (!list.length) {
      const msg = '没有找到任何备份。';
      writeState({ phase: 'failed', pendingAction: null, error: msg });
      return { ok: false, message: msg, from: versionOf(live), to: null };
    }
    target = list[0].dir;
  }
  if (!fs.existsSync(target)) {
    const msg = `备份不存在：${target}`;
    writeState({ phase: 'failed', pendingAction: null, error: msg });
    return { ok: false, message: msg, from: versionOf(live), to: null };
  }

  const fromVersion = versionOf(live);
  const toVersion = versionOf(target);
  log(`=== 冷启动回滚：${fromVersion} → ${toVersion} ===\n`);
  writeState({ phase: 'switching', pendingAction: null, rollbackTarget: null, error: null });

  fs.mkdirSync(backupRoot(), { recursive: true });
  const parked = path.join(backupRoot(), `dsh-replaced-${fromVersion || 'unknown'}-${timestamp()}`);
  {
    const r = renameWithRetry(live, parked);
    if (!r.ok) {
      const msg = `移开当前版本失败（未改动）：${r.error.message}`;
      writeState({ phase: 'failed', error: msg });
      return { ok: false, message: msg, from: fromVersion, to: null };
    }
  }
  {
    const r = copyDir(target, live);
    if (!r.ok) {
      renameWithRetry(parked, live);
      const msg = `回滚就位失败，已恢复原状：${r.error.message}`;
      writeState({ phase: 'failed', error: msg });
      return { ok: false, message: msg, from: fromVersion, to: null };
    }
  }

  const check = await verifyInstall(live);
  if (!check.ok) {
    log('✘ 回滚后的版本校验失败，恢复回滚前状态…\n');
    rmrf(live);
    renameWithRetry(parked, live);
    const msg = `回滚后的版本也校验失败，已恢复回滚前状态。原因：${check.error}`;
    writeState({ phase: 'failed', error: msg });
    return { ok: false, message: msg, from: fromVersion, to: null };
  }

  writeState({ phase: 'done', installedVersion: check.version, backupDir: null, error: null });
  log(`✔ 已回滚到 ${check.version}\n`);
  return {
    ok: true,
    message: `已回滚到 ${check.version}（回滚前的 ${fromVersion} 也留在备份目录）。`,
    from: fromVersion, to: check.version, parkedDir: parked,
  };
}

// ---------------------------------------------------------------------------
// UI 侧：标记 pending（真正执行在下次冷启动）
// ---------------------------------------------------------------------------

/** 标记「下次启动时应用新版」 */
function markPendingApply() {
  if (!looksLikeDshInstall(stageDshDir())) {
    return { ok: false, message: '没有已下载并通过校验的新版，请先点「下载新版」。' };
  }
  const staged = versionOf(stageDshDir());
  const current = installedVersion();
  if (current && staged && compareVersions(staged, current) <= 0) {
    return { ok: false, message: `暂存版本 ${staged} 不高于现网 ${current}，无需应用。` };
  }
  writeState({ phase: 'staged', pendingAction: 'apply', stagedVersion: staged, installedVersion: current, error: null });
  return { ok: true, message: `已安排升级到 ${staged}，重启 difish 后生效（切换时会自动备份 ${current}）。` };
}

/** 标记「下次启动时回滚到指定备份」 */
function markPendingRollback(backupDir) {
  const list = listBackups();
  const target = backupDir || (list[0] && list[0].dir);
  if (!target || !fs.existsSync(target)) return { ok: false, message: '没有可用的备份。' };
  writeState({ phase: 'idle', pendingAction: 'rollback', rollbackTarget: target, error: null });
  return { ok: true, message: `已安排回滚到 ${versionOf(target)}，重启 difish 后生效。` };
}

/** 清掉暂存目录（放弃升级） */
function discardStaged() {
  rmrf(stagePrefix());
  writeState({ phase: 'idle', pendingAction: null, stagedVersion: null, error: null });
  return { ok: true, message: '已清除暂存的新版。' };
}

// ---------------------------------------------------------------------------
// 汇总状态（给 UI 用）
// ---------------------------------------------------------------------------

function upgradeStatus() {
  const st = readState();
  const staged = versionOf(stageDshDir());
  return {
    installedVersion: installedVersion(),
    stagedVersion: staged,
    stageReady: looksLikeDshInstall(stageDshDir()),
    pendingAction: st.pendingAction || null,
    phase: st.phase || 'idle',
    mirror: st.mirror || DEFAULT_MIRROR,
    mirrors: MIRRORS.map((m) => ({ id: m.id, label: m.label })),
    backups: listBackups().map((b) => ({ name: b.name, dir: b.dir, version: b.version })),
    lastError: st.error || null,
    at: st.at || null,
    paths: { live: liveDshDir(), stage: stageDshDir(), backup: backupRoot() },
  };
}

module.exports = {
  MIRRORS, DEFAULT_MIRROR, PKG,
  liveDshDir, stageDshDir, backupRoot, statePath,
  installedVersion, upgradeStatus, listBackups, verifyInstall, looksLikeDshInstall,
  compareVersions, nodeExePath,
  stageInstall, recoverAndApply, rollbackCold,
  markPendingApply, markPendingRollback, discardStaged,
  _internal: { versionOf, dirSizeMB, readState, writeState, renameWithRetry },
};
