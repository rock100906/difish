'use strict';

/**
 * shell.js — 壳页面交互逻辑
 * 标题栏按钮 / 后端状态点。
 * 通过 preload 暴露的 window.difish 和主进程通信。
 * 设置面板是独立窗口（settings.html），点 ⚙ 由主进程打开。
 */

(function () {
  // ---------- 标题栏按钮 ----------
  document.getElementById('btn-min').addEventListener('click', () => window.difish.windowAction('min'));
  document.getElementById('btn-max').addEventListener('click', () => window.difish.windowAction('max'));
  document.getElementById('btn-close').addEventListener('click', () => window.difish.windowAction('close'));

  // ---------- 后端状态点 ----------
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  function setStatus(status, detail) {
    dot.className = '';
    if (status === 'ready') {
      dot.classList.add('cyan');
      statusText.textContent = '已连接' + (detail ? ' · ' + detail.replace('http://127.0.0.1:', '') : '');
    } else if (status === 'starting') {
      statusText.textContent = '启动中';
    } else if (status === 'stopped') {
      statusText.textContent = '已停止' + (detail ? ' · ' + detail : '');
    } else if (status === 'error') {
      dot.classList.add('red');
      statusText.textContent = '出错' + (detail ? ' · ' + detail : '');
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
    if (state.backendUp) setStatus('ready', state.port ? ':' + state.port : '');
  });
})();
