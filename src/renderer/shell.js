'use strict';

/**
 * shell.js — 壳页面交互逻辑
 * 标题栏按钮 / 后端状态点 / 开机动画。
 * 通过 preload 暴露的 window.difish 和主进程通信。
 * 设置面板是独立窗口（settings.html），点 ⚙ 由主进程打开。
 */

(function () {
  // ---------- 标题栏按钮 ----------
  document.getElementById('btn-min').addEventListener('click', () => window.difish.windowAction('min'));
  document.getElementById('btn-max').addEventListener('click', () => window.difish.windowAction('max'));
  document.getElementById('btn-close').addEventListener('click', () => window.difish.windowAction('close'));

  // ---------------------------------------------------------------------------
  // 开机动画
  // ---------------------------------------------------------------------------
  const boot = document.getElementById('boot');
  const bootVideo = document.getElementById('boot-video');
  const bootNote = document.getElementById('boot-note');
  let bootGone = false;

  /** 素材缺失/解码失败 → 退到纯 CSS 字标，不要留一片黑 */
  function bootFallback() {
    if (!bootVideo) return;
    bootVideo.classList.add('boot-dead');
    if (boot) boot.classList.add('boot-fallback-on');
  }

  if (bootVideo) {
    // 视频源不存在时 error 会触发在 video 上
    bootVideo.addEventListener('error', bootFallback);
    // 保险：3 秒后还没拿到任何元数据，就当素材不可用
    // （某些情况下 error 不触发，比如源为空或解码器静默失败）
    setTimeout(() => {
      if (bootVideo.readyState === 0) bootFallback();
    }, 3000);

    // ⚠️ 这段素材有两个坑，都是实测出来的：
    //  1) 开头约 2 秒是纯黑（黑场 → logo 浮现）。页面在窗口显示之前就开始加载了，
    //     不跳过去的话，等你能看见时黑场早播完了 —— 看着就像「没有动画」。
    //  2) 素材只有 4 秒，而 dsh 冷启动要 7–90 秒。播完就定住，剩下全是静止画面 ——
    //     观感就是「动画放完了，dsh 还没起来」。
    // 对策：跳到 logo 位置开始；播完再从那里重播（不回 0，否则闪黑），
    //       形成缓慢的呼吸感，整个等待期都有动静。
    const SKIP_TO = 1.5;
    let bootStarted = false;
    const startVideo = () => {
      if (bootStarted || bootGone) return;
      bootStarted = true;
      try {
        if (Number.isFinite(bootVideo.duration) && bootVideo.duration > SKIP_TO + 1) {
          bootVideo.currentTime = SKIP_TO;
        }
      } catch (e) { /* 忽略：跳不过去就从头播 */ }
      const p = bootVideo.play();
      if (p && typeof p.catch === 'function') p.catch(() => bootFallback());
    };
    bootVideo.addEventListener('ended', () => {
      if (bootGone) return;
      try { bootVideo.currentTime = SKIP_TO; } catch (e) { /* 忽略 */ }
      const p = bootVideo.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ });
    });
    // 正常由 main.js 在窗口真正显示后调用；1.2 秒没等到就自己开始（防止信号丢失）
    window.__wvStartBoot = startVideo;
    setTimeout(startVideo, 1200);
  }

  /** 淡出并移除开机动画（同时停掉视频，释放解码器） */
  function hideBoot() {
    if (bootGone || !boot) return;
    bootGone = true;
    if (bootTimer) { clearInterval(bootTimer); bootTimer = null; }
    boot.classList.add('boot-out');
    setTimeout(() => {
      try { if (bootVideo) bootVideo.pause(); } catch (e) { /* 忽略 */ }
      try { boot.remove(); } catch (e) { /* 忽略 */ }
    }, 500);
  }

  // 右下角的秒数：显示**真实已等待时长**。
  // 故意不做「假进度条」—— dsh 启动过程没有可读的进度，
  // 编一个 80% 卡住不动，比不给数字更糟。
  let bootTimer = null;
  (function startElapsed() {
    const el = document.getElementById('boot-elapsed');
    if (!el) return;
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      el.textContent = s + 's';
    };
    tick();
    bootTimer = setInterval(tick, 1000);
  })();

  // ---------- 后端状态点 ----------
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  function setStatus(status, detail) {
    dot.className = '';
    if (status === 'ready') {
      dot.classList.add('cyan');
      statusText.textContent = '已连接' + (detail ? ' · ' + detail.replace('http://127.0.0.1:', '') : '');
      hideBoot();                       // 就绪 → 收起开机动画
    } else if (status === 'starting') {
      statusText.textContent = '启动中';
      if (bootNote) bootNote.textContent = '正在启动后端…';
    } else if (status === 'stopped') {
      statusText.textContent = '已停止' + (detail ? ' · ' + detail : '');
      if (bootNote) bootNote.textContent = '后端已停止';
    } else if (status === 'error') {
      dot.classList.add('red');
      statusText.textContent = '出错' + (detail ? ' · ' + detail : '');
      // 出错时不要让动画一直转，把原因写在开机画面上
      if (bootNote) bootNote.textContent = '启动失败' + (detail ? '：' + detail : '');
    }
  }
  window.difish.onBackendStatus(({ status, detail }) => setStatus(status, detail));

  // ---------- 主题（从主进程推过来） ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  window.difish.onThemeChange(applyTheme);

  // ---------- 初始化 ----------
  window.difish.getState().then((state) => {
    applyTheme(state.settings.theme);
    // 左上角显示版本号：difish v0.1.1
    if (state.version) {
      document.getElementById('app-version').textContent = 'v' + state.version;
    }
    if (state.backendUp) {
      // 后端已经就绪（例如刷新壳页面）→ 不必再走一遍开机动画
      setStatus('ready', state.port ? ':' + state.port : '');
    }
  });
})();
