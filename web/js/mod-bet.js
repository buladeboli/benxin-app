/* =========================================================================
 * mod-bet.js — 投注建议模块（v13）
 *   勾选若干场比赛 → 选 1 种「推荐逻辑」→ 给出最合理的 2 场组合
 *
 *   v13 按你的文字要求，把原来的 9 条逻辑收敛成【2 种大情况】：
 *     ① 机构意图优先 —— 出现 8 大场景（场景名直接给方向，按该场景历史准确率排）
 *     ② 基本面补位   —— 没出现 8 大场景（盘口不变的高/低/中水 + 中水四场景）
 *                       方向一律由基本面 X2 决定（中水盘不变走反向规则）
 *   其余排序/组合分散/落选原因等展示逻辑保留。
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;

  /* ---------------- 推荐逻辑：只有 2 项 ---------------- */
  const LOGICS = [
    {
      v: 'intent', n: '① 机构意图优先（出现 8 大场景）',
      desc: '只看<b>场景 1~8</b>的场次 —— 这几个场景的名字本身就是结论（「阻上 / 强支 / 补防 / 诱下」跟上盘，' +
        '「诱上 / 看衰」反买下盘），代表机构意图已经露出来了。' +
        '<br>排序依据是<b>该场景历史按方向买的准确率</b>（Wilson 下界，小样本会往 50% 收缩），所以样本越多越准。' +
        '<br>不属于 8 大场景的场次会被排除，交给第②条逻辑处理。',
      needWeight: false,
    },
    {
      v: 'fundamental', n: '② 基本面补位（没出现 8 大场景）',
      desc: '处理三类「看不出机构意图」的场次，方向全部由<b>基本面 X2</b> 决定：' +
        '<br>· <b>盘口不变·高水 / 低水</b>：X2 支持谁就买谁（上盘是主队时 X2≥3 买上盘、X2≤1 买下盘、X2=2 有平局买下盘）' +
        '<br>· <b>盘口不变·中水</b>：<b>反向</b> —— 基本面偏向热门（主队让球时 X2≥2）说明热门打不出来，买下盘；X2≤1 才跟上盘' +
        '<br>· <b>中水四场景</b>（中水·深升/深降/浅升/浅降）：中水光看名字定不了方向，用 X2 补位' +
        '（原来的「中水二次判定」不改，仍然作为参考证据列出来，一致就加权重、相反就提示减仓）' +
        '<br>X2 = 一致数量 = 攻防/主战绩/排名/加减 四票里「正」的个数（<b>主队视角</b>，0~4）。',
      needWeight: false,
    },
  ];

  const S = {
    sel: {},           // seq -> true
    logic: 'intent',
    onlyOpen: false,   // 只显示未开奖
    result: null,
    msg: '', msgKind: '',
  };

  /* ---------------- 打分 ---------------- */
  function scoreOne(x, logic, W, agg) {
    const r = x.r, inp = x.rec.inp;
    const d = C.decide(r, agg);
    const rc = C.recommend(r, agg);          // v13 统一推荐引擎
    const ss = C.sceneSide(r.scene, C.store.LIB);
    const sd = {
      scene: ss, dir: rc.dir, side: rc.side, team: rc.team, upSide: r.upSide,
      text: rc.line, why: rc.reasons.join('；'), cond: null,
    };
    // —— 按「该方向」取历史赢盘率 ——
    const gs = (agg.scene || {})[r.scene];
    const useScene = gs && gs.dn >= 2;
    const g = useScene ? gs : (agg.overall || {});
    const upRate = (g && g.rate !== null && g.rate !== undefined) ? g.rate : 0.5;
    const upLo = (g && g.lo !== undefined) ? g.lo : 0.4;
    const rate = rc.dir === 'down' ? (1 - upRate) : upRate;
    const lo = rc.dir === 'down' ? (1 - upLo) : upLo;
    const gSide = ((agg.side || {}).byScene || {})[ss.key];
    const sideUse = gSide && gSide.dn >= 2;
    const effRate = sideUse ? gSide.rate : rate;
    const effLo = sideUse ? gSide.lo : lo;
    // 水位：买上盘用记录的水位；买下盘用 WATER_SUM − 水位 估算
    const wUp = C.num(inp.closeWater !== undefined && inp.closeWater !== '' ? inp.closeWater : inp.openWater, 0.95);
    const water = rc.dir === 'down' ? Math.max(0.5, Math.round((C.num(C.store.P.WATER_SUM, 2) - wUp) * 100) / 100) : wUp;
    const ev = effRate * (water - 1) - (1 - effRate);
    const conf = C.confidence(r, agg, C.store.P);
    let raw = 0, eligible = true, why = [];

    switch (logic) {
      case 'intent':
        if (rc.caseKey !== 'A') {
          eligible = false;
          why.push('不是 8 大场景（本场属于「' + rc.caseKey + '：' + rc.caseName + '」，归第②条逻辑）');
        }
        raw = rc.score;
        break;
      case 'fundamental':
        if (rc.caseKey === 'A') { eligible = false; why.push('是 8 大场景，归第①条「机构意图优先」'); }
        if (rc.caseKey === 'none') { eligible = false; why.push('平手或错误 —— 机构没给意图，基本面也没形成倾向'); }
        // 基本面与二次判定相反时降权
        if (rc.alDir && rc.alDir !== rc.dir) raw = rc.score - 25;
        else raw = rc.score;
        break;
    }
    return {
      x: x, r: r, inp: inp, d: d, sd: sd, conf: conf, rc: rc,
      raw: raw, eligible: eligible, why: why,
      rate: effRate, lo: effLo, water: water, ev: ev,
      upRate: upRate, sideUse: sideUse, usedScene: useScene,
      sceneN: gs ? gs.dn : 0, sideN: gSide ? gSide.dn : 0,
    };
  }

  /** 归一化到 0~100，便于不同逻辑下的组合加分在同一尺度上比较 */
  function normalize(list) {
    const vals = list.map(function (s) { return s.raw; });
    if (!vals.length) return;
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    list.forEach(function (s) { s.norm = (mx === mn) ? 50 : (s.raw - mn) / (mx - mn) * 100; });
  }

  /** 两两组合，算分散加分（方向也参与分散：一上一下比两注同向更安全） */
  function pairsOf(list, logic) {
    const ok = list.filter(function (s) { return s.eligible; });
    const out = [];
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) {
        const a = ok[i], b = ok[j];
        let bonus = 0; const notes = [];
        const la = a.inp.league || '', lb = b.inp.league || '';
        if (la && lb && la !== lb) { bonus += 5; notes.push('不同联赛 +5'); }
        else if (la && lb) { bonus -= 6; notes.push('同联赛 −6'); }
        if (a.sd.scene.key !== b.sd.scene.key) { bonus += 4; notes.push('不同场景 +4'); }
        else { bonus -= 4; notes.push('同场景 −4'); }
        // 方向分散：一注买上盘、一注买下盘，风险来源更独立
        if (a.sd.dir !== b.sd.dir) { bonus += 3; notes.push('方向一上一下 +3'); }
        else { notes.push('同向（都买' + a.sd.side + '）'); }
        if (a.d.level === 'strong' && b.d.level === 'strong') { bonus += 4; notes.push('两场都是重点关注 +4'); }
        if (a.r.total >= C.num(C.store.P.STRONG_SCORE, 7) && b.r.total >= C.num(C.store.P.STRONG_SCORE, 7)) {
          bonus += 3; notes.push('两场综合评分都 ≥' + C.num(C.store.P.STRONG_SCORE, 7) + ' +3');
        }
        if (C.arbIsOk(a.r) && C.arbIsOk(b.r)) { bonus += 2; notes.push('两场仲裁都看好机构让球方 +2'); }
        const mult = (logic === 'diverse') ? 3 : 1;
        out.push({
          a: a, b: b, bonus: bonus, notes: notes,
          total: a.norm + b.norm + bonus * mult,
        });
      }
    }
    out.sort(function (p, q) { return q.total - p.total; });
    return out;
  }

  function run() {
    const recs = C.store.rows;
    const agg = C.groupRates(recs, C.store.P, C.store.LIB);
    const picked = recs.filter(function (rec) { return S.sel[rec.seq]; });
    if (picked.length < 2) {
      S.result = null;
      S.msgKind = 'warn';
      S.msg = '至少要勾选 <b>2 场</b>比赛才能组合。现在勾了 ' + picked.length + ' 场。';
      window.App.refresh(); return;
    }
    const scored = picked.map(function (rec) {
      return scoreOne({ rec: rec, r: C.evaluate(rec.inp, C.store.P, C.store.LIB) }, S.logic, S.W, agg);
    });
    normalize(scored);
    scored.sort(function (a, b) { return b.raw - a.raw; });
    const pairs = pairsOf(scored, S.logic);
    const logic = LOGICS.filter(function (l) { return l.v === S.logic; })[0] || LOGICS[0];
    if (logic.v !== S.logic) S.logic = logic.v;
    S.result = {
      logic: logic, agg: agg, scored: scored, pairs: pairs,
      best: pairs[0] || null,
      at: new Date().toLocaleString(),
    };
    if (!pairs.length) {
      S.msgKind = 'warn';
      S.msg = '按「' + logic.n + '」这条逻辑，勾选的 ' + picked.length + ' 场里<b>没有 2 场同时合格</b>。' +
        '可以换一条逻辑，或放宽勾选（看看下面「落选原因」）。';
    } else {
      S.msgKind = 'ok';
      S.msg = '按「' + logic.n + '」在 ' + picked.length + ' 场里枚举了 ' + pairs.length + ' 个组合，下面是最优的一个。';
    }
    window.App.refresh();
  }

  /* ---------------- 渲染 ---------------- */
  function page(host) {
    const recs = C.store.rows;
    const shown = recs.filter(function (rec) {
      if (!S.onlyOpen) return true;
      const r = C.evaluate(rec.inp, C.store.P, C.store.LIB);
      return !r.actual;
    });
    const agg = C.groupRates(recs, C.store.P, C.store.LIB);

    /* —— 选择区 —— */
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('第一步 · 勾选要参与组合的比赛'),
      U.el('span', { class: 'hint', text: '共 ' + recs.length + ' 场，当前显示 ' + shown.length + ' 场，已勾 ' + Object.keys(S.sel).filter(function (k) { return S.sel[k]; }).length + ' 场' })]));
    c.appendChild(U.el('p', { class: 'desc', text: '勾选 2 场以上，下面会枚举所有两两组合，按你选的逻辑给出最合理的那一个。可以只选未开奖的场次。' }));

    const row = U.el('div', { class: 'row' });
    row.appendChild(U.btn('全选（当前显示）', function () {
      shown.forEach(function (rec) { S.sel[rec.seq] = true; });
      window.App.refresh();
    }, 'pri'));
    row.appendChild(U.btn('清空勾选', function () { S.sel = {}; S.result = null; window.App.refresh(); }, 'ghost'));
    row.appendChild(U.btn('只选「重点关注」', function () {
      S.sel = {};
      shown.forEach(function (rec) {
        const d = C.decide(C.evaluate(rec.inp, C.store.P, C.store.LIB), agg);
        if (d.level === 'strong') S.sel[rec.seq] = true;
      });
      S.onlyOpen = true;
      U.toast('已勾选 ' + Object.keys(S.sel).filter(function (k) { return S.sel[k]; }).length + ' 场', 'ok');
      window.App.refresh();
    }));
    row.appendChild(U.btn('只选「三方一致」', function () {
      S.sel = {};
      shown.forEach(function (rec) {
        const r = C.evaluate(rec.inp, C.store.P, C.store.LIB);
        if (C.arbIsOk(r)) S.sel[rec.seq] = true;
      });
      U.toast('已勾选 ' + Object.keys(S.sel).filter(function (k) { return S.sel[k]; }).length + ' 场', 'ok');
      window.App.refresh();
    }));
    const chip = U.el('span', { class: 'chip' + (S.onlyOpen ? ' on' : ''), text: S.onlyOpen ? '只显示未开奖' : '显示全部' });
    chip.addEventListener('click', function () { S.onlyOpen = !S.onlyOpen; window.App.refresh(); });
    row.appendChild(chip);
    c.appendChild(row);

    /* 表格：带勾选框 */
    const cols = [
      { k: 'ck', n: '选', w: '40px', raw: 1 },
      { k: 'seq', n: '#', w: '40px' },
      { k: 'league', n: '联赛', w: '54px' },
      { k: 'round', n: '轮次', w: '46px', num: 1 },
      { k: 'match', n: '对阵', w: '168px' },
      { k: 'core', n: '本心实力盘', w: '108px' },
      { k: 'side', n: '场景指向 → 买哪边', w: '190px' },
      { k: 'arb', n: '冲突仲裁结论', w: '160px' },
      { k: 'total', n: '综合评分', w: '64px', num: 1 },
      { k: 'str', n: '信号强度', w: '62px' },
      { k: 'dec', n: '决策树结论', w: '130px' },
      { k: 'rate', n: '该方向历史命中率', w: '124px' },
      { k: 'ev', n: '期望 EV', w: '80px' },
      { k: 'st', n: '状态', w: '66px' },
    ];
    const rows = shown.map(function (rec) {
      const r = C.evaluate(rec.inp, C.store.P, C.store.LIB);
      const d = C.decide(r, agg);
      const sd = C.sideOf(r, C.store.LIB);
      const gSide = ((agg.side || {}).byScene || {})[sd.scene.key];
      const gs = agg.scene[r.scene];
      const useSide = gSide && gSide.dn >= 2;
      const g = useSide ? gSide : ((gs && gs.dn >= 2) ? gs : agg.overall);
      let rate = (g && g.rate !== null && g.rate !== undefined) ? g.rate : null;
      if (!useSide && sd.dir === 'down' && rate !== null) rate = 1 - rate;   // 下盘 = 1 − 上盘
      const wUp = C.num(rec.inp.closeWater !== '' && rec.inp.closeWater !== undefined ? rec.inp.closeWater : rec.inp.openWater, 0.95);
      const w = sd.dir === 'down' ? Math.max(0.5, Math.round((C.num(C.store.P.WATER_SUM, 2) - wUp) * 100) / 100) : wUp;
      const ev = rate === null ? null : rate * (w - 1) - (1 - rate);
      const sideTxt = sd.dir === 'none'
        ? '无指向'
        : sd.side + ' · ' + sd.team;
      return {
        ck: '<input type="checkbox" data-bet="' + rec.seq + '"' + (S.sel[rec.seq] ? ' checked' : '') + '>',
        seq: rec.seq,
        league: rec.inp.league || '',
        round: rec.inp.round === undefined || rec.inp.round === '' ? '' : rec.inp.round,
        match: (rec.inp.home || '?') + ' vs ' + (rec.inp.away || '?'),
        core: r.corePanText,
        side: sd.dir === 'none' ? '<span class="mini">无指向（' + r.scene + '）</span>' : ('<b>' + sideTxt + '</b><br><span class="mini">' + C.sceneKeyOf(r.scene) + ' ' + sd.scene.label + '</span>'),
        arb: r.arb,
        total: U.fmt(r.total, 2),
        str: r.strength,
        dec: d.label,
        rate: rate === null ? '—' : U.pct(rate) + '（' + (g.dn || 0) + '）',
        ev: ev === null ? '—' : (ev >= 0 ? '+' : '') + U.pct(ev),
        st: r.actual ? '已开奖 上盘' + r.actual : '未开奖',
      };
    });
    c.appendChild(U.el('div', { html: U.table(cols, rows), style: { maxHeight: '46vh', overflow: 'auto' } }));
    host.appendChild(c);

    /* —— 逻辑选择 —— */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('第二步 · 选推荐逻辑')]));
    const sel = U.select(LOGICS.map(function (l) { return { v: l.v, n: l.n }; }), S.logic, function (v) {
      S.logic = v; S.result = null; window.App.refresh();
    }, { style: { minWidth: '520px', maxWidth: '100%' } });
    c2.appendChild(U.field('推荐逻辑', sel));
    const cur = LOGICS.filter(function (l) { return l.v === S.logic; })[0];
    c2.appendChild(U.note('<b>' + U.esc(cur.n) + '</b><br>' + cur.desc, ''));

    const r2 = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    r2.appendChild(U.btn('▶ 生成 2 场推荐组合', function () { run(); }, 'pri'));
    r2.appendChild(U.btn('两条逻辑都跑一遍看覆盖率', function () {
      const out = [];
      LOGICS.forEach(function (L) {
        const keep = S.logic;
        S.logic = L.v; run();
        const RR = S.result;
        out.push(L.n + '：合格 ' + (RR ? RR.scored.filter(function (s) { return s.eligible; }).length : 0) +
          ' 场' + (RR && RR.pairs.length ? '，最佳组合 ' + RR.best.a.x.rec.seq + ' + ' + RR.best.b.x.rec.seq : ''));
        S.logic = keep;
      });
      S.logic = 'intent';
      S.msgKind = 'ok';
      S.msg = out.map(U.esc).join('<br>');
      window.App.refresh();
    }, 'ghost'));
    c2.appendChild(r2);
    if (S.msg) c2.appendChild(U.note(S.msg, S.msgKind));
    host.appendChild(c2);

    /* —— 结果 —— */
    if (S.result) host.appendChild(renderResult(S.result));
  }

  function renderResult(R) {
    const box = U.el('div');
    const logic = R.logic;

    if (!R.best) {
      const c = U.el('div', { class: 'card' });
      c.appendChild(U.el('h2', {}, [document.createTextNode('第三步 · 推荐组合')]));
      c.appendChild(U.note('按这条逻辑没有任何 2 场组合合格。下面是每场为什么落选：', 'warn'));
      const rows0 = R.scored.map(function (s) {
        return {
          seq: s.x.rec.seq, match: (s.inp.home || '?') + ' vs ' + (s.inp.away || '?'),
          dec: s.d.label, why: s.eligible ? '合格，但没有另一个合格场次可配对' : s.why.join('；'),
        };
      });
      const t0 = U.table([
        { k: 'seq', n: '#', w: '40px' }, { k: 'match', n: '对阵', w: '180px' },
        { k: 'dec', n: '决策树结论', w: '130px' }, { k: 'why', n: '落选原因', w: '420px' }
      ], rows0);
      c.appendChild(U.el('div', { html: t0 }));
      box.appendChild(c);
      return box;
    }

    /* 主推荐 */
    const c = U.el('div', { class: 'card' });
    const h = U.el('h2');
    h.appendChild(document.createTextNode('第三步 · 最合理推荐组合（2 场）'));
    h.appendChild(U.el('span', { class: 'hint', text: logic.n + ' · 生成于 ' + R.at }));
    c.appendChild(h);

    const pairBox = U.el('div', { class: 'grid g2' });
    pairBox.appendChild(pickCard(R.best.a, 'A', R));
    pairBox.appendChild(pickCard(R.best.b, 'B', R));
    c.appendChild(pairBox);

    /* 组合说明 */
    c.appendChild(U.el('div', { class: 'sec-title', text: '为什么是这两场' }));
    const why = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '1.95' } });
    why.appendChild(U.el('li', { html: '归一化得分：A <b>' + U.fmt(R.best.a.norm, 1) + '</b> ＋ B <b>' + U.fmt(R.best.b.norm, 1) +
      '</b> ＋ 组合加分 <b>' + (R.best.bonus >= 0 ? '+' : '') + U.fmt(R.best.bonus, 1) + '</b> = <b>' + U.fmt(R.best.total, 1) + '</b>' +
      '（共枚举 ' + R.pairs.length + ' 个组合）' }));
    if (R.best.notes.length) why.appendChild(U.el('li', { html: '组合加分项：' + R.best.notes.map(U.esc).join('；') }));
    why.appendChild(U.el('li', { html: '<b>出手明细</b>：A 买 <b>' + U.esc(R.best.a.sd.team) + '（' + U.esc(R.best.a.sd.side) + '）</b>' +
      '（' + U.esc(R.best.a.sd.scene.key) + ' ' + U.esc(R.best.a.sd.label) + '，上盘是' + U.esc(R.best.a.r.upSide) + '）；' +
      'B 买 <b>' + U.esc(R.best.b.sd.team) + '（' + U.esc(R.best.b.sd.side) + '）</b>' +
      '（' + U.esc(R.best.b.sd.scene.key) + ' ' + U.esc(R.best.b.sd.label) + '，上盘是' + U.esc(R.best.b.r.upSide) + '）。' }));
    why.appendChild(U.el('li', { html: '决策树结论分别是「' + U.esc(R.best.a.d.label) + '」与「' + U.esc(R.best.b.d.label) + '」。' }));
    why.appendChild(U.el('li', { html: '按加权下注（两场各投一半）：合计期望 ' +
      U.pct((R.best.a.ev + R.best.b.ev) / 2) + '（假设两注金额相同、按各自水位结算）。' }));
    if (R.scored.some(function (s) { return !s.eligible; })) {
      why.appendChild(U.el('li', { html: '已排除 ' + R.scored.filter(function (s) { return !s.eligible; }).length + ' 场不合格的（强背离 / 中性盘 / 场景无指向 / 未达门槛），见下面「落选原因」。' }));
    }
    c.appendChild(why);
    c.appendChild(U.note('⚠ 这只是模型口径下的「最合理」，不是保证赢。它做的是<b>在可选的场次里，按你选的逻辑挑出证据最完整的 2 场</b>。' +
      '下注前仍请自己确认盘口、伤停等临场信息。样本不足时（同场景 < 5 场）统计类逻辑仅供参考。', 'warn'));

    const br = U.el('div', { class: 'row' });
    br.appendChild(U.btn('复制这份推荐', function () {
      const L = [];
      L.push('【本心盘口 · 2 场推荐组合】逻辑：' + logic.n + '　生成于 ' + R.at);
      [['A', R.best.a], ['B', R.best.b]].forEach(function (t) {
        const s = t[1];
        L.push(t[0] + '　#' + s.x.rec.seq + '　' + (s.inp.league || '') + ' 第' + (s.inp.round === undefined ? '' : s.inp.round) + '轮　' +
          (s.inp.home || '?') + ' vs ' + (s.inp.away || '?'));
        L.push('    ★ 买 ' + s.sd.team + '（' + s.sd.side + '）　—— ' + s.sd.scene.key + ' ' + s.sd.scene.label + '：' + s.sd.scene.word);
        L.push('    上盘 = ' + s.r.upSide + '　本心实力盘 ' + s.r.corePanText + '　场景 ' + s.r.scene);
        L.push('    仲裁 ' + s.r.arb + '　评分 ' + U.fmt(s.r.total, 2) + '（' + s.r.strength + '）　决策树：' + s.d.label);
        L.push('    买入水位 ' + U.fmt(s.water) + (s.sd.dir === 'down' ? '（估算）' : '') +
          '　该方向历史命中率 ' + U.pct(s.rate) + '　EV ' + U.pct(s.ev));
      });
      L.push('组合得分 ' + U.fmt(R.best.total, 1) + '（' + R.best.notes.join('；') + '）');
      U.copy(L.join('\n'));
      U.toast('已复制推荐', 'ok');
    }, 'pri'));
    br.appendChild(U.btn('把 A 送到「盘」逐项看', function () {
      window.Batch.editRecord(R.best.a.x.rec.seq);
      window.App.go('batch');
    }, 'ghost'));
    c.appendChild(br);
    box.appendChild(c);

    /* 历史回看：这条逻辑 / 场景方向指向，在记录库里的实际表现 */
    box.appendChild(renderBacktest(R));

    /* 备选组合 */
    if (R.pairs.length > 1) {
      const c2 = U.el('div', { class: 'card' });
      c2.appendChild(U.el('h2', {}, [document.createTextNode('备选组合（前 ' + Math.min(8, R.pairs.length) + ' 名）')]));
      const rows2 = R.pairs.slice(0, 8).map(function (p, i) {
        const nm = function (s) { return '#' + s.x.rec.seq + ' ' + (s.inp.home || '?') + ' vs ' + (s.inp.away || '?'); };
        return {
          rk: i + 1,
          a: nm(p.a), aside: '买' + p.a.sd.team + '（' + p.a.sd.side + '）', adec: p.a.d.label, an: U.fmt(p.a.norm, 1),
          b: nm(p.b), bside: '买' + p.b.sd.team + '（' + p.b.sd.side + '）', bdec: p.b.d.label, bn: U.fmt(p.b.norm, 1),
          bo: (p.bonus >= 0 ? '+' : '') + U.fmt(p.bonus, 1), tt: U.fmt(p.total, 1),
          use: i === 0 ? '当前推荐' : '',
        };
      });
      const t2 = U.table([
        { k: 'rk', n: '排名', w: '50px' },
        { k: 'a', n: 'A 场次', w: '200px' }, { k: 'aside', n: 'A 买哪边', w: '110px' },
        { k: 'adec', n: 'A 结论', w: '100px' }, { k: 'an', n: 'A 得分', w: '68px', num: 1 },
        { k: 'b', n: 'B 场次', w: '200px' }, { k: 'bside', n: 'B 买哪边', w: '110px' },
        { k: 'bdec', n: 'B 结论', w: '100px' }, { k: 'bn', n: 'B 得分', w: '68px', num: 1 },
        { k: 'bo', n: '组合加分', w: '76px', num: 1 }, { k: 'tt', n: '合计', w: '68px', num: 1 },
        { k: 'use', n: '', w: '76px' }
      ], rows2);
      c2.appendChild(U.el('div', { html: t2 }));
      box.appendChild(c2);
    }

    /* 逐场明细 + 落选原因 */
    const c3 = U.el('div', { class: 'card' });
    c3.appendChild(U.el('h2', {}, [document.createTextNode('逐场打分与落选原因')]));
    const rows3 = R.scored.map(function (s) {
      return {
        seq: s.x.rec.seq,
        match: (s.inp.home || '?') + ' vs ' + (s.inp.away || '?'),
        side: s.sd.dir === 'none' ? '无指向' : ('买' + s.sd.team + '（' + s.sd.side + '）'),
        dec: s.d.label,
        raw: U.fmt(s.raw, 1), norm: U.fmt(s.norm, 1),
        rate: U.pct(s.rate) + (s.sideUse ? '（按场景方向 ' + s.sideN + ' 场）' : s.usedScene ? '（同场景 ' + s.sceneN + ' 场推算）' : '（全局推算）'),
        ev: (s.ev >= 0 ? '+' : '') + U.pct(s.ev),
        ok: s.eligible ? '<span style="color:var(--ok)">合格</span>' : '<span style="color:var(--bad)">排除</span>',
        why: s.eligible ? '—' : s.why.join('；'),
      };
    });
    const t3 = U.table([
      { k: 'seq', n: '#', w: '40px' }, { k: 'match', n: '对阵', w: '176px' },
      { k: 'side', n: '买哪边', w: '120px' },
      { k: 'dec', n: '决策树结论', w: '120px' },
      { k: 'raw', n: '原始分', w: '76px', num: 1 }, { k: 'norm', n: '归一化', w: '70px', num: 1 },
      { k: 'rate', n: '该方向历史命中率', w: '150px' }, { k: 'ev', n: 'EV', w: '72px' },
      { k: 'ok', n: '是否合格', w: '76px' }, { k: 'why', n: '原因', w: '300px' }
    ], rows3);
    c3.appendChild(U.el('div', { html: t3 }));
    box.appendChild(c3);
    return box;
  }

  /** 历史回看：场景方向指向这个规则，在你记录库里的实际战绩 */
  function renderBacktest(R) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('历史回看 · 「按场景方向买」这套规则到底准不准')]));
    c.appendChild(U.el('p', { class: 'desc', text: '把记录库里所有已开奖的场次拿出来，按「场景名指向哪边就买哪边」回看一遍，看命中率。' +
      '这是这套逻辑唯一诚实的检验方式 —— 如果某个场景历史上就是不准，样本多了自然看得出来。' }));
    const sr = (R.agg.side || {});
    const ov = sr.overall || {};
    const kpi = U.el('div', { class: 'grid g4' });
    [
      ['按场景方向买的总命中率', ov.rate === null || ov.rate === undefined ? '—' : U.pct(ov.rate)],
      ['命中 / 已开奖', (ov.w || 0) + ' / ' + (ov.dn || 0)],
      ['Wilson 下界', U.pct(ov.lo) + (ov.lo > C.BREAKEVEN ? '　超保本线 ✓' : '　未超保本线')],
      ['保本线', U.pct(C.BREAKEVEN)],
    ].forEach(function (t) {
      const b = U.el('div', { class: 'kpi' });
      b.appendChild(U.el('div', { class: 'v', style: { fontSize: '17px' }, text: t[1] }));
      b.appendChild(U.el('div', { class: 'l', text: t[0] }));
      kpi.appendChild(b);
    });
    c.appendChild(kpi);

    const bys = sr.byScene || {};
    const keys = Object.keys(bys).sort();
    const rows = keys.map(function (k) {
      const g = bys[k];
      const sd = C.sceneSide(k === '中性盘' ? k : (k + '：'), C.store.LIB);
      const dir = sd.dir;
      const lo = g.lo;
      const mark = g.dn === 0 ? '—' : (lo > C.BREAKEVEN ? '可信（下界超保本线）' : (g.rate > C.BREAKEVEN ? '样本不足，仅方向参考' : '历史上不准'));
      return {
        k: k, dir: dir === 'up' ? '跟上盘' : dir === 'down' ? '反买下盘' : '无指向',
        n: g.dn, w: g.w, rate: U.pct(g.rate), lo: U.pct(g.lo), mark: mark,
      };
    });
    const tb = U.table([
      { k: 'k', n: '场景', w: '120px' }, { k: 'dir', n: '方向指向', w: '100px' },
      { k: 'n', n: '已开奖', w: '74px', num: 1 }, { k: 'w', n: '命中', w: '64px', num: 1 },
      { k: 'rate', n: '命中率', w: '82px' }, { k: 'lo', n: 'Wilson 下界', w: '104px' },
      { k: 'mark', n: '结论', w: '220px' }
    ], rows);
    c.appendChild(U.el('div', { html: tb }));
    c.appendChild(U.note('样本说话：<b>下界超保本线</b>说明这个场景的方向指向在统计上站得住；' +
      '<b>「样本不足」</b>只是场次太少，不代表不准；<b>「历史上不准」</b>则是这个场景在你自己的数据里就是反的，' +
      '可以花点时间在「调参中心 → 映射表 → 8 大场景方向指向」里把它调过来。', 'warn'));
    return c;
  }

  function pickCard(s, tag, R) {
    const r = s.r, inp = s.inp, d = s.d, sd = s.sd;
    const isUp = sd.dir === 'up';
    const card = U.el('div', { style: { border: '2px solid ' + d.color, borderRadius: '10px', padding: '11px 13px', background: 'var(--bg)' } });
    const h = U.el('div', { class: 'flexline', style: { gap: '8px', flexWrap: 'wrap' } });
    h.appendChild(U.el('span', {
      style: { background: d.color, color: '#fff', borderRadius: '5px', padding: '1px 7px', fontSize: '12px', fontWeight: '700' },
      text: tag
    }));
    h.appendChild(U.el('span', { class: 'badge-num', text: '#' + s.x.rec.seq }));
    h.appendChild(U.el('span', { style: { fontWeight: '700', fontSize: '14px' }, text: (inp.home || '?') + ' vs ' + (inp.away || '?') }));
    card.appendChild(h);
    card.appendChild(U.el('div', { class: 'mini', text: (inp.league || '') + ' 第' + (inp.round === undefined || inp.round === '' ? '?' : inp.round) + '轮' +
      (inp.openTime ? '　初盘时间 ' + inp.openTime : '') }));
    card.appendChild(U.el('div', {
      style: { fontSize: '15px', fontWeight: '700', color: d.color, marginTop: '6px' },
      text: '决策树：' + d.label
    }));
    /* 最醒目的：买哪支球队 */
    const sideBox = U.el('div', {
      style: {
        marginTop: '5px', padding: '6px 9px', borderRadius: '7px',
        background: isUp ? 'rgba(90,220,140,.10)' : 'rgba(255,120,120,.10)',
        border: '1px solid ' + (isUp ? 'var(--ok)' : 'var(--bad)')
      }
    });
    sideBox.appendChild(U.el('div', {
      style: { fontSize: '16px', fontWeight: '700', color: isUp ? 'var(--ok)' : 'var(--bad)' },
      text: '买 ' + sd.team + '（' + sd.side + '）'
    }));
    sideBox.appendChild(U.el('div', { class: 'mini', html: sd.why }));
    sideBox.appendChild(U.el('div', { class: 'mini', text: '上盘 = ' + r.upSide + '　' + r.scene }));
    card.appendChild(sideBox);

    const g = U.el('div', { class: 'grid g3', style: { gap: '6px', marginTop: '8px' } });
    [
      ['本心实力盘', r.corePanText],
      ['机构初盘 → 终盘', U.fmt(r.J === null ? 0 : r.J, 2) + ' → ' + U.fmt(r.K === null ? 0 : r.K, 2)],
      ['买入方水位', U.fmt(s.water) + (isUp ? '' : '（估算）')],
      ['综合评分', U.fmt(r.total, 2) + ' / ' + r.strength],
      ['该方向历史命中率', U.pct(s.rate) + (s.sideUse ? '（同场景 ' + s.sideN + ' 场）' : s.usedScene ? '（同场景 ' + s.sceneN + ' 场推算）' : '（全局推算）')],
      ['Wilson 下界', U.pct(s.lo)],
      ['期望 EV', (s.ev >= 0 ? '+' : '') + U.pct(s.ev)],
      ['逻辑得分', U.fmt(s.raw, 1) + '（归一 ' + U.fmt(s.norm, 1) + '）'],
      ['冲突仲裁', r.arb],
    ].forEach(function (t) {
      const b = U.el('div', { class: 'kpi', style: { padding: '6px 8px' } });
      b.appendChild(U.el('div', { style: { fontSize: '12.4px', fontWeight: '600', whiteSpace: 'normal', wordBreak: 'break-word' }, text: t[1] }));
      b.appendChild(U.el('div', { class: 'l', style: { fontSize: '10.6px', marginTop: '1px' }, text: t[0] }));
      g.appendChild(b);
    });
    card.appendChild(g);

    const det = U.el('details', { style: { marginTop: '8px' } });
    det.appendChild(U.el('summary', { text: '展开：三步决策树明细' }));
    d.steps.forEach(function (st) {
      const row = U.el('div', { style: { borderLeft: '3px solid ' + (st.pass ? 'var(--ok)' : 'var(--warn)'), padding: '4px 8px', marginBottom: '4px', background: 'var(--panel)' } });
      row.appendChild(U.el('div', { style: { fontSize: '12px', fontWeight: '650' }, text: st.title + '：' + st.value + '（' + (st.pass ? '通过' : '止步') + '）' }));
      row.appendChild(U.el('div', { class: 'mini', html: st.text }));
      row.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: st.hint }));
      det.appendChild(row);
    });
    card.appendChild(det);
    return card;
  }

  /* ---------------- 事件：勾选框 ---------------- */
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (t && t.dataset && t.dataset.bet !== undefined) {
      const seq = Number(t.dataset.bet);
      if (t.checked) S.sel[seq] = true; else delete S.sel[seq];
      S.result = null;
      // 只更新计数文字，不整页重绘（避免跳动）
      const hint = document.getElementById('bet-count');
      if (hint) hint.textContent = '已勾 ' + Object.keys(S.sel).filter(function (k) { return S.sel[k]; }).length + ' 场';
    }
  });

  window.Bet = {
    LOGICS: LOGICS, state: S,
    setLogic: function (v) { S.logic = v; },
    select: function (seqs) { S.sel = {}; (seqs || []).forEach(function (s) { S.sel[s] = true; }); },
    selectAll: function (on) {
      if (on === false) { S.sel = {}; return; }
      C.store.rows.forEach(function (r) { S.sel[r.seq] = true; });
    },
    run: run,
    scoreOne: scoreOne, pairsOf: pairsOf, normalize: normalize,
  };

  window.App.register({
    id: 'bet', title: '投注建议', icon: '◎', group: '分析',
    desc: '勾选若干场比赛 → 选一种推荐逻辑（含你的三步决策树）→ 枚举所有两两组合，给出最合理的 2 场推荐与备选。',
    render: page,
  });
})();
