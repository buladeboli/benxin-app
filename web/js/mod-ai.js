/* =========================================================================
 * mod-ai.js — 模块 6：AI 回测迭代
 *   · 离线规则引擎：单参数扫描 / 坐标下降 / 组合网格搜索（零成本，不联网）
 *   · 在线 LLM：自带 OpenAI 兼容 API Key，让模型读统计结果后给出调参建议
 *   · 过拟合守门：样本外留一验证 + 最小样本门槛 + 警示
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const S = { results: null, log: [], suggestions: [], running: false, tab: 'road' };

  const TUNABLE = [
    'AD_DFW', 'AD_CAP', 'AD_BIGWIN_DIFF', 'AD_BIGWIN_FACTOR', 'STRONG_OPP_MUL', 'WEAK_OPP_MUL', 'SAMPLE_FULL_GAMES',
    'FORM_A', 'FORM_B', 'FORM_LO', 'FORM_HI', 'FORM_SMOOTH', 'FORM_CONVERGE', 'FORM_EMPTY', 'FORM_STEP',
    'RANK_W', 'RANK_LO', 'RANK_HI', 'RANK_TIER_LO', 'RANK_TIER_HI', 'RANK_TIER_MAX',
    'ADJ_CAP', 'ADJ_MOTIV_AWAY',
    'HCP_STEP', 'HCP_UNIT', 'HCP_CAP',
    'W_ULTRA_LOW', 'W_LOW', 'W_MID', 'W_HIGH', 'MOVE_SMALL', 'MOVE_MID', 'MOVE_BIG',
    'DEV_T1', 'DEV_T2', 'DEV_T3', 'LINK_HI', 'LINK_LO', 'LINK_MID', 'ARB_OK', 'ARB_VETO', 'ARB_BAD',
    'TIME_T4', 'TIME_T3', 'TIME_T2', 'TIME_T1', 'TIME_DEF', 'CONSENSUS_MIN', 'VETO_ABS', 'STRONG_SCORE', 'MED_SCORE'
  ];
  const defOf = function (k) { return C.PARAM_DEFS.filter(function (d) { return d.k === k; })[0]; };

  function rowsWithOutcome() {
    return C.store.rows.map(function (rec) { return { rec: rec, r: C.evaluate(rec.inp) }; })
      .filter(function (x) { return x.r.actual === '赢盘' || x.r.actual === '输盘'; });
  }

  /** 目标函数：默认 Wilson 下界（对小样本稳健），可选赢盘率 / 期望收益 / 模型置信度 */
  function objective(list, P, LIB, mode) {
    if (!list.length) return { v: -1, n: 0, w: 0, rate: 0, roi: 0, lo: 0 };
    const agg = C.groupRates(C.store.rows, P, LIB);
    let w = 0, roi = 0, confSum = 0;
    list.forEach(function (x) {
      const r = C.evaluate(x.rec.inp, P, LIB);
      const sd = C.sideOf(r, LIB);
      const down = sd.dir === 'down';
      const upWin = r.actual === '赢盘', upLose = r.actual === '输盘';
      const win = down ? upLose : upWin;                 // 按场景方向买
      if (win) w++;
      const wUp = Number(x.rec.inp.closeWater || x.rec.inp.openWater || 0.95);
      const water = down ? Math.max(0.5, Math.round((C.num(P.WATER_SUM, 2) - wUp) * 100) / 100) : wUp;
      roi += win ? (water - 1) : -1;
      confSum += C.confidence(r, agg, P).score;
    });
    const n = list.length, rate = w / n;
    const lo = C.wilson(w, n).lo;
    let v;
    if (mode === 'rate') v = rate;
    else if (mode === 'roi') v = roi / n;
    else if (mode === 'conf') v = confSum / n;
    else v = lo;   // wilson
    return { v: v, n: n, w: w, rate: rate, roi: roi / n, lo: lo, conf: confSum / n };
  }

  /** 单参数扫描：返回该参数的候选值与其得分 */
  function sweep(key, list, P, LIB, mode, steps) {
    const d = defOf(key);
    if (!d) return null;
    const base = Number(P[key]);
    const lo = d.min !== undefined ? d.min : base * 0.5;
    const hi = d.max !== undefined ? d.max : base * 1.5;
    const N = steps || 11;
    const set = {};
    const cands = [];
    if (d.int) {
      const a = Math.max(lo, Math.round(base) - 3), b = Math.min(hi, Math.round(base) + 3);
      for (let v = a; v <= b; v++) cands.push(v);
    } else {
      for (let i = 0; i <= N; i++) {
        let v = lo + (hi - lo) * i / N;
        v = Math.round(v * 1e6) / 1e6;
        cands.push(v);
      }
    }
    cands.push(base);
    const out = [];
    cands.forEach(function (v) {
      const k = String(v); if (set[k]) return; set[k] = 1;
      const P2 = Object.assign({}, P); P2[key] = v;
      const s = objective(list, P2, LIB, mode);
      out.push({ v: v, s: s });
    });
    out.sort(function (a, b) { return b.s.v - a.s.v; });
    return { key: key, name: d.n, group: d.g, base: base, baseScore: objective(list, P, LIB, mode), grid: out };
  }

  /** 坐标下降：多轮逐个参数取最优 */
  function coordinateDescent(list, P0, LIB, mode, rounds, keys) {
    let P = Object.assign({}, P0);
    const trace = [];
    let cur = objective(list, P, LIB, mode);
    trace.push({ round: 0, key: '（起始）', from: '', to: '', score: cur.v, rate: cur.rate, n: cur.n });
    for (let rd = 1; rd <= (rounds || 2); rd++) {
      let improved = false;
      for (const key of keys) {
        const sw = sweep(key, list, P, LIB, mode);
        if (!sw) continue;
        const best = sw.grid[0];
        if (best.s.v > cur.v + 1e-9) {
          trace.push({ round: rd, key: key, name: sw.name, from: P[key], to: best.v, score: best.s.v, rate: best.s.rate, n: best.s.n, lo: best.s.lo });
          P[key] = best.v; cur = best.s; improved = true;
        }
      }
      if (!improved) { trace.push({ round: rd, key: '（已收敛）', from: '', to: '', score: cur.v, rate: cur.rate, n: cur.n }); break; }
    }
    return { P: P, trace: trace, score: cur };
  }

  /** 留一交叉验证：用同一套参数，比较训练得分与留一得分 */
  function looScore(list, P, LIB, mode) {
    if (list.length < 4) return null;
    let sum = 0, cnt = 0;
    for (let i = 0; i < list.length; i++) {
      const train = list.filter(function (_, j) { return j !== i; });
      const sw = bestSingle(train, P, LIB, mode, TUNABLE.slice(0, 18));
      if (!sw) continue;
      const P2 = Object.assign({}, P); P2[sw.key] = sw.v;
      const test = objective([list[i]], P2, LIB, mode);
      sum += test.v; cnt++;
    }
    return cnt ? sum / cnt : null;
  }
  function bestSingle(list, P, LIB, mode, keys) {
    let best = null;
    keys.forEach(function (k) {
      const sw = sweep(k, list, P, LIB, mode, 9);
      if (!sw) return;
      const b = sw.grid[0];
      if (!best || b.s.v > best.s.v) best = { key: k, v: b.v, s: b.s };
    });
    return best;
  }

  /** 组合网格：两个参数交叉 */
  function grid2(keyA, keyB, list, P0, LIB, mode, nA, nB) {
    const mk = function (key, N) {
      const d = defOf(key); const base = Number(P0[key]);
      const lo = d.min !== undefined ? d.min : base * 0.5;
      const hi = d.max !== undefined ? d.max : base * 1.5;
      const arr = [];
      if (d.int) { for (let v = Math.max(lo, Math.round(base) - 2); v <= Math.min(hi, Math.round(base) + 2); v++) arr.push(v); }
      else for (let i = 0; i <= N; i++) arr.push(Math.round((lo + (hi - lo) * i / N) * 1e6) / 1e6);
      if (arr.indexOf(base) < 0) arr.push(base);
      return arr;
    };
    const A = mk(keyA, nA || 6), B = mk(keyB, nB || 6);
    const cells = [];
    let best = null;
    A.forEach(function (a) {
      B.forEach(function (b) {
        const P2 = Object.assign({}, P0); P2[keyA] = a; P2[keyB] = b;
        const s = objective(list, P2, LIB, mode);
        const cell = { a: a, b: b, s: s };
        cells.push(cell);
        if (!best || s.v > best.s.v) best = cell;
      });
    });
    return { keyA: keyA, keyB: keyB, A: A, B: B, cells: cells, best: best };
  }

  /* -------- 离线分析页 -------- */
  function panelOffline(host) {
    const list = rowsWithOutcome();
    const P = C.store.P, LIB = C.store.LIB;
    const mode = S.mode || 'wilson';

    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('离线规则引擎'),
      U.el('span', { class: 'hint', text: '不联网、零成本，用你自己的历史样本反推参数' })]));
    c.appendChild(U.el('p', { class: 'desc', text: '流程：① 单参数扫描看每个系数的敏感度和最优区间 → ② 坐标下降自动迭代调参 → ③ 留一验证确认不是过拟合 → ④ 一键应用到调参中心。' }));

    const g = U.el('div', { class: 'grid g4' });
    g.appendChild(kpi('可用于回测的样本', String(list.length) + ' 场', '仅统计已开奖（赢盘/输盘）的比赛'));
    const now = objective(list, P, LIB, mode);
    g.appendChild(kpi('当前赢盘率', list.length ? U.pct(now.rate) : '—', now.w + ' 赢 / ' + (now.n - now.w) + ' 输'));
    g.appendChild(kpi('当前 Wilson 下界', list.length ? U.pct(now.lo) : '—', '稳健目标函数'));
    g.appendChild(kpi('当前期望收益', list.length ? U.pct(now.roi) : '—', '按终盘水位估算'));
    c.appendChild(g);

    const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    row.appendChild(U.field('优化目标', U.select([
      { v: 'wilson', n: 'Wilson 95% 下界（推荐：抗小样本过拟合）' },
      { v: 'rate', n: '按场景方向买的命中率（最直观，但小样本容易虚高）' },
      { v: 'roi', n: '期望收益（考虑水位与买卖方向，最贴近真实盈亏）' },
      { v: 'conf', n: '平均模型置信度（让模型对自己更有把握）' },
    ], mode, function (v) { S.mode = v; window.App.refresh(); }, { style: { minWidth: '360px' } })));
    row.appendChild(U.field('坐标下降轮数', U.number(S.rounds || 2, function (v) { S.rounds = Number(v) || 1; }, { step: '1', min: '1', max: '6' })));
    row.appendChild(U.field('参与迭代的参数个数', U.number(S.topN || 18, function (v) { S.topN = Number(v) || 6; }, { step: '1', min: '2', max: String(TUNABLE.length) })));
    c.appendChild(row);

    if (list.length < 5) {
      c.appendChild(U.note('已开奖样本不足 5 场，自动调参没有统计意义。建议先累积到 50~100 场，再用这里的引擎。' +
        '（你也可以只做「单参数扫描」看趋势，不要在样本少时直接应用参数。）', 'warn'));
    }

    const btns = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    btns.appendChild(U.btn('① 单参数扫描', function () { runSweep(); }, 'pri'));
    btns.appendChild(U.btn('② 坐标下降自动调参', function () { runCD(); }));
    btns.appendChild(U.btn('③ 留一交叉验证', function () { runLOO(); }));
    btns.appendChild(U.btn('④ 一键应用最优参数', function () { applyAll(); }, 'ghost'));
    btns.appendChild(U.btn('清空分析日志', function () { S.log = []; S.suggestions = []; window.App.refresh(); }, 'ghost'));
    c.appendChild(btns);

    if (S.log.length) {
      const box = U.el('div', { style: { marginTop: '12px' } });
      S.log.forEach(function (blk) {
        if (blk.type === 'table') {
          box.appendChild(U.el('div', { class: 'sec-title', text: blk.title }));
          box.appendChild(U.el('div', { html: U.table(blk.cols, blk.rows, { maxH: '340px' }) }));
        } else if (blk.type === 'text') {
          box.appendChild(U.note(blk.html, blk.kind || ''));
        }
      });
      c.appendChild(box);
    }
    host.appendChild(c);

    // 组合网格
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('两参数组合网格搜索')]));
    c2.appendChild(U.el('p', { class: 'desc', text: '当两个系数互相牵制时（例如 D值权重 × 联赛系数、一票否决阈值 × 仲裁分），单参数扫描会失真，用组合网格看二维地貌。' }));
    if (S.gridA === undefined) S.gridA = 'AD_DFW';
    if (S.gridB === undefined) S.gridB = 'VETO_ABS';
    const opts = TUNABLE.map(function (k) { const d = defOf(k); return { v: k, n: (d ? d.g + ' / ' + d.n : k) }; });
    const r2 = U.el('div', { class: 'row' });
    r2.appendChild(U.field('参数 A', U.select(opts, S.gridA, function (v) { S.gridA = v; window.App.refresh(); }, { style: { minWidth: '260px' } })));
    r2.appendChild(U.field('参数 B', U.select(opts, S.gridB, function (v) { S.gridB = v; window.App.refresh(); }, { style: { minWidth: '260px' } })));
    r2.appendChild(U.btn('运行网格搜索', function () { runGrid(); }, 'pri'));
    c2.appendChild(r2);
    if (S.grid) c2.appendChild(gridView(S.grid));
    host.appendChild(c2);
  }

  function kpi(l, v, s, color) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', style: color ? { color: color } : null, text: v }));
    b.appendChild(U.el('div', { class: 'l', text: l }));
    if (s) b.appendChild(U.el('div', { class: 'sub', text: s }));
    return b;
  }

  function runSweep() {
    const list = rowsWithOutcome();
    if (!list.length) return U.toast('没有已开奖样本', 'bad');
    const mode = S.mode || 'wilson';
    const keys = TUNABLE.slice(0, S.topN || 18);
    const blocks = [];
    const sens = [];
    blocks.push({ type: 'text', html: '已扫描 <b>' + keys.length + '</b> 个参数，每个参数在允许区间内取 11 个候选值，用 ' + list.length + ' 场样本重算。目标函数：' + modeName(mode) + '。', kind: '' });
    keys.forEach(function (k) {
      const sw = sweep(k, list, C.store.P, C.store.LIB, mode);
      if (!sw) return;
      const b = sw.grid[0];
      sens.push({
        key: k, name: sw.name, group: sw.group,
        cur: sw.base, curScore: sw.baseScore.v, curRate: sw.baseScore.rate,
        best: b.v, bestScore: b.s.v, bestRate: b.s.rate, bestN: b.s.n,
        delta: b.s.v - sw.baseScore.v
      });
      const top = sw.grid.slice(0, 6);
      blocks.push({
        type: 'table',
        title: '【' + sw.group + '】' + sw.name + '（' + k + '）当前 ' + sw.base + ' → 最优 ' + b.v +
          '（提升 ' + U.fmt(b.s.v - sw.baseScore.v, 4) + '）',
        cols: [{ k: 'v', n: '候选值', w: '90px' }, { k: 't', n: '目标值', w: '90px' }, { k: 'rate', n: '赢盘率', w: '80px' }, { k: 'w', n: '赢/总', w: '80px' }, { k: 'mark', n: '', w: '60px' }],
        rows: top.map(function (x) {
          return {
            v: U.fmt(x.v, 6), t: U.fmt(x.s.v, 6), rate: x.s.n ? U.pct(x.s.rate) : '—',
            w: x.s.w + '/' + x.s.n,
            mark: Math.abs(x.v - sw.base) < 1e-9 ? '<span class="pill info">当前</span>' : (x.v === b.v ? '<span class="pill ok">最优</span>' : '')
          };
        })
      });
    });
    sens.sort(function (a, b) { return b.delta - a.delta; });
    blocks.unshift({
      type: 'table',
      title: '敏感度排序（越靠上说明这个参数越值得动）',
      cols: [
        { k: 'name', n: '参数', w: '150px' }, { k: 'group', n: '分组', w: '100px' },
        { k: 'cur', n: '当前值', w: '80px' }, { k: 'curRate', n: '当前赢盘率', w: '96px' },
        { k: 'best', n: '扫描最优', w: '90px' }, { k: 'bestRate', n: '最优赢盘率', w: '96px' },
        { k: 'delta', n: '目标提升', w: '96px' }, { k: 'use', n: '', w: '60px' }
      ],
      rows: sens.map(function (s) {
        return {
          name: U.esc(s.name) + ' <span class="mini">' + s.key + '</span>', group: s.group,
          cur: U.fmt(s.cur, 6), curRate: U.pct(s.curRate),
          best: U.fmt(s.best, 6), bestRate: U.pct(s.bestRate),
          delta: '<span style="color:' + (s.delta > 0 ? 'var(--ok)' : 'var(--txt-3)') + '">' + (s.delta > 0 ? '+' : '') + U.fmt(s.delta, 4) + '</span>',
          use: s.delta > 0 ? '<button class="sm" data-apply="' + s.key + '|' + s.best + '">应用</button>' : ''
        };
      })
    });
    S.log = blocks;
    S.suggestions = sens.filter(function (s) { return s.delta > 0; });
    window.App.refresh();
  }

  function runCD() {
    const list = rowsWithOutcome();
    if (!list.length) return U.toast('没有已开奖样本', 'bad');
    const mode = S.mode || 'wilson';
    const keys = TUNABLE.slice(0, S.topN || 18);
    const res = coordinateDescent(list, C.store.P, C.store.LIB, mode, S.rounds || 2, keys);
    const b0 = objective(list, C.store.P, C.store.LIB, mode);
    const blocks = [{
      type: 'text', kind: res.score.v > b0.v ? 'ok' : 'warn',
      html: '坐标下降完成：目标值 <b>' + U.fmt(b0.v, 4) + '</b> → <b>' + U.fmt(res.score.v, 4) + '</b>' +
        '，赢盘率 <b>' + U.pct(b0.rate) + '</b> → <b>' + U.pct(res.score.rate) + '</b>' +
        '，Wilson 下界 ' + U.pct(b0.lo) + ' → ' + U.pct(res.score.lo) + '。' +
        (res.score.n < 30 ? ' ⚠ 样本仅 ' + res.score.n + ' 场，这个“提升”很可能只是拟合噪声，请务必做留一验证。' : '')
    }, {
      type: 'table', title: '迭代轨迹',
      cols: [{ k: 'round', n: '轮次', w: '56px' }, { k: 'name', n: '参数', w: '150px' },
      { k: 'from', n: '原值', w: '90px' }, { k: 'to', n: '新值', w: '90px' },
      { k: 'score', n: '目标值', w: '90px' }, { k: 'rate', n: '赢盘率', w: '90px' }, { k: 'n', n: '样本', w: '60px' }],
      rows: res.trace.map(function (t) {
        return { round: t.round, name: U.esc(t.name || t.key), from: t.from === '' ? '' : U.fmt(t.from, 6), to: t.to === '' ? '' : U.fmt(t.to, 6), score: U.fmt(t.score, 4), rate: U.pct(t.rate), n: t.n };
      })
    }];
    // 应用按钮
    const changes = res.trace.filter(function (t) { return t.from !== '' }).map(function (t) {
      return { key: TUNABLE.filter(function (k) { return defOf(k) && defOf(k).n === t.name; })[0] || t.key, v: t.to, name: t.name };
    }).filter(function (c) { return c.key && TUNABLE.indexOf(c.key) >= 0; });
    S.cdResult = res; S.cdChanges = changes;
    if (changes.length) {
      blocks.push({
        type: 'table', title: '建议改动（点「应用」逐条改，或点上方「一键应用最优参数」全部改）',
        cols: [{ k: 'name', n: '参数', w: '160px' }, { k: 'from', n: '原值', w: '90px' }, { k: 'to', n: '建议值', w: '90px' }, { k: 'use', n: '', w: '70px' }],
        rows: changes.map(function (c) {
          return { name: U.esc(c.name), from: U.fmt(C.store.P[c.key], 6), to: U.fmt(c.v, 6), use: '<button class="sm" data-apply="' + c.key + '|' + c.v + '">应用</button>' };
        })
      });
    }
    S.log = blocks;
    window.App.refresh();
  }

  function runLOO() {
    const list = rowsWithOutcome();
    if (list.length < 4) return U.toast('留一验证至少需要 4 场已开奖样本', 'bad');
    const mode = S.mode || 'wilson';
    const ins = objective(list, C.store.P, C.store.LIB, mode);
    const out = looScore(list, C.store.P, C.store.LIB, mode);
    const opt = coordinateDescent(list, C.store.P, C.store.LIB, mode, 1, TUNABLE.slice(0, 12));
    const outOpt = looScore(list, opt.P, C.store.LIB, mode);
    const gap = outOpt === null ? null : opt.score.v - outOpt;
    S.log = [{
      type: 'text', kind: 'ok',
      html: '<b>基准</b>：样本内赢盘率 ' + U.pct(ins.rate) + '，Wilson 下界 ' + U.pct(ins.lo) + '（' + ins.n + ' 场）<br>' +
        '<b>当前参数·留一验证</b>：平均留一得分 ' + (out === null ? '—' : U.pct(out)) + '<br>' +
        '<b>调参后·样本内</b>：' + U.pct(opt.score.rate) + '（Wilson ' + U.pct(opt.score.lo) + '）<br>' +
        '<b>调参后·留一验证</b>：' + (outOpt === null ? '—' : U.pct(outOpt)) + '<br>' +
        '<b>过拟合缺口</b>：' + (gap === null ? '—' : U.fmt(gap, 4)) +
        (gap !== null && gap > 0.12 ? ' ⚠ 缺口偏大，说明样本内提升主要来自拟合噪声，<b>不要</b>直接应用。' :
          gap !== null && gap > 0.05 ? ' 缺口中等，建议只应用幅度小的改动。' : ' 缺口很小，参数改动相对可信。')
    }, {
      type: 'text', kind: 'warn',
      html: '经验法则：<b>每 1 个可调参数至少需要 20~30 场已开奖样本</b>。你现在有 ' + list.length +
        ' 场，而本页可调参数有 ' + TUNABLE.length + ' 个 —— 参数远多于样本时，任何“最优值”都是拟合噪声。' +
        '建议：先用默认参数跑满 50 场以上，再只微调敏感度最高的 2~3 个参数。'
    }];
    window.App.refresh();
  }

  function runGrid() {
    const list = rowsWithOutcome();
    if (!list.length) return U.toast('没有已开奖样本', 'bad');
    S.grid = grid2(S.gridA, S.gridB, list, C.store.P, C.store.LIB, S.mode || 'wilson', 8, 8);
    S.log = [{
      type: 'text', kind: 'ok',
      html: '组合最优：<b>' + defOf(S.gridA).n + ' = ' + U.fmt(S.grid.best.a, 6) + '</b>，<b>' +
        defOf(S.gridB).n + ' = ' + U.fmt(S.grid.best.b, 6) + '</b>，目标值 ' + U.fmt(S.grid.best.s.v, 4) +
        '（赢盘率 ' + U.pct(S.grid.best.s.rate) + '，' + S.grid.best.s.w + '/' + S.grid.best.s.n + '）'
    }];
    window.App.refresh();
  }

  function gridView(g) {
    const vals = g.cells.map(function (c) { return c.s.v; });
    const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    const color = function (v) {
      const t = mx === mn ? 0.5 : (v - mn) / (mx - mn);
      if (t > 0.75) return 'rgba(63,185,80,.38)';
      if (t > 0.5) return 'rgba(63,185,80,.20)';
      if (t > 0.3) return 'rgba(210,153,34,.16)';
      return 'rgba(248,81,73,.16)';
    };
    let html = '<div class="tw" style="margin-top:10px"><table><thead><tr><th>' + U.esc(defOf(g.keyB).n) + ' \\ ' + U.esc(defOf(g.keyA).n) + '</th>';
    g.A.forEach(function (a) { html += '<th>' + U.fmt(a, 5) + '</th>'; });
    html += '</tr></thead><tbody>';
    g.B.forEach(function (b) {
      html += '<tr><th>' + U.fmt(b, 5) + '</th>';
      g.A.forEach(function (a) {
        const cell = g.cells.filter(function (c) { return c.a === a && c.b === b; })[0];
        const isBest = g.best && g.best.a === a && g.best.b === b;
        html += '<td style="background:' + color(cell.s.v) + (isBest ? ';outline:2px solid var(--acc)' : '') + '">' +
          U.pct(cell.s.rate) + ' <span class="mini">(' + cell.s.w + '/' + cell.s.n + ')</span></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    return U.el('div', { html: html });
  }

  function applyAll() {
    const changes = S.cdChanges || (S.suggestions || []).map(function (s) { return { key: s.key, v: s.best, name: s.name }; });
    if (!changes.length) return U.toast('还没有可应用的调参结果，先跑一次 ① 或 ②', 'warn');
    U.confirmBox('将修改 ' + changes.length + ' 个参数（可在调参中心里再改回来，或点「重置全部参数」）。继续？', function () {
      changes.forEach(function (c) {
        if (!(c.key in C.store.P)) return;
        const d = defOf(c.key);
        let v = Number(c.v);
        if (d && d.int) v = Math.round(v);
        C.store.P[c.key] = v;
      });
      C.saveParams();
      C.store.history.push({ at: new Date().toISOString(), type: 'apply-params', changes: changes });
      C.saveHistory();
      U.toast('已应用 ' + changes.length + ' 个参数', 'ok');
      window.App.refresh();
    });
  }

  function modeName(m) {
    return m === 'rate' ? '按场景方向买的命中率' : m === 'roi' ? '期望收益'
      : m === 'conf' ? '平均模型置信度' : 'Wilson 95% 下界';
  }
  window.AIEngine = {
    TUNABLE: TUNABLE, modeName: modeName,
    objective: function (mode) { return objective(rowsWithOutcome(), C.store.P, C.store.LIB, mode || S.mode || 'wilson'); },
    sweep: function (key, mode) { return sweep(key, rowsWithOutcome(), C.store.P, C.store.LIB, mode || S.mode || 'wilson'); },
    coordinateDescent: function (rounds, keys, mode) {
      return coordinateDescent(rowsWithOutcome(), C.store.P, C.store.LIB, mode || S.mode || 'wilson',
        rounds || S.rounds || 2, keys || TUNABLE.slice(0, S.topN || 18));
    },
    grid2: function (a, b, mode) { return grid2(a, b, rowsWithOutcome(), C.store.P, C.store.LIB, mode || S.mode || 'wilson', 5, 5); },
    loo: function (mode) { return looScore(rowsWithOutcome(), C.store.P, C.store.LIB, mode || S.mode || 'wilson'); },
    buildPrompt: buildPrompt,
  };

  /* -------- 在线 LLM -------- */
  function buildPrompt() {
    const list = rowsWithOutcome();
    const lines = [];
    lines.push('你是一位体育博彩量化分析顾问。下面是一套“本心实力盘 vs 机构盘口”的量化模型。');
    lines.push('模型逻辑：① 用双方近 6 场进失球算攻防积分；② 用主队主客场场均得分比算主战绩系数偏差；');
    lines.push('③ 用排名差算排名分差；④ 用历史交锋/伤病/停赛/疲劳/连胜/战意算加减项；');
    lines.push('⑤ 四者相加得到「本心实力盘」；⑥ 与机构初盘比较得到深开/浅开，结合水位与盘口变动匹配八大场景；');
    lines.push('⑦ 四票（攻防/主战绩/排名/加减）方向一致性与一票否决仲裁；⑧ 偏差+联动+仲裁+时间四维评分得到综合评分。');
    lines.push('');
    lines.push('【当前参数】');
    C.PARAM_DEFS.forEach(function (d) { lines.push('- ' + d.g + ' | ' + d.n + ' (' + d.k + ') = ' + C.store.P[d.k] + '  // ' + d.why); });
    lines.push('');
    lines.push('【已开奖样本（' + list.length + ' 场）】');
    lines.push('序号|联赛|对阵|本心实力盘|初盘|终盘|初水|终水|深浅开|场景|仲裁|评分|强度|上盘方|结果');
    list.forEach(function (x) {
      const i = x.rec.inp;
      lines.push([x.rec.seq, i.league, (i.home || '') + 'vs' + (i.away || ''), x.r.corePanText, x.r.J, x.r.K,
        x.r.Lw, x.r.Mw, x.r.Q, x.r.scene, x.r.arb, x.r.total, x.r.strength, x.r.upSide, x.r.actual].join('|'));
    });
    lines.push('');
    lines.push('【分组统计（上盘赢盘率）】');
    const dims = [['场景', function (x) { return x.r.scene; }], ['深浅开', function (x) { return x.r.Q; }],
    ['水位', function (x) { return x.r.water; }], ['仲裁', function (x) { return x.r.arb; }],
    ['强度', function (x) { return x.r.strength; }], ['联赛', function (x) { return x.rec.inp.league || '未知'; }]];
    dims.forEach(function (d) {
      const map = {};
      list.forEach(function (x) { const k = String(d[1](x)); (map[k] = map[k] || []).push(x); });
      lines.push('[' + d[0] + ']');
      Object.keys(map).forEach(function (k) {
        const arr = map[k], w = arr.filter(function (x) { return x.r.actual === '赢盘'; }).length;
        lines.push('  ' + k + ': ' + w + '/' + arr.length + ' = ' + (w / arr.length * 100).toFixed(1) + '%');
      });
    });
    lines.push('');
    lines.push('【任务】');
    lines.push('1) 判断当前参数是否存在明显逻辑缺陷或互相冲突；');
    lines.push('2) 给出最多 8 个具体参数改动建议，每个都要说明理由和预期效果；');
    lines.push('3) 指出样本量不足导致哪些结论不可信；');
    lines.push('4) 严格按下面的 JSON 返回，不要输出任何其他文字：');
    lines.push('{"summary":"一句话总评","risks":["风险1","风险2"],"changes":[{"key":"参数键名","from":当前值,"to":建议值,"reason":"理由","confidence":0.7}],"nextSteps":["下一步1"]}');
    return lines.join('\n');
  }

  function panelOnline(host) {
    const st = C.store.settings;
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('AI 联网分析（可选）'),
      U.el('span', { class: 'hint', text: '自带 OpenAI 兼容 API Key' })]));
    c.appendChild(U.el('p', { class: 'desc', text: '把上面那套统计数据交给大模型，让它帮你找参数矛盾、给调参建议。这个功能完全可选：不填 Key 也能用「离线规则引擎」，网页本身离线可用。' }));

    const g = U.el('div', { class: 'grid g2' });
    g.appendChild(U.field('接口地址 Base URL', U.input(st.apiBase || '', function (v) { st.apiBase = v.trim(); C.saveSettings(); }, { placeholder: 'https://api.deepseek.com/v1 或 https://api.openai.com/v1' })));
    g.appendChild(U.field('API Key', U.input(st.apiKey || '', function (v) { st.apiKey = v.trim(); C.saveSettings(); window.App.updateFoot(); }, { type: 'password', placeholder: 'sk-...' })));
    g.appendChild(U.field('模型名', U.input(st.apiModel || '', function (v) { st.apiModel = v.trim(); C.saveSettings(); }, { placeholder: 'deepseek-chat / gpt-4o-mini / qwen-plus' })));
    g.appendChild(U.field('温度 (0-1，越低越稳)', U.number(st.apiTemp === undefined ? 0.2 : st.apiTemp, function (v) { st.apiTemp = Number(v); C.saveSettings(); }, { step: '0.1', min: '0', max: '1' })));
    c.appendChild(g);

    const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    row.appendChild(U.btn('生成分析 Prompt（复制到任意 AI 网页用）', function () {
      const p = buildPrompt();
      S.prompt = p;
      U.copy(p);
      U.toast('Prompt 已复制（' + p.length + ' 字），可直接粘到 ChatGPT/DeepSeek 网页', 'ok');
      S.log = [{ type: 'text', kind: '', html: '已生成 Prompt 并复制到剪贴板。你也可以在下面看到全文，或下载为 txt。' }];
      window.App.refresh();
    }, 'pri'));
    row.appendChild(U.btn('下载 Prompt.txt', function () {
      U.download('本心AI分析Prompt.txt', buildPrompt(), 'text/plain;charset=utf-8');
    }, 'ghost'));
    row.appendChild(U.btn('▶ 直接调用 API 获取建议', function () { callAPI(); }));
    row.appendChild(U.btn('测试连通性', function () { testAPI(); }, 'ghost'));
    c.appendChild(row);

    c.appendChild(U.note('隐私与成本：Key 只保存在你自己的浏览器里，请求直接从浏览器发往你填的接口，不经过任何第三方服务器。' +
      '费用由你的 API 账户按 token 结算（本 prompt 约 ' + Math.round(buildPrompt().length / 2) + ' tokens）。' +
      '<br><b>注意</b>：部分厂商接口未开启 CORS，浏览器直连会被拦截；若报跨域错误，请改用上面的「生成 Prompt 并复制」方式。', 'warn'));

    if (S.apiMsg) c.appendChild(U.note(S.apiMsg, S.apiMsgKind || ''));
    if (S.prompt) {
      const det = U.el('details');
      det.appendChild(U.el('summary', { text: '查看完整 Prompt 全文' }));
      det.appendChild(U.el('pre', { class: 'out', text: S.prompt }));
      c.appendChild(det);
    }
    if (S.aiResult) c.appendChild(renderAIResult(S.aiResult));
    host.appendChild(c);
  }

  function renderAIResult(res) {
    const box = U.el('div');
    box.appendChild(U.el('div', { class: 'sec-title', text: 'AI 返回结果' }));
    if (res.summary) box.appendChild(U.note('<b>总评：</b>' + U.esc(res.summary), 'ok'));
    if (res.risks && res.risks.length) {
      const ul = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.5px', color: 'var(--txt-2)' } });
      res.risks.forEach(function (r) { ul.appendChild(U.el('li', { text: r })); });
      box.appendChild(U.el('div', { class: 'sec-title', text: '风险提示' }));
      box.appendChild(ul);
    }
    if (res.changes && res.changes.length) {
      box.appendChild(U.el('div', { class: 'sec-title', text: '参数改动建议' }));
      box.appendChild(U.el('div', { html: U.table([
        { k: 'name', n: '参数', w: '170px' }, { k: 'key', n: '键名', w: '140px' },
        { k: 'from', n: '现值', w: '80px' }, { k: 'to', n: '建议值', w: '80px' },
        { k: 'conf', n: '把握', w: '70px' }, { k: 'reason', n: '理由', w: '360px' }, { k: 'use', n: '', w: '70px' }
      ], res.changes.map(function (ch) {
        const d = defOf(ch.key);
        return {
          name: d ? d.n : '<span class="pill bad">未知键名</span>', key: U.esc(ch.key),
          from: U.fmt(ch.from, 6), to: U.fmt(ch.to, 6),
          conf: ch.confidence !== undefined ? U.pct(ch.confidence, 0) : '—',
          reason: '<span class="wrapcell">' + U.esc(ch.reason || '') + '</span>',
          use: d ? '<button class="sm" data-apply="' + ch.key + '|' + ch.to + '">应用</button>' : ''
        };
      })) }));
    }
    if (res.nextSteps && res.nextSteps.length) {
      const ul = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.5px', color: 'var(--txt-2)' } });
      res.nextSteps.forEach(function (r) { ul.appendChild(U.el('li', { text: r })); });
      box.appendChild(U.el('div', { class: 'sec-title', text: '下一步' }));
      box.appendChild(ul);
    }
    return box;
  }

  function endpoint() {
    const st = C.store.settings;
    let base = (st.apiBase || '').replace(/\/+$/, '');
    if (!base) return null;
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  async function callAPI() {
    const st = C.store.settings;
    const url = endpoint();
    if (!url || !st.apiKey) {
      S.apiMsgKind = 'bad'; S.apiMsg = '请先填写 Base URL 与 API Key。'; window.App.refresh(); return;
    }
    S.apiMsgKind = ''; S.apiMsg = '正在请求 ' + url + ' …'; window.App.refresh();
    try {
      const body = {
        model: st.apiModel || 'deepseek-chat',
        temperature: st.apiTemp === undefined ? 0.2 : st.apiTemp,
        messages: [
          { role: 'system', content: '你是严谨的量化分析顾问，只输出 JSON。' },
          { role: 'user', content: buildPrompt() }
        ]
      };
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.apiKey },
        body: JSON.stringify(body)
      });
      const txt = await resp.text();
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 400));
      let json;
      try { json = JSON.parse(txt); } catch (e) { throw new Error('返回不是 JSON：' + txt.slice(0, 200)); }
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new Error('返回结构异常：' + txt.slice(0, 300));
      const parsed = extractJSON(content);
      if (!parsed) {
        S.apiMsgKind = 'warn';
        S.apiMsg = '模型返回的不是纯 JSON，已保留原文，请人工查看：';
        S.aiRaw = content;
        S.aiResult = { summary: content.slice(0, 4000) };
      } else {
        S.aiMsgOK(parsed);
        S.aiResult = parsed;
        S.apiMsgKind = 'ok';
        S.apiMsg = '已获取 AI 建议（' + ((parsed.changes || []).length) + ' 条改动建议）。逐条点「应用」或自己判断后再改。';
      }
    } catch (e) {
      S.apiMsgKind = 'bad';
      S.apiMsg = '调用失败：' + U.esc(e.message) +
        '<br>常见原因：① 接口未开启 CORS（换用「生成 Prompt 并复制」）；② Base URL 不对（应形如 https://api.deepseek.com/v1）；③ Key 无效或余额不足；④ 模型名写错。';
    }
    window.App.refresh();
  }
  async function testAPI() {
    const st = C.store.settings;
    const url = endpoint();
    if (!url || !st.apiKey) { S.apiMsgKind = 'bad'; S.apiMsg = '请先填写 Base URL 与 API Key。'; window.App.refresh(); return; }
    S.apiMsgKind = ''; S.apiMsg = '正在测试 ' + url + ' …'; window.App.refresh();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.apiKey },
        body: JSON.stringify({ model: st.apiModel || 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 })
      });
      const t = await resp.text();
      S.apiMsgKind = resp.ok ? 'ok' : 'bad';
      S.apiMsg = resp.ok ? '连通成功，接口可用于分析。' : ('HTTP ' + resp.status + '：' + U.esc(t.slice(0, 300)));
    } catch (e) {
      S.apiMsgKind = 'bad';
      S.apiMsg = '连通失败：' + U.esc(e.message) + '（很可能是接口未开启 CORS，浏览器直连被拦截）';
    }
    window.App.refresh();
  }
  function extractJSON(text) {
    if (!text) return null;
    const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch (e) { }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { } }
    return null;
  }
  S.aiMsgOK = function () { };

  /* -------- 历史 -------- */
  function panelHistory(host) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('调参 / 回测历史')]));
    const h = (C.store.history || []).slice().reverse();
    if (!h.length) { c.appendChild(U.note('还没有历史记录。每次「一键应用最优参数」或 AI 建议应用都会记一笔。', '')); }
    else {
      c.appendChild(U.el('div', { html: U.table([
        { k: 'at', n: '时间', w: '170px' }, { k: 'type', n: '类型', w: '110px' },
        { k: 'n', n: '改动数', w: '70px' }, { k: 'detail', n: '细节', w: '520px' }
      ], h.map(function (x) {
        return {
          at: new Date(x.at).toLocaleString(), type: x.type || '-',
          n: (x.changes || []).length,
          detail: '<span class="wrapcell">' + U.esc((x.changes || []).map(function (c2) { return (c2.name || c2.key) + ' → ' + c2.v; }).join('；')) + '</span>'
        };
      })) }));
    }
    c.appendChild(U.btn('清空历史', function () { C.store.history = []; C.saveHistory(); window.App.refresh(); }, 'danger'));
    host.appendChild(c);
  }

  /* -------- 事件委托：应用单个参数 -------- */
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.dataset && t.dataset.apply) {
      const parts = t.dataset.apply.split('|');
      const key = parts[0], v = Number(parts[1]);
      if (!(key in C.store.P)) return U.toast('未知参数 ' + key, 'bad');
      const d = defOf(key);
      const nv = (d && d.int) ? Math.round(v) : v;
      const old = C.store.P[key];
      C.store.P[key] = nv; C.saveParams();
      C.store.history.push({ at: new Date().toISOString(), type: 'apply-one', changes: [{ key: key, name: d ? d.n : key, v: nv }] });
      C.saveHistory();
      U.toast((d ? d.n : key) + '：' + old + ' → ' + nv, 'ok');
      window.App.refresh();
    }
  });

  /* =====================================================================
   * 调参路线图（v13 新增）—— 按「从源头到末端」的六个方向讲，大白话 + 例子
   * =================================================================== */
  const ROADMAP = [
    {
      id: 'd1', no: '方向一', tag: '源头 · 调天线', tone: 'bad',
      title: '四个基础模块的系数',
      what: '攻防积分、排名分差、主战绩系数偏差、加减分项里的<b>所有参数</b>。',
      when: '当你发现「本心盘」整体偏深或偏浅时（本页顶部会自动检测并高亮）。',
      how: '这是最源头的调整 —— 改了它，<b>后面所有盘口都会跟着变</b>，所以必须最先修、也最危险。',
      example: '你测了 20 场葡超，发现模型算出来的本心盘平均比机构盘<b>深了 0.5 球</b>' +
        '（你算主让一球，机构只开半球）。这说明你的模型<b>高估了主队</b>。<br>这时候要查：<br>' +
        '· 攻防积分的联赛系数（葡超 0.9 是不是太高了？改成 0.85 试试）<br>' +
        '· 排名权重（<code>RANK_W</code> 0.6 是不是太大了？改成 0.5 试试）<br>' +
        '· 主战绩系数的 a 和 b（<code>FORM_A</code> 0.65 / <code>FORM_B</code> 0.2，是不是把主场优势放太大了？）',
      keys: ['RANK_W', 'FORM_A', 'FORM_B', 'FORM_SMOOTH', 'AD_DFW'],
    },
    {
      id: 'd2', no: '方向二', tag: '分类 · 调频率', tone: 'warn',
      title: '场景判断的边界',
      what: '水位五档的阈值、深开/浅开的判断、升盘/降盘的判断。',
      when: '当发现「中水盘」占比太高（>30%），或者某个场景准确率特别低（≤45%）时（本页会高亮）。',
      how: '这一步决定一场比赛被分到哪个场景，是「翻译精度」问题。阈值太宽 → 什么都往中水挤；阈值太窄 → 场景太少。',
      example: '你测了 30 场，有 12 场落入「中水盘」（占比 40%）。检查后发现，其中 8 场的水位刚好卡在 0.99~1.00 之间，' +
        '被判成了中水。这时候要调水位阈值，比如把<b>中水的上界从 0.99 改成 1.02</b>，让更多场次能被归类到高水/低水组。',
      keys: ['W_ULTRA_LOW', 'W_LOW', 'W_MID', 'W_HIGH', 'MOVE_SMALL', 'MOVE_MID', 'MOVE_BIG'],
    },
    {
      id: 'd3', no: '方向三', tag: '筛选 · 调频道', tone: 'warn',
      title: '仲裁和评分',
      what: '一票否决阈值、仲裁口径（方向对称 / 旧口径）、四个评分的权重、强中弱的分界线。',
      when: '当发现「强信号」的准确率和「弱信号」差不多时，说明评分没有区分度（本页会高亮）。',
      how: '这一步决定一场比赛是「重点关注」还是「忽略」，是筛选力度问题。',
      example: '你发现「强信号」场次准确率只有 50%，和「弱信号」的 45% 差不多。这说明你的评分体系<b>没有区分能力</b>。可能要调：<br>' +
        '· 偏差评分的分档（现在 0.25 / 0.5 / 0.75 三档，可能太粗）<br>' +
        '· 各维度的权重（偏差 3 分、联动 3 分、仲裁 2 分、时间 2 分，可能权重不对）<br>' +
        '· 强中弱的分界线（7 分 / 4 分可能太高或太低）',
      keys: ['VETO_ABS', 'CONSENSUS_MIN', 'DEV_T1', 'DEV_T2', 'DEV_T3',
        'LINK_HI', 'LINK_LO', 'LINK_MID', 'ARB_OK', 'ARB_VETO', 'ARB_BAD',
        'TIME_T1', 'TIME_T2', 'TIME_T3', 'TIME_T4', 'STRONG_SCORE', 'MED_SCORE'],
    },
    {
      id: 'd4', no: '方向四', tag: '补丁 · 调音量', tone: 'warn',
      title: '中水补充逻辑',
      what: '中水四场景的判定逻辑、基本面 X2 的门槛、中水二次判定的门槛。',
      when: '当中水场次的准确率明显低于非中水场次时（本页会高亮）。',
      how: '中水本身信号最弱，这一支是「补丁」。补丁不准有两种处理：调门槛，或者干脆承认它看不出意图、全部标「不参与」。',
      example: '中水场次有 10 场，按中水判定「可关注上盘」的有 4 场，结果只有 1 场赢盘。说明中水判定逻辑不准，可能：<br>' +
        '· X2≥3 的门槛太低，应该改成 X2≥4（改「一致数量门槛」CONSENSUS_MIN）<br>' +
        '· 或者中水本身就不该参与判断，直接全部标记「不参与」' +
        '（去「调参中心 → 映射表 → 8 大场景方向指向」把中水四场景都设成「不参与」）',
      keys: ['CONSENSUS_MIN', 'VETO_ABS'],
    },
    {
      id: 'd5', no: '方向五', tag: '细分 · 换电台', tone: 'mute',
      title: '联赛差异化',
      what: '不同联赛用不同的系数、阈值、场景逻辑。',
      when: '当发现某个联赛整体表现差，另一个联赛表现好时（本页会高亮）。需要每个联赛 ≥ 8 场已开奖。',
      how: '这一步要足够数据量才能做。现在能做的只有「联赛系数」与「赛季总轮次」；水位阈值/场景逻辑的分联赛化还没做，需要告诉我。',
      example: '你的模型在葡超准确率 70%，在意甲只有 40%。说明不同联赛需要不同的参数。可能要：<br>' +
        '· 给意甲单独设联赛系数（意甲现在 0.85，改成 0.75 试试）<br>' +
        '· 或者给意甲单独设水位阈值（意甲的中水区间可能跟葡超不一样）<br>' +
        '· 甚至考虑「分联赛建模」—— 葡超用一套参数，意甲用另一套',
      jump: '映射表 → 联赛参数表',
    },
  ];
  const PRIORITY = [
    ['第一', '修复准确率 ≤ 45% 的场景', '方向明显反了，必须先修'],
    ['第二', '降低「平手或错误」占比', '分类问题，影响样本量'],
    ['第三', '调基础模块系数（方向一）', '源头问题，影响面最大'],
    ['第四', '调场景边界阈值（方向二）', '分类精度问题'],
    ['第五', '调仲裁和评分权重（方向三）', '精细调整'],
    ['第六', '分联赛差异化（方向五）', '需要足够数据量才能做'],
  ];

  /** 用当前记录库跑一遍诊断，返回每个方向的状态（给路线图高亮用） */
  function diagState() {
    const st = C.recommendStats(C.store.rows, C.store.P, C.store.LIB);
    const xs = st.rows;
    const dec = xs.filter(function (x) { return x.res; });
    const hr = function (arr) {
      const d = arr.filter(function (x) { return x.res; });
      const w = d.filter(function (x) { return x.res.win; }).length;
      return { n: arr.length, dn: d.length, w: w, rate: d.length ? w / d.length : null };
    };
    const out = { n: dec.length, hit: {}, d1: null, d2: null, d3: null, d4: null, d5: null };

    // 方向一：本心盘整体偏差
    {
      const dev = xs.filter(function (x) { return x.r.J !== null; })
        .map(function (x) { return (-x.r.corePan) - (-x.r.J); });
      const avg = dev.length ? dev.reduce(function (a, b) { return a + b; }, 0) / dev.length : 0;
      out.d1 = { avg: avg, hit: Math.abs(avg) > 0.25, n: dev.length };
    }
    // 方向二：中水占比 + 低准确率场景
    {
      const midN = xs.filter(function (x) { return x.r.isMidScene || x.r.scene === C.LABELS.scene.fm; }).length;
      const share = xs.length ? midN / xs.length : 0;
      const byScene = {};
      xs.forEach(function (x) { (byScene[x.r.scene] = byScene[x.r.scene] || []).push(x); });
      const bad = Object.keys(byScene).map(function (k) { return { k: k, g: hr(byScene[k]) }; })
        .filter(function (o) { return o.g.dn >= 5 && o.g.rate !== null && o.g.rate <= 0.45; });
      out.d2 = { share: share, midN: midN, bad: bad, hit: share > 0.3 || bad.length > 0 };
    }
    // 方向三：强/弱区分度
    {
      const s = hr(xs.filter(function (x) { return x.r.strength === '强'; }));
      const w = hr(xs.filter(function (x) { return x.r.strength === '弱'; }));
      const ok = s.dn >= 5 && w.dn >= 5;
      const gap = ok ? Math.abs((s.rate || 0) - (w.rate || 0)) : null;
      out.d3 = { strong: s, weak: w, gap: gap, hit: ok && gap < 0.1, ready: ok };
    }
    // 方向四：中水 vs 非中水
    {
      const mid = hr(xs.filter(function (x) { return x.rc.caseKey === 'B2' || x.rc.caseKey === 'B3'; }));
      const non = hr(xs.filter(function (x) { return x.rc.caseKey === 'A' || x.rc.caseKey === 'B1'; }));
      const ok = mid.dn >= 5 && non.dn >= 5;
      const gap = ok ? ((non.rate || 0) - (mid.rate || 0)) : null;
      out.d4 = { mid: mid, non: non, gap: gap, hit: ok && gap > 0.15, ready: ok };
    }
    // 方向五：联赛差异
    {
      const byLg = {};
      xs.forEach(function (x) { (byLg[x.rec.inp.league || '未知'] = byLg[x.rec.inp.league || '未知'] || []).push(x); });
      const list = Object.keys(byLg).map(function (k) { return { k: k, g: hr(byLg[k]) }; })
        .filter(function (o) { return o.g.dn >= 8; }).sort(function (a, b) { return (b.g.rate || 0) - (a.g.rate || 0); });
      const spread = list.length >= 2 ? (list[0].g.rate || 0) - (list[list.length - 1].g.rate || 0) : null;
      out.d5 = { list: list, spread: spread, hit: spread !== null && spread > 0.25, ready: list.length >= 2 };
    }
    out.hit = out;
    return out;
  }

  function panelRoad(host) {
    const dg = diagState();
    const nDec = dg.n;

    /* 顶部：够不够格开始调参 */
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('调参路线图 · 从源头到末端'),
      U.el('span', { class: 'hint', text: '对应「13版文字叙述」的六个方向，命中条件自动高亮' })]));
    const enough = nDec >= 50, mid = nDec >= 20;
    c0.appendChild(U.note(
      (enough ? '✅ <b>样本足够了（' + nDec + ' 场已开奖）—— 六个方向都可以动。</b>'
        : mid ? '🟡 <b>样本一般（' + nDec + ' 场已开奖）—— 现在只能动方向二、方向三。</b>源头系数（方向一）先别动，20~50 场改了容易过拟合。'
          : '🔴 <b>样本还不够（' + nDec + ' 场已开奖）—— 先攒样本，别调参。</b>少于 20 场时任何顺序都在拟合噪声。')
      + '<br>下面每一块都标了「命中条件」，满足就会亮起来。', enough ? 'ok' : mid ? 'warn' : 'bad'));
    c0.appendChild(U.el('div', {
      html: U.table([
        { k: 'p', n: '优先级', w: '70px' }, { k: 'w', n: '调什么', w: '270px' }, { k: 'when', n: '什么时候调', w: '430px' }
      ], PRIORITY.map(function (t) { return { p: t[0], w: t[1], when: t[2] }; }))
    }));
    c0.appendChild(U.el('ul', {
      style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '2', marginTop: '8px' },
      html: '<li>方向一 = <b>调天线</b>（源头信号）　方向二 = <b>调频率</b>（翻译精度）　方向三 = <b>调频道</b>（分类边界）</li>' +
        '<li>方向四 = <b>调音量</b>（筛选力度）　方向五 = <b>换电台</b>（分联赛）</li>' +
        '<li><b>先调天线，再调频率，最后才调音量。顺序不能乱。</b></li>'
    }));
    host.appendChild(c0);

    /* 五个方向 */
    ROADMAP.forEach(function (d) {
      const hit = d.id === 'd1' ? dg.d1.hit
        : d.id === 'd2' ? dg.d2.hit
          : d.id === 'd3' ? dg.d3.hit
            : d.id === 'd4' ? dg.d4.hit
              : d.id === 'd5' ? dg.d5.hit : false;
      const ready = d.id === 'd3' ? dg.d3.ready : d.id === 'd4' ? dg.d4.ready : d.id === 'd5' ? dg.d5.ready : true;
      const tone = hit ? (d.tone === 'mute' ? 'var(--warn)' : (d.tone === 'bad' ? 'var(--bad)' : 'var(--warn)')) : 'var(--line-2)';
      const c = U.el('div', {
        style: {
          border: hit ? ('2px solid ' + tone) : '1px solid var(--line)',
          borderLeft: '5px solid ' + (hit ? tone : 'var(--line-2)'),
          borderRadius: '10px', padding: '11px 14px', marginBottom: '10px',
          background: hit ? 'rgba(255,190,90,.06)' : 'var(--bg)'
        }
      });
      const h = U.el('div', { class: 'flexline', style: { gap: '9px', flexWrap: 'wrap' } });
      h.appendChild(U.el('span', {
        style: { fontSize: '11.5px', fontWeight: '700', color: 'var(--acc)', border: '1px solid var(--acc)', borderRadius: '4px', padding: '0 6px' },
        text: d.no
      }));
      h.appendChild(U.el('span', { class: 'mini', style: { color: 'var(--txt-3)' }, text: d.tag }));
      h.appendChild(U.el('span', { style: { fontSize: '14px', fontWeight: '700' }, text: d.title }));
      if (hit) h.appendChild(U.el('span', { style: { fontSize: '12px', color: tone, fontWeight: '700' }, text: '★ 命中条件，建议处理' }));
      if (!ready) h.appendChild(U.el('span', { class: 'mini', style: { color: 'var(--txt-3)' }, text: '（样本还不够，先攒）' }));
      c.appendChild(h);

      // 当前状态
      let status = '';
      if (d.id === 'd1') {
        status = '本心盘平均偏差 <b>' + (dg.d1.avg >= 0 ? '+' : '') + dg.d1.avg.toFixed(3) + ' 球</b>' +
          '（' + dg.d1.n + ' 场）→ ' + (dg.d1.avg > 0.25 ? '模型偏深（高估主队）' : dg.d1.avg < -0.25 ? '模型偏浅（低估主队）' : '基本贴合机构盘');
      } else if (d.id === 'd2') {
        status = '中水占比 <b>' + C.pct(dg.d2.share) + '</b>（' + dg.d2.midN + ' 场）' +
          (dg.d2.bad.length ? '；准确率 ≤45% 的场景：<b>' + dg.d2.bad.map(function (o) { return o.k + ' ' + C.pct(o.g.rate); }).join('、') + '</b>' : '；没有准确率明显偏低的场景');
      } else if (d.id === 'd3') {
        status = '强信号 ' + (dg.d3.strong.rate === null ? '—' : C.pct(dg.d3.strong.rate) + '（' + dg.d3.strong.dn + '）') +
          '　弱信号 ' + (dg.d3.weak.rate === null ? '—' : C.pct(dg.d3.weak.rate) + '（' + dg.d3.weak.dn + '）') +
          (dg.d3.gap === null ? '（样本不足）' : '　差距 ' + C.pct(dg.d3.gap));
      } else if (d.id === 'd4') {
        status = '中水 ' + (dg.d4.mid.rate === null ? '—' : C.pct(dg.d4.mid.rate) + '（' + dg.d4.mid.dn + '）') +
          '　非中水 ' + (dg.d4.non.rate === null ? '—' : C.pct(dg.d4.non.rate) + '（' + dg.d4.non.dn + '）') +
          (dg.d4.gap === null ? '（样本不足）' : '　差 ' + C.pct(dg.d4.gap));
      } else if (d.id === 'd5') {
        status = dg.d5.list.length
          ? dg.d5.list.map(function (o) { return o.k + ' ' + C.pct(o.g.rate) + '（' + o.g.dn + '）'; }).join('　') +
            (dg.d5.spread === null ? '' : '　最大差 ' + C.pct(dg.d5.spread))
          : '还没有联赛各满 8 场';
      }
      const box = U.el('div', { style: { marginTop: '7px' } });
      box.appendChild(U.el('div', { style: { fontSize: '12.4px', color: 'var(--txt-2)' }, html: '<b>当前状态：</b>' + status }));
      box.appendChild(U.el('div', { style: { fontSize: '12.4px', marginTop: '5px' }, html: '<b>调什么：</b>' + d.what }));
      box.appendChild(U.el('div', { style: { fontSize: '12.4px', marginTop: '3px' }, html: '<b>什么时候调：</b>' + d.when }));
      box.appendChild(U.el('div', { style: { fontSize: '12.4px', marginTop: '3px' }, html: '<b>为什么：</b>' + d.how }));
      const det = U.el('details', { style: { marginTop: '6px' }, open: hit });
      det.appendChild(U.el('summary', { text: '展开：举个例子（大白话）' }));
      det.appendChild(U.el('div', { style: { fontSize: '12.5px', color: 'var(--txt-2)', lineHeight: '1.9', padding: '6px 0' }, html: d.example }));
      box.appendChild(det);
      if (d.keys && d.keys.length) {
        const rr = U.el('div', { class: 'chips', style: { marginTop: '7px' } });
        d.keys.forEach(function (k) {
          const def = C.PARAM_DEFS.filter(function (x) { return x.k === k; })[0];
          const chip = U.el('span', { class: 'chip', text: (def ? def.n : k) + '（' + k + '=' + U.fmt(C.store.P[k], 4) + '）' });
          chip.addEventListener('click', function () {
            if (window.Params) window.Params.setTab('参数项');
            U.toast('去「调参中心 → 参数项」搜「' + k + '」', 'ok');
            window.App.go('params');
          });
          rr.appendChild(chip);
        });
        box.appendChild(rr);
      }
      if (d.jump) {
        const rr2 = U.el('div', { class: 'row', style: { marginTop: '6px' } });
        rr2.appendChild(U.btn('→ 去「' + d.jump + '」', function () {
          if (window.Params) window.Params.setTab('映射表');
          window.App.go('params');
        }, 'sm'));
        box.appendChild(rr2);
      }
      c.appendChild(box);
      host.appendChild(c);
    });

    /* 底部：跑一遍自动扫描 */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('自动扫描（属于方向一到方向三）')]));
    c2.appendChild(U.el('p', {
      class: 'desc', html: '上面讲的是<b>往哪调</b>，这里解决<b>调多少</b>：' +
        '点下面的按钮，程序会把参数逐个在允许区间里试一遍，用你的样本重算，告诉你哪个参数最值得动。'
    }));
    c2.appendChild(U.btn('▶ 打开离线规则引擎（单参数扫描 / 坐标下降 / 网格 / 留一验证）', function () {
      S.tab = 'offline'; window.App.refresh();
    }, 'pri'));
    c2.appendChild(U.note('扫描结果只当参考：样本 < 20 场时任何「最优值」都极可能是过拟合。', 'warn'));
    host.appendChild(c2);
  }

  window.App.register({
    id: 'ai', title: 'AI 回测迭代', icon: '✧', group: '回测迭代',
    desc: '按「从源头到末端」的六个方向调参：路线图（大白话 + 例子 + 自动诊断高亮）+ 离线规则引擎 + 可选联网 AI 分析。',
    render: function (host) {
      const chips = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
      [['road', '调参路线图（先看这个）'], ['offline', '离线规则引擎'],
      ['online', 'AI 联网分析'], ['hist', '调参历史']].forEach(function (t) {
        const c = U.el('span', { class: 'chip' + (S.tab === t[0] ? ' on' : ''), text: t[1] });
        c.addEventListener('click', function () { S.tab = t[0]; window.App.refresh(); });
        chips.appendChild(c);
      });
      host.appendChild(chips);
      if (S.tab === 'road') panelRoad(host);
      else if (S.tab === 'offline') panelOffline(host);
      else if (S.tab === 'online') panelOnline(host);
      else panelHistory(host);
    }
  });

  window.AIRoad = { ROADMAP: ROADMAP, PRIORITY: PRIORITY, diagState: diagState, setTab: function (t) { S.tab = t; } };
})();
