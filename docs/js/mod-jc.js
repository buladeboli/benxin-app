/* =========================================================================
 * mod-jc.js — 竞彩选票计算器（作为「本心盘口」的一个页面模块）
 *
 * 依赖：
 *   · 本文件之前必须已加载 js/jc-calc.js      → window.JCCalc（纯计算）
 *   · 本文件之前必须已加载 js/ui.js / js/app.js → window.UI / window.App
 *   · 数据来自本机后端（竞彩计算器\server.py）。没有后端时：
 *       ① 显示「连不上后端」诊断卡（含逐步排查）
 *       ② 可以载入示例数据 / 手动导入 JSON / 用上次缓存
 *     —— 也就是说：**后端挂了，这个页面也不会白屏、不会崩**
 *
 * 状态存在 localStorage: benxin.jc.v2
 * ========================================================================= */
(function () {
  'use strict';

  var U = window.UI, K = window.JCCalc;
  var LS = 'benxin.jc.v2';

  /* ============================================================ 常量 */

  var R3 = ['3', '1', '0'];
  var R3_TEXT = { '3': '胜', '1': '平', '0': '负' };
  var MARKET_NAME = { nspf: '胜平负', spf: '让球胜平负', bf: '比分', jqs: '总进球', bqc: '半全场' };
  var EXTRA_MARKETS = ['bf', 'jqs', 'bqc'];
  var BQC_TEXT = { '3': '胜', '1': '平', '0': '负' };
  var MAX_CHORD = (K && K.MAX_CHORD) || 8;
  var STAKE = (K && K.STAKE) || 2;
  var HEALTH_TIMEOUT = 2500;

  /* ============================================================ 状态 */

  var S = {
    apiBase: null,        // 探测到的后端地址（'' = 同源，null = 还没探测）
    apiState: 'idle',     // idle | probing | ok | fail
    apiErr: '',
    apiTried: [],
    data: null,
    loading: false,
    demo: false,
    onlyOnSale: true,
    jc: {},
    expanded: {},
    chord: 2,
    jcMulti: 1,
    sfcMode: 'all',
    sfc: {},
    sfcMulti: 1,
    diagOpen: true
  };

  /* ============================================================ 样式 */
  /* 只注入一次；全部选择器都收在 #page-jc 里，不污染其它页面 */

  var CSS_ID = 'mod-jc-style';
  var CSS = [
    '#page-jc .jc-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}',
    '#page-jc .jc-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 9px}',
    '#page-jc .jc-dot.ok{background:var(--ok)}',
    '#page-jc .jc-dot.bad{background:var(--bad)}',
    '#page-jc .jc-dot.wait{background:var(--warn)}',
    '#page-jc .jc-status{display:flex;align-items:center;gap:8px;font-size:12.3px;color:var(--txt-2);' +
      'background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:6px 11px}',
    '#page-jc .jc-status b{color:var(--txt)}',
    '#page-jc .jc-status .sep{color:var(--txt-3)}',

    '#page-jc .odd{display:block;width:100%;text-align:center;cursor:pointer;user-select:none;' +
      'font-family:var(--mono);font-size:12.6px;color:var(--txt);border:1px solid transparent;' +
      'border-radius:5px;padding:3px 2px;transition:background .1s,border-color .1s,color .1s}',
    '#page-jc .odd:hover{background:var(--acc-soft);border-color:var(--line-2)}',
    '#page-jc .odd.on{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:700;' +
      'box-shadow:0 0 0 2px rgba(77,156,246,.25)}',
    '#page-jc .odd.dead{color:var(--txt-3);cursor:not-allowed}',
    '#page-jc .odd.dead:hover{background:transparent;border-color:transparent}',
    '#page-jc .odd.mine{background:rgba(163,113,247,.22);border-color:var(--purple);color:#d9c6ff;font-weight:700}',
    '#page-jc .mycell{display:flex;gap:4px}',
    '#page-jc .mycell .odd{min-width:32px}',

    '#page-jc tr.picked{background:rgba(77,156,246,.07)}',
    '#page-jc tr.picked:hover{background:rgba(77,156,246,.11)}',
    '#page-jc tr.ended{opacity:.45}',
    '#page-jc td.num-c{font-family:var(--mono);text-align:center;font-size:12px;color:var(--txt-2)}',
    '#page-jc td.odd-c{text-align:center}',
    '#page-jc .team-h{font-weight:600}',
    '#page-jc .team-a{color:var(--txt-2)}',

    '#page-jc tr.morerow>td{padding:0;background:#131a21}',
    '#page-jc .morebox{padding:9px 12px 12px;display:flex;flex-direction:column;gap:8px}',
    '#page-jc .mkline{display:flex;align-items:flex-start;gap:10px}',
    '#page-jc .mkname{flex:0 0 74px;font-size:11.8px;color:var(--txt-3);padding-top:4px}',
    '#page-jc .mkopts{display:flex;flex-wrap:wrap;gap:5px;flex:1 1 auto}',
    '#page-jc .mkopt{display:inline-flex;align-items:baseline;gap:5px;border:1px solid var(--line-2);' +
      'border-radius:5px;background:var(--bg);color:var(--txt-2);padding:2px 7px;font-size:11.8px;cursor:pointer}',
    '#page-jc .mkopt b{font-family:var(--mono);color:var(--txt);font-weight:600}',
    '#page-jc .mkopt:hover{border-color:var(--acc)}',
    '#page-jc .mkopt.on{background:var(--acc);border-color:var(--acc);color:#fff}',
    '#page-jc .mkopt.on b{color:#fff}',
    '#page-jc .mkopt.dead{opacity:.35;cursor:not-allowed}',
    '#page-jc .mkempty{font-size:11.8px;color:var(--txt-3)}',
    '#page-jc .btn.picked{background:var(--acc-soft);border-color:var(--acc);color:#cfe4fb;font-weight:600}',

    '#page-jc .sumgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:8px}',
    '@media(max-width:1180px){#page-jc .sumgrid{grid-template-columns:1fr}}',
    '#page-jc .pane{background:var(--panel-2);border:1px solid var(--line);border-radius:7px;padding:12px 13px}',
    '#page-jc .pane h3{margin:0 0 9px;font-size:13.5px;font-weight:650;display:flex;gap:8px;align-items:center}',
    '#page-jc .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;' +
      'background:var(--acc-soft);color:#9ccbfb;border:1px solid rgba(77,156,246,.3)}',
    '#page-jc .picklist{display:flex;flex-direction:column;gap:4px;margin:8px 0 10px}',
    '#page-jc .pickrow{display:flex;align-items:center;gap:8px;font-size:12.3px;padding:3px 7px;' +
      'background:var(--bg);border:1px solid var(--line);border-radius:5px}',
    '#page-jc .pickrow .nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#page-jc .pickrow .val{font-family:var(--mono);color:var(--acc);font-weight:600}',
    '#page-jc .pickrow .del{cursor:pointer;color:var(--txt-3);font-size:14px;padding:0 3px;border-radius:4px}',
    '#page-jc .pickrow .del:hover{color:var(--bad);background:rgba(248,81,73,.12)}',
    '#page-jc .picknone{font-size:12.2px;color:var(--txt-3);padding:6px 2px}',
    '#page-jc .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(94px,1fr));gap:7px}',
    '#page-jc .kpi{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 9px}',
    '#page-jc .kpi .v{font-size:15px;font-weight:700;font-family:var(--mono);line-height:1.3}',
    '#page-jc .kpi .l{font-size:10.8px;color:var(--txt-3)}',
    '#page-jc .kpi.win .v{color:var(--ok)}',
    '#page-jc .kpi.money .v{color:var(--warn)}',
    '#page-jc .notes{margin-top:9px;font-size:11.8px;color:var(--txt-3);line-height:1.7}',
    '#page-jc .notes .bad{color:var(--bad)}',
    '#page-jc .notes ul{margin:4px 0 0;padding-left:18px}',
    '#page-jc .totalbar{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:12px;' +
      'padding:11px 13px;background:var(--bg);border:1px solid var(--line-2);border-radius:7px}',
    '#page-jc .totalbar .ti{display:flex;flex-direction:column;gap:1px}',
    '#page-jc .totalbar .lab{font-size:11px;color:var(--txt-3)}',
    '#page-jc .totalbar b{font-size:16px;font-family:var(--mono);font-weight:700}',
    '#page-jc .totalbar .ti.big b{font-size:21px;color:var(--warn)}',
    '#page-jc .totalbar .ti .win{color:var(--ok)}',
    '#page-jc .totalbar .grow{flex:1 1 auto}',

    '#page-jc .seg{display:inline-flex;border:1px solid var(--line-2);border-radius:7px;overflow:hidden}',
    '#page-jc .seg button{font:inherit;font-size:12.4px;cursor:pointer;background:transparent;' +
      'color:var(--txt-2);border:0;padding:5px 12px}',
    '#page-jc .seg button.on{background:var(--acc-soft);color:#cfe4fb;font-weight:600}',
    '#page-jc .seg button+button{border-left:1px solid var(--line-2)}',

    '#page-jc .diag{border:1px solid var(--bad);border-radius:8px;background:rgba(248,81,73,.07);padding:12px 14px;margin-bottom:12px}',
    '#page-jc .diag h3{margin:0 0 6px;font-size:13.5px;color:#ff9c96}',
    '#page-jc .diag ol{margin:6px 0;padding-left:20px;font-size:12.4px;line-height:1.85}',
    '#page-jc .diag code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-family:var(--mono)}',
    '#page-jc .diag .tried{font-family:var(--mono);font-size:11.6px;color:var(--txt-3);margin-top:6px;line-height:1.7}',
    '#page-jc .srcs{font-size:11.6px;color:var(--txt-3);margin-top:6px;line-height:1.8}',
    '#page-jc .srcs .ok{color:var(--ok)}',
    '#page-jc .srcs .bad{color:var(--bad)}',

    /* ---------- 手机专用卡片（<768px）：赔率必须横向排，不能竖着堆 ---------- */
    '#page-jc .mcard{border:1px solid var(--line-2);border-radius:12px;background:var(--panel);' +
      'margin-bottom:10px;padding:10px 11px}',
    '#page-jc .mcard.picked{border-color:rgba(77,156,246,.55);background:rgba(77,156,246,.07)}',
    '#page-jc .mcard.ended{opacity:.5}',
    '#page-jc .mc-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--txt-2);min-height:22px}',
    '#page-jc .mc-head input{width:20px;height:20px;accent-color:var(--acc)}',
    '#page-jc .mc-head .mc-no{font-family:var(--mono);font-weight:700;color:var(--txt);font-size:12.5px}',
    '#page-jc .mc-head .mc-time{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--txt-3)}',
    '#page-jc .mc-teams{display:flex;align-items:baseline;gap:8px;margin:8px 0 10px;font-size:15.5px;line-height:1.35}',
    '#page-jc .mc-teams b{font-weight:700}',
    '#page-jc .mc-teams i{font-style:normal;color:var(--txt-2)}',
    '#page-jc .mc-teams .vs{color:var(--txt-3);font-size:11.5px;flex:0 0 auto}',
    '#page-jc .mc-row{display:flex;align-items:center;gap:8px;margin-bottom:7px}',
    '#page-jc .mc-lab{flex:0 0 54px;font-size:11px;color:var(--txt-3);line-height:1.3}',
    '#page-jc .mc-lab em{display:block;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--txt-2)}',
    '#page-jc .mc-opts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;flex:1 1 auto;min-width:0}',
    '#page-jc .mc-opts .odd{min-height:48px;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:1px;padding:4px 2px;font-size:15px;line-height:1.2}',
    '#page-jc .mc-opts .odd .k{font-size:10.5px;color:var(--txt-3)}',
    '#page-jc .mc-opts .odd.on .k{color:#dbeafe}',
    '#page-jc .mc-foot{margin-top:2px}',
    '#page-jc .mc-foot .btn{width:100%}',
    '@media (max-width:767px){',
    '  #page-jc .jc-status{font-size:11.5px;padding:5px 9px;line-height:1.5}',
    '  #page-jc .jc-status .apiurl{display:none}',
    '  #page-jc .jc-status .srcname{display:none}',
    '  #page-jc .jc-bar .btn{flex:1 1 calc(50% - 5px);min-width:0}',
    '  #page-jc .morebox{padding:8px 4px 4px}',
    '  #page-jc .mkline{flex-direction:column;gap:4px}',
    '  #page-jc .mkname{flex:none;padding-top:0}',
    '  #page-jc .mkopt{min-height:40px;align-items:center;padding:6px 9px;font-size:12.5px}',
    '  #page-jc .sumgrid{grid-template-columns:1fr}',
    '  #page-jc .pane{padding:10px}',
    '  #page-jc .pickrow{font-size:12px}',
    '  #page-jc .totalbar{gap:10px;padding:10px;display:grid;grid-template-columns:1fr 1fr 1fr}',
    '  #page-jc .totalbar .ti{min-width:0}',
    '  #page-jc .totalbar .ti.grow{grid-column:1 / -1}',
    '  #page-jc .totalbar b{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '  #page-jc .totalbar b{font-size:16px}',
    '  #page-jc .totalbar .ti.big b{font-size:20px}',
    '}'
  ].join('\n');

  function ensureCss() {
    try {
      if (!document.head || document.getElementById(CSS_ID)) return;
      var st = U.el('style', { id: CSS_ID });
      st.textContent = CSS;
      document.head.appendChild(st);
    } catch (e) { /* 样式注不进去也不影响功能 */ }
  }

  /* ============================================================ 工具 */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtOdds(v) { var n = Number(v); return (isFinite(n) && n > 0) ? n.toFixed(2) : '—'; }
  function fmtMoney(v) { return '¥' + (Number(v) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
  function fmtInt(v) { return (Number(v) || 0).toLocaleString('zh-CN'); }
  function shortTime(t) {
    var s = String(t || '');
    var m = s.match(/\d{4}-(\d{2}-\d{2}\s+\d{2}:\d{2})/);
    return m ? m[1] : s;
  }
  function bqcText(v) {
    var p = String(v).split('-');
    if (p.length !== 2) return String(v);
    return (BQC_TEXT[p[0]] || p[0]) + (BQC_TEXT[p[1]] || p[1]);
  }
  function pickLabel(market, value) {
    if (market === 'nspf') return R3_TEXT[value] || value;
    if (market === 'spf') return '让' + (R3_TEXT[value] || value);
    if (market === 'jqs') return value + ' 球';
    if (market === 'bqc') return bqcText(value);
    return value;
  }

  /* 断点判断：和 index.html 里的媒体查询保持一致（<768px 走手机布局） */
  function isMobile() {
    try {
      return !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
    } catch (e) {
      return (window.innerWidth || 1024) < 768;
    }
  }

  /* ============================================================ 存取 */

  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        apiBase: S.apiBase, onlyOnSale: S.onlyOnSale, jc: S.jc, expanded: S.expanded,
        chord: S.chord, jcMulti: S.jcMulti, sfcMode: S.sfcMode, sfc: S.sfc, sfcMulti: S.sfcMulti
      }));
    } catch (e) { /* 满了就算了 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(LS);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o.apiBase !== undefined && o.apiBase !== null) S.apiBase = o.apiBase;
      if (o.jc && typeof o.jc === 'object') S.jc = o.jc;
      if (o.sfc && typeof o.sfc === 'object') S.sfc = o.sfc;
      if (o.expanded && typeof o.expanded === 'object') S.expanded = o.expanded;
      if (o.chord) S.chord = Number(o.chord) || 1;
      if (o.jcMulti) S.jcMulti = Math.max(1, Number(o.jcMulti) || 1);
      if (o.sfcMulti) S.sfcMulti = Math.max(1, Number(o.sfcMulti) || 1);
      if (o.sfcMode === 'nine') S.sfcMode = 'nine';
      if (o.onlyOnSale === false) S.onlyOnSale = false;
    } catch (e) { }
  }

  /* ============================================================ 后端连接 */

  /**
   * 候选后端地址：
   *   · 页面本身是 http(s) 时，先试**同源**（server.py 会把「网页」目录当静态站一起服务）
   *   · 再试本机 8765~8771 这几个端口（启动.bat 默认 8765，占用时会顺延）
   * 这样不管你是双击 index.html（file://）还是从后端地址打开，都能连上。
   */
  function candidateBases() {
    var list = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') list.push('');
    for (var p = 8765; p <= 8771; p++) list.push('http://127.0.0.1:' + p);
    // 去重（同源 '' 与显式地址可能重复）
    var out = [], seen = {};
    list.forEach(function (b) {
      var key = b || location.origin;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(b);
    });
    return out;
  }

  function fetchJson(base, path, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var opt = { cache: 'no-store' };
    if (ctrl) {
      opt.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, ms || 15000);
    }
    return fetch(base + path, opt).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? ('超时 ' + (ms || 15000) + 'ms') : (e.message || '网络错误'));
    });
  }

  /** 探测后端：返回 Promise<base|null> */
  function probe() {
    var cands = candidateBases();
    S.apiTried = [];
    var i = 0;
    function next() {
      if (i >= cands.length) return Promise.resolve(null);
      var base = cands[i++];
      var label = base || location.origin;
      return fetchJson(base, '/api/health', HEALTH_TIMEOUT).then(function (d) {
        S.apiTried.push({ base: label, ok: !!(d && d.ok) });
        if (d && d.ok) return base;
        return next();
      }, function (e) {
        S.apiTried.push({ base: label, ok: false, err: e.message });
        return next();
      });
    }
    return next();
  }

  function ensureBackend() {
    if (S.apiBase !== null) return Promise.resolve(S.apiBase);
    S.apiState = 'probing';
    return probe().then(function (base) {
      S.apiBase = base;
      S.apiState = base === null ? 'fail' : 'ok';
      if (base === null) {
        S.apiErr = '没有找到在运行的数据服务（试过 ' + S.apiTried.length + ' 个地址）';
      }
      save();
      return base;
    });
  }

  function loadData(forceRefresh) {
    if (S.loading) return Promise.resolve();
    /* 没有 fetch（老浏览器 / Node 自检环境）就别硬来，直接进"连不上"状态 */
    if (typeof fetch !== 'function') {
      S.apiState = 'fail';
      S.apiErr = '当前环境不支持 fetch（浏览器太老？），只能用手动导入';
      renderCurrent();
      return Promise.resolve();
    }
    S.loading = true;
    renderCurrent();

    return ensureBackend().then(function (base) {
      if (base === null) {
        S.loading = false;
        S.apiState = 'fail';
        renderCurrent();
        return null;
      }
      S.apiState = 'ok';
      return fetchJson(base, forceRefresh ? '/api/refresh' : '/api/data', 60000).then(function (d) {
        S.apiState = 'ok';
        S.apiErr = '';
        applyData(d);
        S.loading = false;
        renderCurrent();
        U.toast(d.ok ? (forceRefresh ? '数据已更新' : '数据已载入') : '抓取失败，看页面顶部的提示',
          d.ok ? 'ok' : 'warn');
        return d;
      }, function (e) {
        S.loading = false;
        S.apiState = 'fail';
        S.apiErr = '连上了服务但取数据失败：' + e.message;
        renderCurrent();
        return null;
      });
    }, function (e) {
      S.loading = false;
      S.apiState = 'fail';
      S.apiErr = '探测后端时出错：' + (e && e.message);
      renderCurrent();
      return null;
    });
  }

  function applyData(d) {
    S.data = d;
    prunePicks();
    save();
  }

  function prunePicks() {
    var d = S.data || { jczq: [], sfc: { matches: [] } };
    var alive = {};
    (d.jczq || []).forEach(function (m) { alive[m.num] = 1; });
    Object.keys(S.jc).forEach(function (k) { if (!alive[k]) delete S.jc[k]; });
    var alive2 = {};
    ((d.sfc && d.sfc.matches) || []).forEach(function (m) { alive2[String(m.no)] = 1; });
    Object.keys(S.sfc).forEach(function (k) { if (!alive2[k]) delete S.sfc[k]; });
  }

  function jcList() { return (S.data && S.data.jczq) || []; }
  function sfcMatches() { return (S.data && S.data.sfc && S.data.sfc.matches) || []; }

  function findJc(num) {
    var a = jcList();
    for (var i = 0; i < a.length; i++) if (a[i].num === num) return a[i];
    return null;
  }
  function oddsOf(m, market, value) {
    if (!m || !m.odds || !m.odds[market]) return null;
    var v = m.odds[market][value];
    return (v === undefined || v === null || !(Number(v) > 0)) ? null : Number(v);
  }

  /* ============================================================ 选择 */

  function pickOf(num) { return S.jc[num] || null; }

  function togglePick(num, market, value) {
    var m = findJc(num);
    if (!m) return;
    if (!m.on_sale) { U.toast('这场已经截止了', 'warn'); return; }
    if (oddsOf(m, market, value) === null) { U.toast('这个选项没有赔率', 'warn'); return; }
    var cur = S.jc[num];
    if (cur && cur.market === market && cur.value === value) delete S.jc[num];
    else S.jc[num] = { market: market, value: value };
    save();
    renderCurrent();
  }

  function setChecked(num, on) {
    var m = findJc(num);
    if (!m) return;
    if (on) {
      if (!m.on_sale) { U.toast('这场已经截止了', 'warn'); return; }
      if (!S.jc[num]) {
        var best = null;
        R3.forEach(function (k) {
          var o = oddsOf(m, 'nspf', k);
          if (o !== null && (best === null || o < best.o)) best = { k: k, o: o };
        });
        if (best) S.jc[num] = { market: 'nspf', value: best.k };
      }
    } else delete S.jc[num];
    save();
    renderCurrent();
  }

  function toggleSfc(no, v) {
    var key = String(no);
    var sel = S.sfc[key] || (S.sfc[key] = {});
    if (sel[v]) delete sel[v]; else sel[v] = true;
    if (!Object.keys(sel).length) delete S.sfc[key];
    save();
    renderCurrent();
  }

  /* ============================================================ 计算 */

  function calcJc() {
    var picked = [];
    Object.keys(S.jc).forEach(function (num) {
      var m = findJc(num), p = S.jc[num];
      if (!m || !p) return;
      var o = oddsOf(m, p.market, p.value);
      picked.push({
        m: m, market: p.market, value: p.value, odds: o === null ? 0 : o,
        label: pickLabel(p.market, p.value)
      });
    });
    var m = picked.length;
    var multi = Math.max(1, Math.floor(Number(S.jcMulti) || 1));
    var maxChord = Math.min(MAX_CHORD, Math.max(1, m));
    var chord = Math.min(Math.max(1, Math.floor(Number(S.chord) || 1)), maxChord);
    S.chord = chord;

    var out = {
      picked: picked, count: m, chord: chord, multi: multi, maxChord: maxChord,
      bets: 0, money: 0, winAll: 0, minOne: 0, maxOne: 0, problems: []
    };
    if (!m) { out.problems.push('还没选比赛：点赔率格子，或勾左侧方框'); return out; }

    var st = K.jcStats(picked.map(function (x) { return x.odds; }), chord, multi);
    out.bets = st.bets; out.money = st.money; out.winAll = st.winAll;
    out.minOne = st.minOne; out.maxOne = st.maxOne;
    if (!st.ok) out.problems.push(st.reason);

    var expired = picked.filter(function (x) { return !x.m.on_sale; });
    if (expired.length) {
      out.problems.push('有 ' + expired.length + ' 场已经截止（'
        + expired.map(function (x) { return x.m.num; }).join('、') + '），实际买不了，建议移出');
    }
    if (out.bets > 100000) out.problems.push('注数过大（' + fmtInt(out.bets) + ' 注），不像正常买法，检查一下串关');
    return out;
  }

  function calcSfc() {
    var list = sfcMatches();
    var multi = Math.max(1, Math.floor(Number(S.sfcMulti) || 1));
    var ks = [], rows = [];
    list.forEach(function (m) {
      var key = String(m.no);
      var sel = S.sfc[key] || {};
      var picked = R3.filter(function (k) { return sel[k]; });
      ks.push(picked.length);
      if (picked.length) {
        rows.push({
          no: m.no, m: m, n: picked.length,
          text: picked.map(function (k) { return R3_TEXT[k]; }).join('+')
        });
      }
    });
    var mode = S.sfcMode;
    var out = { mode: mode, multi: multi, rows: rows, selectedCount: rows.length, bets: 0, money: 0, problems: [], notes: [] };
    if (!rows.length) { out.problems.push('胜负彩还没选：点「胜 / 平 / 负」格子，双选就点两个'); return out; }

    var st = K.sfcStats(ks, mode);
    out.bets = st.bets;
    out.money = STAKE * out.bets * multi;
    if (!st.ok) { out.problems.push(st.reason); return out; }

    var doubles = ks.filter(function (k) { return k >= 2; }).length;
    if (doubles) out.notes.push('复式：有 ' + doubles + ' 场是多选，注数已按组合算好');
    if (mode === 'all') out.notes.push('一等奖 = 14 场全中；只中 13 场是<b>二等奖</b>（同一张票，不额外花钱）');
    else {
      out.notes.push('任九 = 从你勾的场次里任取 9 场组成一注，9 场全中才算中奖');
      if (out.selectedCount > 9) out.notes.push('你勾了 ' + out.selectedCount + ' 场 → 自动组合成 ' + fmtInt(out.bets) + ' 注');
    }
    out.notes.push('胜负彩是奖池制，官方不公布固定赔率；本工具只算注数和成本，不算中奖金额');
    return out;
  }

  /* ============================================================ 渲染 */

  var hostRef = null;

  function renderCurrent() {
    if (!hostRef) return;
    var scroll = document.getElementById('main');
    var top = scroll ? scroll.scrollTop : 0;
    hostRef.innerHTML = '';
    build(hostRef);
    if (scroll) scroll.scrollTop = top;
  }

  function build(host) {
    ensureCss();

    /* ---------- 诊断卡（连不上后端时） ---------- */
    if (S.apiState === 'fail') host.appendChild(diagCard());

    /* ---------- 顶部状态条 ---------- */
    host.appendChild(statusBar());

    /* ---------- 竞彩 ---------- */
    host.appendChild(jcCard());

    /* ---------- 胜负彩 ---------- */
    host.appendChild(sfcCard());

    /* ---------- 汇总 ---------- */
    host.appendChild(sumCard());
  }

  function dot(state) {
    return U.el('span', { class: 'jc-dot ' + (state === 'ok' ? 'ok' : state === 'fail' ? 'bad' : 'wait') });
  }

  function statusBar() {
    var d = S.data || {};
    var bar = U.el('div', { class: 'jc-bar' });

    var box = U.el('div', { class: 'jc-status' });
    box.appendChild(dot(S.apiState === 'ok' ? 'ok' : S.apiState === 'fail' ? 'fail' : 'wait'));
    var txt = U.el('span');
    if (S.apiState === 'fail') {
      txt.innerHTML = location.protocol === 'file:'
        ? '<b>后端未连接</b>　你现在是 file:// 打开的 → 请改用 <b>http://127.0.0.1:8765/</b>（点下面诊断卡里的按钮）'
        : '<b>后端未连接</b>　数据抓不到，但下面的计算器还能用（示例 / 导入）';
    } else if (S.apiState === 'probing') {
      txt.innerHTML = '<b>正在连接数据服务…</b>';
    } else {
      txt.innerHTML = (d.ts ? '数据时间 <b>' + esc(d.ts) + '</b>' : '还没有数据')
        + (d.source ? '　<span class="sep srcname">·</span><span class="srcname">　来源 ' + esc(d.source) + '</span>' : '')
        + (d.from_cache ? '　<span class="sep">·</span>　<b style="color:var(--warn)">缓存</b>' : '')
        + (S.apiBase !== null ? '　<span class="sep apiurl">·</span><span class="apiurl">　后端 ' + esc(S.apiBase || location.origin) + '</span>' : '');
    }
    box.appendChild(txt);
    bar.appendChild(box);

    var bRefresh = U.btn(S.loading ? '抓取中…' : '⟳ 刷新数据', function () {
      if (S.loading) return;
      S.apiBase = null;                   // 每次手动刷新都重新探测，防止端口变了
      loadData(true);
    }, 'pri');
    if (S.loading) bRefresh.disabled = true;
    bar.appendChild(bRefresh);

    bar.appendChild(U.btn('测试连接', function () {
      S.apiBase = null; S.apiState = 'probing'; renderCurrent();
      ensureBackend().then(function (b) {
        renderCurrent();
        U.toast(b === null ? '还是连不上，看下面的排查步骤' : ('连上了：' + (b || location.origin)), b === null ? 'bad' : 'ok');
      });
    }, 'ghost'));

    bar.appendChild(U.btn('载入示例', function () {
      loadDemo(); U.toast('已载入示例数据（不会保存成真实数据）', 'ok');
    }, 'ghost'));

    bar.appendChild(U.btn('导入 JSON', function () {
      U.pickFile('.json,application/json', function (f) {
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var d = JSON.parse(String(fr.result));
            if (!d.jczq && !d.sfc) throw new Error('文件里没有 jczq / sfc');
            S.demo = true;
            applyData(d);
            renderCurrent();
            U.toast('已导入 ' + ((d.jczq || []).length) + ' 场竞彩 + ' + (((d.sfc || {}).matches || []).length) + ' 场胜负彩', 'ok');
          } catch (e) { U.toast('导入失败：' + e.message, 'bad'); }
        };
        fr.readAsText(f, 'utf-8');
      });
    }, 'ghost'));

    if (S.data) {
      bar.appendChild(U.btn('导出 JSON', function () {
        U.download('竞彩数据_' + new Date().toISOString().slice(0, 10) + '.json',
          JSON.stringify(S.data, null, 2), 'application/json;charset=utf-8');
      }, 'ghost'));
    }

    /* 数据源明细 */
    var srcs = S.data && S.data.sources;
    if (srcs && srcs.length) {
      var det = U.el('details', { style: { flex: '1 1 100%' } });
      det.appendChild(U.el('summary', { class: 'mini', text: '数据源明细（抓取时每个源的结果）' }));
      var ul = U.el('div', { class: 'srcs' });
      srcs.forEach(function (s) {
        ul.appendChild(U.el('div', {
          html: (s.ok ? '<span class="ok">✔</span>' : '<span class="bad">✘</span>')
            + ' ' + esc(s.name || s.id) + '　'
            + (s.ok ? ('拿到 ' + (s.count || 0) + ' 场，耗时 ' + (s.ms || 0) + 'ms')
              : ('失败：' + esc(s.error || '未知')))
        }));
      });
      det.appendChild(ul);
      bar.appendChild(det);
    }

    var errs = (S.data && S.data.errors) || [];
    if (errs.length) {
      var eb = U.el('div', { style: { flex: '1 1 100%' } });
      eb.appendChild(U.note('<b>抓取提示：</b><br>· ' + errs.map(esc).join('<br>· '), 'warn'));
      bar.appendChild(eb);
    }
    return bar;
  }

  function diagCard() {
    var box = U.el('div', { class: 'diag' });
    var isFile = location.protocol === 'file:';

    if (isFile) {
      /* 最常见的情况：双击了 index.html。这个问题靠代码解决不了，只能换打开方式。 */
      box.appendChild(U.el('h3', { text: '⚠ 请换个方式打开这个页面（这是 file:// 方式）' }));
      box.appendChild(U.el('div', {
        html: '你现在是<b>直接双击 <code>index.html</code></b> 打开的（地址栏以 <code>file:///</code> 开头）。<br>' +
          '浏览器有一条安全规则：<b>file:// 页面不许访问本机的 127.0.0.1 端口</b> —— 所以不管后端开没开，' +
          '这里都会报 <code>Failed to fetch</code>。这不是坏了。<br><br>' +
          '<b>正确开法（两条，任选一条）：</b>'
      }));
      var ol0 = U.el('ol');
      ol0.appendChild(U.el('li', { html: '双击 <code>G:\\网页(转app)\\竞彩计算器\\启动.bat</code>，它会自动打开 <code>http://127.0.0.1:8765/</code> —— 那个地址就是<b>同一个页面</b>，但能连后端' }));
      ol0.appendChild(U.el('li', { html: '或者：先开 <code>启动.bat</code>，然后在浏览器地址栏手动输入 <code>http://127.0.0.1:8765/</code>' }));
      box.appendChild(ol0);

      var row0 = U.el('div', { class: 'row', style: { margin: '10px 0 4px' } });
      row0.appendChild(U.btn('直接跳到 http://127.0.0.1:8765/', function () {
        location.href = 'http://127.0.0.1:8765/';
      }, 'pri sm'));
      row0.appendChild(U.btn('我先把服务开起来', function () {
        U.toast('去双击 竞彩计算器\\启动.bat，等黑窗口出现「服务已启动」再回来点上面的按钮', 'warn', 6000);
      }, 'sm ghost'));
      box.appendChild(row0);

      box.appendChild(U.el('div', {
        class: 'mini', style: { marginTop: '8px' },
        html: '<b>不想开服务也能用：</b>点下面「载入示例数据」先熟悉界面，或「导入 JSON」载入我之前导给你的一份数据。'
      }));
      var row1 = U.el('div', { class: 'row', style: { marginTop: '8px' } });
      row1.appendChild(U.btn('载入示例数据', function () { loadDemo(); renderCurrent(); }, 'sm'));
      row1.appendChild(U.btn('导入 JSON', function () {
        U.pickFile('.json,application/json', function (f) {
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var d = JSON.parse(String(fr.result));
              S.demo = true; applyData(d); renderCurrent();
              U.toast('已导入', 'ok');
            } catch (e) { U.toast('导入失败：' + e.message, 'bad'); }
          };
          fr.readAsText(f, 'utf-8');
        });
      }, 'sm ghost'));
      box.appendChild(row1);
      return box;
    }

    /* 正常情况：页面是 http 打开的，但后端没起来 */
    box.appendChild(U.el('h3', { text: '⚠ 连不上数据服务（"Failed to fetch" 就是这个意思）' }));
    box.appendChild(U.el('div', {
      html: '<b>原因</b>：页面找不到本机的抓取服务。它不是一个网页，是一个要单独开的小程序。' +
        (S.apiErr ? '<br><span class="mini">技术信息：' + esc(S.apiErr) + '</span>' : '')
    }));

    var ol = U.el('ol');
    ol.appendChild(U.el('li', { html: '打开文件夹 <code>G:\\网页(转app)\\竞彩计算器</code>' }));
    ol.appendChild(U.el('li', { html: '双击 <code>启动.bat</code>（会弹出一个黑色窗口）' }));
    ol.appendChild(U.el('li', { html: '等黑窗口里出现 <code>✔ 服务已启动</code> —— <b>不要关这个窗口</b>' }));
    ol.appendChild(U.el('li', { html: '回来点 <b>「再试一次连接」</b>' }));
    box.appendChild(ol);

    box.appendChild(U.el('div', {
      class: 'tried',
      html: '这次试过的地址：<br>' + (S.apiTried.length
        ? S.apiTried.map(function (t) { return (t.ok ? '✔ ' : '✘ ') + esc(t.base) + (t.err ? '（' + esc(t.err) + '）' : ''); }).join('<br>')
        : '（还没试）')
    }));

    box.appendChild(U.el('div', {
      class: 'mini', style: { marginTop: '8px' },
      html: '还不行就查三件事：① <code>启动.bat</code> 有没有报「没找到 Python」；' +
        '② 黑窗口有没有一闪就消失（把里面的红字发我）；③ 防火墙/杀毒有没有拦住 python 监听本机端口。' +
        '<br><b>不想弄后端也能用</b>：点「载入示例」先用着，或「导入 JSON」。'
    }));

    var row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    row.appendChild(U.btn('再试一次连接', function () {
      S.apiBase = null; S.apiState = 'probing'; renderCurrent();
      ensureBackend().then(function () { renderCurrent(); });
    }, 'pri sm'));
    row.appendChild(U.btn('载入示例数据', function () { loadDemo(); renderCurrent(); }, 'sm ghost'));
    box.appendChild(row);
    return box;
  }

  /* ---------- 竞彩表 ---------- */

  function jcCard() {
    var card = U.el('div', { class: 'card' });
    var all = jcList();
    var onSale = all.filter(function (m) { return m.on_sale; });

    var h = U.el('h2', {}, [document.createTextNode('① 竞彩足球 ')]);
    h.appendChild(U.el('span', { class: 'hint', text: all.length ? ('共 ' + all.length + ' 场，在售 ' + onSale.length + ' 场') : '（无数据）' }));
    card.appendChild(h);

    card.appendChild(U.el('p', {
      class: 'desc',
      html: '点赔率格子即选中该场（<b>同一场只能选一个</b>，跟真实竞彩一致）。勾选框决定这场要不要进串关。' +
        '点「其他玩法」看比分 / 总进球 / 半全场。'
    }));

    var tools = U.el('div', { class: 'row', style: { marginBottom: '10px' } });
    var chk = U.el('label', { class: 'chk' });
    var cb = U.el('input', { type: 'checkbox' });
    cb.checked = S.onlyOnSale;
    cb.addEventListener('change', function () { S.onlyOnSale = cb.checked; save(); renderCurrent(); });
    chk.appendChild(cb);
    chk.appendChild(document.createTextNode(' 只看未截止'));
    tools.appendChild(chk);
    tools.appendChild(U.btn('清空竞彩选择', function () {
      S.jc = {}; save(); renderCurrent();
    }, 'sm ghost'));
    tools.appendChild(U.btn('展开/收起全部玩法', function () {
      var any = all.some(function (m) { return S.expanded[m.num]; });
      S.expanded = {};
      if (!any) all.forEach(function (m) { S.expanded[m.num] = true; });
      renderCurrent();
    }, 'sm ghost'));
    card.appendChild(tools);

    var list = S.onlyOnSale ? onSale : all;
    if (!list.length) {
      card.appendChild(U.note(all.length
        ? '当前没有「未截止」的场次。取消上面的勾选可以看到已截止的场次。'
        : '还没有竞彩数据。点右上角「⟳ 刷新数据」；连不上后端就看页面顶部的排查步骤。', 'warn'));
      return card;
    }

    /* ===== 手机：每场一张紧凑卡片（赔率横向三列，方便比较和点） ===== */
    if (isMobile()) {
      var mbox = U.el('div', { class: 'mcards' });
      mbox.innerHTML = jcMobileCards(list);
      card.appendChild(mbox);
      bindJcEvents(mbox);
      return card;
    }

    var tw = U.el('div', { class: 'tw' });
    var tb = U.el('table');
    tb.innerHTML = '<thead><tr>'
      + '<th style="width:34px;text-align:center">选</th><th style="width:64px">编号</th><th style="width:60px">联赛</th>'
      + '<th style="width:130px">主队</th><th style="width:130px">客队</th><th style="width:100px">开赛时间</th>'
      + '<th style="width:56px;text-align:center">胜</th><th style="width:56px;text-align:center">平</th><th style="width:56px;text-align:center">负</th>'
      + '<th style="width:66px;text-align:center">让球</th>'
      + '<th style="width:56px;text-align:center">让胜</th><th style="width:56px;text-align:center">让平</th><th style="width:56px;text-align:center">让负</th>'
      + '<th style="width:96px">操作</th></tr></thead>';
    var body = U.el('tbody');
    body.innerHTML = jcRows(list);
    tb.appendChild(body);
    tw.appendChild(tb);
    card.appendChild(tw);

    bindJcEvents(body);
    return card;
  }

  /** 竞彩表格与手机卡片共用的事件绑定 */
  function bindJcEvents(root) {
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.num && t.dataset.m) { togglePick(t.dataset.num, t.dataset.m, t.dataset.v); return; }
      var btn = t && t.closest ? t.closest('[data-more]') : null;
      if (btn) {
        var num = btn.getAttribute('data-more');
        S.expanded[num] = !S.expanded[num];
        renderCurrent();
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.check) setChecked(t.dataset.check, t.checked);
    });
  }

  /** 手机端：一场 = 一张卡；胜/平/负 与 让胜/让平/让负 各占一行三列 */
  function jcMobileCards(list) {
    var html = '';
    list.forEach(function (m) {
      var p = S.jc[m.num];
      var cls = ['mcard'];
      if (!m.on_sale) cls.push('ended');
      if (p) cls.push('picked');
      var hasExtra = EXTRA_MARKETS.some(function (x) { return m.odds && m.odds[x]; });
      var extraPick = (p && EXTRA_MARKETS.indexOf(p.market) >= 0) ? p : null;

      html += '<div class="' + cls.join(' ') + '">';

      // 头部：勾选 + 编号 + 联赛 + 时间
      html += '<div class="mc-head">'
        + '<input type="checkbox" data-check="' + esc(m.num) + '"' + (p ? ' checked' : '')
        + (m.on_sale ? '' : ' disabled') + ' aria-label="选中这场">'
        + '<span class="mc-no">' + esc(m.num) + '</span>'
        + '<span>' + esc(m.league) + '</span>'
        + '<span class="mc-time">' + esc(shortTime(m.kickoff)) + '</span>'
        + '</div>';

      // 对阵
      html += '<div class="mc-teams"><b>' + esc(m.home) + '</b><span class="vs">vs</span><i>' + esc(m.away) + '</i></div>';

      // 胜平负
      html += '<div class="mc-row"><div class="mc-lab">胜平负</div><div class="mc-opts">'
        + R3.map(function (k) { return mcOdd(m, 'nspf', k, R3_TEXT[k]); }).join('')
        + '</div></div>';

      // 让球胜平负
      html += '<div class="mc-row"><div class="mc-lab">让球<em>' + esc(m.rangqiu_text || '—') + '</em></div>'
        + '<div class="mc-opts">'
        + R3.map(function (k) { return mcOdd(m, 'spf', k, '让' + R3_TEXT[k]); }).join('')
        + '</div></div>';

      // 其他玩法
      if (hasExtra) {
        var label = extraPick
          ? (MARKET_NAME[extraPick.market] + ' ' + pickLabel(extraPick.market, extraPick.value) + (S.expanded[m.num] ? ' ▴' : ' ▾'))
          : (S.expanded[m.num] ? '收起 ▴' : '其他玩法 ▾');
        html += '<div class="mc-foot"><button class="btn sm ' + (extraPick ? 'picked' : 'ghost')
          + '" data-more="' + esc(m.num) + '">' + esc(label) + '</button></div>';
        if (S.expanded[m.num]) html += '<div class="mc-foot">' + moreBox(m) + '</div>';
      }

      html += '</div>';
    });
    return html;
  }

  function mcOdd(m, market, value, label) {
    var o = oddsOf(m, market, value);
    var p = S.jc[m.num];
    var on = p && p.market === market && p.value === value;
    if (o === null) return '<span class="odd dead"><span class="k">' + esc(label) + '</span>—</span>';
    if (!m.on_sale) return '<span class="odd dead"><span class="k">' + esc(label) + '</span>' + fmtOdds(o) + '</span>';
    return '<span class="odd' + (on ? ' on' : '') + '" data-num="' + esc(m.num) + '" data-m="' + market
      + '" data-v="' + esc(value) + '"><span class="k">' + esc(label) + '</span>' + fmtOdds(o) + '</span>';
  }

  function jcRows(list) {
    var html = '';
    list.forEach(function (m) {
      var p = S.jc[m.num];
      var cls = [];
      if (!m.on_sale) cls.push('ended');
      if (p) cls.push('picked');
      html += '<tr class="' + cls.join(' ') + '">';

      html += '<td style="text-align:center"><input type="checkbox" data-check="' + esc(m.num) + '"'
        + (p ? ' checked' : '') + (m.on_sale ? '' : ' disabled') + '></td>';
      html += '<td class="num-c">' + esc(m.num) + '</td>';
      html += '<td>' + esc(m.league) + '</td>';
      html += '<td class="team-h">' + esc(m.home) + '</td>';
      html += '<td class="team-a">' + esc(m.away) + '</td>';
      html += '<td class="num-c">' + esc(shortTime(m.kickoff)) + '</td>';
      R3.forEach(function (k) { html += '<td class="odd-c">' + oddCell(m, 'nspf', k) + '</td>'; });
      html += '<td class="num-c">' + esc(m.rangqiu_text || '—') + '</td>';
      R3.forEach(function (k) { html += '<td class="odd-c">' + oddCell(m, 'spf', k) + '</td>'; });

      var extraPick = (p && EXTRA_MARKETS.indexOf(p.market) >= 0) ? p : null;
      var hasExtra = EXTRA_MARKETS.some(function (x) { return m.odds && m.odds[x]; });
      var label = extraPick
        ? (MARKET_NAME[extraPick.market] + ' ' + pickLabel(extraPick.market, extraPick.value) + (S.expanded[m.num] ? ' ▴' : ' ▾'))
        : (S.expanded[m.num] ? '收起 ▴' : '其他玩法 ▾');
      html += '<td>'
        + (hasExtra
          ? '<button class="btn sm ' + (extraPick ? 'picked' : 'ghost') + '" data-more="' + esc(m.num) + '">' + esc(label) + '</button>'
          : '<span class="mkempty">—</span>')
        + '</td>';
      html += '</tr>';

      if (hasExtra && S.expanded[m.num]) {
        html += '<tr class="morerow"><td colspan="14">' + moreBox(m) + '</td></tr>';
      }
    });
    return html;
  }

  function oddCell(m, market, value) {
    var o = oddsOf(m, market, value);
    var p = S.jc[m.num];
    var on = p && p.market === market && p.value === value;
    if (o === null) return '<span class="odd dead">—</span>';
    if (!m.on_sale) return '<span class="odd dead">' + fmtOdds(o) + '</span>';
    return '<span class="odd' + (on ? ' on' : '') + '" data-num="' + esc(m.num)
      + '" data-m="' + market + '" data-v="' + esc(value) + '" title="'
      + esc(MARKET_NAME[market] + ' ' + pickLabel(market, value) + ' @' + fmtOdds(o)) + '">'
      + fmtOdds(o) + '</span>';
  }

  function moreBox(m) {
    var h = '<div class="morebox">', any = false;
    EXTRA_MARKETS.forEach(function (mk) {
      var om = m.odds && m.odds[mk];
      if (!om || !Object.keys(om).length) return;
      any = true;
      var cur = S.jc[m.num];
      h += '<div class="mkline"><div class="mkname">' + esc(MARKET_NAME[mk]) + '</div><div class="mkopts">';
      Object.keys(om).forEach(function (v) {
        var o = Number(om[v]);
        if (!(o > 0)) return;
        var on = cur && cur.market === mk && cur.value === v;
        var lab = mk === 'jqs' ? (v + ' 球') : (mk === 'bqc' ? bqcText(v) : v);
        h += '<span class="mkopt' + (on ? ' on' : '') + (m.on_sale ? '' : ' dead') + '"'
          + (m.on_sale ? ' data-num="' + esc(m.num) + '" data-m="' + mk + '" data-v="' + esc(v) + '"' : '')
          + '>' + esc(lab) + ' <b>' + fmtOdds(o) + '</b></span>';
      });
      h += '</div></div>';
    });
    if (!any) h += '<div class="mkempty">这场没有可选的附加玩法（可能已关闭）</div>';
    return h + '</div>';
  }

  /* ---------- 胜负彩表 ---------- */

  function sfcCard() {
    var card = U.el('div', { class: 'card' });
    var list = sfcMatches();
    var d = S.data || {};
    var expect = (d.sfc && d.sfc.expect) || '';

    var h = U.el('h2', {}, [document.createTextNode('② 胜负彩 ')]);
    h.appendChild(U.el('span', {
      class: 'hint',
      text: list.length ? ('第 ' + (expect || '?') + ' 期 · ' + list.length + ' 场'
        + (d.sfc && d.sfc.deadline ? ' · 截止 ' + d.sfc.deadline : '')) : '（无数据）'
    }));
    card.appendChild(h);

    card.appendChild(U.el('p', {
      class: 'desc',
      html: '每场可以选 <b>胜 / 平 / 负 多个</b>（双选、三选就是复式）。胜负彩是<b>奖池制</b>：官方不公布固定赔率，' +
        '中奖金额由猜中人数均分奖池 —— 所以这里只算<b>注数 / 金额</b>。' +
        '「胜平负」列如果显示数字，是<b>同场竞彩的参考赔率</b>（带 * 号），不参与计奖。'
    }));

    var tools = U.el('div', { class: 'row', style: { marginBottom: '10px' } });
    var seg = U.el('div', { class: 'seg' });
    [['all', '14 场（一等奖）'], ['nine', '任九']].forEach(function (t) {
      var b = U.el('button', { class: S.sfcMode === t[0] ? 'on' : '', text: t[1] });
      b.addEventListener('click', function () { S.sfcMode = t[0]; save(); renderCurrent(); });
      seg.appendChild(b);
    });
    tools.appendChild(seg);
    tools.appendChild(U.btn('清空胜负彩选择', function () { S.sfc = {}; save(); renderCurrent(); }, 'sm ghost'));
    card.appendChild(tools);

    if (!list.length) {
      card.appendChild(U.note('还没有胜负彩数据（可能当前没有在售期次）。点右上角「⟳ 刷新数据」。', 'warn'));
      return card;
    }

    /* ===== 手机：14 张小卡，胜/平/负 横排（不堆成 9 行表格） ===== */
    if (isMobile()) {
      var mbox = U.el('div', { class: 'mcards' });
      mbox.innerHTML = sfcMobileCards(list);
      card.appendChild(mbox);
      mbox.addEventListener('click', function (e) {
        var t = e.target;
        var el = t && t.closest ? t.closest('[data-sfcpick]') : null;
        if (el) toggleSfc(el.getAttribute('data-sfcpick'), el.getAttribute('data-v'));
      });
      return card;
    }

    var tw = U.el('div', { class: 'tw' });
    var tb = U.el('table');
    tb.innerHTML = '<thead><tr>'
      + '<th style="width:52px">场次</th><th style="width:70px">联赛</th>'
      + '<th style="width:150px">主队</th><th style="width:150px">客队</th><th style="width:104px">开赛时间</th>'
      + '<th style="width:62px;text-align:center">胜</th><th style="width:62px;text-align:center">平</th>'
      + '<th style="width:62px;text-align:center">负</th><th style="width:150px">我的选择</th></tr></thead>';
    var body = U.el('tbody');
    body.innerHTML = sfcRows(list);
    tb.appendChild(body);
    tw.appendChild(tb);
    card.appendChild(tw);

    body.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.sfcpick) toggleSfc(t.dataset.sfcpick, t.dataset.v);
    });
    return card;
  }

  /** 手机端：一场一张小卡，胜/平/负 三个大按钮横排 */
  function sfcMobileCards(list) {
    var html = '';
    list.forEach(function (m) {
      var key = String(m.no);
      var sel = S.sfc[key] || {};
      html += '<div class="mcard">';
      html += '<div class="mc-head"><span class="mc-no">#' + esc(m.no) + '</span>'
        + '<span>' + esc(m.league) + '</span>'
        + '<span class="mc-time">' + esc(m.kickoff) + '</span></div>';
      html += '<div class="mc-teams"><b>' + esc(m.home) + '</b><span class="vs">vs</span><i>' + esc(m.away) + '</i></div>';
      html += '<div class="mc-opts">';
      R3.forEach(function (k, i) {
        var o = m.odds ? Number(m.odds[i]) : null;
        var has = o && o > 0;
        /* 没参考赔率时只显示「胜/平/负」一个字，别上下重复两遍同一个字 */
        html += '<span class="odd' + (sel[k] ? ' on' : '') + '" data-sfcpick="' + esc(key) + '" data-v="' + k + '">'
          + (has ? '<span class="k">' + esc(R3_TEXT[k]) + '</span>' + fmtOdds(o) : esc(R3_TEXT[k]))
          + '</span>';
      });
      html += '</div></div>';
    });
    return html;
  }

  function sfcRows(list) {
    var html = '';
    list.forEach(function (m) {
      var key = String(m.no);
      var sel = S.sfc[key] || {};
      html += '<tr>';
      html += '<td class="num-c">' + esc(m.no) + '</td>';
      html += '<td>' + esc(m.league) + '</td>';
      html += '<td class="team-h">' + esc(m.home) + '</td>';
      html += '<td class="team-a">' + esc(m.away) + '</td>';
      html += '<td class="num-c">' + esc(m.kickoff) + '</td>';
      R3.forEach(function (k, i) {
        var o = m.odds ? Number(m.odds[i]) : null;
        var has = o && o > 0;
        html += '<td class="odd-c"><span class="odd' + (sel[k] ? ' on' : '') + '"'
          + ' data-sfcpick="' + esc(key) + '" data-v="' + k + '" title="'
          + esc(R3_TEXT[k] + (has ? ' 参考赔率 ' + fmtOdds(o) : ' 无参考赔率')) + '">'
          + (has ? fmtOdds(o) : R3_TEXT[k]) + (m.odds_from ? '<span class="ovr">*</span>' : '')
          + '</span></td>';
      });
      html += '<td><div class="mycell">' + R3.map(function (k) {
        return '<span class="odd' + (sel[k] ? ' mine' : '') + '" data-sfcpick="' + esc(key)
          + '" data-v="' + k + '">' + R3_TEXT[k] + '</span>';
      }).join('') + '</div></td>';
      html += '</tr>';
    });
    return html;
  }

  /* ---------- 汇总 ---------- */

  function sumCard() {
    var jc = calcJc(), sf = calcSfc();
    var card = U.el('div', { class: 'card' });
    card.appendChild(U.el('h2', {}, [document.createTextNode('③ 选票汇总 ')]));
    var tools = U.el('div', { class: 'row', style: { marginBottom: '8px' } });
    tools.appendChild(U.btn('复制选票文本', function () {
      var txt = ticketText();
      if (!txt) return U.toast('还没选任何东西', 'warn');
      U.copy(txt);
    }, 'sm ghost'));
    tools.appendChild(U.btn('全部清空', function () {
      U.confirmBox('清空全部选择（竞彩 + 胜负彩）？', function () {
        S.jc = {}; S.sfc = {}; S.chord = 2; S.jcMulti = 1; S.sfcMulti = 1;
        save(); renderCurrent(); U.toast('已清空', 'ok');
      });
    }, 'sm ghost'));
    card.appendChild(tools);

    var grid = U.el('div', { class: 'sumgrid' });

    /* --- 竞彩 pane --- */
    var p1 = U.el('div', { class: 'pane' });
    var h1 = U.el('h3', {}, [document.createTextNode('竞彩足球 ')]);
    h1.appendChild(U.el('span', { class: 'pill', text: jc.count + ' 场' }));
    p1.appendChild(h1);

    var row1 = U.el('div', { class: 'row', style: { marginBottom: '9px' } });
    row1.appendChild(U.field('串关方式', chordSelect(jc)));
    row1.appendChild(U.field('倍数', numberInput(S.jcMulti, function (v) {
      S.jcMulti = v; save(); renderSummaryOnly();
    })));
    p1.appendChild(row1);

    var list1 = U.el('div', { class: 'picklist' });
    if (!jc.picked.length) list1.appendChild(U.el('div', { class: 'picknone', text: '还没选比赛' }));
    else {
      jc.picked.forEach(function (x) {
        var r = U.el('div', { class: 'pickrow' });
        r.appendChild(U.el('span', { class: 'val', text: x.label }));
        r.appendChild(U.el('span', { class: 'nm', title: x.m.league + ' ' + x.m.home + ' vs ' + x.m.away, text: x.m.num + ' ' + x.m.home + ' vs ' + x.m.away }));
        r.appendChild(U.el('span', { class: 'val', text: fmtOdds(x.odds) }));
        var del = U.el('span', { class: 'del', text: '×', title: '移除' });
        del.addEventListener('click', function () { delete S.jc[x.m.num]; save(); renderCurrent(); });
        r.appendChild(del);
        list1.appendChild(r);
      });
    }
    p1.appendChild(list1);
    p1.appendChild(kpiGrid([
      [jc.count + ' 场', '已选比赛', ''],
      [jc.chord === 1 ? '单关' : jc.chord + '串1', '串关方式', ''],
      [fmtInt(jc.bets), '注数', ''],
      [fmtMoney(jc.money), '投注金额', 'money'],
      [jc.winAll ? fmtMoney(jc.winAll) : '—', '全部命中奖金', 'win'],
      [jc.maxOne ? (jc.minOne !== jc.maxOne ? fmtMoney(jc.minOne) + ' ~ ' + fmtMoney(jc.maxOne) : fmtMoney(jc.maxOne)) : '—', '单注奖金', '']
    ]));
    var n1 = U.el('div', { class: 'notes' });
    var n1h = '';
    if (jc.problems.length) n1h += '<span class="bad">' + jc.problems.map(esc).join('<br>') + '</span>';
    if (jc.bets) {
      n1h += (n1h ? '<br>' : '') + '算法：' + (jc.chord === 1 ? '单关' : jc.chord + '串1') + ' → 从 ' + jc.count
        + ' 场任取 ' + jc.chord + ' 场 = ' + fmtInt(jc.bets) + ' 注 × 2 元 × ' + jc.multi + ' 倍 = ' + fmtMoney(jc.money)
        + '<br>奖金 = 2 × 各场赔率相乘 × 倍数，所有注加起来（全中）';
    }
    n1.innerHTML = n1h;
    p1.appendChild(n1);
    grid.appendChild(p1);

    /* --- 胜负彩 pane --- */
    var p2 = U.el('div', { class: 'pane' });
    var h2 = U.el('h3', {}, [document.createTextNode('胜负彩 ')]);
    h2.appendChild(U.el('span', { class: 'pill', text: sf.mode === 'all' ? '14 场' : '任九' }));
    p2.appendChild(h2);

    var row2 = U.el('div', { class: 'row', style: { marginBottom: '9px' } });
    row2.appendChild(U.field('玩法', (function () {
      var s = U.select([
        { v: 'all', n: '14 场（猜一等奖）' }, { v: 'nine', n: '任九（任选 9 场）' }
      ], sf.mode, function (v) { S.sfcMode = v === 'nine' ? 'nine' : 'all'; save(); renderCurrent(); });
      return s;
    })()));
    row2.appendChild(U.field('倍数', numberInput(S.sfcMulti, function (v) {
      S.sfcMulti = v; save(); renderSummaryOnly();
    })));
    p2.appendChild(row2);

    var list2 = U.el('div', { class: 'picklist' });
    if (!sf.rows.length) list2.appendChild(U.el('div', { class: 'picknone', text: '还没选结果' }));
    else {
      sf.rows.forEach(function (x) {
        var r = U.el('div', { class: 'pickrow' });
        r.appendChild(U.el('span', { class: 'val', text: '#' + x.no }));
        r.appendChild(U.el('span', { class: 'nm', title: x.m.league + ' ' + x.m.home + ' vs ' + x.m.away, text: x.m.home + ' vs ' + x.m.away }));
        r.appendChild(U.el('span', { class: 'val', text: x.text }));
        var del = U.el('span', { class: 'del', text: '×', title: '移除' });
        del.addEventListener('click', function () { delete S.sfc[String(x.no)]; save(); renderCurrent(); });
        r.appendChild(del);
        list2.appendChild(r);
      });
    }
    p2.appendChild(list2);
    p2.appendChild(kpiGrid([
      [sf.selectedCount + ' / ' + sfcMatches().length + ' 场', '已选场次', ''],
      [fmtInt(sf.bets), '注数', ''],
      [fmtMoney(sf.money), '投注金额', 'money'],
      [sf.mode === 'all' ? '14 场' : '任九', '玩法', '']
    ]));
    var n2 = U.el('div', { class: 'notes' });
    var n2h = '';
    if (sf.problems.length) n2h += '<span class="bad">' + sf.problems.map(esc).join('<br>') + '</span>';
    if (sf.notes.length) n2h += (n2h ? '<br>' : '') + '<ul>' + sf.notes.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>';
    n2.innerHTML = n2h;
    p2.appendChild(n2);
    grid.appendChild(p2);

    card.appendChild(grid);

    /* --- 合计 --- */
    var tb = U.el('div', { class: 'totalbar' });
    tb.appendChild(totalItem('竞彩金额', fmtMoney(jc.money)));
    tb.appendChild(totalItem('胜负彩金额', fmtMoney(sf.money)));
    tb.appendChild(totalItem('合计需要', fmtMoney(jc.money + sf.money), 'big'));
    var win = totalItem('竞彩全中预计奖金', jc.winAll ? fmtMoney(jc.winAll) : '—', 'grow');
    win.querySelector('b').classList.add('win');
    tb.appendChild(win);
    card.appendChild(tb);

    return card;
  }

  function chordSelect(jc) {
    var opts = [];
    for (var i = 1; i <= jc.maxChord; i++) {
      opts.push({ v: String(i), n: i === 1 ? '单关（每场单独一注）' : (i + ' 串 1') });
    }
    var sel = U.select(opts, String(jc.chord), function (v) {
      S.chord = Number(v) || 1; save(); renderSummaryOnly();
    });
    if (jc.count < 1) sel.disabled = true;
    return sel;
  }

  function numberInput(val, onChange) {
    var i = U.el('input', { type: 'number', min: '1', max: '999', step: '1', value: String(val) });
    i.addEventListener('input', function () {
      var v = Math.max(1, Math.min(999, Math.floor(Number(i.value) || 1)));
      onChange(v);
    });
    return i;
  }

  function kpiGrid(items) {
    var g = U.el('div', { class: 'kpis' });
    items.forEach(function (t) {
      g.appendChild(U.el('div', { class: 'kpi ' + (t[2] || '') }, [
        U.el('div', { class: 'v', text: String(t[0]) }),
        U.el('div', { class: 'l', text: t[1] })
      ]));
    });
    return g;
  }

  function totalItem(label, value, cls) {
    var b = U.el('b', { text: String(value) });
    return U.el('div', { class: 'ti ' + (cls || '') }, [
      U.el('span', { class: 'lab', text: label }), b
    ]);
  }

  /** 只重画汇总区（改倍数/串关时不闪整页） */
  function renderSummaryOnly() {
    renderCurrent();
  }

  /* ============================================================ 选票文本 */

  function ticketText() {
    var jc = calcJc(), sf = calcSfc(), lines = [];
    if (jc.picked.length) {
      lines.push('【竞彩足球】' + (jc.chord === 1 ? '单关' : jc.chord + '串1') + ' × ' + jc.multi
        + ' 倍  共 ' + jc.bets + ' 注  ' + fmtMoney(jc.money));
      jc.picked.forEach(function (x) {
        lines.push('  ' + x.m.num + ' ' + x.m.home + ' vs ' + x.m.away + ' —— '
          + MARKET_NAME[x.market] + '：' + x.label + ' @' + fmtOdds(x.odds));
      });
    }
    if (sf.rows.length) {
      var expect = (S.data && S.data.sfc && S.data.sfc.expect) || '?';
      lines.push('【胜负彩】第 ' + expect + ' 期  ' + (sf.mode === 'all' ? '14场' : '任九')
        + ' × ' + sf.multi + ' 倍  共 ' + (sf.bets ? (sf.bets + ' 注  ' + fmtMoney(sf.money)) : '（未完成）'));
      sf.rows.forEach(function (x) {
        lines.push('  ' + x.no + '. ' + x.m.home + ' vs ' + x.m.away + ' —— ' + x.text);
      });
    }
    return lines.join('\n');
  }

  /* ============================================================ 示例数据 */

  /** 没有任何后端时，也能让人看到一张"填好的票"长什么样 */
  function loadDemo() {
    var teams = [['圣克拉拉', '本菲卡', '葡超'], ['布洛涅', '兰斯', '法乙'], ['塞维利亚', '奥萨苏纳', '西甲'],
      ['弗拉门戈', '米竞技', '巴甲'], ['洛杉矶FC', '洛城银河', '美职足']];
    var jczq = teams.map(function (t, i) {
      var base = 1.6 + i * 0.35;
      return {
        id: '示例' + (i + 1), num: '示例' + (i + 1), home: t[0], away: t[1], league: t[2],
        kickoff: '2026-01-01 20:00', rangqiu: i % 2 ? 1 : -1,
        rangqiu_text: i % 2 ? '主受让1' : '主让1',
        on_sale: true,
        nspf: [base, base + 1.2, base + 2.4],
        spf: [base + 0.4, base + 1.4, base + 1.9],
        odds: {
          nspf: { '3': base, '1': base + 1.2, '0': base + 2.4 },
          spf: { '3': base + 0.4, '1': base + 1.4, '0': base + 1.9 },
          jqs: { '0': 9, '1': 5, '2': 3.6, '3': 3.9, '4': 5.5, '5': 9, '6': 17, '7': 30 },
          bqc: { '3-3': 2.4, '3-1': 13, '3-0': 26, '1-3': 5, '1-1': 6.5, '1-0': 12, '0-3': 26, '0-1': 12, '0-0': 9 },
          bf: { '1:0': 8, '2:0': 13, '2:1': 8.5, '3:0': 26, '3:1': 17, '3:2': 29, '0:0': 11, '1:1': 6.5, '0:1': 12, '胜其它': 15, '平其它': 60, '负其它': 30 }
        },
        sub_on: []
      };
    });
    var sfcTeams = [['大田', '神户', '亚冠杯'], ['京都', '喷气机', '亚冠杯'], ['国安', '全北现代', '亚冠杯'],
      ['叻武里', '太阳神', '亚冠杯'], ['波鸿', '美因茨', '德国杯'], ['汉堡', '法兰克福', '德国杯'],
      ['科隆', '柏林联', '德国杯'], ['多特', '不来梅', '德国杯'], ['埃沃斯', '达姆施', '德国杯'],
      ['门兴', '卡尔斯', '德国杯'], ['萨索洛', '拉齐奥', '意甲'], ['都灵', '科莫', '意甲'],
      ['罗马', '卡利亚', '意甲'], ['索尔纳', '埃尔夫', '瑞典超']];
    var sfc = {
      expect: '示例期', deadline: '示例数据', matches: sfcTeams.map(function (t, i) {
        return { no: i + 1, league: t[2], home: t[0], away: t[1], kickoff: '2026-01-01 20:00', odds: null, odds_from: null };
      })
    };
    S.demo = true;
    applyData({
      ok: true, ts: '示例数据（不是真实赔率）', jczq: jczq, sfc: sfc,
      errors: ['这是内置示例数据，赔率是编的，只用来熟悉界面'],
      from_cache: false, source: '内置示例'
    });
    S.jc = {}; S.sfc = {};
    S.jc[jczq[0].num] = { market: 'nspf', value: '3' };
    S.jc[jczq[1].num] = { market: 'nspf', value: '1' };
    S.jc[jczq[2].num] = { market: 'jqs', value: '2' };
    S.chord = 2;
    S.expanded[jczq[0].num] = true;
    sfc.matches.forEach(function (m, i) {
      S.sfc[String(m.no)] = {};
      S.sfc[String(m.no)][R3[i % 3]] = true;
      if (i % 5 === 0) S.sfc[String(m.no)][R3[(i + 1) % 3]] = true;
    });
    save();
  }

  /* ============================================================ 页面 */

  function page(host) {
    hostRef = host;
    try { load(); } catch (e) { /* 坏数据忽略 */ }
    try {
      build(host);
    } catch (e) {
      /* 渲染不能把整个页面搞崩：兜一张错误卡，别让 App 显示白屏 */
      host.appendChild(U.note('<b>竞彩选票模块渲染出错：</b>' + U.esc(e && e.message)
        + '<br><span class="mini">' + U.esc((e && e.stack) || '') + '</span>', 'bad'));
      return;
    }
    // 首次进入自动连一次后端（只读缓存，不触发抓取）
    if (!S.data && !S.demo && !S.loading) {
      try { loadData(false); } catch (e) { /* 连不上就显示诊断卡 */ }
    }
  }

  window.App.register({
    id: 'jc',
    title: '竞彩选票',
    icon: '🎯',
    group: '工具',
    desc: '把今天开售的<b>竞彩</b>和<b>胜负彩 14 场</b>拉下来，勾选组成模拟选票，立刻算出<b>注数 / 金额 / 全中奖金</b>。' +
      '数据来自本机抓取服务（竞彩计算器），只做计算，不代购不下注。',
    render: page
  });

  /* 手机/平板横竖屏切换时，表格 ↔ 卡片要跟着换 */
  (function watchBreakpoint() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(max-width: 767px)');
    var last = mq.matches;
    var onChange = function () {
      if (mq.matches === last) return;
      last = mq.matches;
      if (hostRef && document.body && document.body.contains(hostRef)) renderCurrent();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);     // 老 Safari
  })();

  /* 给自检 / 调试用 */
  window.JCMod = {
    state: S,
    calcJc: calcJc,
    calcSfc: calcSfc,
    loadDemo: loadDemo,
    candidateBases: candidateBases,
    ticketText: ticketText,
    demoData: function () { var o = S.data; loadDemo(); var d = S.data; S.data = o; return d; }
  };
})();
