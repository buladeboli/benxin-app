/* =========================================================================
 * calc.js —— 纯计算（不碰 DOM，可以单独单元测试）
 *
 * 只做两件事：
 *   1. 竞彩：N 串 1 的注数 / 金额 / 奖金
 *   2. 胜负彩：14 场 / 任九 的注数
 *
 * 关键公式：初等对称多项式
 *   e_N(a1..am) = 「从 m 个数里任取 N 个相乘，再把所有乘积加起来」
 *   · 把「每场的赔率」当 a 传进去 → 得到全部注的赔率乘积之和 → ×2×倍数 = 全中奖金
 *   · 把「1」当 a 传进去         → e_N = C(m, N) = 注数
 *   O(m·N)，几万注也是瞬间，不会因为组合数爆炸而卡死。
 * ========================================================================= */
(function (root) {
  'use strict';

  var STAKE = 2;          // 每注 2 元（体彩固定）
  var MAX_CHORD = 8;      // 竞彩最多 8 串 1

  /** 初等对称多项式 e_N(a1..am) */
  function eSym(arr, N) {
    N = Math.floor(N);
    if (!arr || !arr.length || N <= 0 || N > arr.length) return 0;
    var e = new Array(N + 1), i, k;
    for (i = 0; i <= N; i++) e[i] = 0;
    e[0] = 1;
    for (k = 0; k < arr.length; k++) {
      var a = Number(arr[k]);
      if (!isFinite(a) || a === 0) continue;             // 选 0 个的场次等于不存在
      for (var j = Math.min(N, k + 1); j >= 1; j--) e[j] += e[j - 1] * a;
    }
    return e[N];
  }

  /** 组合数 C(n, k) —— 只是给 eSym 做一次交叉验证用 */
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    var r = 1;
    for (var i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return Math.round(r);
  }

  /**
   * 竞彩过关统计。
   * @param {number[]} odds  每场选中那一项的赔率（只传已选中的场次）
   * @param {number}   chord 串关数：1 = 单关，2 = 2串1 …
   * @param {number}   multi 倍数
   * @returns {{ok:boolean,reason:string,bets:number,money:number,winAll:number,minOne:number,maxOne:number}}
   */
  function jcStats(odds, chord, multi) {
    odds = (odds || []).map(Number);
    chord = Math.floor(chord || 1);
    multi = Math.max(1, Math.floor(multi || 1));

    var m = odds.length;
    var res = { ok: false, reason: '', bets: 0, money: 0, winAll: 0, minOne: 0, maxOne: 0 };

    if (!m) { res.reason = '没有选中任何比赛'; return res; }
    if (chord > MAX_CHORD) { res.reason = '竞彩最多 8 串 1'; return res; }
    if (chord > m) { res.reason = '要选 ' + chord + ' 场，但只选了 ' + m + ' 场'; return res; }
    for (var i = 0; i < m; i++) {
      if (!(odds[i] > 0)) { res.reason = '有比赛没有赔率，无法计算奖金'; return res; }
    }

    // 注数：从 m 场里任取 chord 场的组合数（每场只选一个结果 = 真实竞彩规则）
    res.bets = Math.round(eSym(odds.map(function () { return 1; }), chord));
    res.money = STAKE * res.bets * multi;

    // 全中奖金：所有注的赔率乘积之和
    res.winAll = STAKE * multi * eSym(odds, chord);

    // 单注最高 / 最低：赔率最大（小）的 chord 场相乘
    var asc = odds.slice().sort(function (a, b) { return a - b; });
    var lo = 1, hi = 1;
    for (var k = 0; k < chord; k++) {
      lo *= asc[k];
      hi *= asc[asc.length - 1 - k];
    }
    res.minOne = STAKE * multi * lo;
    res.maxOne = STAKE * multi * hi;
    res.ok = true;
    return res;
  }

  /**
   * 胜负彩注数。
   * @param {number[]} ks   每场的选取数（0 = 没选，1 = 单选，2 = 双选，3 = 三选）
   * @param {string}   mode 'all' = 14 场；'nine' = 任九
   */
  function sfcStats(ks, mode) {
    ks = (ks || []).map(function (k) { return Math.max(0, Math.floor(k || 0)); });
    var selected = ks.filter(function (k) { return k > 0; }).length;
    var res = { ok: false, reason: '', bets: 0, money: 0, selected: selected, total: ks.length };

    if (!selected) { res.reason = '胜负彩还没选'; return res; }

    if (mode === 'all') {
      var miss = ks.filter(function (k) { return !k; }).length;
      if (miss > 0) { res.reason = '14 场玩法要每场都选，还有 ' + miss + ' 场没选'; return res; }
      var p = 1;
      ks.forEach(function (k) { p *= k; });
      res.bets = p;
    } else {
      if (selected < 9) { res.reason = '任九至少要有 9 场有选择，现在只有 ' + selected + ' 场'; return res; }
      res.bets = Math.round(eSym(ks, 9));
    }
    res.money = STAKE * res.bets;
    res.ok = true;
    return res;
  }

  root.JCCalc = {
    STAKE: STAKE,
    MAX_CHORD: MAX_CHORD,
    eSym: eSym,
    comb: comb,
    jcStats: jcStats,
    sfcStats: sfcStats
  };
})(typeof window !== 'undefined' ? window : globalThis);
