'use strict';

/**
 * snapshot.js — 用户数据快照（导出 / 清理）
 *
 * 设计前提（2026-09 与用户确认）：
 *   dsh 引擎本身是可再生的（npm 上重装即可），真正丢了会疼的是这四样：
 *     ① 记忆（.dsh-project-memory，散落在项目和各插件目录）
 *     ② 上下文（sessions 会话记录）
 *     ③ prompt / 配置（AGENTS.md、settings.yaml、credentials、profiles 的配置）
 *     ④ 正在做的项目（源码，不在 dsh 里，但要能一起打包）
 *   本模块只负责 ①②③；④ 由调用方决定是否包含（项目源码可能很大）。
 *
 * 为什么不用 Compress-Archive：它走 .NET，几万个文件会慢且吃内存。
 * 系统自带 bsdtar（C:\WINDOWS\system32\tar.exe）快得多，也支持排除规则。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}
function difishDataDir() {
  return path.join(process.env.APPDATA || os.homedir(), 'difish');
}
function backupRoot() {
  return path.join(difishDataDir(), 'dsh-backups');
}
/** 快照默认输出目录 */
function snapshotDir() {
  return path.join(difishDataDir(), 'snapshots');
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function tarExe() {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(p) ? p : 'tar';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timer = null;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(r); };
    let proc;
    try { proc = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ code: -1, stdout: '', stderr: e.message }); }
    if (opts.timeout > 0) {
      timer = setTimeout(() => {
        try { proc.kill(); } catch { /* 已退出 */ }
        finish({ code: -1, stdout: out, stderr: err + '\n[超时]' });
      }, opts.timeout);
    }
    proc.stdout.on('data', (d) => { out += d.toString(); opts.onLog && opts.onLog(d.toString()); });
    proc.stderr.on('data', (d) => { err += d.toString(); opts.onLog && opts.onLog(d.toString()); });
    proc.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.message }));
    proc.on('close', (code) => finish({ code, stdout: out, stderr: err }));
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

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

function countFiles(p) {
  try {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else n++;
      }
    };
    walk(p);
    return n;
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
// 快照内容清单
// ---------------------------------------------------------------------------

/**
 * 收集要打包的条目。
 * 每条 { id, label, abs, rel, exists, files, sizeMB, optional, skip }
 * rel 是压缩包内的相对路径（用 / 分隔）。
 * skip 是「相对条目根」的路径前缀数组，命中即跳过整棵子树。
 */
function snapshotPlan({ includeSessions = true, includeProfiles = true, projectDirs = [] } = {}) {
  const home = dshHome();
  const entries = [];

  // 按 skip 前缀过滤后统计（体积/文件数必须与实际打包一致）
  const scan = (abs, skip) => {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { files: 1, sizeMB: st.size / (1024 * 1024) };
    let n = 0, total = 0;
    const walk = (d, relFromRoot) => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const childRel = relFromRoot ? relFromRoot + '/' + e.name : e.name;
        if (skipped(childRel, skip)) continue;
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp, childRel);
        else { n++; try { total += fs.statSync(fp).size; } catch { /* 跳过 */ } }
      }
    };    walk(abs, '');
    return { files: n, sizeMB: total / (1024 * 1024) };
  };

  const add = (id, label, abs, rel, opts = {}) => {
    const { optional = false, skip = [] } = opts;
    const exists = fs.existsSync(abs);
    const stat = exists ? scan(abs, skip) : { files: 0, sizeMB: 0 };
    entries.push({ id, label, abs, rel, optional, exists, skip, files: stat.files, sizeMB: stat.sizeMB });
  };

  // ① 记忆
  add('mem-project', '记忆库（difish 项目）', path.join('D:\\difish', '.dsh-project-memory'), 'memory/difish/.dsh-project-memory');
  add('mem-user', '记忆库（用户级）', path.join(home, '.dsh-project-memory'), 'memory/user/.dsh-project-memory');
  add('mem-plugin', '记忆库（difish-settings 插件）',
    path.join('D:\\difish', 'difish-settings-plugin', '.dsh-project-memory'),
    'memory/difish-settings-plugin/.dsh-project-memory');

  // ② 上下文
  if (includeSessions) add('sessions', '会话记录（上下文）', path.join(home, 'sessions'), 'sessions');

  // ③ prompt / 配置
  add('agents', 'prompt（AGENTS.md）', path.join(home, 'AGENTS.md'), 'config/AGENTS.md');
  add('settings', 'settings.yaml', path.join(home, 'settings.yaml'), 'config/settings.yaml');
  add('creds', 'credentials（密钥）', path.join(home, '.credentials.yaml'), 'config/.credentials.yaml', { optional: true });

  if (includeProfiles) {
    // profiles 下有 187 + 数百个依赖包（profiles/node_modules、profiles/web/node_modules），
    // 全是可重装的第三方依赖，按包名逐个排除既脆弱又难维护。
    //
    // 改成白名单思路：
    //   profiles 配置   → 只收几个配置文件（cordis.yml / pnpm-lock.yaml 等）
    //   自装插件        → 单独列成条目，精确到包目录
    // 这样规则稳定，也不会因为将来多装一个依赖就把快照撑大几十 MB。
    add('profiles', 'profiles 配置（不含依赖）', path.join(home, 'profiles'), 'profiles', {
      skip: ['node_modules', 'web/node_modules', 'web/.dsh-module-fallback', '.pnpm', '.pnpm-store'],
    });

    // 自写 / 自装的插件，逐个显式保留
    const pluginDirs = [
      ['plugin-difish', '自写插件：difish-settings', path.join(home, 'profiles', 'web', 'node_modules', 'difish-settings')],
      ['plugin-memory', '自装插件：dsh-project-memory（记忆）', path.join(home, 'profiles', 'web', 'node_modules', '@yolk_vat-y', 'dsh-project-memory')],
    ];
    for (const [id, label, abs] of pluginDirs) {
      add(id, label, abs, 'plugins/' + path.basename(abs));
    }
  }

  // ④ 项目（可选）
  for (const pd of projectDirs) {
    if (!pd || !fs.existsSync(pd)) continue;
    const name = path.basename(pd);
    add('proj-' + name, '项目源码：' + name, pd, 'projects/' + name, {
      optional: true,
      skip: ['node_modules', '.git', 'dist', 'build', '.dsh-project-memory'],
    });
  }

  return entries;
}

/** childRel 是否命中任一 skip 前缀（按路径段边界判断；分隔符统一成 / 再比） */
function skipped(childRel, skip) {
  if (!skip || !skip.length) return false;
  const norm = String(childRel).replace(/\\/g, '/');
  for (const s of skip) {
    if (norm === s || norm.startsWith(s + '/')) return true;
  }
  return false;
}

/** 概览（给 UI 用，不打包） */
function snapshotOverview(opts = {}) {
  const plan = snapshotPlan(opts);
  const present = plan.filter((e) => e.exists);
  return {
    entries: plan.map((e) => ({
      id: e.id, label: e.label, exists: e.exists, optional: e.optional,
      files: e.files, sizeMB: Math.round(e.sizeMB * 10) / 10,
    })),
    totalFiles: present.reduce((s, e) => s + e.files, 0),
    totalMB: Math.round(present.reduce((s, e) => s + e.sizeMB, 0) * 10) / 10,
    defaultDir: snapshotDir(),
  };
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 导出快照为一个 .tar.gz。
 *
 * 实现选择：先把要保留的文件**硬链接/复制**到一个暂存目录，再用 tar 打包。
 * 为什么不用 tar 的 --exclude：实测它在 Windows 上对相对/绝对模式的匹配很反直觉
 * （同一份数据三种写法得到 0MB / 0MB / 34MB），而这种"保命"功能不能靠猜。
 * 显式筛选多一次 IO，但结果完全可预测。
 */
async function exportSnapshot({ outDir, label, includeSessions = true, includeProfiles = true, projectDirs = [], onLog } = {}) {
  const plan = snapshotPlan({ includeSessions, includeProfiles, projectDirs }).filter((e) => e.exists && e.files > 0);
  if (!plan.length) return { ok: false, message: '没有可导出的内容。', output: '' };

  const dir = outDir || snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `difish-snapshot-${timestamp()}${label ? '-' + String(label).replace(/[^\w\u4e00-\u9fa5-]/g, '') : ''}.tar.gz`;
  const outFile = path.join(dir, name);
  const stage = path.join(difishDataDir(), '.snapshot-stage');

  onLog && onLog(`=== 导出快照 ===\n输出: ${outFile}\n`);

  // 1) 组装暂存目录（包内结构 = 我们希望的样子）
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  let copied = 0;
  const copyFiltered = (srcAbs, destAbs, skip, relFromRoot = '') => {
    const st = fs.statSync(srcAbs);
    if (!st.isDirectory()) {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      copied++;
      return;
    }
    fs.mkdirSync(destAbs, { recursive: true });
    for (const e of fs.readdirSync(srcAbs, { withFileTypes: true })) {
      const childRel = relFromRoot ? relFromRoot + '/' + e.name : e.name;
      if (skipped(childRel, skip)) continue;
      copyFiltered(path.join(srcAbs, e.name), path.join(destAbs, e.name), skip, childRel);
    }
  };

  try {
    for (const e of plan) {
      onLog && onLog(`  + ${e.label}  (${e.files} 文件, ${e.sizeMB.toFixed(1)} MB)\n`);
      copyFiltered(e.abs, path.join(stage, e.rel), e.skip);
    }
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    return { ok: false, message: `收集文件失败：${err.message}`, output: '' };
  }

  // 2) 打包（-C 到暂存目录，包内就是干净的相对路径）
  const res = await run(tarExe(), ['-czf', outFile, '-C', stage, '.'], { timeout: 10 * 60 * 1000, onLog });

  // 3) 清理暂存（无论成败）
  fs.rmSync(stage, { recursive: true, force: true });

  if (res.code !== 0) {
    try { fs.rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
    return {
      ok: false,
      message: `打包失败（tar 退出码 ${res.code}）`,
      output: (res.stderr || '').trim().split(/\r?\n/).slice(-10).join('\n'),
    };
  }

  const sizeMB = fs.statSync(outFile).size / (1024 * 1024);
  const manifest = {
    createdAt: new Date().toISOString(),
    file: outFile,
    sizeMB: Math.round(sizeMB * 10) / 10,
    totalFiles: copied,
    entries: plan.map((e) => ({
      id: e.id, label: e.label, files: e.files,
      sizeMB: Math.round(e.sizeMB * 10) / 10, inArchive: e.rel,
    })),
  };
  try {
    fs.writeFileSync(outFile.replace(/\.tar\.gz$/, '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } catch { /* 非关键 */ }

  onLog && onLog(`\n✔ 完成：${copied} 文件, ${sizeMB.toFixed(1)} MB\n`);
  return {
    ok: true,
    file: outFile,
    sizeMB: Math.round(sizeMB * 10) / 10,
    totalFiles: copied,
    entries: manifest.entries,
    message: `快照已导出：${name}（${copied} 文件，${sizeMB.toFixed(1)} MB）`,
    output: '',
  };
}

/** 列出已有快照 */
function listSnapshots() {
  try {
    return fs.readdirSync(snapshotDir())
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const p = path.join(snapshotDir(), f);
        const st = fs.statSync(p);
        const mf = p.replace(/\.tar\.gz$/, '.manifest.json');
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { /* 无清单 */ }
        return { name: f, path: p, sizeMB: Math.round(st.size / (1024 * 1024) * 10) / 10, at: st.mtime.toISOString(), entries: meta && meta.entries };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// 备份清理
// ---------------------------------------------------------------------------

/** 列出 dsh 备份（按名字倒序 = 最新优先） */
function listBackups() {
  try {
    return fs.readdirSync(backupRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = path.join(backupRoot(), e.name);
        let version = null;
        try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* 无 */ }
        return { name: e.name, dir, version, sizeMB: Math.round(dirSizeMB(dir) * 10) / 10, at: fs.statSync(dir).mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch { return []; }
}

/**
 * 清理旧备份，只保留最近 keep 个。
 * 安全规则：**永不删除正在使用的版本**，也永不删到 0 个。
 * 名字以 dsh- 开头的是「某个版本的原样备份」；dsh-replaced- 是回滚时腾出来的旧版本。
 */
function pruneBackups({ keep = 3, onLog } = {}) {
  const all = listBackups();
  if (all.length <= keep) {
    return { ok: true, removed: [], kept: all, message: `当前 ${all.length} 个备份，未超过保留数 ${keep}，无需清理。` };
  }
  const keepList = all.slice(0, keep);
  const dropList = all.slice(keep);
  const removed = [];
  for (const b of dropList) {
    try {
      fs.rmSync(b.dir, { recursive: true, force: true, maxRetries: 3 });
      removed.push(b);
      onLog && onLog(`  删除旧备份 ${b.name}（${b.sizeMB} MB）\n`);
    } catch (e) {
      onLog && onLog(`  ✘ 删除失败 ${b.name}：${e.message}\n`);
    }
  }
  const freed = Math.round(removed.reduce((s, b) => s + b.sizeMB, 0) * 10) / 10;
  return {
    ok: true,
    removed,
    kept: keepList,
    freedMB: freed,
    message: removed.length
      ? `已清理 ${removed.length} 个旧备份，释放 ${freed} MB（保留最近 ${keepList.length} 个）`
      : '没有可清理的备份。',
  };
}

module.exports = {
  dshHome, snapshotDir, backupRoot,
  snapshotPlan, snapshotOverview, exportSnapshot, listSnapshots,
  listBackups, pruneBackups,
  _internal: { dirSizeMB, countFiles, timestamp, tarExe },
};
