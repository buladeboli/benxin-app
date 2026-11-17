/* =========================================================================
 * mod-params.js — 模块 1：调参中心
 *   · 所有系数、所有硬编码阈值、所有映射表均可调
 *   · 支持分组浏览、搜索、改动高亮、单组重置、导入/导出配置
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const D = C.PARAM_DEFS;
  const state = { q: '', group: '全部' };

  function groups() {
    const g = [];
    D.forEach(function (d) { if (g.indexOf(d.g) < 0) g.push(d.g); });
    return g;
  }

  function setParam(k, v) {
    const def = D.filter(function (d) { return d.k === k; })[0];
    let val = v;
    if (def && def.int) val = Math.round(Number(v) || 0);
    else val = Number(v);
    if (!isFinite(val)) val = def ? def.d : 0;
    if (def && def.min !== undefined && val < def.min) val = def.min;
    if (def && def.max !== undefined && val > def.max) val = def.max;
    C.store.P[k] = val;
    C.saveParams();
    return val;
  }

  function renderParams(host) {
    const dirty = C.store.P.__dirty || {};
    // 工具条
    const tools = U.el('div', { class: 'card' });
    const t1 = U.el('div', { class: 'row' });
    t1.appendChild(U.el('label', { class: 'f grow' }, [
      U.el('span', { class: 'k', text: '搜索参数（名称 / 键名 / 说明）' }),
      U.input(state.q, function (v) { state.q = v; rerender(); }, { placeholder: '如：权重、0.35、水、评分、RANK' })
    ]));
    const chipBox = U.el('div', { class: 'grow' });
    chipBox.appendChild(U.el('label', { class: 'f' }, [U.el('span', { class: 'k', text: '分组' })]));
    chipBox.appendChild(U.chips(['全部'].concat(groups()), state.group, function (v) { state.group = v; rerender(); }));
    t1.appendChild(chipBox);
    tools.appendChild(t1);

    const t2 = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    t2.appendChild(U.btn('重置全部参数', function () {
      U.confirmBox('确定把所有参数恢复为出厂默认值？映射表不受影响。', function () {
        C.resetParams(); U.toast('参数已重置', 'ok'); rerender();
      });
    }, 'ghost'));
    t2.appendChild(U.btn('仅重置当前分组', function () {
      if (state.group === '全部') return U.toast('请先选择一个分组', 'warn');
      D.forEach(function (d) { if (d.g === state.group) C.store.P[d.k] = d.d; });
      C.saveParams(); U.toast('已重置分组：' + state.group, 'ok'); rerender();
    }, 'ghost'));
    t2.appendChild(U.btn('导出参数(JSON)', function () {
      U.download('本心参数_' + stamp() + '.json', JSON.stringify({
        params: C.store.P, lib: C.store.LIB
      }, null, 2), 'application/json');
    }));
    t2.appendChild(U.btn('导入参数(JSON)', function () {
      U.pickFile('.json,application/json', function (f) {
        const fr = new FileReader();
        fr.onload = function () {
          try {
            const o = JSON.parse(fr.result);
            if (o.params) { for (const k in o.params) if (k in C.store.P) C.store.P[k] = o.params[k]; C.saveParams(); }
            if (o.lib) { for (const k in o.lib) C.store.LIB[k] = o.lib[k]; C.saveLib(); }
            U.toast('参数已导入', 'ok'); rerender();
          } catch (e) { U.toast('解析失败：' + e.message, 'bad'); }
        };
        fr.readAsText(f, 'utf-8');
      });
    }));
    t2.appendChild(U.btn('复制当前参数快照', function () {
      U.copy(JSON.stringify(C.store.P, null, 1));
    }, 'ghost'));
    const changed = D.filter(function (d) { return Math.abs(Number(C.store.P[d.k]) - d.d) > 1e-12; }).length;
    t2.appendChild(U.el('span', { class: 'stat' }, [
      U.el('span', { text: '共 ' + D.length + ' 个可调项' }),
      U.el('span', { text: '已偏离默认：' + changed })
    ]));
    tools.appendChild(t2);
    tools.appendChild(U.note('参数改动会立即写入浏览器本地存储，并作用于「批量计算 / 统计 / AI 回测」全部模块。' +
      '每个参数都标了它控制什么、出厂默认值是多少；改了会实时生效并存在本机。'));
    host.appendChild(tools);

    // 参数分组
    const q = state.q.trim().toLowerCase();
    groups().forEach(function (g) {
      if (state.group !== '全部' && g !== state.group) return;
      const list = D.filter(function (d) { return d.g === g; }).filter(function (d) {
        if (!q) return true;
        return (d.n + ' ' + d.k + ' ' + d.why + ' ' + (d.lib || '')).toLowerCase().indexOf(q) >= 0;
      });
      if (!list.length) return;
      const card = U.el('div', { class: 'card' });
      const h = U.el('h2');
      h.appendChild(document.createTextNode(g));
      h.appendChild(U.el('span', { class: 'hint', text: '（' + list.length + ' 项）' }));
      card.appendChild(h);
      const grid = U.el('div', { class: 'grid g4' });
      list.forEach(function (d) { grid.appendChild(paramField(d)); });
      card.appendChild(grid);
      host.appendChild(card);
    });
    if (!host.querySelector('.card:nth-child(2)')) {
      host.appendChild(U.note('没有匹配的参数。', 'warn'));
    }
  }

  function paramField(d) {
    const cur = C.store.P[d.k];
    const isInt = !!d.int;
    const inp = U.el('input', {
      type: 'number', step: d.s || 'any',
      min: d.min !== undefined ? d.min : '', max: d.max !== undefined ? d.max : '',
      value: String(cur)
    });
    if (Math.abs(Number(cur) - d.d) > 1e-12) inp.classList.add('dirty');
    inp.addEventListener('input', function () {
      const v = inp.value === '' ? d.d : Number(inp.value);
      if (!isFinite(v)) return;
      C.store.P[d.k] = isInt ? Math.round(v) : v;
      C.saveParams();
      inp.classList.toggle('dirty', Math.abs(Number(C.store.P[d.k]) - d.d) > 1e-12);
    });
    // 注意：这里刻意不做 blur / change 后的整页重绘 —— 否则每改一个数字页面就会跳回顶部
    const lab = U.el('label', { class: 'f' });
    const top = U.el('span', { class: 'k' });
    top.innerHTML = U.esc(d.n) + (d.lib ? ' <span class="mini">' + U.esc(d.lib) + '</span>' : '');
    lab.appendChild(top);
    lab.appendChild(inp);
    const meta = U.el('div', { class: 'mini' });
    meta.textContent = '默认 ' + d.d + (d.lib ? ' · ' + d.lib : '');
    meta.title = d.why || '';
    lab.appendChild(meta);
    // 参数改动即时生效并写入本地存储；不整页重绘，避免编辑时页面跳动
    const why = U.el('div', { class: 'mini', style: { color: 'var(--txt-3)', marginTop: '2px' }, text: d.why || '' });
    lab.appendChild(why);
    return lab;
  }

  /* ---------------- 映射表 ---------------- */
  function renderLib(host) {
    const L = C.store.LIB;

    // 联赛参数
    const card = U.el('div', { class: 'card' });
    card.appendChild(U.el('h2', {}, [
      document.createTextNode('联赛参数表'),
      U.el('span', { class: 'hint', text: '联赛 → 球队总数 / 强度系数' })
    ]));
    card.appendChild(U.el('p', { class: 'desc', text: '球队总数 N 参与排名分差与对手强度档位；联赛系数直接乘进攻防积分；赛季总轮次决定“赛季末修正”的触发。' }));
    const cols = [
      { k: 'name', n: '联赛', w: '90px' },
      { k: 'N', n: '球队总数 N', w: '90px' },
      { k: 'coef', n: '联赛系数', w: '100px' },
      { k: 'R', n: '赛季总轮次', w: '100px' },
      { k: 'act', n: '', w: '60px' }
    ];
    // ★ v15：删掉「封顶值 cap」这一列 —— 引擎从来没有读过它，改它不会有任何效果（僵尸字段）
    const tw = U.el('div', { class: 'tw' });
    function paintLeague() {
      const tb = U.el('table');
      tb.innerHTML = '<thead><tr>' + cols.map(function (c) { return '<th>' + U.esc(c.n) + '</th>'; }).join('') + '</tr></thead>';
      const body = U.el('tbody');
      Object.keys(L.leagues).forEach(function (nm) {
        const lg = L.leagues[nm];
        const tr = U.el('tr');
        tr.appendChild(U.el('td', {}, [U.input(nm, function (v) {
          if (v === nm || !v.trim()) return;
          L.leagues[v.trim()] = L.leagues[nm]; delete L.leagues[nm]; C.saveLib(); paintLeague();
        })]));
        ['N', 'coef', 'R'].forEach(function (f) {
          const td = U.el('td');
          td.appendChild(U.number(lg[f], function (v) {
            lg[f] = v === '' ? 0 : Number(v); C.saveLib();
          }, { step: f === 'N' || f === 'R' ? '1' : '0.01' }));
          tr.appendChild(td);
        });
        const td = U.el('td');
        td.appendChild(U.btn('删除', function () {
          U.confirmBox('删除联赛「' + nm + '」？', function () { delete L.leagues[nm]; C.saveLib(); paintLeague(); });
        }, 'danger sm'));
        tr.appendChild(td);
        body.appendChild(tr);
      });
      tb.appendChild(body);
      tw.innerHTML = ''; tw.appendChild(tb);
    }
    paintLeague();
    card.appendChild(tw);
    const add = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    add.appendChild(U.btn('＋ 新增联赛', function () {
      const nm = '新联赛' + (Object.keys(L.leagues).length + 1);
      L.leagues[nm] = { N: 20, coef: 1, R: 38, cap: 1.2 };
      C.saveLib(); paintLeague();
    }, 'sm'));
    card.appendChild(add);
    host.appendChild(card);

    // 区间衰减
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('排名区间衰减系数'),
      U.el('span', { class: 'hint', text: '排名区间 → 系数' })]));
    c2.appendChild(U.el('p', { class: 'desc', text: '排名分差 = ((客排名−主排名)/(N−1)) × 排名权重 × 本表衰减。区间由「参数 → 排名分差」的分界排名自动判定，也可在录入时手动覆盖。' }));
    const grid = U.el('div', { class: 'grid g4' });
    L.decay.forEach(function (d, i) {
      const box = U.el('div', { class: 'kpi' });
      const line = U.el('div', { class: 'flexline' });
      line.appendChild(U.select(C.TIERS, d.h, function (v) { d.h = v; C.saveLib(); }));
      line.appendChild(U.el('span', { text: '对', style: { color: 'var(--txt-3)' } }));
      line.appendChild(U.select(C.TIERS, d.a, function (v) { d.a = v; C.saveLib(); }));
      box.appendChild(line);
      const l2 = U.el('div', { class: 'flexline', style: { marginTop: '6px' } });
      l2.appendChild(U.number(d.v, function (v) { d.v = Number(v); C.saveLib(); }, { step: '0.05' }));
      box.appendChild(l2);
      grid.appendChild(box);
    });
    c2.appendChild(grid);
    c2.appendChild(U.btn('＋ 新增组合', function () {
      L.decay.push({ h: '下游', a: '上游', v: 1 }); C.saveLib(); window.App.refresh();
    }, 'sm'));
    host.appendChild(c2);

    /* ---- 8 大场景的「方向指向」：场景名说买哪边 ---- */
    const cS = U.el('div', { class: 'card' });
    cS.appendChild(U.el('h2', {}, [document.createTextNode('8 大场景的方向指向（买上盘还是买下盘）'),
      U.el('span', { class: 'hint', text: '① 盘 · 决策树与「投注建议」都读这张表' })]));
    cS.appendChild(U.el('p', { class: 'desc', html:
      '8 大场景的<b>名字本身就是结论</b>：「阻上 / 强支 / 补防 / 诱下」是<b>跟上盘</b>，「诱上 / 看衰」是<b>反着买下盘</b>。' +
      '比如「场景5：浅开高水升盘诱上」，机构在引诱大家买上盘 → 这场应该买<b>下盘</b>。' +
      '<br>如果某个场景在你自己的数据里长期是反的，就在下面把它调过来（改完立刻生效，' +
      '「投注建议」页底部的「历史回看」会告诉你每个场景的真实命中率）。' }));
    const dirRows = Object.keys(L.sceneDir || {}).map(function (k) {
      const known = Object.keys(C.LABELS.scene).map(function (kk) { return C.LABELS.scene[kk]; })
        .filter(function (v) { return C.sceneKeyOf(v) === k; })[0];
      const kw = (L.sceneKw || {});
      let word = '';
      Object.keys(kw).forEach(function (w) { if (known && known.indexOf(w) >= 0 && word === '') word = w; });
      const d = L.sceneDir[k];
      return {
        k: k,
        name: known || k,
        word: word || '—',
        dir: '<b style="color:' + (d === 'up' ? 'var(--ok)' : d === 'down' ? 'var(--bad)' : 'var(--txt-3)') + '">' +
          (d === 'up' ? '跟上盘' : d === 'down' ? '反买下盘' : '不参与') + '</b>',
      };
    });
    const dirTable = U.table([
      { k: 'k', n: '场景键', w: '80px' }, { k: 'name', n: '场景名', w: '250px' },
      { k: 'word', n: '方向词', w: '76px' }, { k: 'dir', n: '当前指向', w: '100px' }
    ], dirRows);
    cS.appendChild(U.el('div', { html: dirTable }));

    const dirGrid = U.el('div', { class: 'grid g3', style: { marginTop: '10px' } });
    Object.keys(L.sceneDir || {}).forEach(function (k) {
      const known = Object.keys(C.LABELS.scene).map(function (kk) { return C.LABELS.scene[kk]; })
        .filter(function (v) { return C.sceneKeyOf(v) === k; })[0] || k;
      const box = U.el('div', { class: 'kpi', style: { padding: '8px 10px' } });
      box.appendChild(U.el('div', { class: 'mini', style: { marginBottom: '4px' }, text: known }));
      box.appendChild(U.select([
        { v: 'up', n: '跟上盘（阻上/强支/补防/诱下）' },
        { v: 'down', n: '反买下盘（诱上/看衰）' },
        { v: 'none', n: '不参与（无指向）' },
      ], L.sceneDir[k], function (v) { L.sceneDir[k] = v; C.saveLib(); window.App.refresh(); }));
      dirGrid.appendChild(box);
    });
    cS.appendChild(dirGrid);
    cS.appendChild(U.note('「跟下盘」的逻辑：机构在「诱上 / 看衰」时，让球方向是给散户看的陷阱，' +
      '真正该买的是另一边 —— 也就是<b>下盘</b>。如果上盘是主队，下盘就是客队，反之亦然。', 'warn'));
    host.appendChild(cS);

    // 盘口对照
    const c3 = U.el('div', { class: 'card' });
    c3.appendChild(U.el('h2', {}, [document.createTextNode('盘口对照表'),
      U.el('span', { class: 'hint', text: '隐藏页 盘口对照表 A1:B13' })]));
    c3.appendChild(U.el('p', { class: 'desc', text: '盘口数值 ↔ 中文名。心盘、排名折算、加减折算、主战绩折算都走这张表。若你用的盘口名称不同，直接改文本列即可。' }));
    const g3 = U.el('div', { class: 'grid g4' });
    L.plate.forEach(function (p, i) {
      const box = U.el('div', { class: 'kpi', style: { padding: '8px 10px' } });
      const l = U.el('div', { class: 'flexline' });
      l.appendChild(U.number(p[0], function (v) { p[0] = Number(v); C.saveLib(); }, { step: '0.25' }));
      l.appendChild(U.input(p[1], function (v) { p[1] = v; C.saveLib(); }));
      box.appendChild(l);
      g3.appendChild(box);
    });
    c3.appendChild(g3);
    c3.appendChild(U.btn('＋ 新增档位', function () { L.plate.push([3.25, '×']); C.saveLib(); window.App.refresh(); }, 'sm'));
    host.appendChild(c3);

    // 加减库
    const tables = [
      ['hist', '历史交锋得分', '对应 加减分项 B2/B3（主客各自取分）'],
      ['injury', '伤病修正分', '会再乘「阵容深度倍数」，并做 ±封顶'],
      ['suspend', '停赛修正分', '与伤病取 MIN 后计入'],
      ['fatigue', '赛程疲劳修正分', ''],
      ['streak', '连赢连负修正分', ''],
      ['depth', '阵容深度倍数', '乘在伤病分上：雄厚×0.7 会削弱扣分，薄弱×1.4 会放大扣分'],
      ['motive', '战意修正', '仅当 剩余轮次 < 赛季末修正轮数 时生效；客队再乘「客队战意折扣」'],
    ];
    const c4 = U.el('div', { class: 'card' });
    c4.appendChild(U.el('h2', {}, [document.createTextNode('加减分库（下拉选项与分值）'),
      U.el('span', { class: 'hint', text: '隐藏页 加减库' })]));
    c4.appendChild(U.el('p', { class: 'desc', text: '这里同时决定「批量录入」里下拉框能选什么、以及每个选项值多少分。改这里等于改规则。' }));
    tables.forEach(function (t) {
      const [key, title, tip] = t;
      const box = U.el('details', { open: key === 'hist' });
      box.appendChild(U.el('summary', { text: title + '（' + Object.keys(L[key]).length + ' 项）' }));
      if (tip) box.appendChild(U.el('div', { class: 'mini', style: { marginBottom: '8px' }, text: tip }));
      const g = U.el('div', { class: 'grid g3' });
      Object.keys(L[key]).forEach(function (k) {
        const line = U.el('div', { class: 'flexline' });
        line.appendChild(U.input(k, function (v) {
          if (v === k) return;
          L[key][v] = L[key][k]; delete L[key][k]; C.saveLib();
        }, { style: { flex: '2 1 0' } }));
        line.appendChild(U.number(L[key][k], function (v) { L[key][k] = v === '' ? 0 : Number(v); C.saveLib(); }, { step: '0.01', style: { flex: '0 0 92px' } }));
        line.appendChild(U.btn('×', function () { delete L[key][k]; C.saveLib(); window.App.refresh(); }, 'danger sm'));
        g.appendChild(line);
      });
      box.appendChild(g);
      box.appendChild(U.btn('＋ 新增选项', function () {
        L[key]['新选项' + (Object.keys(L[key]).length + 1)] = 0; C.saveLib(); window.App.refresh();
      }, 'sm'));
      c4.appendChild(box);
    });
    host.appendChild(c4);

    /* ---- 伤停量化：位置命名对照 + 位置伤害系数（第 5 点：以表格命名为准） ---- */
    if (!L.posClass) L.posClass = JSON.parse(JSON.stringify(C.POS_CLASS_DEF));
    if (!L.posFac) L.posFac = JSON.parse(JSON.stringify(C.POS_FAC_DEF));
    const c5 = U.el('div', { class: 'card' });
    c5.appendChild(U.el('h2', {}, [document.createTextNode('位置命名对照 & 伤害系数'),
      U.el('span', { class: 'hint', text: '「生成录入 → 伤停量化」用它把表格里的位置换算成伤害权重' })]));
    c5.appendChild(U.el('p', {
      class: 'desc', html:
        '左边是你球员信息表里的写法（<b>以表格为准</b>），右边是程序内部的位置类别。' +
        '规则文档只给了 <code>GK / CB / WB / CM / WM / ST-CF</code> 六档，' +
        '你表里有 <b>守门员 / 中卫 / 左后卫 / 右后卫 / 后腰 / 中前卫 / 中场 / 前腰 / 左边锋 / 右边锋 / 左中场 / 右中场 / 中锋 / 前锋 / 影锋 / 后卫</b> 共 16 种。' +
        '后腰（DM）与前腰（AM）是规则没列的，我按「不可替代性」补了 1.08 与 1.02。'
    }));
    const cg = U.el('div', { class: 'grid g2' });
    const box1 = U.el('div', { class: 'card', style: { background: 'var(--bg)' } });
    box1.appendChild(U.el('div', { class: 'sec-title', style: { marginTop: '0' },
      text: '位置命名 → 类别（共 ' + Object.keys(L.posClass).length + ' 项）' }));
    const g1 = U.el('div', { class: 'grid g2' });
    Object.keys(L.posClass).forEach(function (k) {
      const line = U.el('div', { class: 'flexline' });
      line.appendChild(U.input(k, function (v) {
        if (v === k) return;
        L.posClass[v] = L.posClass[k]; delete L.posClass[k]; C.saveLib();
      }, { style: { flex: '2 1 0' } }));
      line.appendChild(U.select(['GK', 'CB', 'FB', 'DM', 'CM', 'AM', 'WM', 'ST'].map(function (x) {
        return { v: x, n: x + ' ' + (C.POS_CLASS_NAME[x] || '') };
      }), L.posClass[k], function (v) { L.posClass[k] = v; C.saveLib(); }, { style: { flex: '0 0 128px' } }));
      line.appendChild(U.btn('×', function () { delete L.posClass[k]; C.saveLib(); window.App.refresh(); }, 'danger sm'));
      g1.appendChild(line);
    });
    box1.appendChild(g1);
    box1.appendChild(U.btn('＋ 新增位置写法', function () {
      L.posClass['新位置' + (Object.keys(L.posClass).length + 1)] = 'CM'; C.saveLib(); window.App.refresh();
    }, 'sm'));
    cg.appendChild(box1);

    const box2 = U.el('div', { class: 'card', style: { background: 'var(--bg)' } });
    box2.appendChild(U.el('div', { class: 'sec-title', style: { marginTop: '0' }, text: '位置伤害系数（PosFac）' }));
    const g2 = U.el('div', { class: 'grid g2' });
    Object.keys(L.posFac).forEach(function (k) {
      const line = U.el('div', { class: 'flexline' });
      line.appendChild(U.el('span', { style: { flex: '1 1 0', fontSize: '12.6px' },
        text: k + '　' + (C.POS_CLASS_NAME[k] || '') }));
      line.appendChild(U.number(L.posFac[k], function (v) {
        L.posFac[k] = v === '' ? 0.95 : Number(v); C.saveLib();
      }, { step: '0.01', min: '0', style: { flex: '0 0 96px' } }));
      g2.appendChild(line);
    });
    box2.appendChild(g2);
    box2.appendChild(U.note('含义：<b>越不可替代的位置系数越高</b>。它乘在「出场权重 W × 身价占比 S」之后。' +
      '门将 1.20（规则原值）最高；中卫 1.10、后腰 1.08、中前卫 1.05、前腰 1.02、边后卫 1.00、边锋/中锋 0.95。', ''));
    cg.appendChild(box2);
    c5.appendChild(cg);
    host.appendChild(c5);

    /* ---- 阵容深度口径（★ 修正重复惩罚的开关） ---- */
    const c5b = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    c5b.appendChild(U.el('h2', {}, [document.createTextNode('阵容深度口径（★ 已修正重复惩罚）'),
      U.el('span', { class: 'hint', text: '「生成录入 → 伤停量化」算「阵容深度文本」时用哪套' })]));
    c5b.appendChild(U.el('p', {
      class: 'desc', html:
        '<b>问题出在哪：</b>规则原文里 <code>S_i = Val_i / ValidSumVal</code>，' +
        '而 <code>ResidualRatio = (ValidSumVal − Σ(W×Val×PosFac)) / ValidSumVal</code> —— ' +
        '把 S 代进去就是 <code>ResidualRatio ≡ 1 − Loss_Est</code>。' +
        '也就是说「伤病等级」和「阵容深度」<b>是同一个数的两种分档</b>，两个乘数会同向叠加：' +
        '缺人少 → 扣分低 <b>再</b> ×0.7；缺人多 → 扣分高 <b>再</b> ×1.4。' +
        '这正是规则自己禁止的「对缺人重复惩罚」。<br><br>' +
        '<b>修正：</b>把深度改成球队的<b>固有板凳厚度</b>，与伤病完全解耦 ——' +
        '<code>DepthRatio = 替补席平均身价 ÷ 首发平均身价</code>（「替补能顶几成首发」）。' +
        '它只描述这支球队有没有牌可换。板凳厚 → ×0.7 削弱扣分；板凳薄 → ×1.4 放大扣分。' +
        '这也正好回到规则文档自己的定位：「阵容深度系数仅仅是伤病项事后的缩放乘数」。'
    }));
    if (!L.depthMode) L.depthMode = 'squad';
    const r5 = U.el('div', { class: 'row' });
    r5.appendChild(U.field('口径', U.select([
      { v: 'squad', n: '✔ 固有板凳厚度（推荐 · 已修正重复惩罚）' },
      { v: 'residual', n: '⚠ 规则原文 ResidualRatio（与伤病同源，会重复惩罚）' },
    ], L.depthMode, function (v) { L.depthMode = v; C.saveLib(); window.App.refresh(); }, { style: { minWidth: '380px' } })));
    c5b.appendChild(r5);
    if (L.depthMode === 'residual') {
      c5b.appendChild(U.note('⚠ 当前用的是规则原文口径：<code>ResidualRatio = 1 − Loss_Est</code>，' +
        '与「伤病等级」完全同源。同一批伤病会被扣两次（先按等级扣、再按深度乘）。' +
        '除非你就是想要原表的复现，否则建议切回「固有板凳厚度」。', 'bad'));
    } else {
      const cal = (function () {
        const arr = [];
        const PL = window.Players ? window.Players.PL() : null;
        if (!PL) return null;
        PL.leagues.forEach(function (lg) {
          (window.Players.teamsOf(lg) || []).forEach(function (t) {
            const ps = window.Players.roster(lg, t);
            if (ps.length < 14) return;
            const r = C.computeInjury(ps, { injured: [], suspended: [], starters: [], subs: [] }, C.store.P, C.store.LIB);
            arr.push({ lg: lg, t: t, v: r.depthRatio, n: ps.length });
          });
        });
        if (!arr.length) return null;
        arr.sort(function (a, b) { return b.v - a.v; });
        const hi = arr.filter(function (x) { return x.v >= C.store.P.DEPTH_HI; }).length;
        const lo = arr.filter(function (x) { return x.v < C.store.P.DEPTH_LO; }).length;
        return { arr: arr, hi: hi, lo: lo, mid: arr.length - hi - lo };
      })();
      if (cal) {
        c5b.appendChild(U.el('div', {
          class: 'mini', style: { marginBottom: '6px' },
          html: '按当前阈值扫一遍你的球员库（' + cal.arr.length + ' 支球队）：' +
            '<b style="color:var(--ok)">雄厚 ' + cal.hi + '</b> 支（≥' + C.store.P.DEPTH_HI + '）· ' +
            '<b>一般 ' + cal.mid + '</b> 支 · ' +
            '<b style="color:var(--bad)">薄弱 ' + cal.lo + '</b> 支（&lt;' + C.store.P.DEPTH_LO + '）。' +
            '建议让「一般」占多数，这样大多数球队拿 ×1.0 不被扭曲。'
        }));
        c5b.appendChild(U.el('div', {
          html: U.table([
            { k: 'r', n: '#', w: '40px' }, { k: 'lg', n: '联赛', w: '70px' }, { k: 't', n: '球队', w: '170px' },
            { k: 'n', n: '人数', w: '56px', num: 1 }, { k: 'v', n: 'DepthRatio', w: '92px' },
            { k: 'lvl', n: '档位', w: '90px' }, { k: 'bar', n: '', w: '180px' },
          ], [].concat(cal.arr.slice(0, 6), [{ sep: 1 }], cal.arr.slice(-6)).map(function (x, i) {
            if (x.sep) return { r: '…', lg: '', t: '<span class="mini">（中间 ' + cal.mid + ' 支略）</span>', n: '', v: '', lvl: '', bar: '' };
            const lv = x.v >= C.store.P.DEPTH_HI ? '深度雄厚' : x.v >= C.store.P.DEPTH_LO ? '深度一般' : '深度薄弱';
            const tone = lv === '深度雄厚' ? 'var(--ok)' : lv === '深度薄弱' ? 'var(--bad)' : 'var(--txt-2)';
            return {
              r: i + 1, lg: x.lg, t: U.esc(x.t), n: x.n, v: U.fmt(x.v, 4),
              lvl: '<span style="color:' + tone + '">' + lv + '</span>',
              bar: '<span style="display:inline-block;height:7px;border-radius:4px;background:' + tone +
                ';width:' + Math.max(3, Math.round(x.v / (cal.arr[0].v || 1) * 170)) + 'px"></span>',
            };
          }))
        }));
      }
    }
    host.appendChild(c5b);

    /* ---- 仲裁口径（★ 修正主队/上盘坐标系混用） ---- */
    const c5c = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    c5c.appendChild(U.el('h2', {}, [document.createTextNode('仲裁口径（★ 已修正「主队 / 上盘」坐标系混用）'),
      U.el('span', { class: 'hint', text: '② 盘「第 2 步 · 看仲裁结论」与「仲裁评分 AB」用哪套' })]));
    c5c.appendChild(U.el('p', {
      class: 'desc', html:
        '<b>旧口径的问题：</b>四个分量（攻防 / 主战绩 / 排名 / 加减）' +
        '全是「<b>主队 − 客队</b>」，所以 Y 的方向语义是【主队 / 客队】；' +
        '可模型的决策方向是【上盘 / 下盘】（场景名「阻上 / 诱上」说的就是上盘）。' +
        '两者只在「主队 = 上盘」时重合 —— <b>客队让球（客让盘）时整个仲裁语义是反的</b>。<br>' +
        '典型误伤：机构开客让盘、客队短期也占优（完全一致），旧口径却判「强背离 · 一票否决」。<br><br>' +
        '<b>还有一层更深的问题：</b>四票的正号个数 X 就是心盘净分差的正号计数版，' +
        '而心盘与机构盘 92% 同向 —— 所以「信号有效」几乎等价于「主队是热门」，没有增量信息。' +
        '换成上盘视角也一样：本库 12 场里 11 场都会变成「信号有效」，等于恒真式。<br><br>' +
        '<b>新口径（v14）：以机构让球方（上盘方）为基准做方向对称检验</b><br>' +
        '· <code>L = 攻防 + 主战绩 + 排名</code> —— 长期固有实力<br>' +
        '· <code>S = 加减</code> —— 短期突发（伤停 / 停赛 / 疲劳 / 战意），唯一可能与机构开盘脱节的信息<br>' +
        '· <code>e1 = sgn(L) × sgn(机构让球方)</code>、<code>e2 = sgn(S) × sgn(机构让球方)</code><br>' +
        '判据：<br>' +
        '<table style="margin:6px 0;font-size:12.4px"><tr><th>情形</th><th>结论</th><th>AB</th><th>第 2 步</th></tr>' +
        '<tr><td>e1&gt;0 且 e2&gt;0</td><td>三方一致：机构·长期·短期同向</td><td>' + C.store.P.ARB_OK + '</td><td>通过</td></tr>' +
        '<tr><td>e1&gt;0 且 e2&lt;0 且 |S|&lt;阈值</td><td>长期一致，短期小分歧</td><td>' + C.store.P.ARB_MINOR + '</td><td>通过</td></tr>' +
        '<tr><td>e1&lt;0 且 e2&gt;0</td><td>长期背离：机构开反了长期实力</td><td>' + C.store.P.ARB_DIV + '</td><td>通过（标黄）</td></tr>' +
        '<tr><td>e1&gt;0 且 e2&lt;0 且 |S|≥阈值</td><td>短期反向：突发信息与机构让球冲突</td><td>' + C.store.P.ARB_REV + '</td><td>止步</td></tr>' +
        '<tr><td>e1&lt;0 且 e2&lt;0</td><td>一票否决：机构与模型全面背离</td><td>' + C.store.P.ARB_TOTAL + '</td><td>否决</td></tr>' +
        '<tr><td>机构开平手盘 / L≈0</td><td>方向证据不足</td><td>' + C.store.P.ARB_THIN + '</td><td>通过</td></tr></table>' +
        '<b>验证：</b>莱万特 vs 巴塞罗那、图卢兹 vs 里尔（两场客让盘）旧口径被误判「强背离」，' +
        '新口径恢复为「三方一致」；赫塔费 vs 拉科鲁尼亚（机构主让但模型长期+短期都看客队）' +
        '新口径仍然是「一票否决」—— 真矛盾保住了。'
    }));
    if (!L.arbMode) L.arbMode = 'v2';
    const r5c = U.el('div', { class: 'row' });
    r5c.appendChild(U.field('口径', U.select([
      { v: 'v2', n: '✔ 方向对称 · 以机构让球方为基准（推荐）' },
      { v: 'legacy', n: '⚠ 旧口径 · 纯主队视角（只作对照用，客让盘会整反）' },
    ], L.arbMode, function (v) { L.arbMode = v; C.saveLib(); window.App.refresh(); }, { style: { minWidth: '420px' } })));
    c5c.appendChild(r5c);
    {
      const rowsAll = C.store.rows.map(function (rec) {
        const r2 = C.evaluate(rec.inp, C.store.P, C.store.LIB);
        return { rec: rec, r: r2 };
      });
      const cnt = {};
      ['resonance', 'minorSplit', 'longDivergence', 'majorReversal', 'totalDivergence', 'thin'].forEach(function (k) { cnt[k] = 0; });
      rowsAll.forEach(function (x) { if (cnt[x.r.arbKey] !== undefined) cnt[x.r.arbKey]++; });
      const nPass = rowsAll.filter(function (x) { return x.r.arbPass; }).length;
      c5c.appendChild(U.el('div', {
        class: 'mini', style: { marginBottom: '6px' },
        html: (L.arbMode === 'legacy' ? '当前是<b>旧口径</b>。' : '当前是<b>新口径</b>。') +
          '你的记录库（' + rowsAll.length + ' 场）分布：' +
          (L.arbMode === 'legacy'
            ? '<b style="color:var(--ok)">信号有效 ' + rowsAll.filter(function (x) { return C.arbIsOk(x.r); }).length + '</b> · ' +
              '信号无效 ' + rowsAll.filter(function (x) { return C.arbIsBad(x.r); }).length + ' · ' +
              '<b style="color:var(--bad)">强背离 ' + rowsAll.filter(function (x) { return C.arbIsVeto(x.r); }).length + '</b>' +
              '　→ 通过第 2 步的只有 ' + nPass + ' 场'
            : '<b style="color:var(--ok)">' + C.LABELS.arb.resonance + ' ' + cnt.resonance + '</b> · ' +
              C.LABELS.arb.minorSplit + ' ' + cnt.minorSplit + ' · ' +
              '<b style="color:var(--warn)">' + C.LABELS.arb.longDivergence + ' ' + cnt.longDivergence + '</b> · ' +
              '<b style="color:var(--warn)">' + C.LABELS.arb.majorReversal + ' ' + cnt.majorReversal + '</b> · ' +
              '<b style="color:var(--bad)">' + C.LABELS.arb.totalDivergence + ' ' + cnt.totalDivergence + '</b> · ' +
              C.LABELS.arb.thin + ' ' + cnt.thin +
              '　→ 通过第 2 步 ' + nPass + ' 场')
      }));
      c5c.appendChild(U.el('div', {
        html: U.table([
          { k: 'm', n: '比赛', w: '190px' },
          { k: 'up', n: '机构让球方', w: '86px' },
          { k: 'L', n: 'L 长期', w: '88px', num: 1 },
          { k: 'S', n: 'S 短期', w: '88px', num: 1 },
          { k: 'e1', n: 'e1', w: '46px' },
          { k: 'e2', n: 'e2', w: '46px' },
          { k: 'arb', n: '仲裁结论', w: '240px' },
          { k: 'ab', n: 'AB', w: '46px', num: 1 },
        ], rowsAll.slice(0, 12).map(function (x) {
          return {
            m: U.esc((x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?')),
            up: x.r.upSide,
            L: U.fmt(x.r.arbL, 4), S: U.fmt(x.r.arbS, 4),
            e1: x.r.arbE1 > 0 ? '＋1' : x.r.arbE1 < 0 ? '−1' : '0',
            e2: x.r.arbE2 > 0 ? '＋1' : x.r.arbE2 < 0 ? '−1' : '0',
            arb: C.arbIsVeto(x.r) ? U.pill(x.r.arb, 'bad')
              : C.arbIsBad(x.r) ? U.pill(x.r.arb, 'warn')
                : C.arbIsOk(x.r) ? U.pill(x.r.arb, 'ok') : U.pill(x.r.arb, 'info'),
            ab: x.r.arbScore,
          };
        }))
      }));
    }
    host.appendChild(c5c);

    /* ---- 上盘判定口径（★ 初盘/终盘 0 球 + 平手盘） ---- */
    const c5d = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    c5d.appendChild(U.el('h2', {}, [document.createTextNode('上盘判定口径（★ 初盘/终盘出现 0 球时）'),
      U.el('span', { class: 'hint', text: '决定「谁是上盘」—— 推荐方向、赛果判定、仲裁全靠它' })]));
    c5d.appendChild(U.el('p', {
      class: 'desc', html:
        '<b>判定顺序：</b><br>' +
        '① <b>初盘 ≠ 0</b> → 用初盘符号：<code>负数 = 主队上盘</code>、<code>正数 = 客队上盘</code><br>' +
        '② <b>初盘 = 0 但终盘 ≠ 0</b> → 用<b>终盘</b>符号（初盘开平手、临场才让出球）<br>' +
        '③ <b>初盘 = 终盘 = 0（平手盘）</b> → 让球为 0，机构只能用<b>水位</b>表达强弱：' +
        '<b>水位低的一方是上盘</b>；两侧都落在中水档 → 平手，<b>不推荐方向</b><br><br>' +
        '<b>修正了三个 bug：</b><br>' +
        '· 旧代码只看初盘，初盘为 0 时上盘一律算成「平手」→ 推荐方向显示成「买 平手（上盘）」<br>' +
        '· 上盘算成「平手」会连带 <code>settle()</code> 对所有比分都返回「走水」，赛果判定整个失效<br>' +
        '· <b>settle() 的盘口符号本来就是反的</b>：约定 <code>J&lt;0 = 主队让球</code>，' +
        '但旧写法用的是「受让」逻辑（<code>+hcp</code>）→ 主队让平半打平本该输盘，却判成赢盘。' +
        '拿 12 场示例比赛验证：<b>修正前 8/12 命中 → 修正后 12/12</b>。'
    }));
    if (!L.flatWaterMode) L.flatWaterMode = 'columns';
    if (!L.flatWaterDefault) L.flatWaterDefault = 'home';
    if (!L.flatWaterDir) L.flatWaterDir = 'up';
    const r5d = U.el('div', { class: 'row' });
    r5d.appendChild(U.field('平手盘（双 0）时两栏水位怎么读', U.select([
      { v: 'columns', n: '✔「初盘水位」= 主队，「终盘水位」= 客队（两个队各一栏）—— 默认' },
      { v: 'home', n: '两栏都是主队水位（只是初盘 / 终盘两个时点）' },
      { v: 'alwaysHome', n: '不看水位 —— 平手盘一律以主队为上盘' },
    ], L.flatWaterMode, function (v) { L.flatWaterMode = v; C.saveLib(); window.App.refresh(); }, { style: { minWidth: '460px' } })));
    r5d.appendChild(U.field('水位判不出来时', U.select([
      { v: 'home', n: '✔ 默认主队为上盘' },
      { v: 'none', n: '平手 · 不推荐方向' },
    ], L.flatWaterDefault, function (v) { L.flatWaterDefault = v; C.saveLib(); window.App.refresh(); }, { style: { minWidth: '200px' } })));
    r5d.appendChild(U.field('平手盘判出上盘后', U.select([
      { v: 'up', n: '✔ 给方向：跟上盘（让球为 0 时水位就是盘口）' },
      { v: 'ignore', n: '不给方向（只把上盘方标出来）' },
    ], L.flatWaterDir, function (v) { L.flatWaterDir = v; C.saveLib(); window.App.refresh(); }, { style: { minWidth: '330px' } })));
    c5d.appendChild(r5d);
    {
      // 演示：三种口径 × 典型输入
      const demo = [
        [0, -0.25, 0.90, 0.90, '初盘 0、终盘主让平半'],
        [0, 0.75, 1.10, 1.10, '初盘 0、终盘客让半一'],
        [0, 0, 0.88, 1.02, '双 0 · 主队低水 / 客队高水'],
        [0, 0, 1.02, 0.88, '双 0 · 主队高水 / 客队低水'],
        [0, 0, 0.95, 0.95, '双 0 · 两边都是中水'],
        [0, 0, '', '', '双 0 · 没填水位'],
      ];
      const cols = [
        { k: 'in', n: '输入（初盘 / 终盘 / 初水 / 终水）', w: '230px' },
        { k: 'm1', n: 'columns（默认）', w: '150px' },
        { k: 'm2', n: 'home', w: '150px' },
        { k: 'm3', n: 'alwaysHome', w: '150px' },
        { k: 'dir', n: '推荐方向（按当前口径 ' + L.flatWaterMode + '）', w: '200px' },
      ];
      const one = function (d, mode) {
        const u = C.resolveUpper(d[0], d[1], d[2], d[3], C.store.P, Object.assign({}, L, { flatWaterMode: mode }));
        return u.upSide === '平手' ? U.pill('平手', 'mute') : U.pill(u.upSide, 'ok');
      };
      c5d.appendChild(U.el('div', {
        class: 'mini', style: { marginBottom: '6px' },
        html: '<b>三种口径下这几种输入各判成什么</b>（绿=判出上盘，灰=不推荐方向）：'
      }));
      c5d.appendChild(U.el('div', { html: U.table(cols, demo.map(function (d) {
        const u = C.resolveUpper(d[0], d[1], d[2], d[3], C.store.P, L);
        const sd = C.sideOf({
          scene: '盘口不变·中水', upSide: u.upSide, upFrom: u.from, upNote: u.note,
          midVerdict: '—', upSideRaw: u.upSide,
        }, L);
        return {
          in: U.esc(d[4] + '　' + String(d[0]) + ' / ' + String(d[1]) + ' / ' + String(d[2]) + ' / ' + String(d[3])),
          m1: one(d, 'columns'), m2: one(d, 'home'), m3: one(d, 'alwaysHome'),
          dir: U.esc(sd.text),
        };
      })) }));
      const cur = C.resolveUpper(0, 0, 0.88, 1.02, C.store.P, L);
      c5d.appendChild(U.note('<b>当前口径下「双 0 · 主队低水 / 客队高水」会判成：</b>' +
        (cur.upSide === '平手' ? '平手（不推荐方向）' : cur.upSide + ' 为上盘') +
        '<br>' + String(cur.note || '').replace(/&/g, '&amp;').replace(/<b>/g, '<b>'), ''));
    }
    host.appendChild(c5d);

    /* ---- 转会窗口 ---- */
    if (!L.transferWindows) L.transferWindows = JSON.parse(JSON.stringify(C.TRANSFER_WINDOWS));
    const c6 = U.el('div', { class: 'card' });
    c6.appendChild(U.el('h2', {}, [document.createTextNode('转会窗口'),
      U.el('span', { class: 'hint', text: '「生成录入 → 转会窗口」页读的就是这里' })]));
    c6.appendChild(U.el('p', {
      class: 'desc', html: '日期格式 <code>MM-DD</code>；时分 24 小时制。<b>可以增删联赛</b>（比如加荷甲、巴甲、日职）。'
    }));
    const twList = C.transferStatus(L);
    c6.appendChild(U.grid([
      { n: '联赛', w: '72px' },
      { n: '夏窗开始', w: '86px' }, { n: '夏窗结束', w: '86px' }, { n: '时分', w: '62px' },
      { n: '冬窗开始', w: '86px' }, { n: '冬窗结束', w: '86px' }, { n: '时分', w: '62px' },
      { n: '时区', w: '48px' }, { n: '当前状态', w: '160px' },
      { n: '', w: '34px' },
    ], twList.map(function (x, i) {
      const row = L.transferWindows[i];
      const mk = function (which, k2, w2) {
        return U.input(row[which][k2], function (v) { row[which][k2] = v; C.saveLib(); },
          { style: { flex: '0 0 ' + w2 + 'px', width: w2 + 'px' } });
      };
      return [
        '<b>' + U.esc(x.lg) + '</b>',
        mk('sum', 'from', 86), mk('sum', 'to', 86), mk('sum', 'hm', 62),
        mk('win', 'from', 86), mk('win', 'to', 86), mk('win', 'hm', 62),
        U.input(row.sum.tz, function (v) { row.sum.tz = v; row.win.tz = v; C.saveLib(); },
          { style: { flex: '0 0 48px', width: '48px' } }),
        x.summer.state + ' / ' + x.winter.state,
        U.btn('×', function () {
          L.transferWindows.splice(i, 1); C.saveLib(); window.App.refresh();
        }, 'danger sm'),
      ];
    })));
    c6.appendChild(U.btn('＋ 新增联赛窗口', function () {
      L.transferWindows.push({ lg: '新联赛', sum: { from: '07-01', to: '09-01', hm: '23:59', tz: 'CET' }, win: { from: '01-01', to: '02-01', hm: '23:59', tz: 'CET' } });
      C.saveLib(); window.App.refresh();
    }, 'sm pri'));
    host.appendChild(c6);
  }

  function stamp() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  /* =====================================================================
   * 第三个标签页：推荐准确率
   *   1) 6 条诊断 —— 命中就高亮（对应「13版文字叙述」里的六个方向）
   *   2) 按方向分组的可调参数（点一下就能改）
   *   3) 优先级表 + 调参起点提示
   * =================================================================== */
  function renderRecDiag(host) {
    const C2 = C;
    const st = C2.recommendStats(C2.store.rows, C2.store.P, C2.store.LIB);
    const xs = st.rows;
    const dec = xs.filter(function (x) { return x.res; });
    const hitRate = function (arr) {
      const d = arr.filter(function (x) { return x.res; });
      const w = d.filter(function (x) { return x.res.win; }).length;
      return { n: arr.length, dn: d.length, w: w, rate: d.length ? w / d.length : null };
    };

    /* ---- 顶部：总览 ---- */
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('推荐准确率 · 调参诊断台'),
      U.el('span', { class: 'hint', text: '哪条亮红，就先调它对应的那一组参数' })]));
    c0.appendChild(U.el('p', {
      class: 'desc', html: '这一页把「13版文字叙述」里的<b>六个调参方向</b>做成了自动诊断：满足条件就高亮，' +
        '并给出<b>具体该调哪个参数</b>。下面是当前记录库的体检结果。'
    }));
    const k = U.el('div', { class: 'grid g4' });
    const noneR = xs.filter(function (x) { return x.rc.caseKey === 'none'; }).length;
    k.appendChild(kpiBox('记录总数', xs.length, '已开奖 ' + dec.length + ' 场'));
    k.appendChild(kpiBox('推荐准确率', st.all.rate === null ? '—' : C2.pct(st.all.rate),
      st.all.w + ' / ' + st.all.dn, st.all.rate !== null && st.all.rate > C2.BREAKEVEN ? 'var(--ok)' : 'var(--bad)'));
    k.appendChild(kpiBox('ROI', st.all.roi === null ? '—' : (st.all.roi >= 0 ? '+' : '') + C2.pct(st.all.roi),
      '保本线 ' + C2.pct(C2.BREAKEVEN), st.all.roi !== null && st.all.roi > 0 ? 'var(--ok)' : 'var(--bad)'));
    k.appendChild(kpiBox('判「不参与」占比', C2.pct(xs.length ? noneR / xs.length : 0),
      '分类问题：太高说明场景匹配不上', noneR / Math.max(1, xs.length) > 0.3 ? 'var(--warn)' : 'var(--ok)'));
    c0.appendChild(k);
    host.appendChild(c0);

    /* ---- 诊断条目 ---- */
    const diags = [];
    const P = C2.store.P, L = C2.store.LIB;
    const ALL = C2.LABELS.scene;

    /* 0 · 样本量够不够开始调参 */
    {
      const n = dec.length;
      const ok = n >= 50, mid = n >= 20;
      diags.push({
        dir: '前提', tone: ok ? 'ok' : (mid ? 'warn' : 'bad'),
        title: '现在能不能开始调参？',
        found: '已开奖 ' + n + ' 场',
        advice: ok
          ? '样本够了 —— **六个方向都可以动**。建议按优先级：先修准确率 ≤45% 的场景 → 再降「平手或错误」占比 → 再调源头系数。'
          : mid
            ? '样本一般 —— 只能动**方向二（场景边界）和方向三（仲裁评分）**。源头系数（方向一）先别动，20~50 场时改了容易过拟合。'
            : '样本太少 —— **先攒样本，别调参**。少于 20 场时任何顺序都在拟合噪声。先把「生成录入」用起来，攒到 20 场再看这一页。',
      });
    }

    /* 1 · 本心盘整体偏深 / 偏浅（方向一） */
    {
      const arr = xs.filter(function (x) { return x.r.J !== null && x.r.netRaw !== null; });
      // 同一坐标系：有符号差 = 心盘（主队视角）+ 机构初盘（同样转成主队视角）
      // 机构初盘 J<0=主让；心盘用 -corePan（corePan 是「让球方为负」的转换值）
      const dev = arr.map(function (x) { return (-x.r.corePan) - (-x.r.J); });   // 都转成「正数=主让」
      const avg = dev.length ? dev.reduce(function (a, b) { return a + b; }, 0) / dev.length : 0;
      const deep = avg > 0.25, shallow = avg < -0.25;
      diags.push({
        dir: '方向一', tone: deep || shallow ? 'bad' : 'ok',
        title: '本心盘整体' + (deep ? '偏深' : shallow ? '偏浅' : '基本贴合') + '机构初盘',
        found: '平均偏差 ' + (avg >= 0 ? '+' : '') + avg.toFixed(3) + ' 球（' + dev.length + ' 场）',
        advice: deep
          ? '模型**高估了主队**（算出来比机构深）。按优先级查：攻防积分的联赛系数 → 排名权重 RANK_W → 主战绩系数的 FORM_A/FORM_B。'
          : shallow
            ? '模型**低估了主队**。同样先查联赛系数、排名权重、主战绩系数 a/b。'
            : '模型与机构开盘基本吻合，源头系数先不用动。',
        jump: '攻防积分 / 排名分差 / 主战绩系数偏差',
        keys: ['RANK_W', 'FORM_A', 'FORM_B', 'AD_DFW'],
      });
    }

    /* 2 · 中水占比过高（方向二） */
    {
      const midN = xs.filter(function (x) { return x.r.isMidScene || x.r.scene === ALL.fm; }).length;
      const share = xs.length ? midN / xs.length : 0;
      const hi = share > 0.3;
      diags.push({
        dir: '方向二', tone: hi ? 'warn' : 'ok',
        title: '中水场次占比' + (hi ? '偏高' : '正常'),
        found: C2.pct(share) + '（' + midN + '/' + xs.length + ' 场）',
        advice: hi
          ? '中水（' + C2.num(P.W_LOW, 0.9) + '~' + C2.num(P.W_MID, 0.99) + '）区间太宽，很多场次挤进来了。' +
            '把「中水上限」调大（比如 0.99 → 1.02）或调小「低水上限」，让更多场次能被归进高水/低水组。' +
            '调完回来看这一页的占比与准确率。'
          : '中水占比正常，水位阈值不用动。',
        keys: ['W_ULTRA_LOW', 'W_LOW', 'W_MID', 'W_HIGH'],
      });
    }

    /* 3 · 某场景准确率特别低（方向二） */
    {
      const byScene = {};
      xs.forEach(function (x) { (byScene[x.r.scene] = byScene[x.r.scene] || []).push(x); });
      const bad = Object.keys(byScene).map(function (k2) {
        const g = hitRate(byScene[k2]);
        return { k: k2, g: g };
      }).filter(function (o) { return o.g.dn >= 5 && o.g.rate !== null && o.g.rate <= 0.45; })
        .sort(function (a, b) { return a.g.rate - b.g.rate; });
      diags.push({
        dir: '方向二', tone: bad.length ? 'bad' : 'ok',
        title: bad.length ? (bad.length + ' 个场景准确率 ≤ 45%') : '没有准确率明显偏低的场景',
        found: bad.length
          ? bad.slice(0, 4).map(function (o) { return o.k + ' ' + C2.pct(o.g.rate) + '（' + o.g.w + '/' + o.g.dn + '）'; }).join('；')
          : '所有场景（已开奖 ≥ 5 场）都在 45% 以上',
        advice: bad.length
          ? '这些场景方向可能反了，必须**先修**（优先级第一）。两种修法：' +
            '① 去「映射表 → 8 大场景方向指向」把这个场景改成「反买下盘 / 跟上盘」；' +
            '② 若认为场景本身没问题，就去调场景边界阈值（水位 / 深开浅开 / 升降盘）把它拆开。'
          : '场景判定没问题。',
        jump: '映射表 → 8 大场景方向指向',
        keys: ['W_MID', 'W_HIGH', 'MOVE_SMALL'],
      });
    }

    /* 4 · 强信号与弱信号没区分度（方向三） */
    {
      const strong = hitRate(xs.filter(function (x) { return x.r.strength === '强'; }));
      const weak = hitRate(xs.filter(function (x) { return x.r.strength === '弱'; }));
      const bothOk = strong.dn >= 5 && weak.dn >= 5;
      const gap = bothOk ? Math.abs((strong.rate || 0) - (weak.rate || 0)) : null;
      const noSep = bothOk && gap < 0.1;
      diags.push({
        dir: '方向三', tone: !bothOk ? 'mute' : (noSep ? 'bad' : 'ok'),
        title: !bothOk ? '强/弱信号区分度：样本不足'
          : (noSep ? '强信号与弱信号准确率几乎一样（没区分度）' : '强/弱信号有区分度'),
        found: '强 ' + (strong.rate === null ? '—' : C2.pct(strong.rate) + '（' + strong.w + '/' + strong.dn + '）') +
          '　弱 ' + (weak.rate === null ? '—' : C2.pct(weak.rate) + '（' + weak.w + '/' + weak.dn + '）') +
          (gap === null ? '' : '　差距 ' + C2.pct(gap)),
        advice: !bothOk
          ? '强信号或弱信号其中一边不足 5 场，等样本攒够再看。'
          : noSep
            ? '评分体系**没有区分能力**。按顺序调：① 偏差评分分档 DEV_T1/T2/T3（现在 0.25/0.5/0.75 可能太粗）；' +
              '② 强中弱分界 STRONG_SCORE / MED_SCORE（现在 7 / 4）；③ 一票否决阈值 VETO_ABS。'
            : '评分区分度正常。',
        keys: ['DEV_T1', 'DEV_T2', 'DEV_T3', 'STRONG_SCORE', 'MED_SCORE', 'VETO_ABS'],
      });
    }

    /* 5 · 中水场次准确率明显低于非中水（方向四） */
    {
      const mid = hitRate(xs.filter(function (x) { return x.rc.caseKey === 'B2' || x.rc.caseKey === 'B3'; }));
      const nonMid = hitRate(xs.filter(function (x) { return x.rc.caseKey === 'A' || x.rc.caseKey === 'B1'; }));
      const bothOk = mid.dn >= 5 && nonMid.dn >= 5;
      const gap = bothOk ? ((nonMid.rate || 0) - (mid.rate || 0)) : null;
      const worse = bothOk && gap > 0.15;
      diags.push({
        dir: '方向四', tone: !bothOk ? 'mute' : (worse ? 'bad' : 'ok'),
        title: !bothOk ? '中水 vs 非中水：样本不足'
          : (worse ? '中水场次准确率明显低于非中水' : '中水与非中水表现接近'),
        found: '中水 ' + (mid.rate === null ? '—' : C2.pct(mid.rate) + '（' + mid.w + '/' + mid.dn + '）') +
          '　非中水 ' + (nonMid.rate === null ? '—' : C2.pct(nonMid.rate) + '（' + nonMid.w + '/' + nonMid.dn + '）'),
        advice: !bothOk
          ? '中水或非中水其中一边不足 5 场。'
          : worse
            ? '中水补丁逻辑不准。可调：① 中水二次判定的门槛（本工具里对应「仲裁/评分」那组 + 上面的映射表）；' +
              '② 直接在「映射表 → 8 大场景方向指向」把中水四场景全设为「不参与」，承认中水看不出意图。'
            : '中水补丁表现正常。',
        jump: '映射表 → 8 大场景方向指向（中水四场景）',
        keys: ['CONSENSUS_MIN', 'VETO_ABS'],
      });
    }

    /* 6 · 联赛差异大（方向五） */
    {
      const byLg = {};
      xs.forEach(function (x) { (byLg[x.rec.inp.league || '未知'] = byLg[x.rec.inp.league || '未知'] || []).push(x); });
      const list = Object.keys(byLg).map(function (k2) { return { k: k2, g: hitRate(byLg[k2]) }; })
        .filter(function (o) { return o.g.dn >= 8; })
        .sort(function (a, b) { return (b.g.rate || 0) - (a.g.rate || 0); });
      const spread = list.length >= 2 ? (list[0].g.rate || 0) - (list[list.length - 1].g.rate || 0) : null;
      const big = spread !== null && spread > 0.25;
      diags.push({
        dir: '方向五', tone: list.length < 2 ? 'mute' : (big ? 'warn' : 'ok'),
        title: list.length < 2 ? '联赛差异：还没有 2 个联赛各满 8 场'
          : (big ? '联赛之间差距很大（可能该分联赛调参）' : '联赛表现接近'),
        found: list.length ? list.map(function (o) {
          return o.k + ' ' + C2.pct(o.g.rate) + '（' + o.g.dn + '）';
        }).join('　') + (spread === null ? '' : '　最大差 ' + C2.pct(spread)) : '样本不足',
        advice: list.length < 2
          ? '分联赛建模需要足够数据量（每个联赛 8 场以上），先攒。'
          : big
            ? '不同联赛可能需要不同参数。可先在「映射表 → 联赛参数表」给弱联赛单独调联赛系数；' +
              '水位阈值/场景逻辑的分联赛化还没做（要做告诉我）。'
            : '联赛表现一致，不用分联赛。',
        jump: '映射表 → 联赛参数表',
      });
    }

    /* 渲染诊断条目 */
    const c1 = U.el('div', { class: 'card' });
    const nHit = diags.filter(function (d) { return d.tone === 'bad' || d.tone === 'warn'; }).length;
    c1.appendChild(U.el('h2', {}, [document.createTextNode('六个方向的自动诊断'),
      U.el('span', { class: 'hint', text: nHit ? (nHit + ' 条需要处理（已高亮）') : '全部正常' })]));
    diags.forEach(function (d) {
      const tone = d.tone === 'bad' ? 'var(--bad)' : d.tone === 'warn' ? 'var(--warn)' : d.tone === 'ok' ? 'var(--ok)' : 'var(--txt-3)';
      const box = U.el('div', {
        style: {
          border: (d.tone === 'bad' || d.tone === 'warn') ? ('2px solid ' + tone) : '1px solid var(--line)',
          borderLeft: '5px solid ' + tone,
          borderRadius: '8px', padding: '9px 12px', marginBottom: '8px',
          background: d.tone === 'bad' ? 'rgba(255,120,120,.07)' : d.tone === 'warn' ? 'rgba(255,190,90,.07)' : 'var(--bg)'
        }
      });
      const h = U.el('div', { class: 'flexline', style: { gap: '8px', flexWrap: 'wrap' } });
      h.appendChild(U.el('span', {
        style: { fontSize: '11px', color: tone, border: '1px solid ' + tone, borderRadius: '4px', padding: '0 5px', whiteSpace: 'nowrap' },
        text: d.dir
      }));
      h.appendChild(U.el('span', { style: { fontSize: '13.2px', fontWeight: '700', color: d.tone === 'ok' ? 'var(--txt)' : tone }, text: d.title }));
      if (d.tone === 'bad' || d.tone === 'warn') {
        h.appendChild(U.el('span', { style: { fontSize: '11.5px', color: tone, fontWeight: '700' }, text: '★ 需要处理' }));
      }
      box.appendChild(h);
      box.appendChild(U.el('div', { class: 'mini', style: { marginTop: '3px' }, text: d.found }));
      box.appendChild(U.el('div', {
        style: { fontSize: '12.4px', color: 'var(--txt-2)', marginTop: '4px', lineHeight: '1.75' },
        html: U.esc(d.advice).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      }));
      if (d.keys && d.keys.length) {
        const row2 = U.el('div', { class: 'chips', style: { marginTop: '6px' } });
        d.keys.forEach(function (kk) {
          const def = D.filter(function (x) { return x.k === kk; })[0];
          const lbl = def ? (def.n + '（' + kk + '=' + U.fmt(C2.store.P[kk], 4) + '）') : kk;
          const chip = U.el('span', { class: 'chip', text: lbl });
          chip.addEventListener('click', function () {
            state.tab = '参数项'; state.q = kk; state.group = '全部';
            U.toast('已跳到参数项并搜索「' + kk + '」', 'ok');
            window.App.refresh();
          });
          row2.appendChild(chip);
        });
        if (d.jump) {
          const chip2 = U.el('span', { class: 'chip', text: '→ ' + d.jump });
          chip2.addEventListener('click', function () { state.tab = '映射表'; window.App.refresh(); });
          row2.appendChild(chip2);
        }
        box.appendChild(row2);
      }
      c1.appendChild(box);
    });
    host.appendChild(c1);

    /* ---- 优先级表 ---- */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('调参的优先顺序（重要）'),
      U.el('span', { class: 'hint', text: '不能同时调所有东西' })]));
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'p', n: '优先级', w: '70px' }, { k: 'w', n: '调什么', w: '260px' }, { k: 'when', n: '什么时候调', w: '430px' }
      ], [
        { p: '第一', w: '修复准确率 ≤ 45% 的场景', when: '方向明显反了，必须先修（对应上面「方向二」那条红色的）' },
        { p: '第二', w: '降低「平手或错误」占比', when: '分类问题，影响样本量（上面总览里的「判不参与占比」）' },
        { p: '第三', w: '调基础模块系数（方向一）', when: '本心盘整体偏深/偏浅 —— 源头问题，影响面最大，需要 ≥ 50 场' },
        { p: '第四', w: '调场景边界阈值（方向二）', when: '中水占比过高、或某个场景准确率低（≥ 20 场就能动）' },
        { p: '第五', w: '调仲裁与评分权重（方向三）', when: '强信号和弱信号准确率差不多，评分没区分度' },
        { p: '第六', w: '分联赛差异化（方向五）', when: '某联赛好某联赛差，需要每个联赛 ≥ 8 场' },
      ])
    }));
    c2.appendChild(U.el('div', {
      class: 'sec-title', text: '一句话记住顺序'
    }));
    c2.appendChild(U.el('ul', {
      style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '2' },
      html: '<li>方向一 = <b>调天线</b>（源头信号）</li>' +
        '<li>方向二 = <b>调频率</b>（翻译精度）</li>' +
        '<li>方向三 = <b>调频道</b>（分类边界）</li>' +
        '<li>方向四 = <b>调音量</b>（筛选力度）</li>' +
        '<li>方向五 = <b>换电台</b>（分联赛）</li>' +
        '<li style="margin-top:6px"><b>先调天线，再调频率，最后才调音量。顺序不能乱。</b></li>'
    }));
    c2.appendChild(U.note('每次只动一个方向、一次只改一个参数，改完回来刷新这一页看诊断有没有变绿。' +
      '同时改一堆参数，出了问题你不知道是哪一个的锅。', 'warn'));
    host.appendChild(c2);
  }
  function kpiBox(label, value, sub, tone) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', style: { fontSize: '18px', color: tone || 'var(--txt)' }, text: String(value) }));
    b.appendChild(U.el('div', { class: 'l', text: label }));
    if (sub) b.appendChild(U.el('div', { class: 'mini', style: { marginTop: '2px' }, text: sub }));
    return b;
  }

  window.App.register({
    id: 'params', title: '调参中心', icon: '⚙', group: '配置',
    desc: '所有系数与硬编码阈值集中在这里。改动实时生效并本地持久化，每个参数都标了它控制什么。',
    render: function (host) {
      const tabs = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
      ['参数项', '映射表', '推荐准确率'].forEach(function (t) {
        const c = U.el('span', { class: 'chip' + ((state.tab || '参数项') === t ? ' on' : ''), text: t });
        c.addEventListener('click', function () { state.tab = t; window.App.refresh(); });
        tabs.appendChild(c);
      });
      host.appendChild(tabs);
      const tb = state.tab || '参数项';
      if (tb === '参数项') renderParams(host);
      else if (tb === '映射表') renderLib(host);
      else renderRecDiag(host);
    }
  });

  window.Params = {
    setTab: function (t) { if (['参数项', '映射表', '推荐准确率'].indexOf(t) >= 0) state.tab = t; },
    getTab: function () { return state.tab || '参数项'; },
    state: state,
  };
})();
