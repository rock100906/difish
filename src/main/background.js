'use strict';

/**
 * background.js — difish 壳的背景渲染
 *
 * 背景类型：
 *   none        无背景（dsh 默认外观）
 *   image       静态图片（从电脑选择）
 *   video       动态视频（本地 http 流式提供，支持大文件）
 *   transparent 透明背景（页面底色打透，让窗口毛玻璃材质把桌面透上来）
 *
 * 两个可调系数：
 *   opacity  透明系数 0~1：页面底色遮罩的 alpha（越大越不透明，0 全透）
 *   blur     模糊系数 0~50：背景图片/视频元素的模糊像素
 *
 * 原理：背景图片/视频作为 fixed + z-index:-1 的元素注入 dsh 页面，
 *       页面底色用 insertCSS 打透/半透明，露出背景层。
 *       和 Bigfish 的思路一致，但把背景/系数都做成动态可调。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/** 当前背景设置（由 main.js 传入/更新） */
let current = {
  type: 'none',
  filePath: '',
  opacity: 0.8,
  blur: 0,
};

let bgServer = null;       // 本地静态文件服务器（图片/视频统一走它，支持 Range）
let bgCssKey = null;       // insertCSS 返回的 key（移除时用）
let bgElementType = null;  // 当前注入的元素类型 'img' | 'video' | null

/** 根据文件扩展名猜 MIME（图片/视频） */
function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  };
  return map[ext] || 'application/octet-stream';
}

function isImage(p) { return mimeFor(p).startsWith('image/'); }
function isVideo(p) { return mimeFor(p).startsWith('video/'); }

/**
 * 起 127.0.0.1 随机端口 http 服务，流式提供背景文件（支持 Range 断点，大文件不占内存）。
 * @returns {Promise<string|null>} 页面可访问的 URL（失败返回 null）
 */
function startBgServer(filePath) {
  stopBgServer();
  if (!filePath || !fs.existsSync(filePath)) return Promise.resolve(null);
  let total;
  try { total = fs.statSync(filePath).size; } catch { return Promise.resolve(null); }
  const type = mimeFor(filePath);
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const range = (req.headers.range || '').trim();
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (range && m) {
        let start = m[1] !== '' ? parseInt(m[1], 10) : 0;
        let end = m[2] !== '' ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': total });
        fs.createReadStream(filePath).pipe(res);
      }
    });
    srv.on('error', () => { srv.close(); resolve(null); });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      bgServer = srv;
      resolve(`http://127.0.0.1:${port}/bg${path.extname(filePath).toLowerCase()}`);
    });
  });
}

function stopBgServer() {
  if (bgServer) {
    try { bgServer.close(); } catch { /* 忽略 */ }
    bgServer = null;
  }
}

/** 注入背景元素 + 页面底色遮罩（核心逻辑）。wc = dsh 的 webContents */
async function applyBackground(wc) {
  if (!wc || wc.isDestroyed()) return;
  // 1) 清掉旧注入
  try { if (bgCssKey) wc.removeInsertedCSS(bgCssKey); } catch { /* 忽略 */ }
  bgCssKey = null;
  try {
    await wc.executeJavaScript(
      "(function(){['difish-bg-el'].forEach(function(id){var el=document.getElementById(id);if(el)el.remove();});return true;})()"
    );
  } catch { /* 忽略 */ }
  bgElementType = null;

  const { type, filePath, opacity, blur } = current;
  const blurPx = Math.max(0, Math.min(50, Number(blur) || 0));
  const alpha = Math.max(0, Math.min(1, Number(opacity) == null ? 0.8 : Number(opacity)));

  // 2) 构造页面遮罩 CSS（透明系数控制 alpha）
  // 深色遮罩偏墨蓝，浅色偏纸白；透明度越高越不透明。
  const darkMask = `rgba(18, 18, 24, ${alpha})`;
  const lightMask = `rgba(244, 246, 249, ${Math.max(0.1, alpha * 0.9)})`;
  let overlayCss = '';
  if (type === 'transparent') {
    // 透明玻璃：不透明度控制页面遮罩厚度
    // 0 = 完全透明（纯 Acrylic 毛玻璃，壁纸清晰透出）；1 = 盖满不透明遮罩（界面内容最清晰）
    // 注意 alpha=0 时所有遮罩 alpha 必须为 0，否则侧边栏残留底色就不算"完全透明"
    const gDark = `rgba(18,18,22,${(alpha * 0.6).toFixed(3)})`;
    const gSideDark = `rgba(26,26,33,${(alpha * 0.7).toFixed(3)})`;
    const gLight = `rgba(255,255,255,${(alpha * 0.4).toFixed(3)})`;
    const gSideLight = `rgba(255,255,255,${(alpha * 0.55).toFixed(3)})`;
    overlayCss = `
      html, body { background-color: transparent !important; }
      body[data-ds-dark-theme] { background-color: ${gDark} !important; }
      body[data-ds-dark-theme] [class*="_sidebarCol"] { background-color: ${gSideDark} !important; }
      body[data-ds-dark-theme] [class*="_frame"],
      body[data-ds-dark-theme] [class*="_root"],
      body[data-ds-dark-theme] [class*="_centerCol"],
      body[data-ds-dark-theme] [class*="_scrollBody"] { background-color: transparent !important; }
      body:not([data-ds-dark-theme]) { background-color: ${gLight} !important; }
      body:not([data-ds-dark-theme]) [class*="_sidebarCol"] { background-color: ${gSideLight} !important; }
      body:not([data-ds-dark-theme]) [class*="_frame"],
      body:not([data-ds-dark-theme]) [class*="_root"],
      body:not([data-ds-dark-theme]) [class*="_centerCol"],
      body:not([data-ds-dark-theme]) [class*="_scrollBody"] { background-color: transparent !important; }
      #root, #app { background-color: transparent !important; }
    `;
  } else if (type === 'image' || type === 'video') {
    // 图片/视频背景：页面底色按透明系数打半透明，透出背景层
    overlayCss = `
      html, body { background-color: ${darkMask} !important; }
      body[data-ds-dark-theme] { background-color: ${darkMask} !important; }
      body[data-ds-dark-theme] [class*="_sidebarCol"] { background-color: rgba(24,24,30,${Math.min(1, alpha + 0.08)}) !important; }
      body[data-ds-dark-theme] [class*="_frame"],
      body[data-ds-dark-theme] [class*="_root"],
      body[data-ds-dark-theme] [class*="_centerCol"],
      body[data-ds-dark-theme] [class*="_scrollBody"] { background-color: transparent !important; }
      body:not([data-ds-dark-theme]) { background-color: ${lightMask} !important; }
      body:not([data-ds-dark-theme]) [class*="_sidebarCol"] { background-color: rgba(236,238,244,${Math.min(1, alpha * 0.9 + 0.1)}) !important; }
      body:not([data-ds-dark-theme]) [class*="_frame"],
      body:not([data-ds-dark-theme]) [class*="_root"],
      body:not([data-ds-dark-theme]) [class*="_centerCol"],
      body:not([data-ds-dark-theme]) [class*="_scrollBody"] { background-color: transparent !important; }
    `;
  } else {
    // none：恢复 dsh 默认外观
    overlayCss = `html { background-image: none !important; }`;
  }

  if (overlayCss) {
    try {
      bgCssKey = await wc.insertCSS(overlayCss);
    } catch { /* 忽略 */ }
  }

  // 3) 注入背景元素（图片/视频）
  if ((type === 'image' || type === 'video') && filePath) {
    const url = await startBgServer(filePath);
    if (!url) return;
    const tag = isVideo(filePath) ? 'video' : 'img';
    bgElementType = tag;
    const js = [
      "(function(){",
      "var old=document.getElementById('difish-bg-el');if(old)old.remove();",
      `var el=document.createElement(${JSON.stringify(tag)});`,
      "el.id='difish-bg-el';",
      `el.src=${JSON.stringify(url)};`,
      tag === 'video' ? 'el.muted=true;el.loop=true;el.autoplay=true;el.playsInline=true;' : '',
      `el.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;object-fit:cover;z-index:-1;pointer-events:none;filter:blur(${blurPx}px);transform:scale(${blurPx > 0 ? 1.02 : 1});background:#000;';`,
      "document.documentElement.appendChild(el);",
      tag === 'video' ? "var p=el.play();if(p&&p.catch)p.catch(function(){});" : '',
      "return true;",
      "})()",
    ].join('');
    try { await wc.executeJavaScript(js); } catch { /* 忽略 */ }
  }
}

/** 设置新背景并立即应用（供 IPC / 启动时调用） */
async function setBackground(wc, next) {
  current = {
    type: next.type || 'none',
    filePath: next.filePath || '',
    opacity: next.opacity == null ? 0.8 : Number(next.opacity),
    blur: next.blur == null ? 0 : Number(next.blur),
  };
  if (wc && !wc.isDestroyed()) await applyBackground(wc);
  return { ...current };
}

function getBackground() {
  return { ...current };
}

function stopAll() {
  stopBgServer();
}

module.exports = { applyBackground, setBackground, getBackground, stopAll, mimeFor, isImage, isVideo };
