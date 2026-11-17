/* =========================================================================
 * app.js — 应用外壳：左侧模块导航 + 右侧内容
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const PAGES = [];
  const scripts = {};   // 每个模块可挂载辅助函数

  /* ============================================================
   * 手机端只保留这 4 个模块（其余在手机上隐藏，桌面端不受影响）
   *   生成录入 entry / 批量计算 batch / 投注建议 bet / 导出 export
   * 想加回来：往这个数组里加页面 id 即可（如 'help'、'jc'）。
   * ============================================================ */
  const MOBILE_PAGES = ['entry', 'batch', 'bet', 'export'];

  function isMobile() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 767px)').matches);
  }

  const App = {
    /** 注册页面 */
    register: function (page) { PAGES.push(page); return App; },
    /** 切换页面 */
    go: function (id) {
      location.hash = '#' + id;
      render(id);
    },
    /** 重新渲染当前页 */
    refresh: function () { render(App.current()); },
    current: function () { return (location.hash || '').replace('#', '') || (App.pages()[0] && App.pages()[0].id); },
    /** 手机端的页面白名单（外部可改） */
    mobilePages: MOBILE_PAGES,
    isMobile: isMobile,
    /** 当前设备上「可见」的页面列表 */
    pages: function () {
      if (!isMobile() || !App.mobilePages || !App.mobilePages.length) return PAGES;
      const list = PAGES.filter(function (p) { return App.mobilePages.indexOf(p.id) >= 0; });
      return list.length ? list : PAGES;
    },
    /** 供模块共享的小工具 */
    script: function (k, v) { if (v !== undefined) scripts[k] = v; return scripts[k]; },
  };

  function render(id) {
    const pages = App.pages();
    let page = pages.filter(function (p) { return p.id === id; })[0];
    if (!page) {
      page = pages[0];
      /* 手机端访问了被隐藏的页面（比如地址栏留着 #dash）→ 悄悄换成第一个可见页 */
      if (page && (location.hash || '').replace('#', '') !== page.id) {
        try { history.replaceState(null, '', '#' + page.id); } catch (e) { location.hash = page.id; }
      }
    }
    if (!page) return;
    U.$$('#nav a').forEach(function (a) { a.classList.toggle('on', a.dataset.id === page.id); });
    const host = document.getElementById('pages');
    host.innerHTML = '';
    U.$$('#pages > .page').forEach(function (n) { n.remove(); });
    const wrap = U.el('div', { class: 'page on', id: 'page-' + page.id });
    const head = U.el('div', { class: 'page-h' });
    const left = U.el('div');
    left.appendChild(U.el('h1', { text: page.title }));
    if (page.desc) left.appendChild(U.el('p', { html: page.desc }));
    head.appendChild(left);
    if (page.actions) {
      const act = U.el('div', { class: 'flexline' });
      page.actions.forEach(function (a) { act.appendChild(a); });
      head.appendChild(act);
    }
    wrap.appendChild(head);
    try { page.render(wrap); }
    catch (e) {
      wrap.appendChild(U.note('<b>该模块渲染出错：</b>' + U.esc(e && e.message) + '<br><span class="mini">' + U.esc(e && e.stack || '') + '</span>', 'bad'));
    }
    /* 手机端：给表格补「表头文字」，宽表转卡片 */
    if (U.autoLabelTables) U.autoLabelTables(wrap);
    host.appendChild(wrap);
    document.getElementById('main').scrollTop = 0;
    updateFoot();
  }

  /* ============================================================
   * 手机端：顶部汉堡 → 左侧导航抽屉
   * ============================================================ */
  function setupMobileNav() {
    var btn = document.getElementById('navToggle');
    var side = document.getElementById('side');
    var scrim = document.getElementById('scrim');
    if (!btn || !side || !scrim) return;

    function open() {
      side.classList.add('open');
      scrim.classList.add('on');
      document.body.classList.add('navopen');
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      side.classList.remove('open');
      scrim.classList.remove('on');
      document.body.classList.remove('navopen');
      btn.setAttribute('aria-expanded', 'false');
    }
    App.closeNav = close;

    btn.addEventListener('click', function () {
      if (side.classList.contains('open')) close(); else open();
    });
    scrim.addEventListener('click', close);
    // 点导航项后自动收起
    side.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.nav a') : null;
      if (a) close();
    });
    // 手机横屏转竖屏 / 变宽时自动收起；跨过断点则重建导航（手机只显示 4 个模块）
    var wasMobile = isMobile();
    window.addEventListener('resize', function () {
      if (window.innerWidth > 767) close();
      var nowMobile = isMobile();
      if (nowMobile !== wasMobile) {
        wasMobile = nowMobile;
        buildNav();
        render(App.current());
      }
    });
  }

  /**
   * 每次保存记录，都顺手把数据写进「手机本地文件夹」（OPFS，或桌面端选过的文件夹）。
   * 挂在 Core.saveRows 上：任何模块只要调 saveRows() 就会自动同步，不用改各个模块。
   */
  function hookFileSync() {
    if (!window.FileStore) return null;
    const raw = C.saveRows;
    if (raw.__fsHooked) return raw;
    const wrapped = function () {
      const r = raw.apply(C, arguments);
      try { window.FileStore.autoSync('保存记录'); } catch (e) { /* 写文件失败不能影响保存 */ }
      return r;
    };
    wrapped.__fsHooked = true;
    C.saveRows = wrapped;
    try { window.FileStore.init(); } catch (e) { }
    return wrapped;
  }

  /**
   * 表格的「手机适配」得跟着 DOM 变：各模块经常局部重绘（renderLive / paintLeague…），
   * 那些新表格不经过 App.render。用一个 MutationObserver 兜住，60ms 防抖。
   */
  function watchTables() {
    if (typeof MutationObserver === 'undefined') return;
    var pages = document.getElementById('pages');
    if (!pages) return;
    var timer = null;
    var mo = new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        if (U.autoLabelTables) U.autoLabelTables(pages);
      }, 60);
    });
    mo.observe(pages, { childList: true, subtree: true });
  }

  function updateFoot() {
    const f1 = document.getElementById('footRows');
    if (f1) f1.textContent = C.store.rows.length + ' 条记录';
    const f2 = document.getElementById('footState');
    if (f2) {
      const s = C.store.settings;
      f2.textContent = (s.apiKey ? 'AI 已配置' : '离线就绪');
    }
    const f3 = document.getElementById('mtopState');
    if (f3) f3.textContent = C.store.rows.length + ' 条';
  }
  App.updateFoot = updateFoot;

  function buildNav() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    nav.innerHTML = '';
    let lastG = null;
    App.pages().forEach(function (p) {
      const g = p.group || '模块';
      if (g !== lastG) { nav.appendChild(U.el('div', { class: 'grp', text: g })); lastG = g; }
      const a = U.el('a', { 'data-id': p.id, href: '#' + p.id });
      a.appendChild(U.el('span', { class: 'ic', text: p.icon || '•' }));
      a.appendChild(U.el('span', { text: p.title }));
      a.addEventListener('click', function (e) { e.preventDefault(); App.go(p.id); });
      nav.appendChild(a);
    });
  }

  window.addEventListener('hashchange', function () { render(App.current()); });

  document.addEventListener('DOMContentLoaded', function () {
    /* ★ v15：升级后第一次打开时，先把旧的记录库原样备份一份。
     *   因为这一版修了「中文盘口符号反了」「中水判定判反」两个 bug，历史记录的结论会跟着变。
     *   只备份一次（已有备份就不再动），且超过 900KB 时跳过，避免把 5MB 配额挤满。 */
    try {
      const rawRows = localStorage.getItem('benxin.rows.v1');
      if (rawRows && !localStorage.getItem('benxin.rows.bak.v1') && rawRows.length < 900000) {
        localStorage.setItem('benxin.rows.bak.v1', rawRows);
      }
    } catch (e) { }
    C.loadParams(); C.loadLib(); C.loadRows(); C.loadSettings(); C.loadHistory(); C.loadIters();
    // 首次运行：植入 12 条示例比赛，打开就有东西可看（在「批量计算」里可删）
    if (!C.store.rows.length && window.SEED_ROWS) {
      C.store.rows = window.SEED_ROWS.map(function (inp) {
        const rec = C.newRecord(inp);
        rec.seed = true;
        return rec;
      });
      C.saveRows();
    } else {
      // 历史数据修复：只填空值，不覆盖你已经填过的
      const fixed = C.migrateRows();
      if (fixed) U.toast('已补齐 ' + fixed + ' 个历史缺失字段（近 6 场实际场次等）', 'ok', 4200);
    }
    hookFileSync();          // ★ 让每次保存都同步到「手机本地文件夹」
    buildNav();
    setupMobileNav();
    watchTables();
    render(App.current());

    if (window.FileStore) {
      FileStore.ready().then(function () { App.updateFoot(); }, function () { App.updateFoot(); });
    }

    U.toast(isMobile()
      ? ('手机端已就绪 · ' + C.store.rows.length + ' 条记录 · 保存会自动写入手机本地')
      : ('离线工作台已就绪 · ' + C.store.rows.length + ' 条记录'), 'ok');
  });

  window.App = App;
})();
