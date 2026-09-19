// difish-settings — Client 侧 bundle
// 在 dsh 设置界面里注册「difish」设置页（背景 / 窗口 / 系统 / 后端），
// 通过 window.difishBridge 调 difish 壳的原生能力（由 difish 的 WebContentsView preload 注入）。
// 不在 difish 桌面版里运行时（无 difishBridge），只展示界面不生效。
window.__ModuleLoader__.load({
  id: 'difish-settings',
  factory: (require) => {
    'use strict';
    // dsh 的模块加载器不提供 module，需自己定义（和官方插件 bundle 一致）
    var module = { exports: {} };
    var React = require('react');

    var name = 'difish-settings';
    // remote / remote.llm / remote.settings 必须显式声明：dsh 的 Cordis 上下文对
    // 未声明的服务做严格访问检查，直接读 ctx.remote 会抛异常；异常若发生在组件
    // 挂载的 effect 里，整棵 React 树会被卸载 —— 整个界面变空白。
    var inject = ['slots', 'remote', 'remote.llm', 'remote.settings'];

    var CSS = [
      '.df-page{padding:20px 22px;max-width:760px}',
      '.df-hero{display:flex;align-items:center;gap:12px;margin-bottom:16px}',
      '.df-logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),#7c5cff);display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 0 18px color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,transparent)}',
      '.df-title{font-size:17px;font-weight:650;color:var(--dsw-alias-label-primary)}',
      '.df-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.df-note{font-size:12px;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);border-radius:8px;padding:8px 12px;margin-bottom:12px}',
      '.df-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:12px}',
      '.df-sync{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.df-sync-h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:8px}',
      '.df-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary);padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);margin:0 6px 6px 0;cursor:pointer}',
      '.df-chip.on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.df-chip input{accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.df-tag{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}',
      '.df-card-h{font-size:12px;font-weight:650;letter-spacing:.6px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}',
      '.df-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}',
      '.df-bgtype{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 6px;cursor:pointer;text-align:center;transition:all .15s ease;color:var(--dsw-alias-label-secondary)}',
      '.df-bgtype .df-ic{font-size:18px;display:block;margin-bottom:4px}',
      '.df-bgtype .df-lb{font-size:12px}',
      '.df-bgtype:hover{border-color:var(--dsw-alias-border-l2)}',
      '.df-bgtype.active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);box-shadow:0 0 14px color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}',
      '.df-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;gap:12px}',
      '.df-k{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.df-v{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.df-file{width:100%;margin-top:8px;padding:8px 12px;font-size:12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.df-file:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.df-file small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px;color:var(--dsw-alias-label-secondary)}',
      '.df-slider-wrap{display:flex;align-items:center;gap:10px}',
      '.df-slider{flex:1;accent-color:var(--dsw-alias-brand-primary)}',
      '.df-slider-val{min-width:46px;text-align:right;font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.df-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 10px;font-size:12px}',
      '.df-toggle{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}',
      '.df-btn{padding:8px 14px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600;cursor:pointer}',
      '.df-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      // 主按钮：不要用硬编码白色文字 —— 暗色主题下 brand-primary 是亮色，
      // 白字压亮底会糊成一片（看起来像"没有字的白按钮"）。改用品牌色描边 +
      // 极淡品牌底 + 主题保证可读的 label-primary 文字。
      '.df-btn-primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.df-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);color:var(--dsw-alias-label-primary)}',
      '.df-sep{height:1px;background:var(--dsw-alias-border-l1);margin:12px 0}',
      '.df-log{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-all}',
      '.df-btn:disabled{opacity:.5;cursor:default}',
      '.df-status{display:inline-flex;align-items:center;gap:6px;font-size:12px}',
      '.df-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}',
      '.df-dot.err{background:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(React, [type, props].concat(children));
    }

    // 兜底：设置页内部任何异常都只显示一小块提示，绝不把整棵 React 树掀掉变白屏
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error) {
        console.error('[difish-settings] 设置页渲染失败:', error);
      }
      render() {
        if (this.state.error) {
          var message = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
          return h('div', { className: 'df-page' },
            h('div', { className: 'df-card' },
              h('div', { className: 'df-card-h' }, '⚠️ difish 设置页加载失败'),
              h('div', { className: 'df-sub' }, message)
            )
          );
        }
        return this.props.children;
      }
    }

    // DeepSeek 官方路由的 settings 命名空间与路由名（必须和 dsh-llm-deepseek 一致）
    var DS_NS = 'llm-deepseek';
    var DS_PROVIDER = 'deepseek-official';

    // ===== DeepSeek 官方模型拉取（共用组件：difish 设置页 + 原生模型卡官方插槽）=====
    // dsh 自带的 dsh-llm-deepseek 只实现了 listModels()，从没注册过
    // ctx.llm.registerModelDiscovery()，所以原生 DeepSeek 卡片只能看到本地静态目录。
    // Host 侧已补上 discovery；这里提供「拉取 → 勾选 → 应用」的界面。
    // 只增不减：官方 /models 不返回 inputModalities / imagePixelBudget /
    // systemPromptUpdate 等字段，整体替换会把本地已有的能力冲掉。
    function remoteOfCtx(ctx) {
      // 双保险：即使服务未声明/未就绪，也绝不把异常抛到渲染或 effect 里
      try {
        var remote = ctx && ctx.remote;
        return (remote && remote.settings && remote.llm) ? remote : null;
      } catch (error) {
        return null;
      }
    }
    // dsh 的远程调用统一返回 RemoteResult<T> = {ok:true,value} | {ok:false,error}，必须拆包
    function unwrapRemote(result, what) {
      if (result && result.ok === true) return result.value;
      var message = result && result.error && result.error.message ? result.error.message : '未知错误';
      throw new Error(what + '失败：' + message);
    }
    function readDeepSeekCatalog(ctx) {
      return remoteOfCtx(ctx).settings.describe().then(function (result) {
        var all = unwrapRemote(result, '读取设置');
        var views = (all && all.namespaces) || [];
        var view = null;
        for (var i = 0; i < views.length; i++) { if (views[i].ns === DS_NS) { view = views[i]; break; } }
        var models = (view && view.value && Array.isArray(view.value.models)) ? view.value.models : [];
        return { view: view, models: models };
      });
    }
    function idOf(model) { return model && model.id; }
    function catalogEntry(model) {
      var entry = { id: model.id, name: model.name || model.id };
      if (typeof model.contextWindow === 'number') entry.contextWindow = model.contextWindow;
      if (typeof model.maxTokens === 'number') entry.maxTokens = model.maxTokens;
      return entry;
    }
    // 「以官网为准」时的条目构造：id 集合听官网的，但同名模型继承本地能力字段。
    // 官方 /models 只返回 id（顶多 name），不返回 inputModalities / imagePixelBudget /
    // imageMaxBytes / systemPromptUpdate / description —— 直接用官方条目重建，
    // deepseek-flash 会退化成纯文本模型（dsh-llm-deepseek 里 inputModalities 缺省 ["text"]）。
    function alignEntry(model, prior) {
      var entry = { id: model.id };
      var officialName = (model.name && model.name !== model.id) ? model.name : null;
      entry.name = officialName || (prior && prior.name) || model.id;
      if (prior && prior.description !== undefined) entry.description = prior.description;
      if (typeof model.contextWindow === 'number') entry.contextWindow = model.contextWindow;
      else if (prior && typeof prior.contextWindow === 'number') entry.contextWindow = prior.contextWindow;
      if (typeof model.maxTokens === 'number') entry.maxTokens = model.maxTokens;
      else if (prior && typeof prior.maxTokens === 'number') entry.maxTokens = prior.maxTokens;
      if (prior) {
        if (Array.isArray(prior.inputModalities)) entry.inputModalities = prior.inputModalities.slice();
        if (prior.imagePixelBudget !== undefined) entry.imagePixelBudget = prior.imagePixelBudget;
        if (prior.imageMaxBytes !== undefined) entry.imageMaxBytes = prior.imageMaxBytes;
        if (prior.systemPromptUpdate !== undefined) entry.systemPromptUpdate = prior.systemPromptUpdate;
      }
      return entry;
    }

    function DeepSeekModelSync(props) {
      var ctx = props && props.ctx;
      var compact = props && props.compact === true;
      var keyConfigured = props && props.keyConfigured;
      var snapState = React.useState({ current: [], base: [], official: null, picked: {}, revision: undefined, pulled: false });
      var snap = snapState[0], setSnap = snapState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var msgState = React.useState('');
      var msg = msgState[0], setMsg = msgState[1];

      function load() {
        if (!remoteOfCtx(ctx)) { setMsg('当前环境拿不到 dsh 远程接口（仅桌面版 difish 可用）'); return; }
        readDeepSeekCatalog(ctx).then(function (read) {
          setSnap({ current: read.models.map(idOf).filter(Boolean), base: read.models, official: null, picked: {}, revision: read.view ? read.view.revision : undefined, pulled: false });
        }).catch(function (e) { setMsg('读取本地目录失败：' + (e && e.message ? e.message : e)); });
      }
      function pull() {
        var remote = remoteOfCtx(ctx);
        if (!remote) { setMsg('当前环境拿不到 dsh 远程接口（仅桌面版 difish 可用）'); return; }
        setBusy(true); setMsg('正在向官方 /models 拉取…');
        readDeepSeekCatalog(ctx).then(function (read) {
          return remote.llm.discoverModels(DS_NS, { provider: DS_PROVIDER }).then(function (result) {
            var found = unwrapRemote(result, '拉取模型');
            var official = Array.isArray(found) ? found : [];
            var known = {};
            read.models.forEach(function (m) { if (m && m.id) known[m.id] = true; });
            var picked = {};
            official.forEach(function (m) { if (!known[m.id]) picked[m.id] = true; });
            var freshCount = official.filter(function (m) { return !known[m.id]; }).length;
            // 关键防护：settings 层没有 models 时，dsh 实际用的是「内置默认目录」——
            // 只有那里才有 inputModalities / imagePixelBudget / systemPromptUpdate 等字段。
            // 此时若把它当成「本地为空」去写，等于把整个默认目录替换成官方精简条目，
            // 「只增不减」当场变成「只减不增」，图像输入能力会直接消失。所以此状态只读不写。
            var delegatesToDefaults = read.models.length === 0;
            setSnap({
              current: delegatesToDefaults ? [] : read.models.map(idOf).filter(Boolean),
              base: read.models,
              official: official,
              picked: delegatesToDefaults ? {} : picked,
              revision: read.view ? read.view.revision : undefined,
              pulled: delegatesToDefaults ? false : true
            });
            setMsg(delegatesToDefaults
              ? '⚠️ settings 里没有模型目录（读到 0 个），说明 dsh 正在使用内置默认目录。写入会整体替换它、丢掉图像输入等能力字段，所以本次只读不写。'
              : '官方公布 ' + official.length + ' 个，本地 ' + read.models.length + ' 个' + (freshCount ? '，新增 ' + freshCount + ' 个（已默认勾选）' : '（没有新增）'));
          });
        }).catch(function (e) { setMsg('❌ 拉取失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setBusy(false); });
      }
      // 以官网为准：写入的 id 集合 = 官网返回的集合（本地多出来的会被移除），
      // 但同名模型继承本地能力字段（见 alignEntry 的说明）。
      function submit() {
        var remote = remoteOfCtx(ctx);
        if (!remote || snap.pulled !== true) return;
        var base = snap.base || [];
        var official = snap.official || [];
        if (base.length === 0) {
          setMsg('⚠️ 本地目录为空，已停用写入：那说明 dsh 正在用内置默认目录，读不到真实目录就没法保住同名模型的能力字段。');
          return;
        }
        if (official.length === 0) {
          setMsg('⚠️ 官网没有返回任何模型，已停用写入（避免把目录清空）。');
          return;
        }
        var priorById = {};
        base.forEach(function (m) { if (m && m.id) priorById[m.id] = m; });
        var aligned = official.map(function (m) { return alignEntry(m, priorById[m.id]); });
        var officialIds = {};
        official.forEach(function (m) { officialIds[m.id] = true; });
        var removed = base.filter(function (m) { return m && m.id && !officialIds[m.id]; }).map(idOf);
        if (base.map(idOf).filter(Boolean).join('|') === aligned.map(idOf).filter(Boolean).join('|')) {
          setMsg('✅ 已与官网一致（' + aligned.length + ' 个），无需写入。');
          return;
        }
        setBusy(true); setMsg('正在按官网写入…');
        remote.settings.mutate(DS_NS, [{ op: 'set', path: ['models'], value: aligned }], snap.revision)
          .then(function (result) {
            unwrapRemote(result, '写入设置');
            setMsg('✅ 已按官网对齐：' + aligned.length + ' 个模型'
              + (removed.length ? '，移除 ' + removed.length + ' 个（' + removed.join(', ') + '）' : '')
              + '；同名模型的能力字段已保留。');
            setSnap({ current: aligned.map(idOf).filter(Boolean), base: aligned, official: snap.official, picked: {}, revision: undefined, pulled: false });
          })
          .catch(function (e) { setMsg('❌ 写入失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setBusy(false); });
      }
      React.useEffect(function () {
        try { load(); } catch (error) { setMsg('读取失败：' + (error && error.message ? error.message : error)); }
      }, []);

      var officialList = snap.official || [];
      var knownNow = {};
      snap.current.forEach(function (id) { knownNow[id] = true; });
      var freshCount = officialList.filter(function (m) { return !knownNow[m.id]; }).length;
      var officialIdsNow = {};
      officialList.forEach(function (m) { officialIdsNow[m.id] = true; });
      var willRemove = officialList.length ? snap.current.filter(function (id) { return !officialIdsNow[id]; }) : [];

      return h('div', { className: compact ? 'df-sync' : null },
        compact ? h('div', { className: 'df-sync-h' }, '🧠 官网模型同步') : null,
        keyConfigured === false ? h('div', { className: 'df-note', style: { margin: '0 0 8px' } }, '还没配置 API Key，先在卡片里填好再拉取。') : null,
        h('div', { className: 'df-row' },
          h('span', { className: 'df-k' }, '本地目录'),
          h('span', { className: 'df-v' }, snap.current.length ? (snap.current.length + ' 个 · ' + snap.current.join(', ')) : '—')
        ),
        officialList.length ? h('div', { className: 'df-row' },
          h('span', { className: 'df-k' }, '官方公布'),
          h('span', { className: 'df-v' }, officialList.length + ' 个 · ' + officialList.map(idOf).join(', '))
        ) : null,
        officialList.length ? h('div', { style: { margin: '8px 0' } },
          h('div', { className: 'df-sub', style: { marginBottom: 8 } },
            '以官网为准：应用后本地目录 = 下面的官网列表' + (freshCount ? '（新增 ' + freshCount + ' 个）' : '') + '。'),
          officialList.map(function (m) {
            var isNew = !knownNow[m.id];
            return h('span', { className: 'df-chip' + (isNew ? ' on' : ''), key: m.id },
              h('span', null, m.id),
              h('span', { className: 'df-tag' }, isNew ? '新增' : '保留')
            );
          })
        ) : null,
        willRemove.length ? h('div', { className: 'df-note', style: { margin: '8px 0' } },
          '⚠️ 本地多出 ' + willRemove.length + ' 个，覆盖后会被移除：' + willRemove.join(', ')) : null,
        msg ? h('div', { className: 'df-sub', style: { margin: '8px 0' } }, msg) : null,
        h('div', { className: 'df-row' },
          h('button', { className: 'df-btn', disabled: busy, onClick: pull }, busy ? '处理中…' : '拉取官网模型'),
          snap.pulled === true ? h('button', {
            className: 'df-btn df-btn-primary',
            disabled: busy,
            onClick: submit,
            style: { marginLeft: 8 }
          }, busy ? '处理中…' : '以官网为准覆盖') : null
        ),
        h('div', { className: 'df-sub', style: { marginTop: 6 } }, '以官网为准：本地多出的模型会被移除；同名模型保留本地能力字段（图像输入等），不会被官方精简字段冲掉。')
      );
    }

    function DifishSettingsPage(props) {
      var bridge = (typeof window !== 'undefined' && window.difishBridge) ? window.difishBridge : null;
      // difish 设置页挂在 dsh 设置界面里，DeepSeek 模型拉取走 dsh 自己的远程接口
      var ctx = props && props.ctx;
      var state = React.useState({ type: 'none', filePath: '', opacity: 0.8, blur: 0 });
      var bg = state[0], setBg = state[1];
      var shellState = React.useState(null);
      var shell = shellState[0], setShell = shellState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var updState = React.useState(null);
      var upd = updState[0], setUpd = updState[1];
      var chkState = React.useState(false);
      var checking = chkState[0], setChecking = chkState[1];
      var upgState = React.useState(false);
      var updating = upgState[0], setUpdating = upgState[1];
      var msgState = React.useState('');
      var updMsg = msgState[0], setUpdMsg = msgState[1];
      // 安全升级（备份 + 校验 + 回滚）
      var ugState = React.useState(null);
      var ug = ugState[0], setUg = ugState[1];
      var ugBusyState = React.useState(false);
      var ugBusy = ugBusyState[0], setUgBusy = ugBusyState[1];
      var ugMsgState = React.useState('');
      var ugMsg = ugMsgState[0], setUgMsg = ugMsgState[1];
      var ugMirrorState = React.useState('tencent');
      var ugMirror = ugMirrorState[0], setUgMirror = ugMirrorState[1];
      var ugLogState = React.useState('');
      var ugLog = ugLogState[0], setUgLog = ugLogState[1];
      // 用户数据快照
      var snapInfoState = React.useState(null);
      var snapInfo = snapInfoState[0], setSnapInfo = snapInfoState[1];
      var snapsState = React.useState([]);
      var snaps = snapsState[0], setSnaps = snapsState[1];
      var snapBusyState = React.useState(false);
      var snapBusy = snapBusyState[0], setSnapBusy = snapBusyState[1];
      var snapMsgState = React.useState('');
      var snapMsg = snapMsgState[0], setSnapMsg = snapMsgState[1];

      React.useEffect(function () {
        var alive = true;
        (async function init() {
          try {
            var b = bridge ? await bridge.getBackground() : null;
            var s = bridge ? await bridge.getShellState() : null;
            if (alive) { if (b) setBg(b); if (s) setShell(s); }
          } catch (e) { console.error('[difish-settings] bridge init failed', e); }
        })();
        // 安全升级：读初始状态 + 订阅下载日志
        if (bridge && bridge.upgradeStatus) {
          bridge.upgradeStatus().then(function (st) {
            if (!alive) return;
            setUg(st);
            if (st && st.mirror) setUgMirror(st.mirror);
          }).catch(function () {});
        }
        // 快照概览
        if (bridge && bridge.snapshotOverview) {
          bridge.snapshotOverview().then(function (o) { if (alive) setSnapInfo(o); }).catch(function () {});
        }
        if (bridge && bridge.snapshotList) {
          bridge.snapshotList().then(function (l) { if (alive) setSnaps(l || []); }).catch(function () {});
        }
        var offLog = null;
        if (bridge && bridge.onUpgradeLog) {
          try {
            offLog = bridge.onUpgradeLog(function (line) {
              if (!alive) return;
              setUgLog(function (prev) {
                var next = prev + line;
                return next.length > 8000 ? next.slice(-8000) : next; // 别让日志无限涨
              });
            });
          } catch (e) { /* 订阅失败不影响其它功能 */ }
        }
        return function () {
          alive = false;
          if (typeof offLog === 'function') { try { offLog(); } catch (e) { /* 忽略 */ } }
        };
      }, []);

      function push(next) {
        setBg(next);
        if (bridge) bridge.setBackground(next).then(setBg).catch(function () {});
      }
      function setType(t) { push({ ...bg, type: t }); }
      function setFilter(f) { push({ ...bg, filter: f }); }
      function setOpacity(v) { push({ ...bg, opacity: v }); }
      function setBlur(v) { push({ ...bg, blur: v }); }
      function chooseFile() {
        if (!bridge) return;
        bridge.chooseBackgroundFile().then(function (p) {
          if (p) push({ ...bg, filePath: p });
        }).catch(function () {});
      }
      function setSetting(key, value) {
        if (bridge) bridge.setShellSetting(key, value).then(function (s) { setShell(function (prev) { return prev ? { ...prev, settings: s } : prev; }); }).catch(function () {});
        else setShell(function (prev) { return prev ? { ...prev, settings: { ...prev.settings, [key]: value } } : prev; });
      }
      function restart() {
        setBusy(true);
        if (bridge) bridge.restartBackend().catch(function () {}).finally(function () { setBusy(false); });
        else setBusy(false);
      }
      function checkNow() {
        if (!bridge) return;
        setChecking(true); setUpdMsg('');
        bridge.checkUpdates().then(function (info) {
          setUpd(info);
          if (info.error) setUpdMsg('检查失败：' + info.error);
        }).catch(function (e) { setUpdMsg('检查失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setChecking(false); });
      }
      function doUpdate() {
        if (!bridge) return;
        setUpdating(true); setUpdMsg('正在升级 dsh，可能需要几分钟，请稍候…');
        bridge.updateDsh().then(function (res) {
          setUpdMsg(res.ok ? '✅ ' + res.message : '❌ ' + res.message);
          if (res.ok) {
            bridge.checkUpdates().then(function (info) { setUpd(info); }).catch(function () {});
            if (window.confirm('dsh 升级完成，重启后端后生效。现在重启？')) {
              bridge.restartBackend().catch(function () {});
            }
          }
        }).catch(function (e) { setUpdMsg('升级失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setUpdating(false); });
      }

      // ---- 安全升级（备份 + 校验 + 可回滚）----
      function loadUpgrade() {
        if (!bridge || !bridge.upgradeStatus) return;
        bridge.upgradeStatus().then(function (st) {
          setUg(st);
          if (st && st.pendingAction) setUgMsg('⏳ 已安排' + (st.pendingAction === 'apply' ? '升级' : '回滚') + '，重启 difish 后生效。');
        }).catch(function () {});
      }
      function ugDownload() {
        if (!bridge || !bridge.upgradeDownload) return;
        setUgBusy(true); setUgMsg('正在下载到暂存区（不碰现网，可以继续用）…');
        bridge.upgradeDownload(ugMirror).then(function (res) {
          setUgMsg((res.ok ? '✅ ' : '❌ ') + res.message + (res.output ? '\n' + res.output : ''));
          loadUpgrade();
        }).catch(function (e) { setUgMsg('❌ 下载失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setUgBusy(false); });
      }
      function ugApply() {
        if (!bridge || !bridge.upgradeApply) return;
        var st = ug || {};
        if (!window.confirm('将升级到 ' + (st.stagedVersion || '新版') + ' 并重启 difish。\n\n'
          + '· 切换时会自动把当前 ' + (st.installedVersion || '') + ' 备份到 backups\n'
          + '· 新版启动失败会自动回滚\n\n现在安排并重启？')) return;
        bridge.upgradeApply().then(function (res) {
          if (!res.ok) { setUgMsg('❌ ' + res.message); return; }
          setUgMsg('✅ ' + res.message);
          bridge.relaunch ? bridge.relaunch().catch(function () {}) : null;
        }).catch(function (e) { setUgMsg('❌ ' + (e && e.message ? e.message : e)); });
      }
      function ugRollback() {
        if (!bridge || !bridge.upgradeRollback) return;
        var st = ug || {};
        var b = (st.backups && st.backups[0]) || null;
        if (!b) { setUgMsg('❌ 还没有任何备份，无法回滚。'); return; }
        if (!window.confirm('回滚到 ' + (b.version || b.name) + ' 并重启 difish？\n\n当前版本也会被保留在备份目录。')) return;
        bridge.upgradeRollback(b.dir).then(function (res) {
          if (!res.ok) { setUgMsg('❌ ' + res.message); return; }
          setUgMsg('✅ ' + res.message);
          bridge.relaunch ? bridge.relaunch().catch(function () {}) : null;
        }).catch(function (e) { setUgMsg('❌ ' + (e && e.message ? e.message : e)); });
      }
      function ugDiscard() {
        if (!bridge || !bridge.upgradeDiscard) return;
        bridge.upgradeDiscard().then(function (res) {
          setUgMsg(res.ok ? '✅ ' + res.message : '❌ ' + res.message);
          loadUpgrade();
        }).catch(function () {});
      }
      function ugRelaunch() {
        if (bridge && bridge.relaunch) bridge.relaunch().catch(function () {});
      }

      // ---- 用户数据快照 ----
      function loadSnap() {
        if (!bridge || !bridge.snapshotOverview) return;
        bridge.snapshotOverview().then(function (o) { setSnapInfo(o); }).catch(function () {});
        if (bridge.snapshotList) bridge.snapshotList().then(function (l) { setSnaps(l || []); }).catch(function () {});
      }
      function snapExport() {
        if (!bridge || !bridge.snapshotExport) return;
        setSnapBusy(true); setSnapMsg('正在打包…');
        bridge.snapshotExport({ label: '手动' }).then(function (r) {
          setSnapMsg((r.ok ? '✅ ' : '❌ ') + r.message);
          loadSnap();
        }).catch(function (e) { setSnapMsg('❌ 导出失败：' + (e && e.message ? e.message : e)); })
          .finally(function () { setSnapBusy(false); });
      }
      function snapReveal() {
        if (bridge && bridge.snapshotReveal) bridge.snapshotReveal().catch(function () {});
      }
      function pruneNow() {
        if (!bridge || !bridge.backupPrune) return;
        bridge.backupPrune(3).then(function (r) {
          setSnapMsg((r.ok ? '✅ ' : '❌ ') + r.message);
          loadUpgrade();
        }).catch(function () {});
      }

      var s = (shell && shell.settings) || {};
      var types = [
        { t: 'none', ic: '🚫', lb: '无背景' },
        { t: 'image', ic: '🖼', lb: '静态图片' },
        { t: 'video', ic: '🎬', lb: '动态视频' },
        { t: 'transparent', ic: '💎', lb: '透明玻璃' },
      ];
      var isMedia = bg.type === 'image' || bg.type === 'video';
      var isTransparent = bg.type === 'transparent';

      // 透明模式的滤镜选项
      var filters = [
        { f: 'none', ic: '✨', lb: '纯透明' },
        { f: 'glass', ic: '🌫', lb: '毛玻璃' },
      ];
      var glassNote = isTransparent
        ? h('div', { className: 'df-note', style: { marginTop: 10, marginBottom: 0 } }, '💡 「毛玻璃」模糊壁纸透出；「纯透明」清晰透出壁纸。透明程度 0 = 完全透明。')
        : null;

      return h('div', { className: 'df-page' },
        h('div', { className: 'df-hero' },
          h('div', { className: 'df-logo' }, '🐋'),
          h('div', null,
            h('div', { className: 'df-title' }, 'difish 桌面壳'),
            h('div', { className: 'df-sub' }, shell ? ('v' + shell.version) : 'DeepSeek Harness 桌面版')
          )
        ),
        bridge ? null : h('div', { className: 'df-note' }, '⚠ 当前不在 difish 桌面版里运行，改动不会生效。'),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '🎨 背景'),
          h('div', { className: 'df-grid' }, types.map(function (x) {
            return h('div', { key: x.t, className: 'df-bgtype' + (bg.type === x.t ? ' active' : ''), onClick: function () { setType(x.t); } },
              h('span', { className: 'df-ic' }, x.ic),
              h('span', { className: 'df-lb' }, x.lb)
            );
          })),
          // —— 图片/视频背景：选文件 + 不透明度 + 模糊 ——
          isMedia ? h('button', { className: 'df-file', onClick: chooseFile }, '📁 选择' + (bg.type === 'image' ? '图片' : '视频') + '文件',
            h('small', null, bg.filePath || '（未选择）')) : null,
          isMedia ? h('div', null,
            h('div', { className: 'df-row' },
              h('span', { className: 'df-k' }, '不透明度'),
              h('div', { className: 'df-slider-wrap' },
                h('input', { className: 'df-slider', type: 'range', min: 0, max: 100, value: Math.round((bg.opacity || 0) * 100), onChange: function (e) { setOpacity(Number(e.target.value) / 100); } }),
                h('span', { className: 'df-slider-val' }, Math.round((bg.opacity || 0) * 100) + '%')
              )
            ),
            h('div', { className: 'df-row' },
              h('span', { className: 'df-k' }, '模糊系数'),
              h('div', { className: 'df-slider-wrap' },
                h('input', { className: 'df-slider', type: 'range', min: 0, max: 50, value: bg.blur || 0, onChange: function (e) { setBlur(Number(e.target.value)); } }),
                h('span', { className: 'df-slider-val' }, (bg.blur || 0) + 'px')
              )
            )
          ) : null,
          // —— 透明模式：滤镜选择 + 透明程度 ——
          isTransparent ? h('div', null,
            h('div', { className: 'df-row' },
              h('span', { className: 'df-k' }, '滤镜'),
              h('div', { className: 'df-grid', style: { width: '62%' } }, filters.map(function (f) {
                return h('div', { key: f.f, className: 'df-bgtype' + ((bg.filter || 'glass') === f.f ? ' active' : ''), onClick: function () { setFilter(f.f); } },
                  h('span', { className: 'df-ic' }, f.ic),
                  h('span', { className: 'df-lb' }, f.lb)
                );
              }))
            ),
            h('div', { className: 'df-row' },
              h('span', { className: 'df-k' }, '透明程度'),
              h('div', { className: 'df-slider-wrap' },
                h('input', { className: 'df-slider', type: 'range', min: 0, max: 100, value: Math.round((bg.opacity || 0) * 100), onChange: function (e) { setOpacity(Number(e.target.value) / 100); } }),
                h('span', { className: 'df-slider-val' }, Math.round((bg.opacity || 0) * 100) + '%')
              )
            )
          ) : null
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '🪟 窗口'),
          glassNote,
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '主题'),
            h('select', { className: 'df-select', value: s.theme || 'dark', onChange: function (e) { setSetting('theme', e.target.value); } },
              h('option', { value: 'dark' }, '深色'),
              h('option', { value: 'light' }, '浅色')
            )
          ),
          isTransparent ? null : h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '毛玻璃（Win11）'),
            h('select', { className: 'df-select', value: s.glass || 'acrylic', onChange: function (e) { setSetting('glass', e.target.value); } },
              h('option', { value: 'acrylic' }, 'Acrylic 强模糊'),
              h('option', { value: 'mica' }, 'Mica 柔和'),
              h('option', { value: 'tabbed' }, 'Tabbed 居中'),
              h('option', { value: 'none' }, '关闭')
            )
          )
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '🖥 系统'),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '开机自启'),
            h('input', { className: 'df-toggle', type: 'checkbox', checked: !!s.launchAtLogin, onChange: function (e) { setSetting('launchAtLogin', e.target.checked); } })
          ),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '完成通知'),
            h('input', { className: 'df-toggle', type: 'checkbox', checked: !!s.notifyOnComplete, onChange: function (e) { setSetting('notifyOnComplete', e.target.checked); } })
          ),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '关窗收进托盘'),
            h('input', { className: 'df-toggle', type: 'checkbox', checked: s.minimizeToTray !== false, onChange: function (e) { setSetting('minimizeToTray', e.target.checked); } })
          ),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '全局唤出快捷键'),
            h('span', { className: 'df-v' }, (s.globalShortcut || '').replace('CommandOrControl', 'Ctrl'))
          )
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '⚙️ 后端'),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '状态'),
            h('span', { className: 'df-status' },
              h('span', { className: 'df-dot' + (shell && shell.backendUp ? '' : ' err') }),
              h('span', { className: 'df-v' }, shell && shell.backendUp ? ('已连接 · :' + shell.port) : '未连接')
            )
          ),
          h('div', { className: 'df-row' },
            h('button', { className: 'df-btn', disabled: busy, onClick: restart }, busy ? '重启中…' : '重启后端')
          )
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '🔄 更新'),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, 'difish 壳版本'),
            h('span', { className: 'df-v' }, shell ? ('v' + shell.version) : '—')
          ),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, 'dsh 当前版本'),
            h('span', { className: 'df-v' }, (ug && ug.installedVersion) || (upd && upd.installedDshVersion) || '—')
          ),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, 'dsh 最新版本'),
            h('span', { className: 'df-v' }, upd ? (upd.latestDshVersion || (upd.error ? '获取失败' : '—')) : '—')
          ),
          upd && upd.hasUpdate ? h('div', { className: 'df-note', style: { margin: '8px 0' } }, '🎉 有可用的 dsh 新版本！') : null,
          updMsg ? h('div', { className: 'df-note', style: { margin: '8px 0' } }, updMsg) : null,
          h('div', { className: 'df-row' },
            h('button', { className: 'df-btn', disabled: checking || updating || !bridge, onClick: checkNow }, checking ? '检查中…' : '检查更新')
          ),

          // ---- 安全升级（推荐）----
          h('div', { className: 'df-sep' }),
          h('div', { className: 'df-sub', style: { marginBottom: 8 } },
            '🛡 安全升级：先把新版下载到暂存区并试跑校验，确认能启动才切换；切换前自动备份旧版，新版起不来会自动回滚。'),
          ug && ug.stagedVersion ? h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '已暂存待应用'),
            h('span', { className: 'df-v' }, ug.stagedVersion + (ug.stageReady ? '' : '（不完整）'))
          ) : null,
          ug && ug.pendingAction ? h('div', { className: 'df-note', style: { margin: '8px 0' } },
            '⏳ 已安排' + (ug.pendingAction === 'apply' ? '升级' : '回滚') + '，重启 difish 后生效'
          ) : null,
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '下载源'),
            h('select', {
              className: 'df-select',
              value: ugMirror,
              disabled: ugBusy,
              onChange: function (e) { setUgMirror(e.target.value); }
            }, ((ug && ug.mirrors) || [
              { id: 'tencent', label: '腾讯云（推荐 · 实测最快）' },
              { id: 'huawei', label: '华为云' },
              { id: 'npmmirror', label: 'npmmirror（淘宝源）' },
              { id: 'npmjs', label: 'npm 官方源（可能超时）' }
            ]).map(function (m) { return h('option', { key: m.id, value: m.id }, m.label); }))
          ),
          ugMsg ? h('div', { className: 'df-note', style: { margin: '8px 0', whiteSpace: 'pre-wrap' } }, ugMsg) : null,
          h('div', { className: 'df-row' },
            h('button', {
              className: 'df-btn df-btn-primary',
              disabled: ugBusy || !bridge,
              onClick: ugDownload
            }, ugBusy ? '下载中…' : (ug && ug.stageReady ? '重新下载新版' : '① 下载新版到暂存区')),
            ug && ug.stageReady ? h('button', {
              className: 'df-btn',
              disabled: ugBusy,
              onClick: ugApply,
              style: { marginLeft: 8 }
            }, '② 应用并重启') : null,
            ug && ug.stageReady ? h('button', {
              className: 'df-btn',
              disabled: ugBusy,
              onClick: ugDiscard,
              style: { marginLeft: 8 }
            }, '放弃') : null
          ),
          ug && ug.backups && ug.backups.length ? h('div', { className: 'df-row', style: { marginTop: 4 } },
            h('span', { className: 'df-k' }, '可用备份'),
            h('span', { className: 'df-v' }, ug.backups.length + ' 个 · 最近 ' + (ug.backups[0].version || ug.backups[0].name)),
            h('button', { className: 'df-btn', disabled: ugBusy, onClick: ugRollback, style: { marginLeft: 8 } }, '回滚')
          ) : null,
          h('div', { className: 'df-sub', style: { marginTop: 6 } },
            '暂存目录和备份都在 %APPDATA%\\difish 下，升级全程不改动 npm 全局目录的其它内容。'),
          ugLog ? h('div', { className: 'df-log' }, ugLog.slice(-2000)) : null,

          // ---- 旧路径（原地覆盖，不推荐）----
          h('div', { className: 'df-sep' }),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, '启动时自动检查更新'),
            h('input', { className: 'df-toggle', type: 'checkbox', checked: !!s.autoCheckUpdates, onChange: function (e) { setSetting('autoCheckUpdates', e.target.checked); } })
          ),
          h('div', { className: 'df-sub', style: { marginTop: 6 } },
            'difish 只是壳：功能更新主要靠升级 dsh（npm 包）。升级后需重启 difish 生效。')
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '🧠 DeepSeek 官方模型'),
          h(DeepSeekModelSync, { ctx: ctx })
        ),
        h('div', { className: 'df-card' },
          h('div', { className: 'df-card-h' }, '💾 数据快照'),
          h('div', { className: 'df-sub', style: { marginBottom: 8 } },
            'dsh 引擎本身可以重装，真正丢不起的是下面这几样。快照把它们打成一个压缩包，放到 snapshots 目录。'),
          snapInfo && snapInfo.entries ? h('div', null,
            snapInfo.entries.map(function (e) {
              return h('div', { className: 'df-row', key: e.id },
                h('span', { className: 'df-k' }, (e.exists ? '' : '（缺失）') + e.label),
                h('span', { className: 'df-v' }, e.exists ? (e.files + ' 文件 · ' + e.sizeMB + ' MB') : '—')
              );
            })
          ) : h('div', { className: 'df-sub' }, '读取中…'),
          snapInfo ? h('div', { className: 'df-row', style: { marginTop: 4 } },
            h('span', { className: 'df-k' }, '合计'),
            h('span', { className: 'df-v' }, snapInfo.totalFiles + ' 文件 · ' + snapInfo.totalMB + ' MB')
          ) : null,
          snapMsg ? h('div', { className: 'df-note', style: { margin: '8px 0', whiteSpace: 'pre-wrap' } }, snapMsg) : null,
          h('div', { className: 'df-row' },
            h('button', {
              className: 'df-btn df-btn-primary',
              disabled: snapBusy || !bridge,
              onClick: snapExport
            }, snapBusy ? '打包中…' : '导出快照'),
            h('button', { className: 'df-btn', onClick: snapReveal, style: { marginLeft: 8 } }, '打开目录')
          ),
          snaps && snaps.length ? h('div', { style: { marginTop: 10 } },
            h('div', { className: 'df-sub', style: { marginBottom: 6 } }, '已有快照（' + snaps.length + ' 个）：'),
            snaps.slice(0, 5).map(function (sn) {
              return h('div', { className: 'df-row', key: sn.name },
                h('span', { className: 'df-k', style: { fontSize: 11 } }, sn.name.replace(/^difish-snapshot-/, '').replace(/\.tar\.gz$/, '')),
                h('span', { className: 'df-v' }, sn.sizeMB + ' MB')
              );
            })
          ) : null,
          h('div', { className: 'df-sep' }),
          h('div', { className: 'df-row' },
            h('span', { className: 'df-k' }, 'dsh 旧版本备份'),
            h('span', { className: 'df-v' }, (ug && ug.backups && ug.backups.length)
              ? (ug.backups.length + ' 个 · 约 ' + Math.round(ug.backups.reduce(function (a, b) { return a + (b.sizeMB || 0); }, 0)) + ' MB')
              : '—'),
            h('button', { className: 'df-btn', onClick: pruneNow, style: { marginLeft: 8 } }, '只留最近 3 个')
          ),
          h('div', { className: 'df-sub', style: { marginTop: 6 } },
            '每次升级都会备份一份旧版（约 214 MB）。升级后会自动清理，只保留最近 3 个，也可以手动点。')
        )
      );
    }

    function apply(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== 'function') return;
      try {
        var styleEl = document.createElement('style');
        styleEl.textContent = CSS;
        styleEl.setAttribute('data-difish-css', '1');
        document.head.appendChild(styleEl);
        slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'difish', order: 5, label: 'difish' },
            function () {
              return React.createElement(PageBoundary, null,
                React.createElement(DifishSettingsPage, { ctx: ctx }));
            }
          );
        });
        // 原生「设置 → 模型」里 DeepSeek 卡片的官方扩展席位：
        // keyed 插槽，key = 该行的 settingsNs（DeepSeek 官方路由即 "llm-deepseek"），
        // owner props 会带上该行的 keyConfigured 状态。无需改 dsh 自己的 bundle。
        try {
          slots.inject('settings.models.provider-card', function () {
            return slots.register(
              { name: 'settings.models.provider-card', key: DS_NS },
              function (ownerProps) {
                return React.createElement(PageBoundary, null,
                  React.createElement(DeepSeekModelSync, {
                    ctx: ctx,
                    compact: true,
                    keyConfigured: ownerProps && ownerProps.keyConfigured
                  }));
              }
            );
          });
        } catch (slotError) {
          console.error('[difish-settings] 原生模型卡插槽注册失败:', slotError);
        }
      } catch (err) {
        console.error('[difish-settings] 注册失败:', err);
      }
    }

    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  }
});
