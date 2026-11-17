/* =========================================================================
 * mod-dash.js — 模块 ① 数据总览
 *   首页：样本概况 · 当前生效的核心系数 · 最近记录 · 记录库体检
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;

  function results() {
    return C.store.rows.map(function (r, i) { return { rec: r, r: C.evaluate(r.inp), i: i }; });
  }

  function kpi(label, value, sub, kind) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', style: kind ? { color: kind } : null, text: value }));
    b.appendChild(U.el('div', { class: 'l', text: label }));
    if (sub) b.appendChild(U.el('div', { class: 'sub', text: sub }));
    return b;
  }

  /* ------------------------------------------------------------------ 总览 */
  function renderDash(host) {
    const rs = results();
    const withResult = rs.filter(function (x) { return x.r.actual; });
    const win = withResult.filter(function (x) { return x.r.actual === '赢盘'; }).length;
    const push = withResult.filter(function (x) { return x.r.actual === '走水'; }).length;
    const lose = withResult.filter(function (x) { return x.r.actual === '输盘'; }).length;
    const decided = win + lose;
    const strong = rs.filter(function (x) { return x.r.strength === '强'; });
    const strongDecided = strong.filter(function (x) { return x.r.actual === '赢盘' || x.r.actual === '输盘'; });
    const strongWin = strongDecided.filter(function (x) { return x.r.actual === '赢盘'; }).length;
    const veto = rs.filter(function (x) { return C.arbIsVeto(x.r); });

    const grid = U.el('div', { class: 'grid g4' });
    grid.appendChild(kpi('样本场次', String(rs.length), '已录入的比赛'));
    grid.appendChild(kpi('上盘赢盘率', decided ? U.pct(win / decided) : '—',
      win + ' 赢 / ' + lose + ' 输 / ' + push + ' 走水', decided && win / decided >= 0.5 ? 'var(--ok)' : 'var(--bad)'));
    grid.appendChild(kpi('强信号命中率', strongDecided.length ? U.pct(strongWin / strongDecided.length) : '—',
      '强信号 ' + strong.length + ' 场，已开奖 ' + strongDecided.length + ' 场'));
    grid.appendChild(kpi('一票否决场次', String(veto.length), '机构让球方向与模型长期+短期全面背离'));
    host.appendChild(grid);

    /* —— 当前生效的核心系数 —— */
    const quick = U.el('div', { class: 'card' });
    quick.appendChild(U.el('h2', {}, [document.createTextNode('当前生效的核心系数'),
      U.el('span', { class: 'hint', text: '全部参数在「调参中心」' })]));
    const qg = U.el('div', { class: 'grid g4' });
    [
      ['D值权重', 'AD_DFW'], ['排名权重', 'RANK_W'],
      ['主战绩基础系数 a', 'FORM_A'], ['主战绩斜率 b', 'FORM_B'],
      ['一票否决阈值', 'VETO_ABS'], ['强信号分界', 'STRONG_SCORE'],
      ['深度雄厚线', 'DEPTH_HI'], ['深度薄弱线', 'DEPTH_LO'],
    ].forEach(function (t) {
      const b = U.el('div', { class: 'kpi' });
      b.appendChild(U.el('div', { class: 'v', text: U.fmt(C.store.P[t[1]], 4) }));
      b.appendChild(U.el('div', { class: 'l', text: t[0] }));
      qg.appendChild(b);
    });
    quick.appendChild(qg);
    const qa = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    qa.appendChild(U.btn('去调参 →', function () { window.App.go('params'); }, 'pri'));
    qa.appendChild(U.btn('去录入一场 →', function () { window.App.go('batch'); }, 'ghost'));
    qa.appendChild(U.btn('去统计分析 →', function () { window.App.go('stats'); }, 'ghost'));
    qa.appendChild(U.btn('去导出 / 备份 →', function () { window.App.go('export'); }, 'ghost'));
    quick.appendChild(qa);
    host.appendChild(quick);

    /* —— 最近记录 —— */
    const recent = rs.slice(-10).reverse();
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('最近记录'),
      U.el('span', { class: 'hint', text: '最新的 10 场' })]));
    c.appendChild(U.el('div', { html: U.table([
      { k: 'seq', n: '#', w: '44px' },
      { k: 'league', n: '联赛', w: '54px' },
      { k: 'match', n: '对阵', w: '180px' },
      { k: 'up', n: '上盘方', w: '60px' },
      { k: 'core', n: '本心实力盘', w: '116px' },
      { k: 'scene', n: '八大场景', w: '210px' },
      { k: 'dir', n: '推荐方向', w: '120px' },
      { k: 'arb', n: '仲裁结论', w: '190px' },
      { k: 'total', n: '评分', w: '60px' },
      { k: 'str', n: '强度', w: '52px' },
      { k: 'act', n: '结果', w: '60px' },
    ], recent.map(function (x) {
      const sd = C.sideOf(x.r, C.store.LIB);
      return {
        seq: x.rec.seq,
        league: x.rec.inp.league || '',
        match: U.esc((x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?')),
        up: x.r.upSide === '平手' ? U.pill('平手', 'mute') : U.pill(x.r.upSide, 'info'),
        core: '<span class="pill info">' + U.esc(x.r.corePanText) + '</span>',
        scene: '<span class="ellip" title="' + U.esc(x.r.scene) + '">' + U.esc(x.r.scene) + '</span>',
        dir: sd.dir === 'none' ? '<span class="mini">不参与</span>' : U.esc(sd.team + '（' + sd.side + '）'),
        arb: C.arbIsVeto(x.r) ? U.pill(x.r.arb, 'bad')
          : C.arbIsBad(x.r) ? U.pill(x.r.arb, 'warn')
            : C.arbIsOk(x.r) ? U.pill(x.r.arb, 'ok') : U.pill(x.r.arb, 'info'),
        total: U.fmt(x.r.total, 2),
        str: x.r.strength === '强' ? U.pill('强', 'ok') : x.r.strength === '中' ? U.pill('中', 'warn') : U.pill('弱', 'mute'),
        act: x.r.actual ? (x.r.actual === '赢盘' ? U.pill('赢盘', 'ok') : x.r.actual === '输盘' ? U.pill('输盘', 'bad') : U.pill('走水', 'mute'))
          : '<span class="mini">待开奖</span>',
      };
    })) }));
    if (!recent.length) c.appendChild(U.note('还没有记录。去「批量计算 → ① 单场录入」建一场，或在「导出 / 导入」里恢复一份备份。', 'warn'));
    host.appendChild(c);

    /* —— 记录库体检 —— */
    host.appendChild(dataAuditCard());
  }

  /* -------------------------------------------------------------- 记录库体检 */
  const MISS_LABEL = {
    hADGames: '主队近6场实际场次', aADGames: '客队近6场实际场次',
    league: '联赛（不在映射表里）', open: '机构初盘', openWater: '初盘水位',
  };
  function dataAuditCard() {
    const box = U.el('div', { class: 'card' });
    box.appendChild(U.el('h2', {}, [document.createTextNode('记录库体检'),
      U.el('span', { class: 'hint', text: '查缺失的关键字段' })]));
    const list = C.auditRows();
    if (!list.length) {
      box.appendChild(U.note('✅ 所有记录的关键字段齐全（联赛 / 机构初盘 / 初盘水位 / 近 6 场实际场次）。', 'ok'));
      return box;
    }
    box.appendChild(U.note('下面这些记录缺关键字段，<b>算出来的结论会不准</b>：<br>' +
      '· 缺「近 6 场实际场次」→ 程序按近 6 场非空槽位数估算，心盘会偏；<br>' +
      '· 缺「初盘水位」→ 水档判成「未知」，<b>八大场景直接判不出来</b>（这种场次请务必补上，或在录入页手动指定上盘方）。', 'warn'));
    const tw = U.el('div', { class: 'tw' });
    const tb = U.el('table');
    tb.innerHTML = '<thead><tr><th>#</th><th>比赛</th><th>缺失字段</th>' +
      '<th>主队近6场实际场次</th><th>客队近6场实际场次</th><th>非空槽位</th></tr></thead>';
    const bd = U.el('tbody');
    list.forEach(function (a) {
      const tr = U.el('tr');
      tr.appendChild(U.el('td', { text: a.seq }));
      tr.appendChild(U.el('td', { text: a.label }));
      tr.appendChild(U.el('td', { html: a.miss.map(function (m) {
        return U.pill(MISS_LABEL[m] || m, 'warn');
      }).join(' ') }));
      ['hADGames', 'aADGames'].forEach(function (k) {
        const td = U.el('td');
        if (a.miss.indexOf(k) >= 0) {
          const i = U.el('input', {
            type: 'number', step: '1', min: '0', style: { width: '80px' },
            placeholder: String(k === 'hADGames' ? a.slotsH : a.slotsA),
          });
          i.addEventListener('change', function () {
            a.rec.inp[k] = i.value === '' ? '' : Number(i.value);
            C.saveRows();
            U.toast('已更新 #' + a.seq + ' 的「' + (k === 'hADGames' ? '主队' : '客队') + '近6场实际场次」', 'ok');
            window.App.refresh();
          });
          td.appendChild(i);
        } else {
          td.appendChild(U.el('span', { class: 'mini', text: String(a.rec.inp[k]) }));
        }
        tr.appendChild(td);
      });
      tr.appendChild(U.el('td', { class: 'mini', text: '主 ' + a.slotsH + ' / 客 ' + a.slotsA }));
      bd.appendChild(tr);
    });
    tb.appendChild(bd);
    tw.appendChild(tb);
    box.appendChild(tw);
    const r = U.el('div', { class: 'row' });
    r.appendChild(U.btn('一键补齐（用出厂样例里存的已知值）', function () {
      const n = C.migrateRows();
      U.toast(n ? '已补齐 ' + n + ' 个字段' : '没有可自动补齐的字段', n ? 'ok' : 'warn');
      window.App.refresh();
    }, 'pri'));
    r.appendChild(U.btn('刷新', function () { window.App.refresh(); }, 'ghost'));
    box.appendChild(r);
    return box;
  }

  /* --------------------------------------------------------------- 页面注册 */
  window.App.register({
    id: 'dash', title: '数据总览', icon: '▦', group: '总览',
    desc: '一眼看清样本量、上盘赢盘率、强信号表现，当前生效的核心系数，以及记录库里有没有缺关键字段。',
    render: renderDash,
  });

  window.Dash = { results: results, dataAuditCard: dataAuditCard };
  /* 兼容旧引用 */
  window.Effects = window.Dash;
})();
