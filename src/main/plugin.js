'use strict';

/**
 * plugin.js — 让 difish 启动的 dsh 加载 difish-settings 设置插件
 *
 * 步骤：
 *   1. 定位 difish-settings-plugin 源码目录
 *      - 开发模式：项目根/difish-settings-plugin
 *      - 打包模式：process.resourcesPath/difish-settings-plugin（由 electron-builder extraResources 拷贝）
 *   2. 把它【拷贝】到 web profile 的 node_modules/difish-settings
 *      （普通目录拷贝，比 junction 链接稳——不会因开发/打包交替运行导致指向失效）
 *   3. 生成一个 patch 文件（userData/difish-patch.yml），difish 启动 dsh 时用 --patch 传入
 *
 * 插件检测不到 window.difishBridge 时自动禁用，因此即使普通 dsh web
 * 意外加载了它也不影响功能。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** difish-settings-plugin 源码目录（开发 / 打包两种来源） */
function pluginSourceDir(appData) {
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'difish-settings-plugin');
    if (fs.existsSync(bundled)) return bundled;
  }
  const dev = path.join(__dirname, '..', '..', 'difish-settings-plugin');
  if (fs.existsSync(dev)) return dev;
  return null;
}

/** web profile 的 node_modules 目录 */
function webProfileNodeModules() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'profiles', 'web', 'node_modules');
}

/**
 * 目录内容指纹：递归收集 (相对路径, 大小, mtimeMs) 并排序后哈希。
 * 用来判断"源码是否真的变了"——比逐个文件比对便宜，比只比目录 mtime 可靠。
 */
function dirFingerprint(dir) {
  const crypto = require('node:crypto');
  const parts = [];
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // 记忆库是运行期数据，不参与"源码是否变化"的判断
      if (e.name === '.dsh-project-memory') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { walk(fp, r); continue; }
      try {
        const st = fs.statSync(fp);
        parts.push(`${r}|${st.size}|${st.mtimeMs}`);
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(dir, '');
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** 把指纹写到目标目录旁的隐藏文件，下次启动用来比对 */
function fingerprintPath(target) {
  return path.join(path.dirname(target), '.difish-settings.fingerprint');
}

/**
 * 确保 difish-settings 就绪，返回 patch 文件路径（供 --patch 使用）。
 *
 * 注意：**内容没变就不重写**。
 * 早期实现每次启动都 rmSync + cpSync，导致目标目录 mtime 每次都变 ——
 * dsh 的 bundle 轮询会把它误判为"插件更新了"，白白触发一次热重载。
 * 现在先比对指纹，一致就直接返回，避免无谓的文件系统扰动。
 *
 * @param {string} userData difish 的 userData 目录
 */
function ensureDifishPlugin(userData) {
  const src = pluginSourceDir();
  if (!src) return null;

  const target = path.join(webProfileNodeModules(), 'difish-settings');
  const fpFile = fingerprintPath(target);

  try {
    const srcFp = dirFingerprint(src);
    let installedFp = null;
    try { installedFp = fs.readFileSync(fpFile, 'utf8').trim(); } catch { /* 没装过 */ }

    const targetExists = fs.existsSync(path.join(target, 'package.json'));

    if (targetExists && installedFp === srcFp) {
      // 内容和上次装的一致 —— 什么都不做，保持 mtime 不变
      return writePatch(userData);
    }

    // 需要（重新）安装
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      console.error('[difish] 删除旧 difish-settings 失败:', e.message);
    }
    fs.cpSync(src, target, { recursive: true, force: true });
    fs.writeFileSync(fpFile, srcFp, 'utf8');
    console.log('[difish] difish-settings 插件已更新:', target);
  } catch (err) {
    console.error('[difish] 拷贝 difish-settings 插件失败:', err.message);
  }

  return writePatch(userData);
}

/** 生成 patch 文件，返回路径 */
function writePatch(userData) {
  const patchPath = path.join(userData, 'difish-patch.yml');
  const content = [
    '# difish 专用 patch（自动生成）——向 dsh web 注入 difish-settings 设置插件',
    '- insert:',
    '    - id: difish-settings',
    '      name: "difish-settings"',
    '      config: {}',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(patchPath, content, 'utf8');
    return patchPath;
  } catch (err) {
    console.error('[difish] 写 patch 文件失败:', err.message);
    return null;
  }
}

module.exports = { ensureDifishPlugin, pluginSourceDir };
