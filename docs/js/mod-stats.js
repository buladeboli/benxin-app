/* =========================================================================
 * mod-stats.js — 统计分析（v12 全部重写）
 *
 * 设计目标只有一个：**判断一场比赛，机构到底想干什么**，并且用统计告诉你
 * 这个判断靠不靠谱。
 *
 * 四个标签页：
 *   ① 单场意图解剖  选一场 → 意图结论 + 五条证据链 + 近邻对照 + 压力测试
 *   ② 场景意图榜    每个场景「按场景方向买」到底赚不赚；并可和「无脑跟上盘」对照
 *   ③ 模型置信度    v12 新增指标：校准表 / 分布 / 逐场分解 / 迭代日志
 *   ④ 维度下钻      水位、变动、仲裁、四票、强度、联赛… 哪个维度真的有边缘
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const BREAKEVEN = C.BREAKEVEN;    // 0.5128（水位 0.95 的保本胜率）

  const S = {
    tab: 'one',
    seq: null,
    mode: 'scene',        // 口径：scene 按场景方向 / up 无脑上盘 / down 无脑下盘
    dim: '水位',          // 维度下钻的分组维度
    iters: null,
  };

  /* ==================== 基础工具 ==================== */
  function P() { return C.store.P; }
  function LIB() { return C.store.LIB; }
  function allX() {
    return C.store.rows.map(function (rec) { return { rec: rec, r: C.evaluate(rec.inp, P(), LIB()) }; });
  }
  function aggOf(recs) { return C.groupRates(recs || C.store.rows, P(), LIB()); }

  /** 这一场在指定口径下买哪一边 */
  function dirOf(x, mode) {
    mode = mode || S.mode;
    if (mode === 'up') return 'up';
    if (mode === 'down') return 'down';
    return C.sideOf(x.r, LIB()).dir;
  }
  /** 买下盘时的水位估算（记录里只存了上盘水位） */
  function waterOf(x, dir) {
    const w = C.num(x.rec.inp.closeWater !== '' && x.rec.inp.closeWater !== undefined
      ? x.rec.inp.closeWater : x.rec.inp.openWater, 0.95);
    return dir === 'down' ? Math.max(0.5, Math.round((C.num(P().WATER_SUM, 2) - w) * 100) / 100) : w;
  }
  /**
   * 结算一场：{ dir, win, water, profit } ；未开奖 / 无方向 → null
   *   win    = 买的这一边赢盘
   *   profit = 赢 +(水位−1)，输 −1（走水不算，已排除）
   */
  function settleX(x, mode) {
    const dir = dirOf(x, mode);
    if (dir !== 'up' && dir !== 'down') return null;
    if (x.r.actual !== '赢盘' && x.r.actual !== '输盘') return null;
    const upWin = x.r.actual === '赢盘';
    const win = (dir === 'up') ? upWin : !upWin;
    const water = waterOf(x, dir);
    return { dir: dir, win: win, water: water, profit: win ? (water - 1) : -1 };
  }
  /** 汇总一组：场次 / 已开奖 / 盈利场次 / 盈利概率 / ROI / Wilson 下界 */
  function rollup(list, mode) {
    const dec = [];
    list.forEach(function (x) { const s = settleX(x, mode); if (s) dec.push(s); });
    const w = dec.filter(function (s) { return s.win; }).length;
    const roi = dec.length ? dec.reduce(function (a, s) { return a + s.profit; }, 0) / dec.length : null;
    const ci = C.wilson(w, dec.length);
    const avgWater = dec.length ? dec.reduce(function (a, s) { return a + s.water; }, 0) / dec.length : null;
    return {
      n: list.length, dn: dec.length, w: w,
      rate: dec.length ? w / dec.length : null,
      roi: roi, lo: ci.lo, hi: ci.hi, avgWater: avgWater,
      decided: dec,
    };
  }
  function verdictOf(g) {
    if (!g.dn) return { t: '无样本', tone: 'mute' };
    if (g.dn < 5) return { t: '样本太少', tone: 'mute' };
    if (g.lo > BREAKEVEN) return { t: '可信（下界超保本线）', tone: 'ok' };
    if (g.rate > BREAKEVEN) return { t: '方向对但证据不足', tone: 'warn' };
    return { t: '历史上不成立', tone: 'bad' };
  }
  function tokenColor(t) { return t === 'ok' ? 'var(--ok)' : t === 'bad' ? 'var(--bad)' : t === 'warn' ? 'var(--warn)' : 'var(--txt-3)'; }
  function kpi(label, value, sub, tone) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', style: { fontSize: '18px', color: tone || 'var(--txt)' }, text: String(value) }));
    b.appendChild(U.el('div', { class: 'l', text: label }));
    if (sub) b.appendChild(U.el('div', { class: 'mini', style: { marginTop: '2px' }, text: sub }));
    return b;
  }
  function rowKpi(t) { return kpi(t[0], t[1], t[2], t[3]); }
  function bar(v, tone) {
    const w = Math.max(0, Math.min(100, (v || 0) * 100));
    const col = tone === 'ok' ? 'var(--ok)' : tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--acc)';
    return '<span style="display:inline-block;width:100%;max-width:150px;height:8px;background:var(--panel);' +
      'border-radius:4px;overflow:hidden;vertical-align:middle">' +
      '<span style="display:block;width:' + w.toFixed(1) + '%;height:100%;background:' + col + '"></span></span>';
  }
  function mark(v) {
    return (v !== null && v !== undefined && v > BREAKEVEN)
      ? '<b style="color:var(--ok)">✓</b>' : '<span style="color:var(--txt-3)">—</span>';
  }

  /* ==================== ① 单场意图解剖 ==================== */
  function tabOne(host) {
    const recs = C.store.rows;
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('单场意图解剖'),
      U.el('span', { class: 'hint', text: '选一场比赛 → 看机构想干什么，以及这个判断有多可信' })]));
    if (!recs.length) {
      c0.appendChild(U.note('还没有记录。先去「生成录入」或「批量计算」录一场。', 'warn'));
      host.appendChild(c0); return;
    }
    if (S.seq === null) S.seq = recs[recs.length - 1].seq;
    const pick = recs.filter(function (r) { return r.seq === S.seq; })[0] || recs[recs.length - 1];
    S.seq = pick.seq;

    const opts = recs.slice().reverse().map(function (rec) {
      const i = rec.inp;
      return {
        v: String(rec.seq),
        n: '#' + rec.seq + '　' + (i.league || '?') + ' 第' + (i.round === undefined || i.round === '' ? '?' : i.round) + '轮　' +
          (i.home || '?') + ' vs ' + (i.away || '?') + (i.scoreText ? '　[' + i.scoreText + ']' : '')
      };
    });
    const r1 = U.el('div', { class: 'row' });
    r1.appendChild(U.field('选择比赛（倒序 · 最新在前）', U.select(opts, String(S.seq), function (v) {
      S.seq = Number(v); window.App.refresh();
    }, { style: { minWidth: '460px', maxWidth: '100%' } })));
    r1.appendChild(U.btn('上一场', function () { stepSeq(-1); }, 'ghost'));
    r1.appendChild(U.btn('下一场', function () { stepSeq(1); }, 'ghost'));
    c0.appendChild(r1);
    host.appendChild(c0);

    const agg = aggOf();
    const r = C.evaluate(pick.inp, P(), LIB());
    const x = { rec: pick, r: r };
    const d = C.decide(r, agg);
    const sd = C.sideOf(r, LIB());
    const rc = C.recommend(r, agg);
    const conf = C.confidence(r, agg, P());
    const s = (function () {
      // 按「推荐引擎给出的方向」结算，而不是老口径
      if (rc.dir === 'none' || (r.actual !== '赢盘' && r.actual !== '输盘')) return null;
      const upWin = r.actual === '赢盘';
      const win = rc.dir === 'up' ? upWin : !upWin;
      const water = waterOf(x, rc.dir);
      return { dir: rc.dir, win: win, water: water, profit: win ? (water - 1) : -1 };
    })();

    host.appendChild(intentHead(x, r, d, sd, rc, conf, s));
    host.appendChild(evidenceCard(x, r, d, sd, rc, conf, agg));
    host.appendChild(neighbourCard(x, rc));
    host.appendChild(stressCard(x, r, d, rc, conf, agg));
  }
  function stepSeq(delta) {
    const recs = C.store.rows;
    if (!recs.length) return;
    let i = recs.map(function (r) { return r.seq; }).indexOf(S.seq);
    if (i < 0) i = recs.length - 1;
    i = Math.max(0, Math.min(recs.length - 1, i + delta));
    S.seq = recs[i].seq;
    window.App.refresh();
  }

  /** ① 意图结论大卡 —— 分「出现 8 大场景」/「没出现」两种结论 */
  function intentHead(x, r, d, sd, rc, conf, s) {
    const c = U.el('div', { class: 'card' });
    const isA = rc.caseKey === 'A';
    c.appendChild(U.el('h2', {}, [document.createTextNode('① 机构的意图结论'),
      U.el('span', {
        class: 'hint', text: '#' + x.rec.seq + '　' + (x.rec.inp.league || '') + ' 第' +
          (x.rec.inp.round === undefined || x.rec.inp.round === '' ? '?' : x.rec.inp.round) + '轮　' +
          (x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?')
      })]));

    /* 先给一句「结论属于哪一类」 */
    c.appendChild(U.note(
      isA
        ? '✅ <b>出现了 8 大场景</b>（' + U.esc(r.scene) + '）—— 机构意图<b>看得出来</b>：场景名直接给出方向，' +
          '这一场按「① 机构意图优先」处理。'
        : (rc.caseKey === 'none'
          ? '⛔ <b>没出现 8 大场景</b>，而且是「平手或错误」—— 机构没给意图，基本面也没形成倾向 → <b>本场不参与</b>。'
          : '🟡 <b>没出现 8 大场景</b>（本场是「' + U.esc(r.scene) + '」）—— 机构意图<b>看不出来</b>，' +
            '所以改走「② 基本面补位」：方向由 X2 决定（情形 ' + U.esc(rc.caseKey) + '）。'),
      isA ? 'ok' : (rc.caseKey === 'none' ? 'warn' : 'warn')));

    const big = U.el('div', { class: 'grid g4' });
    big.appendChild(rowKpi(['场景（机构在做什么）', r.scene,
      r.Q + ' · ' + r.water + ' · ' + (r.hcpUp ? '升盘' : r.hcpDown ? '降盘' : '盘口不变'), 'var(--acc)']));
    big.appendChild(rowKpi(['推荐情形（走哪条逻辑）', rc.caseKey + '　' + rc.caseName,
      rc.caseWhy, isA ? 'var(--ok)' : (rc.caseKey === 'none' ? 'var(--txt-3)' : 'var(--warn)')]));
    big.appendChild(rowKpi(['投注方向', rc.dir === 'none' ? '不参与' : rc.line,
      '基本面 X2 = ' + rc.X + ' → ' + rc.ak + '　·　上盘 = ' + rc.upTeam,
      rc.dir === 'none' ? 'var(--txt-3)' : (rc.dir === 'down' ? 'var(--bad)' : 'var(--ok)')]));
    big.appendChild(rowKpi([conf.name, conf.score + '　' + conf.band, conf.advice, tokenColor(conf.tone)]));
    c.appendChild(big);

    /* 推荐引擎的理由（两种情况都用同一套） */
    c.appendChild(U.el('div', { class: 'sec-title', text: '为什么是「' + (rc.dir === 'none' ? '不参与' : rc.line) + '」' }));
    const ul = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '1.95', margin: '0' } });
    rc.reasons.forEach(function (t) { ul.appendChild(U.el('li', { html: U.esc(t) })); });
    c.appendChild(ul);

    /* 中水场景才有的二次判定 / 盘口不变建议 */
    if (r.isMidScene) {
      c.appendChild(U.note('<b>中水二次判定（原有判定方式，不改）：</b>' + U.esc(rc.al) +
        '　—— 它现在只作为<b>参考证据</b>：与 X2 方向一致就加权重，相反就提示减仓。' +
        '<br>判据：一致数量 X = ' + r.consensus + '/4，偏差评分 Z = ' + r.devScore + '，仲裁 Y = ' + U.esc(r.arb) + '。',
        rc.alTone === 'ok' ? 'ok' : rc.alTone === 'bad' ? 'bad' : 'warn'));
    } else if (r.scene === C.LABELS.scene.fh || r.scene === C.LABELS.scene.fl || r.scene === C.LABELS.scene.fm) {
      c.appendChild(U.note('<b>盘口不变方向建议：</b>' + U.esc(rc.am) +
        '　（公式里「盘口不变·中水」这一档是「待定」，网页按你的文字规则补了反向判定）', ''));
    }
    if (!isA && rc.caseKey === 'B3') {
      c.appendChild(U.note('这一场就是你说的「投注建议太严谨导致覆盖不全」的那一类：' +
        '原来的中水二次判定经常给「不判定」，所以现在<b>用 X2 补位</b>，保证每场都能给出一个方向。', ''));
    }

    if (s) {
      c.appendChild(U.note('本场已开奖：' + U.esc(x.rec.inp.scoreText || '') + ' → 上盘<b>' + r.actual + '</b>；' +
        '按上面这个推荐方向（' + U.esc(rc.line) + '）算，本场 <b style="color:' + (s.win ? 'var(--ok)' : 'var(--bad)') + '">' +
        (s.win ? '盈利 +' + U.pct(s.water - 1) : '亏损 −100%') + '</b>。', s.win ? 'ok' : 'bad'));
    } else if (!r.actual) {
      c.appendChild(U.note('本场还没录比分，下面所有「实际结果」相关列都会留空。赛后去「批量计算 → ③ 赛果录入」补上即可。', ''));
    }

    /* 折叠：三步决策树（现在只作为「信号能不能信」的参考） */
    const det = U.el('details', { style: { marginTop: '8px' } });
    det.appendChild(U.el('summary', { text: '展开：三步决策树（场景 → 仲裁 → 强度）· 只作参考' }));
    det.appendChild(U.el('div', {
      class: 'mini', style: { margin: '6px 0' },
      text: isA
        ? '这一步在「出现 8 大场景」时用来判断信号能不能信（仲裁「一票否决」就直接放弃）。'
        : '这场没走场景路线，三步决策树仅供参考 —— 真正决定方向的是上面的基本面 X2。'
    }));
    d.steps.forEach(function (st) {
      const row = U.el('div', {
        style: {
          borderLeft: '3px solid ' + (st.pass ? 'var(--ok)' : 'var(--warn)'), padding: '5px 9px',
          marginBottom: '5px', background: 'var(--bg)', borderRadius: '0 6px 6px 0'
        }
      });
      row.appendChild(U.el('div', {
        style: { fontSize: '12.4px', fontWeight: '650' },
        html: st.title + '：' + U.esc(st.value) + '（' + (st.pass ? '通过' : '止步') + '）'
      }));
      row.appendChild(U.el('div', { class: 'mini', html: st.text }));
      row.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: st.hint }));
      det.appendChild(row);
    });
    c.appendChild(det);
    return c;
  }

  /** ② 证据链：分情形给出「支持 / 中性 / 反对」的判定 */
  function evidenceCard(x, r, d, sd, rc, conf, agg) {
    const c = U.el('div', { class: 'card' });
    const isA = rc.caseKey === 'A';
    c.appendChild(U.el('h2', {}, [document.createTextNode('② 证据链 · 机构为什么这么做'),
      U.el('span', {
        class: 'hint', text: isA
          ? '这一场机构意图明确（8 大场景），所以「场景证据」是主角'
          : '这一场机构意图看不出来，所以「基本面证据」是主角'
      })]));
    const blocks = [];
    const Pv = P();

    /* 0 基本面证据（X2）—— 无论哪种情形都放第一块 */
    {
      const votes = [['攻防', r.raw.adDiff], ['主战绩', r.raw.formDiff], ['排名', r.raw.rankDiff], ['加减', r.raw.adjNet]];
      const X = rc.X;
      const sup = C.supportUpper(r);
      const supWide = C.supportUpper(r, true);
      const upT = rc.upTeam, lowT = C.lowerTeam(r);
      let state, head;
      if (isA) {
        // 8 大场景：基本面只作旁证
        state = sup ? 'ok' : (X === 2 ? 'mid' : 'bad');
        head = '基本面 X2 = ' + X + ' → ' + rc.ak +
          '（' + (sup ? '顺带支持上盘' : X === 2 ? '提示有平局' : '与场景方向相反') + '，只作旁证）';
      } else if (rc.caseKey === 'B2') {
        // 盘口不变·中水：反向
        state = 'mid';
        head = '基本面 X2 = ' + X + ' → ' + rc.ak + '（主队视角）→ ' +
          (supWide ? '偏向热门 → 反向买' + lowT : '完全不支持热门 → 跟上盘');
      } else if (rc.caseKey === 'none') {
        state = 'none';
        head = '基本面 X2 = ' + X + ' → ' + rc.ak + '，但场景是「平手或错误」，本场不参与';
      } else {
        // B1 / B3：直接用 X2 定方向
        state = sup ? 'ok' : (X === 2 ? 'mid' : 'bad');
        head = '★ 基本面 X2 = ' + X + ' → ' + rc.ak + '（主队视角）→ ' +
          (sup ? '支持上盘（' + upT + '）' : X === 2 ? '有平局 → 买下盘' : '不支持上盘 → 买下盘（' + lowT + '）');
      }
      const rows0 = votes.map(function (v) {
        return [v[0] + '方向', (v[1] > 0 ? '正' : v[1] < 0 ? '负' : '零') + '（' + U.fmt(v[1], 4) + '）' +
          (v[1] > 0 ? '　← 计入 X2' : '')];
      }).concat([
        ['X2 = 一致数量', X + ' / 4　（4 个「正」的个数，<b>主队视角</b>）'],
        ['X2 解读', rc.ak + '　（X2≥3 支持主队 / X2=2 有平局 / X2≤1 支撑客队）'],
        ['上盘方', r.upSide + '（机构初盘 ' + U.fmt(r.J, 2) + '，' + (C.homeIsUpper(r) ? '主队让球' : (C.num(r.J, 0) > 0 ? '客队让球' : '平手盘')) + '）'],
        ['换算成「支持上盘吗」', (sup ? '支持' : '不支持') + '　（上盘是' + upT + ' → ' + (C.homeIsUpper(r) ? 'X2≥3 支持上盘' : 'X2≤1 支持上盘') + '）'],
      ]);
      blocks.push({
        n: '基本面证据（X2）', max: Pv.CONF_W_DIR, got: conf.parts[1].v,
        state: state, head: head, rows: rows0,
      });
    }

    /* 1 场景证据 / 机构意图证据 */
    {
      const g = (agg.side.byScene || {})[C.sceneKeyOf(r.scene)] || { dn: 0, w: 0, rate: null, n: 0 };
      const lo = C.shrunkLo(g.w || 0, g.dn || 0, Pv);
      const ov = agg.side.overall;
      let state, head, rows1;
      if (isA) {
        state = sd.dir === 'none' ? 'none' : (lo > BREAKEVEN ? 'ok' : (lo > 0.3 ? 'mid' : 'bad'));
        head = '「' + r.scene + '」历史上按场景方向买：' +
          (g.dn ? U.pct(g.rate) + '（' + g.w + '/' + g.dn + '）' : '还没样本') +
          '　收缩后 Wilson 下界 ' + U.pct(lo);
        rows1 = [
          ['机构意图', '看得出来 —— 场景名「' + sd.scene.word + '」直接给出方向：' + sd.scene.label],
          ['本场景样本', g.dn ? (g.w + ' 胜 / ' + g.dn + ' 已开奖 / 共 ' + g.n + ' 场') : '0 场'],
          ['收缩后下界 vs 保本线', U.pct(lo) + ' vs ' + U.pct(BREAKEVEN) + ' → ' + (lo > BREAKEVEN ? '超过' : '未超过')],
          ['同类对照（全局）', ov.dn ? U.pct(ov.rate) + '（' + ov.w + '/' + ov.dn + '）' : '无'],
        ];
      } else {
        state = 'none';
        head = '本场是「' + r.scene + '」—— 不属于标准 8 大场景，机构<b>没有给出方向</b>';
        rows1 = [
          ['为什么算「没给方向」', rc.caseKey === 'none'
            ? '场景落到「平手或错误」：既不是 8 大场景，也不是盘口不变/中水四场景'
            : (rc.caseKey === 'B2'
              ? '盘口不变 + 中水：机构只在控水，盘口没动、水位卡在中档，方向不明'
              : (rc.caseKey === 'B3'
                ? '中水四场景：中水本身信号最弱，光看名字定不了方向'
                : '盘口不变 + ' + r.water + '：只有水位在动，盘口没动'))],
          ['所以改走', '② 基本面补位 —— 用 X2 定方向（情形 ' + rc.caseKey + '）'],
          ['这个场景的历史', g.dn ? (U.pct(g.rate) + '（' + g.w + '/' + g.dn + '）') : '还没样本'],
        ];
      }
      blocks.push({
        n: isA ? '场景证据（机构意图）' : '机构意图证据', max: Pv.CONF_W_SCENE,
        got: conf.parts[0].v, state: state, head: head, rows: rows1,
      });
    }

    /* 1b 二次判定 / 盘口不变建议（只在相关情形显示） */
    if (r.isMidScene) {
      const alDir = rc.alDir;
      blocks.push({
        n: '中水二次判定（参考证据）', max: 1, got: alDir ? '—' : '—',
        state: alDir === rc.dir ? 'ok' : (alDir && alDir !== rc.dir ? 'bad' : 'mid'),
        head: rc.al + (alDir === rc.dir ? '　→ 与基本面一致，可信度更高'
          : alDir && alDir !== rc.dir ? '　→ ⚠ 与基本面相反，建议减仓或跳过'
            : '　→ 没给方向，只作参考'),
        rows: [
          ['判定依据', '一致数量 X = ' + r.consensus + '/4　偏差评分 Z = ' + r.devScore + '　仲裁 Y = ' + r.arb],
          ['与 X2 方向', rc.dir === 'none' ? '本场不参与' : (alDir === rc.dir ? '一致' : alDir ? '相反' : '二次判定没给方向')],
          ['说明', '原有判定方式不改，只是不再单独决定方向 —— 方向由 X2 给'],
        ],
      });
    } else if (r.scene === C.LABELS.scene.fh || r.scene === C.LABELS.scene.fl || r.scene === C.LABELS.scene.fm) {
      blocks.push({
        n: '盘口不变方向建议（参考证据）', max: 1, got: '—',
        state: rc.amTone === 'ok' ? 'ok' : rc.amTone === 'bad' ? 'bad' : 'mid',
        head: rc.am,
        rows: [
          ['公式口径', '主队上盘时 X2≥3 看好上盘、X2≤1 看衰上盘；客队上盘时相反'],
          ['本场', '上盘 = ' + rc.upTeam + '，X2 = ' + rc.X],
          ['与 X2 方向', rc.dir === 'none' ? '—' : (rc.caseKey === 'B2' && rc.amTone === 'mute' ? '中水这一档公式里是「待定」，网页按文字规则补了反向判定' : '一致')],
        ],
      });
    }
    /* 3 盘口证据 */
    {
      blocks.push({
        n: '盘口证据', max: Pv.CONF_W_STRUCT, got: conf.parts[3].v,
        state: r.hcpSame ? 'mid' : (r.linkScore >= 3 ? 'ok' : r.linkScore === 0 ? 'bad' : 'mid'),
        head: '心盘 ' + r.corePanText + '（' + U.fmt(r.netRaw, 4) + '）　机构 ' +
          U.fmt(r.J, 2) + ' → ' + U.fmt(r.K, 2) + '　' + r.water,
        rows: [
          ['深开/浅开', r.Q + '（I=' + U.fmt(r.corePan, 3) + '，J=' + U.fmt(r.J, 2) + '）'],
          ['升/降盘（按绝对值）', (r.hcpUp ? '升盘' : r.hcpDown ? '降盘' : '盘口不变') +
            '　|终盘 ' + U.fmt(r.absK, 2) + '| vs |初盘 ' + U.fmt(r.absJ, 2) + '|'],
          ['水位五档（看初盘水位）', r.water + '（' + U.fmt(r.Lw, 2) + ' → ' + U.fmt(r.Mw, 2) + '，' +
            (r.Mw > r.Lw ? '升水' : r.Mw < r.Lw ? '降水' : '平水') + '）'],
          ['变动幅度', r.move + '（N = ' + U.fmt(r.Nv, 3) + '）'],
          ['联动评分', r.linkScore + ' / 3　（' + (r.linkScore >= 3 ? '盘口与水位反向 → 联动强'
            : r.linkScore === 0 ? '盘口与水位同向 → 矛盾' : '盘口不变 → 中性') + '）'],
          ['心盘临界', r.crit ? '★ 是（正落在盘口分界线上，误差风险高）' : '否'],
        ],
      });
    }
    /* 4 评分证据 */
    {
      blocks.push({
        n: '评分证据', max: Pv.CONF_W_CLARITY, got: conf.parts[2].v,
        state: r.total >= C.num(Pv.STRONG_SCORE, 7) ? 'ok' : r.total >= C.num(Pv.MED_SCORE, 4) ? 'mid' : 'bad',
        head: '综合评分 ' + U.fmt(r.total, 2) + ' → 信号强度「' + r.strength + '」',
        rows: [
          ['偏差评分', r.devScore + '　|初盘 ' + U.fmt(r.J, 2) + ' − 心盘 ' + U.fmt(r.corePan, 3) + '| = ' + U.fmt(Math.abs((r.J || 0) - r.corePan), 4)],
          ['联动评分', String(r.linkScore)],
          ['仲裁评分', r.arbScore + '（' + r.arb + '）'],
          ['时间评分', String(r.timeScore)],
          ['强度分界', '≥ ' + C.num(Pv.STRONG_SCORE, 7) + ' 强 ／ ≥ ' + C.num(Pv.MED_SCORE, 4) + ' 中 ／ 否则弱'],
        ],
      });
    }
    /* 5 时间证据 */
    {
      const hrs = (x.rec.inp.openTime && x.rec.inp.closeTime) ? C.hoursBetween(x.rec.inp.openTime, x.rec.inp.closeTime) : null;
      blocks.push({
        n: '时间证据', max: 2, got: r.timeScore,
        state: r.timeScore >= 1.5 ? 'ok' : r.timeScore >= 1 ? 'mid' : 'bad',
        head: hrs === null ? '初盘/终盘时间缺失，时间评分取默认 ' + r.timeScore
          : '观察时长 ' + U.fmt(hrs, 1) + ' 小时 → 时间评分 ' + r.timeScore,
        rows: [
          ['初盘时间', x.rec.inp.openTime || '（缺）'],
          ['终盘时间', x.rec.inp.closeTime || '（缺）'],
          ['评分规则', '≥24h → 2；≥6h → 1.5；≥3h → 1；否则 0.5；缺失 → 1'],
        ],
      });
    }

    const grid = U.el('div', { class: 'grid g2' });
    blocks.forEach(function (b) {
      const tone = tokenColor(b.state);
      const tag = b.state === 'ok' ? '支持' : b.state === 'bad' ? '反对' : b.state === 'mid' ? '中性' : '不适用';
      const box = U.el('div', {
        style: {
          border: '1px solid var(--line)', borderLeft: '3px solid ' + tone, borderRadius: '8px',
          padding: '9px 11px', background: 'var(--bg)'
        }
      });
      const h = U.el('div', { class: 'flexline', style: { gap: '8px', flexWrap: 'wrap' } });
      h.appendChild(U.el('span', { style: { fontWeight: '700', fontSize: '13px' }, text: b.n }));
      h.appendChild(U.el('span', {
        style: { fontSize: '11.5px', color: tone, border: '1px solid ' + tone, borderRadius: '4px', padding: '0 5px' }, text: tag
      }));
      h.appendChild(U.el('span', { class: 'mini', text: '得分 ' + b.got + ' / ' + b.max }));
      box.appendChild(h);
      box.appendChild(U.el('div', { style: { fontSize: '12.2px', color: 'var(--txt-2)', marginTop: '3px' }, text: b.head }));
      box.appendChild(U.el('div', {
        html: U.table([{ k: 'k', n: '', w: '130px' }, { k: 'v', n: '', w: '300px' }],
          b.rows.map(function (rr) { return { k: rr[0], v: String(rr[1]) }; }))
      }));
      grid.appendChild(box);
    });
    c.appendChild(grid);
    return c;
  }

  /** ③ 近邻对照 */
  function neighbourCard(x, rc) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('③ 近邻对照 · 历史上最像这场的比赛'),
      U.el('span', {
        class: 'hint',
        text: '相似度 = 同推荐情形4 + 同场景3 + 同水档2 + 同升降盘2 + 同仲裁2 + 同深浅开1 + 同强度1 + 同上盘方1'
      })]));
    const r = x.r;
    const sim = function (y) {
      let v = 0; const why = [];
      const yc = C.recommend(y.r, aggOf()).caseKey;
      if (yc === rc.caseKey) { v += 4; why.push('同推荐情形'); }
      if (y.r.scene === r.scene) { v += 3; why.push('同场景'); }
      if (y.r.water === r.water) { v += 2; why.push('同水档'); }
      if (y.r.hcpUp === r.hcpUp && y.r.hcpDown === r.hcpDown) { v += 2; why.push('同升降盘'); }
      if (y.r.arb === r.arb) { v += 2; why.push('同仲裁'); }
      if (y.r.Q === r.Q) { v += 1; why.push('同深浅开'); }
      if (y.r.strength === r.strength) { v += 1; why.push('同强度'); }
      if (y.r.upSide === r.upSide) { v += 1; why.push('同上盘方'); }
      return { v: v, why: why };
    };
    const list = allX().filter(function (y) { return y.rec.seq !== x.rec.seq; })
      .map(function (y) { const sm = sim(y); return { y: y, v: sm.v, why: sm.why, yc: C.recommend(y.r, aggOf()) }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
    if (!list.length) { c.appendChild(U.note('记录库里还没有别的比赛。', 'warn')); return c; }
    let w = 0, dn = 0;
    const rows = list.map(function (o) {
      const s2 = settleX(o.y, 'scene');
      const sd2 = C.sideOf(o.y.r, LIB());
      const dir2 = o.yc.dir;
      let res2 = null;
      if (dir2 !== 'none' && (o.y.r.actual === '赢盘' || o.y.r.actual === '输盘')) {
        const upWin = o.y.r.actual === '赢盘';
        res2 = (dir2 === 'up') ? upWin : !upWin;
      }
      if (res2 !== null) { dn++; if (res2) w++; }
      return {
        sim: o.v + ' 分',
        m: '#' + o.y.rec.seq + ' ' + (o.y.rec.inp.home || '?') + ' vs ' + (o.y.rec.inp.away || '?'),
        caseK: o.yc.caseKey + '　' + o.yc.caseName,
        scene: o.y.r.scene,
        dir: dir2 === 'none' ? '不参与' : o.yc.line,
        res: o.y.r.actual || '未开奖',
        out: res2 === null ? '—' : (res2 ? '<b style="color:var(--ok)">✓ 准</b>' : '<b style="color:var(--bad)">✗ 不准</b>'),
        why: o.why.join('、'),
      };
    });
    c.appendChild(U.el('div', {
      html: U.table([
        { k: 'sim', n: '相似度', w: '66px' }, { k: 'm', n: '比赛', w: '176px' },
        { k: 'caseK', n: '推荐情形', w: '190px' }, { k: 'scene', n: '场景', w: '172px' },
        { k: 'dir', n: '方向', w: '118px' },
        { k: 'res', n: '上盘结果', w: '72px' }, { k: 'out', n: '按推荐买', w: '82px' },
        { k: 'why', n: '像在哪', w: '180px' },
      ], rows)
    }));
    c.appendChild(U.note('这 ' + list.length + ' 场里按<b>推荐方向</b>买：' +
      (dn ? (w + ' 准 / ' + dn + ' 已开奖 = ' + U.pct(w / dn)) : '都还没开奖') +
      '。样本 < 5 时只能当参考。', dn >= 5 ? 'ok' : 'warn'));
    return c;
  }

  /** ④ 反向压力测试 */
  function stressCard(x, r, d, rc, conf, agg) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('④ 反向压力测试 · 这个判断最可能错在哪')]));
    const isA = rc.caseKey === 'A';
    /* 先把「这个结论靠什么撑着」讲清楚，再讲怎么错 */
    const base = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '1.95' } });
    base.appendChild(U.el('li', {
      html: isA
        ? '<b>这个结论靠的是「场景」</b>：' + U.esc(r.scene) + ' 的名字直接给出方向，只要场景判断没错、且这个场景历史准确率够高，结论就成立。'
        : (rc.caseKey === 'none'
          ? '<b>这个结论是「不参与」</b>：场景落到「平手或错误」，机构没给意图、基本面也没形成倾向，所以直接跳过。'
          : '<b>这个结论靠的是「基本面 X2」</b>：X2 = ' + rc.X + ' → ' + U.esc(rc.ak) +
            '。机构没给方向（' + U.esc(r.scene) + '），所以只能信基本面 —— 这意味着它比 8 大场景的结论更弱。')
    }));
    base.appendChild(U.el('li', {
      html: '**如果错了，最可能是**：' + (isA
        ? '① 场景本身判错了（水档/升降盘边界）；② 这个场景历史上就不准；③ 临场信息（伤停、天气、轮换）没进模型。'
        : (rc.caseKey === 'none' ? '（本场不参与，不存在判断错误的问题）'
          : '① 四票本身算错了（攻防/主战绩/排名/加减的输入数据有问题）；② 基本面与机构意图确实背离（这种情况本来就该放弃）；' +
            (rc.caseKey === 'B2' ? '③ 「反向规则」本身是经验性的，还没有足够样本验证。' : '③ X2 只在 0~4 之间，区分度天生就粗。')))
    }));
    if (rc.X === 2) base.appendChild(U.el('li', { html: '<b>注意 X2 = 2</b>：这是「有平局」档，方向按买下盘处理，但它本质上是<b>看不清</b>，建议减仓。' }));
    if (rc.alDir && rc.alDir !== rc.dir) {
      base.appendChild(U.el('li', { html: '<b>⚠ 中水二次判定与基本面相反</b>（二次判定给的是' + (rc.alDir === 'up' ? '上盘' : '下盘') + '），两个口径打架时建议跳过。' }));
    }
    c.appendChild(base);

    const parts = conf.parts.map(function (p) {
      return { n: p.n, ratio: p.max ? p.v / p.max : 0, why: p.why, v: p.v, max: p.max };
    }).sort(function (a, b) { return a.ratio - b.ratio; });
    const ul = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '1.95' } });
    parts.slice(0, 2).forEach(function (w) {
      ul.appendChild(U.el('li', { html: '<b>最弱环节：' + U.esc(w.n) + '（' + w.v + '/' + w.max + '）</b> —— ' + U.esc(w.why) }));
    });
    if (conf.caps.length) {
      ul.appendChild(U.el('li', { html: '<b>被硬性封顶：</b>' + conf.caps.map(function (z) { return U.esc(z.k + ' ≤ ' + z.v); }).join('；') }));
    }
    if (conf.flags.length) {
      ul.appendChild(U.el('li', { html: '<b>风险标记：</b>' + conf.flags.map(U.esc).join('；') }));
    }
    c.appendChild(ul);

    const lose = allX().filter(function (y) {
      if (y.rec.seq === x.rec.seq) return false;
      if (C.sceneKeyOf(y.r.scene) !== C.sceneKeyOf(r.scene)) return false;
      const s = settleX(y, 'scene');
      return s && !s.win;
    }).slice(0, 5);
    if (lose.length) {
      c.appendChild(U.el('div', { class: 'sec-title', text: '同一个场景里「按场景方向买」输掉的历史样本' }));
      c.appendChild(U.el('div', {
        html: U.table([
          { k: 'm', n: '比赛', w: '200px' }, { k: 'water', n: '水档', w: '70px' },
          { k: 'arb', n: '仲裁', w: '160px' }, { k: 'total', n: '评分', w: '60px', num: 1 },
          { k: 'conf', n: '置信度', w: '70px', num: 1 }, { k: 'res', n: '结果', w: '70px' },
        ], lose.map(function (y) {
          const cc = C.confidence(y.r, agg, P());
          return {
            m: '#' + y.rec.seq + ' ' + (y.rec.inp.home || '?') + ' vs ' + (y.rec.inp.away || '?'),
            water: y.r.water, arb: y.r.arb, total: U.fmt(y.r.total, 2),
            conf: cc.score, res: '上盘' + y.r.actual,
          };
        }))
      }));
      c.appendChild(U.note('看看这些失败样本和本场有什么共同点（水档？仲裁？评分档？）。如果共同点很明显，' +
        '说明这个场景该再拆细 —— 告诉我，我来加维度。', 'warn'));
    } else {
      c.appendChild(U.note('这个场景目前还没有「按方向买输掉」的历史样本 —— 要么样本太少，要么它的确稳。样本 < 5 时不要当真。', ''));
    }
    return c;
  }

  /* ==================== ② 场景出现准确率 ==================== */
  function tabScene(host) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('场景出现准确率'),
      U.el('span', { class: 'hint', text: '只统计标准 8 大场景：这个场景一旦出现，按它的方向买有多准' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '这一页只回答一件事：<b>「场景 1~8」出现时，按场景名指向的方向买，历史上准确率是多少</b>。' +
        '<br>非 8 大场景（中水四场景、盘口不变·高/低/中水、平手或错误）<b>不在这里</b> —— ' +
        '它们属于「看不出机构意图」的情况，归「③ 推荐准确率」里的基本面补位逻辑管。' +
        '<br><b>投注盈利概率</b> = 按方向买并赢盘的比例；<b>ROI</b> = 每注 1 单位的平均收益；' +
        '<b>Wilson 下界</b>超过保本线 ' + U.pct(BREAKEVEN) + ' 才算统计上站得住。'
    }));
    const modes = [['scene', '按场景名方向买（推荐）'], ['up', '无脑跟上盘'], ['down', '无脑跟下盘']];
    const chips = U.el('div', { class: 'chips' });
    modes.forEach(function (m) {
      const ch = U.el('span', { class: 'chip' + (S.mode === m[0] ? ' on' : ''), text: m[1] });
      ch.addEventListener('click', function () { S.mode = m[0]; window.App.refresh(); });
      chips.appendChild(ch);
    });
    c.appendChild(chips);
    host.appendChild(c);

    const xs = allX();
    const agg = aggOf();
    const L = C.LABELS.scene;
    // 只保留标准 8 大场景
    const order = [L.s1, L.s2, L.s3, L.s4, L.s5, L.s6, L.s7, L.s8];

    const scene8 = xs.filter(function (x) { return /^场景\d/.test(String(x.r.scene || '')); });
    const map = {};
    scene8.forEach(function (x) { (map[x.r.scene] = map[x.r.scene] || []).push(x); });

    const rows = order.map(function (k) {
      const list = map[k] || [];
      const g = rollup(list, S.mode);
      const sd = C.sceneSide(k, LIB());
      const confs = list.map(function (x) { return C.confidence(x.r, agg, P()).score; });
      const v = list.length ? verdictOf(g) : { t: '本库还没出现', tone: 'mute' };
      return {
        scene: k,
        dir: sd.dir === 'up' ? '跟上盘' : sd.dir === 'down' ? '反买下盘' : '不参与',
        n: list.length,
        share: xs.length ? U.pct(list.length / xs.length) : '—',
        dn: g.dn, w: g.w,
        rate: g.rate === null ? '—' : U.pct(g.rate),
        bar: list.length ? bar(g.rate, g.dn && g.lo > BREAKEVEN ? 'ok' : 'bad') : '',
        roi: g.roi === null ? '—' : (g.roi >= 0 ? '+' : '') + U.pct(g.roi),
        lo: g.dn ? U.pct(g.lo) : '—', ok: mark(g.dn ? g.lo : null),
        conf: confs.length ? U.fmt(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length, 1) : '—',
        v: '<span style="color:' + tokenColor(v.tone) + '">' + v.t + '</span>',
      };
    });

    const gAll = rollup(scene8, S.mode);
    const vAll = verdictOf(gAll);
    const c2 = U.el('div', { class: 'card' });
    const k2 = U.el('div', { class: 'grid g4' });
    k2.appendChild(rowKpi(['当前口径', modes.filter(function (m) { return m[0] === S.mode; })[0][1],
      '切换上面的按钮可对比', 'var(--acc)']));
    k2.appendChild(rowKpi(['8 大场景出现', scene8.length + ' / ' + xs.length,
      xs.length ? ('占 ' + U.pct(scene8.length / xs.length)) : '']));
    k2.appendChild(rowKpi(['这 8 个场景合计准确率', gAll.rate === null ? '—' : U.pct(gAll.rate),
      gAll.w + ' / ' + gAll.dn + ' 已开奖',
      gAll.rate !== null && gAll.rate > BREAKEVEN ? 'var(--ok)' : 'var(--bad)']));
    k2.appendChild(rowKpi(['合计 ROI', gAll.roi === null ? '—' : (gAll.roi >= 0 ? '+' : '') + U.pct(gAll.roi),
      gAll.dn && gAll.lo > BREAKEVEN ? '下界超保本线 ✓' : '下界 ' + (gAll.dn ? U.pct(gAll.lo) : '—'),
      gAll.roi !== null && gAll.roi > 0 ? 'var(--ok)' : 'var(--bad)']));
    c2.appendChild(k2);
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'scene', n: '场景（8 大场景）', w: '190px' }, { k: 'dir', n: '场景方向', w: '86px' },
        { k: 'n', n: '出现次数', w: '74px', num: 1 }, { k: 'share', n: '出现占比', w: '74px' },
        { k: 'dn', n: '已开奖', w: '62px', num: 1 }, { k: 'w', n: '盈利场次', w: '72px', num: 1 },
        { k: 'rate', n: '盈利概率', w: '76px' }, { k: 'bar', n: '', w: '150px' },
        { k: 'roi', n: 'ROI', w: '72px' }, { k: 'lo', n: 'Wilson 下界', w: '92px' },
        { k: 'ok', n: '超保本', w: '60px' }, { k: 'conf', n: '平均置信度', w: '84px', num: 1 },
        { k: 'v', n: '判定', w: '150px' },
      ], rows)
    }));
    c2.appendChild(U.note('把口径从「按场景名方向买」切到「无脑跟上盘」，如果合计 ROI 明显下降，' +
      '就说明「跟场景方向」这件事本身是有效的 —— 这是这 8 个场景最核心的价值检验。' +
      '<br>出现次数太少的场景（< 5 场）只能当方向参考，不要当依据。', 'ok'));
    host.appendChild(c2);
  }

  /* ==================== ③ 模型置信度 ==================== */
  function tabConf(host) {
    const cal = C.confCalibration(C.store.rows, P(), LIB());
    const name = C.confName(P());
    const iter = C.curIter(P());

    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode(name),
      U.el('span', { class: 'hint', text: '每一场比赛「基于场景」的模型置信度 · 指标名随迭代版本号自动变化' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '<b>' + U.esc(name) + '</b> 把四块证据合成一个 0~100 分：' +
        '<b>① 场景证据</b>（同场景按方向买的历史，做小样本收缩）' +
        '<b>② 方向证据</b>（<b>相对下注方向</b>：长期实力 + 短期突发是否支持你要买的那一边）' +
        '<b>③ 场景清晰度</b>（标准 8 场景 &gt; 中水 &gt; 盘口不变 &gt; 平手或错误）' +
        '<b>④ 盘口结构</b>（联动 + 时间 + 变动幅度）。' +
        '再套封顶：一票否决 ≤ ' + C.num(P().CONF_CAP_VETO, 25) + '、平手或错误 ≤ ' + C.num(P().CONF_CAP_NEUTRAL, 30) +
        '、中水不判定 ≤ ' + C.num(P().CONF_CAP_MIDWATER, 55) + '。' +
        '<br>权重、分档、封顶全部在「调参中心 → 模型置信度」里可调。'
    }));
    c.appendChild(U.note('迭代版本 <b>v' + C.num(P().ITERATION, 12) + '</b>：' + U.esc(iter.note || '（未填写）'), ''));
    const sc = cal.rows.map(function (z) { return z.conf.score; });
    const k = U.el('div', { class: 'grid g4' });
    k.appendChild(rowKpi(['本版指标名', name, '改「模型迭代版本号」会自动改名', 'var(--acc)']));
    k.appendChild(rowKpi(['平均置信度', sc.length ? U.fmt(sc.reduce(function (a, b) { return a + b; }, 0) / sc.length, 1) : '—',
      sc.length ? '最高 ' + Math.max.apply(null, sc) + ' / 最低 ' + Math.min.apply(null, sc) : '']));
    k.appendChild(rowKpi(['已开奖场次', cal.rows.filter(function (z) { return z.win !== null; }).length + ' / ' + cal.rows.length, '']));
    k.appendChild(rowKpi(['样本量', cal.rows.length < 30 ? '偏少' : cal.rows.length < 100 ? '一般' : '充足',
      '场景证据块要 20+ 场才可能拿满', cal.rows.length < 30 ? 'var(--warn)' : 'var(--ok)']));
    c.appendChild(k);
    host.appendChild(c);

    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('校准表 · 模型置信度有没有「说到做到」'),
      U.el('span', { class: 'hint', text: '按置信度分档，看每档实际的投注盈利概率与 ROI' })]));
    const rows = cal.bands.map(function (b) {
      const v = verdictOf({ dn: b.dn, w: b.w, rate: b.rate, lo: b.lo });
      return {
        band: b.n,
        conf: b.avgConf === null ? '—' : U.fmt(b.avgConf, 1),
        n: b.total, dn: b.dn, w: b.w,
        rate: b.rate === null ? '—' : U.pct(b.rate),
        bar: bar(b.rate, b.lo > BREAKEVEN ? 'ok' : 'bad'),
        roi: b.roi === null ? '—' : (b.roi >= 0 ? '+' : '') + U.pct(b.roi),
        lo: b.dn ? U.pct(b.lo) : '—',
        v: '<span style="color:' + tokenColor(v.tone) + '">' + v.t + '</span>',
      };
    });
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'band', n: '置信度档', w: '130px' }, { k: 'conf', n: '该档平均置信度', w: '110px', num: 1 },
        { k: 'n', n: '场次', w: '54px', num: 1 }, { k: 'dn', n: '已开奖', w: '62px', num: 1 },
        { k: 'w', n: '盈利场次', w: '72px', num: 1 }, { k: 'rate', n: '实际盈利概率', w: '92px' },
        { k: 'bar', n: '', w: '160px' }, { k: 'roi', n: 'ROI', w: '72px' },
        { k: 'lo', n: 'Wilson 下界', w: '92px' }, { k: 'v', n: '判定', w: '170px' },
      ], rows)
    }));
    c2.appendChild(U.note('好的校准表应该<b>单调</b>：置信度越高，实际盈利概率也越高。' +
      '如果高置信档反而不如低置信档，说明权重该调了 —— 去「调参中心 → 模型置信度」改那四个权重。' +
      '当前样本只有 ' + cal.rows.length + ' 场，分档后每档更少，所以这张表现在<b>只能看趋势，不能当结论</b>。', 'warn'));
    host.appendChild(c2);

    const c3 = U.el('div', { class: 'card' });
    c3.appendChild(U.el('h2', {}, [document.createTextNode('逐场分解 · ' + name + ' 的加减法')]));
    const sorted = cal.rows.slice().sort(function (a, b) { return b.conf.score - a.conf.score; });
    c3.appendChild(U.el('div', {
      html: U.table([
        { k: 'seq', n: '#', w: '40px' }, { k: 'm', n: '比赛', w: '180px' },
        { k: 'scene', n: '场景', w: '180px' }, { k: 'dir', n: '方向', w: '100px' },
        { k: 'p1', n: '① 场景', w: '66px', num: 1 }, { k: 'p2', n: '② 方向', w: '66px', num: 1 },
        { k: 'p3', n: '③ 清晰度', w: '72px', num: 1 }, { k: 'p4', n: '④ 结构', w: '66px', num: 1 },
        { k: 'score', n: '合计', w: '60px', num: 1 }, { k: 'band', n: '分档', w: '74px' },
        { k: 'cap', n: '封顶 / 折扣', w: '150px' }, { k: 'res', n: '实际', w: '86px' },
      ], sorted.map(function (z) {
        const s = settleX(z, 'scene');
        const dd = C.sideOf(z.r, LIB());
        return {
          seq: z.rec.seq,
          m: (z.rec.inp.home || '?') + ' vs ' + (z.rec.inp.away || '?'),
          scene: z.r.scene,
          dir: dd.dir === 'none' ? '不参与' : ('买' + dd.team + '（' + dd.side + '）'),
          p1: z.conf.parts[0].v, p2: z.conf.parts[1].v, p3: z.conf.parts[2].v, p4: z.conf.parts[3].v,
          score: z.conf.score, band: z.conf.band,
          cap: (z.conf.caps.length ? z.conf.caps.map(function (q) { return q.k + '≤' + q.v; }).join('；') : '—') +
            (z.r.crit ? '；临界×' + C.num(P().CONF_CRIT_MUL, 0.9) : ''),
          res: s ? (s.win ? '<b style="color:var(--ok)">盈利</b>' : '<b style="color:var(--bad)">亏损</b>')
            : (z.r.actual ? '上盘' + z.r.actual : '未开奖'),
        };
      }))
    }));
    host.appendChild(c3);

    host.appendChild(iterCard());
  }

  function iterCard() {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('迭代日志 · 每次按新表迭代都记一笔'),
      U.el('span', { class: 'hint', text: '置信度指标名 = 「模型置信度 v + 迭代版本号」' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '每次按新表改一版，就来这里加一条，并把「调参中心 → 模型置信度 → 模型迭代版本号」+1 —— ' +
        '指标名会自动变成 <b>模型置信度 v13</b>；历史记录里保留版本号，方便对比同一场比赛在 v12 与 v13 下的置信度变化。'
    }));
    if (!S.iters || !S.iters.length) S.iters = (C.store.iters || []).slice();
    const list = S.iters.slice().sort(function (a, b) { return Number(b.v) - Number(a.v); });
    c.appendChild(U.el('div', {
      html: U.table([
        { k: 'v', n: '版本', w: '66px' }, { k: 'conf', n: '当时的置信度指标名', w: '150px' },
        { k: 'date', n: '日期', w: '92px' }, { k: 'note', n: '这一版改了什么', w: '430px' },
        { k: 'chg', n: '置信度口径变化', w: '230px' }, { k: 'act', n: '', w: '50px' },
      ], list.map(function (it) {
        return {
          v: '<b>v' + it.v + '</b>' + (Number(it.v) === C.num(P().ITERATION, 12)
            ? ' <span class="mini" style="color:var(--ok)">当前</span>' : ''),
          conf: it.confName || ('模型置信度 v' + it.v),
          date: it.date || '—',
          note: it.note || '',
          chg: it.confChanged || '—',
          act: '<button class="sm danger" data-iterdel="' + it.v + '">删</button>',
        };
      }))
    }));
    const r = U.el('div', { class: 'row', style: { marginTop: '8px' } });
    r.appendChild(U.btn('＋ 新增一条迭代记录', function () {
      const cur = C.num(P().ITERATION, 12);
      const nv = Math.max.apply(null, S.iters.map(function (x) { return Number(x.v) || 0; }).concat([cur])) + 1;
      S.iters.push({
        v: nv, date: new Date().toISOString().slice(0, 10), note: '',
        confName: '模型置信度 v' + nv, confChanged: ''
      });
      C.store.iters = S.iters; C.saveIters(); window.App.refresh();
    }, 'pri'));
    r.appendChild(U.btn('把「模型迭代版本号」设为最新一条', function () {
      const nv = Math.max.apply(null, S.iters.map(function (x) { return Number(x.v) || 0; }));
      C.store.P.ITERATION = nv; C.saveParams();
      U.toast('模型迭代版本号已设为 v' + nv + '，指标名随之更新', 'ok');
      window.App.refresh();
    }, 'ghost'));
    r.appendChild(U.btn('恢复内置说明', function () {
      S.iters = C.defaultIters(); C.store.iters = S.iters; C.saveIters();
      U.toast('已恢复内置的 v11 / v12 说明', 'ok'); window.App.refresh();
    }, 'ghost'));
    c.appendChild(r);
    c.appendChild(U.note('这条日志会跟着「整站备份」一起导出，换电脑不会丢。', ''));
    return c;
  }

  /* ==================== ④ 维度下钻 ==================== */
  const DIMS = [
    ['水位', function (x) { return x.r.water; }],
    ['变动幅度', function (x) { return x.r.move; }],
    ['仲裁', function (x) { return x.r.arb; }],
    ['四票一致数', function (x) { return x.r.consensus + '/4'; }],
    ['强度', function (x) { return x.r.strength; }],
    ['联赛', function (x) { return x.rec.inp.league || '未知'; }],
    ['上盘方', function (x) { return x.r.upSide; }],
    ['盘口绝对深度', function (x) {
      const a = Math.abs(C.num(x.r.J, 0));
      return a <= 0.25 ? '≤平半' : a <= 0.75 ? '半球~半一' : a <= 1.25 ? '一球~一球半' : a <= 2 ? '球半~两球' : '>两球';
    }],
    ['场景方向', function (x) {
      const d = C.sideOf(x.r, LIB()).dir;
      return d === 'up' ? '跟上盘' : d === 'down' ? '反买下盘' : '不参与';
    }],
    ['模型置信度档', function (x) { return C.confidence(x.r, S.agg || aggOf(), P()).band; }],
  ];
  function tabDim(host) {
    S.agg = aggOf();
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('维度下钻'),
      U.el('span', { class: 'hint', text: '哪个维度真的有边缘？' })]));
    const chips = U.el('div', { class: 'chips' });
    DIMS.forEach(function (d) {
      const ch = U.el('span', { class: 'chip' + (S.dim === d[0] ? ' on' : ''), text: d[0] });
      ch.addEventListener('click', function () { S.dim = d[0]; window.App.refresh(); });
      chips.appendChild(ch);
    });
    c.appendChild(chips);
    const mchips = U.el('div', { class: 'chips', style: { marginTop: '6px' } });
    [['scene', '按场景方向买'], ['up', '无脑跟上盘'], ['down', '无脑跟下盘']].forEach(function (m) {
      const ch = U.el('span', { class: 'chip' + (S.mode === m[0] ? ' on' : ''), text: m[1] });
      ch.addEventListener('click', function () { S.mode = m[0]; window.App.refresh(); });
      mchips.appendChild(ch);
    });
    c.appendChild(mchips);
    host.appendChild(c);

    const dim = DIMS.filter(function (d) { return d[0] === S.dim; })[0] || DIMS[0];
    const xs = allX();
    const agg = S.agg;
    const map = {};
    xs.forEach(function (x) { const k = String(dim[1](x)); (map[k] = map[k] || []).push(x); });
    const rows = Object.keys(map).map(function (k) {
      const list = map[k];
      const g = rollup(list, S.mode);
      const v = verdictOf(g);
      const confs = list.map(function (x) { return C.confidence(x.r, agg, P()).score; });
      return {
        k: k, n: list.length, dn: g.dn, w: g.w,
        rate: g.rate === null ? '—' : U.pct(g.rate),
        roi: g.roi === null ? '—' : (g.roi >= 0 ? '+' : '') + U.pct(g.roi),
        lo: g.dn ? U.pct(g.lo) : '—', ok: mark(g.dn ? g.lo : null),
        conf: confs.length ? U.fmt(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length, 1) : '—',
        v: '<span style="color:' + tokenColor(v.tone) + '">' + v.t + '</span>',
      };
    }).sort(function (a, b) {
      const ra = a.roi === '—' ? -9 : parseFloat(a.roi);
      const rb = b.roi === '—' ? -9 : parseFloat(b.roi);
      return rb - ra;
    });
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('按「' + S.dim + '」分组 · 按 ROI 从高到低')]));
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'k', n: S.dim, w: '180px' }, { k: 'n', n: '场次', w: '54px', num: 1 },
        { k: 'dn', n: '已开奖', w: '62px', num: 1 }, { k: 'w', n: '盈利场次', w: '72px', num: 1 },
        { k: 'rate', n: '盈利概率', w: '80px' }, { k: 'roi', n: 'ROI', w: '76px' },
        { k: 'lo', n: 'Wilson 下界', w: '92px' }, { k: 'ok', n: '超保本', w: '60px' },
        { k: 'conf', n: '平均置信度', w: '84px', num: 1 }, { k: 'v', n: '判定', w: '180px' },
      ], rows)
    }));
    c2.appendChild(U.note('找边缘的正确姿势：<b>看 ROI 排名靠前的组，但只信「下界超保本线」的那些</b>。' +
      '一两个样本的 100% ROI 是噪声，不是边缘。样本 < 5 的分组一律只当参考。', 'warn'));
    host.appendChild(c2);

    const dec = [];
    xs.forEach(function (x) { const s = settleX(x, S.mode); if (s) dec.push({ x: x, s: s }); });
    if (dec.length >= 8) {
      const c3 = U.el('div', { class: 'card' });
      const win = 20, pts = [];
      for (let i = win; i <= dec.length; i++) {
        const seg = dec.slice(i - win, i);
        const w = seg.filter(function (z) { return z.s.win; }).length;
        pts.push({
          at: '第 ' + i + ' 场', rate: w / seg.length,
          roi: seg.reduce(function (a, z) { return a + z.s.profit; }, 0) / seg.length
        });
      }
      c3.appendChild(U.el('h2', {}, [document.createTextNode('滚动趋势 · 最近 ' + win + ' 场已开奖（共 ' + dec.length + ' 场）')]));
      c3.appendChild(U.el('div', {
        html: U.table([
          { k: 'at', n: '截至', w: '90px' }, { k: 'rate', n: '滚动命中率', w: '96px' },
          { k: 'bar', n: '', w: '200px' }, { k: 'roi', n: '滚动 ROI', w: '90px' },
          { k: 'base', n: 'vs 保本线', w: '120px' },
        ], pts.slice(-12).map(function (p) {
          return {
            at: p.at, rate: U.pct(p.rate), bar: bar(p.rate, p.rate > BREAKEVEN ? 'ok' : 'bad'),
            roi: (p.roi >= 0 ? '+' : '') + U.pct(p.roi),
            base: p.rate > BREAKEVEN ? '高于保本线' : '低于保本线',
          };
        }))
      }));
      c3.appendChild(U.note('滚动窗口 = 最近 20 场已开奖。曲线整体压在保本线以下，说明这套口径最近在亏，该考虑换口径或调参了。', ''));
      host.appendChild(c3);
    }
  }

  /* ==================== ⑤ 推荐准确率 ==================== */
  function tabRec(host) {
    const st = C.recommendStats(C.store.rows, P(), LIB());

    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('推荐购买的准确率'),
      U.el('span', { class: 'hint', text: '补充两大情况推荐逻辑后，每场比赛的推荐到底准不准' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '<b>推荐方向</b> = v13 两大情况定出来的方向：出现 8 大场景 → 按场景意图；没出现 → 按基本面 X2' +
        '（盘口不变的高/低水看 X2；盘口不变中水反向；中水四场景用 X2 补位）。' +
        '<br><b>准确</b> = 推荐的那一边赢盘。走水与未开奖都<b>不算</b>（不进分母也不进分子）。' +
        '<br><b>ROI</b> = 每注 1 单位的平均盈亏（赢 +(水位−1)，输 −1）。'
    }));
    const a = st.all;
    const k = U.el('div', { class: 'grid g4' });
    k.appendChild(rowKpi(['总推荐场次', a.recN + ' / ' + a.n, '其余 ' + (a.n - a.recN) + ' 场判「不参与」']));
    k.appendChild(rowKpi(['推荐准确率', a.rate === null ? '—' : U.pct(a.rate),
      a.w + ' / ' + a.dn + ' 已开奖',
      a.rate === null ? 'var(--txt-3)' : (a.rate > C.BREAKEVEN ? 'var(--ok)' : 'var(--bad)')]));
    k.appendChild(rowKpi(['Wilson 下界', a.dn ? U.pct(a.lo) : '—',
      a.dn && a.lo > C.BREAKEVEN ? '超保本线 ✓' : '未超保本线',
      a.dn && a.lo > C.BREAKEVEN ? 'var(--ok)' : 'var(--warn)']));
    k.appendChild(rowKpi(['总 ROI', a.roi === null ? '—' : (a.roi >= 0 ? '+' : '') + U.pct(a.roi),
      '保本线 ' + U.pct(C.BREAKEVEN), a.roi !== null && a.roi > 0 ? 'var(--ok)' : 'var(--bad)']));
    c.appendChild(k);
    c.appendChild(U.note('样本 < 20 场时准确率波动极大，别当结论看 —— 这一页的价值在于<b>长期跟踪两大情况各自的准确率</b>：' +
      '哪一支掉到 45% 以下，就去「调参中心 → 推荐准确率」看诊断。', 'warn'));
    host.appendChild(c);

    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('按推荐情形拆分 · 哪一支在赚钱'),
      U.el('span', { class: 'hint', text: '对应投注建议的两大情况' })]));
    const ORDER = ['A', 'B1', 'B2', 'B3', 'none'];
    const rows = ORDER.filter(function (k2) { return st.byCase[k2] && st.byCase[k2].n; }).map(function (k2) {
      const b = st.byCase[k2];
      const v = verdictOf({ dn: b.dn, w: b.w, rate: b.rate, lo: b.lo });
      return {
        c: '<b>' + U.esc(k2) + '</b>　' + U.esc(C.REC_CASES[k2].n),
        why: C.REC_CASES[k2].why,
        n: b.n, rec: b.recN, dn: b.dn, w: b.w,
        rate: b.rate === null ? '—' : U.pct(b.rate),
        bar: bar(b.rate, b.dn && b.lo > C.BREAKEVEN ? 'ok' : 'bad'),
        roi: b.roi === null ? '—' : (b.roi >= 0 ? '+' : '') + U.pct(b.roi),
        lo: b.dn ? U.pct(b.lo) : '—',
        v: '<span style="color:' + tokenColor(v.tone) + '">' + v.t + '</span>',
      };
    });
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'c', n: '推荐情形', w: '240px' }, { k: 'why', n: '怎么定方向的', w: '290px' },
        { k: 'n', n: '总场次', w: '60px', num: 1 }, { k: 'rec', n: '给出方向', w: '70px', num: 1 },
        { k: 'dn', n: '已开奖', w: '62px', num: 1 }, { k: 'w', n: '准确', w: '54px', num: 1 },
        { k: 'rate', n: '准确率', w: '74px' }, { k: 'bar', n: '', w: '150px' },
        { k: 'roi', n: 'ROI', w: '74px' }, { k: 'lo', n: 'Wilson 下界', w: '92px' },
        { k: 'v', n: '判定', w: '160px' },
      ], rows)
    }));
    host.appendChild(c2);

    const c3 = U.el('div', { class: 'card' });
    c3.appendChild(U.el('h2', {}, [document.createTextNode('逐场推荐记录'),
      U.el('span', { class: 'hint', text: '每场推荐了什么、依据是什么、实际对不对' })]));
    const list = st.rows.slice().sort(function (p, q) {
      const ap = p.res ? (p.res.win ? 0 : 1) : 2, aq = q.res ? (q.res.win ? 0 : 1) : 2;
      if (ap !== aq) return ap - aq;
      return q.rc.score - p.rc.score;
    });
    c3.appendChild(U.el('div', {
      html: U.table([
        { k: 'seq', n: '#', w: '40px' }, { k: 'm', n: '比赛', w: '176px' },
        { k: 'case', n: '推荐情形', w: '210px' },
        { k: 'dir', n: '推荐方向', w: '126px' },
        { k: 'x2', n: 'X2 / 基本面', w: '126px' },
        { k: 'scene', n: '场景', w: '184px' },
        { k: 'conf', n: '可信度', w: '62px' },
        { k: 'res', n: '上盘结果', w: '72px' },
        { k: 'ok', n: '准不准', w: '90px' },
      ], list.map(function (x) {
        const okTxt = x.res
          ? (x.res.win ? '<b style="color:var(--ok)">✓ 准</b>' : '<b style="color:var(--bad)">✗ 不准</b>')
          : (x.rc.dir === 'none' ? '<span style="color:var(--txt-3)">不参与</span>'
            : (x.r.actual ? '（走水/无结果）' : '<span style="color:var(--txt-3)">未开奖</span>'));
        return {
          seq: x.rec.seq,
          m: (x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?'),
          case: U.esc(x.rc.caseKey) + '　' + U.esc(x.rc.caseName),
          dir: x.rc.dir === 'none' ? '<span style="color:var(--txt-3)">不参与</span>'
            : '<b>' + U.esc(x.rc.line) + '</b>',
          x2: 'X2=' + x.rc.X + '　' + U.esc(x.rc.ak),
          scene: U.esc(x.r.scene),
          conf: U.esc(x.rc.conf),
          res: x.r.actual || '—',
          ok: okTxt,
        };
      }))
    }));
    c3.appendChild(U.note('这一页会随你补赛果自动更新。想看「两大情况」各自的走势，用上面那张分组表的准确率 + 下界。', ''));
    host.appendChild(c3);

    const dec = st.rows.filter(function (x) { return x.res; });
    if (dec.length >= 8) {
      const c4 = U.el('div', { class: 'card' });
      c4.appendChild(U.el('h2', {}, [document.createTextNode('推荐准确率滚动趋势 · 最近 20 场')]));
      const win = 20, pts = [];
      for (let i = win; i <= dec.length; i++) {
        const seg = dec.slice(i - win, i);
        const w = seg.filter(function (z) { return z.res.win; }).length;
        pts.push({
          at: '第 ' + i + ' 场', rate: w / seg.length,
          roi: seg.reduce(function (acc, z) { return acc + z.res.profit; }, 0) / seg.length
        });
      }
      c4.appendChild(U.el('div', {
        html: U.table([
          { k: 'at', n: '截至', w: '90px' }, { k: 'rate', n: '滚动准确率', w: '100px' },
          { k: 'bar', n: '', w: '200px' }, { k: 'roi', n: '滚动 ROI', w: '92px' },
          { k: 'base', n: 'vs 保本线', w: '120px' },
        ], pts.slice(-12).map(function (p) {
          return {
            at: p.at, rate: U.pct(p.rate), bar: bar(p.rate, p.rate > C.BREAKEVEN ? 'ok' : 'bad'),
            roi: (p.roi >= 0 ? '+' : '') + U.pct(p.roi),
            base: p.rate > C.BREAKEVEN ? '高于保本线' : '低于保本线',
          };
        }))
      }));
      host.appendChild(c4);
    }
  }

  /* ==================== 事件 ==================== */
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.dataset && t.dataset.iterdel !== undefined) {
      const v = Number(t.dataset.iterdel);
      C.store.iters = (C.store.iters || []).filter(function (x) { return Number(x.v) !== v; });
      S.iters = C.store.iters.slice();
      C.saveIters(); window.App.refresh();
    }
  });

  /* ==================== 对外接口 ==================== */
  window.Stats = {
    focus: function (seq) { S.seq = Number(seq); S.tab = 'one'; },
    setTab: function (t) { if (['one', 'scene', 'conf', 'rec', 'dim'].indexOf(t) >= 0) S.tab = t; },
    getTab: function () { return S.tab; },
    state: S,
    rollup: rollup, settleX: settleX, dirOf: dirOf, waterOf: waterOf, verdictOf: verdictOf,
    DIMS: DIMS,
  };

  window.App.register({
    id: 'stats', title: '统计分析', icon: '▤', group: '分析',
    desc: '五个角度：① 单场意图解剖（分「出现 8 大场景」与「没出现」两种结论）② 场景出现准确率' +
      '③ 推荐购买的准确率 ④ 模型置信度 ⑤ 维度下钻。',
    render: function (host) {
      const chips = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
      [['one', '① 单场意图解剖'], ['scene', '② 场景出现准确率'],
      ['rec', '③ 推荐准确率'], ['conf', '④ ' + C.confName(P())], ['dim', '⑤ 维度下钻']].forEach(function (t) {
        const ch = U.el('span', { class: 'chip' + (S.tab === t[0] ? ' on' : ''), text: t[1] });
        ch.addEventListener('click', function () { S.tab = t[0]; window.App.refresh(); });
        chips.appendChild(ch);
      });
      host.appendChild(chips);
      if (S.tab === 'one') tabOne(host);
      else if (S.tab === 'scene') tabScene(host);
      else if (S.tab === 'rec') tabRec(host);
      else if (S.tab === 'conf') tabConf(host);
      else tabDim(host);
    }
  });
})();
