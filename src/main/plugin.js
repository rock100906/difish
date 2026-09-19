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
 * 确保 difish-settings 就绪，返回 patch 文件路径（供 --patch 使用）。
 * @param {string} userData difish 的 userData 目录
 */
function ensureDifishPlugin(userData) {
  const src = pluginSourceDir();
  if (!src) return null;

  // 1) 把插件拷贝到 web profile node_modules/difish-settings
  const target = path.join(webProfileNodeModules(), 'difish-settings');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 删除旧的（可能是失效的 junction 或旧拷贝）
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
      console.error('[difish] 删除旧 difish-settings 失败:', e.message);
    }
    fs.cpSync(src, target, { recursive: true, force: true });
    console.log('[difish] difish-settings 插件已就绪:', target);
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
