/* =========================================================================
 * vz-api.js —— 从 V站（vzhan310）自动抓取本场数据，填进「② 单场录入」
 *
 * ★ 只用它的 JSON 接口（mapi.shemen365.com，允许跨域，纯前端可跑，手机上也能用）
 *
 *   1) /new-match/new-detail/base-info?match_id=        联赛/轮次/队名/时间/「当时」排名
 *   2) /new-match/detail/odds/detail/list?book_id=6     「韦*」全部变化：初盘/终盘/水位/两个时间
 *   3) /new-match/jc/football-list?date=&page=1         某日全部比赛（比分 + 当时排名）
 *
 * ★ 关键实测结论（10 场比赛交叉验证）：
 *   盘口字段 f[6] 的**正负号就是方向**，且与模型约定完全一致：
 *       负数 = 主队让球      正数 = 主队受让
 *   例：+0.5 ←→ 网页写「受半球」；−0.75 ←→ 网页写「半一」。所以不需要抓网页（网页还被 CORS 挡着）。
 *
 * ★ 三条铁律：
 *   · 宁可不填，也不填错 —— 校验不过就留空 + 报警
 *   · 限速 + 缓存：同一天的数据只问一次；两队近6场共用一次翻页
 *   · 任何异常都不抛到界面，只在报告里写清楚
 * ========================================================================= */
(function (global) {
  'use strict';

  var API = 'https://mapi.shemen365.com';
  var BOOK_WEI = 6;          // 「韦*」= book_id 6（初盘/即时双值验证）
  var GAP = 120;             // 单次请求最小间隔（ms）
  var CONCURRENCY = 8;       // 翻历史时并发数（实测 8 路不会被拦）
  var MAX_DAYS = 110;        // 往前最多翻多少天（宁可翻远点也要凑齐 6 场，实测 70 天会漏）
  var LS_CACHE = 'benxin.vz.cache.v2';

  var _day = {};             // date → 归一化比赛数组（内存）
  var _persist = loadCache();

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(LS_CACHE) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveCache() {
    try {
      var team = _persist.team || {};
      var keys = Object.keys(team);
      if (keys.length > 60) {                      // 只留最近 60 个队
        var keep = {};
        keys.slice(-60).forEach(function (k) { keep[k] = team[k]; });
        _persist.team = keep;
      }
      localStorage.setItem(LS_CACHE, JSON.stringify(_persist));
    } catch (e) { }
  }

  /* -------------------------------------------------------------- 请求层 */

  var _last = 0;
  function throttle() {
    var wait = GAP - (Date.now() - _last);
    _last = Math.max(Date.now(), _last + GAP);
    return wait > 0 ? sleep(wait) : Promise.resolve();
  }

  function once(path) {
    return throttle().then(function () {
      return fetch(API + path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.code !== 0) throw new Error((j && j.msg) || '接口异常');
      return j.data;
    });
  }

  /** 不过全局限速的原始请求（给批量用，靠 batch 里的错峰控制节奏） */
  function raw(path) {
    return fetch(API + path, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '接口异常');
        return j.data;
      });
  }

  /**
   * 并发跑一组请求：开 CONCURRENCY 个 worker，互相错开 GAP。
   * ★ 不能用全局 throttle 串行化 —— 那样 100 天的历史要 18 秒。
   */
  function batch(paths) {
    var out = new Array(paths.length);
    var i = 0;
    function worker() {
      if (i >= paths.length) return Promise.resolve();
      var idx = i++;
      return raw(paths[idx]).then(function (d) { out[idx] = d; }, function () { out[idx] = null; })
        .then(function () { return sleep(GAP); })
        .then(worker);
    }
    var ws = [];
    for (var k = 0; k < CONCURRENCY; k++) ws.push(sleep(k * (GAP / CONCURRENCY)).then(worker));
    return Promise.all(ws).then(function () { return out; });
  }

  /* ------------------------------------------------------------ 接口封装 */

  function baseInfo(matchId) {
    return once('/new-match/new-detail/base-info?match_id=' + matchId);
  }

  /** 韦* 的变化史 → 初盘/终盘（盘口带符号）+ 双水位 + 两个时间 */
  function weiHistory(matchId) {
    return once('/new-match/detail/odds/detail/list?match_id=' + matchId +
      '&book_id=' + BOOK_WEI + '&type_id=1').then(function (d) {
        var rows = String((d && d.detail_list) || '').split('!!').filter(Boolean).map(function (line) {
          var f = String(line).split('^');
          return {
            plate: Number(f[6]),      // ★ 带符号：负=主让，正=主受
            home: Number(f[7]),
            away: Number(f[9]),
            ts: Number(f[10])
          };
        }).filter(function (r) { return r.ts > 0 && isFinite(r.plate) && isFinite(r.home); });
        if (!rows.length) throw new Error('这家公司没有变化记录');
        var newest = rows[0], oldest = rows[rows.length - 1];   // 接口按时间倒序
        return {
          open: oldest.plate, openWater: oldest.home, openWaterAway: oldest.away, openTs: oldest.ts,
          close: newest.plate, closeWater: newest.home, closeWaterAway: newest.away, closeTs: newest.ts,
          count: rows.length, rows: rows
        };
      });
  }

  /** 某一天全部比赛（归一化；内存 + localStorage 双层缓存，第二次起几乎零成本） */
  function dayMatches(dateStr) {
    if (_day[dateStr]) return Promise.resolve(_day[dateStr]);
    var memo = (_persist.days || {})[dateStr];
    if (memo && memo.length) { _day[dateStr] = memo; return Promise.resolve(memo); }
    return once('/new-match/jc/football-list?date=' + dateStr + '&page=1').then(function (d) {
      var ml = (d && d.match_list) || {}, list = [];
      Object.keys(ml).forEach(function (day) {
        (ml[day] || []).forEach(function (e) {
          var mi = e.match_info || {}, ti = e.team_info || {};
          if (!mi.match_id) return;
          list.push({
            day: day, mid: String(mi.match_id),
            tid: String(mi.tournament_id || ''),
            homeId: String(mi.home_team_id || ''), awayId: String(mi.away_team_id || ''),
            home: ti.home_team_name || '', away: ti.away_team_name || '',
            hs: Number(mi.home_team_score || 0), as: Number(mi.away_team_score || 0),
            isEnd: !!mi.is_end,
            homeRank: Number(ti.home_rank || 0) || null,
            awayRank: Number(ti.away_rank || 0) || null
          });
        });
      });
      _day[dateStr] = list;
      /* 存进 localStorage（只留最近 100 天，别把配额挤爆） */
      try {
        _persist.days = _persist.days || {};
        _persist.days[dateStr] = list;
        var ds = Object.keys(_persist.days).sort();
        if (ds.length > 100) {
          ds.slice(0, ds.length - 100).forEach(function (k) { delete _persist.days[k]; });
        }
        localStorage.setItem(LS_CACHE, JSON.stringify(_persist));
      } catch (e) { }
      return list;
    });
  }

  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + n);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * 两支球队共用的「近 n 场同联赛」回翻：一天只问一次，两队共用结果。
   * 返回 [ [team0 的比赛…], [team1 的比赛…] ]，各自按时间倒序（[0] = 最近一场）。
   */
  function recentForTeams(teamIds, tournamentId, beforeDate, n, onStep) {
    var want = teamIds.map(function () { return []; });
    var done = 0;

    var cached = tryCache(teamIds, tournamentId, beforeDate, n);
    if (cached) {
      if (onStep) onStep(want.map(function (_, i) { return cached[i].length; }), 0, true);
      return Promise.resolve(cached);
    }

    function step() {
      var allEnough = want.every(function (w) { return w.length >= n; });
      if (allEnough || done >= MAX_DAYS) return Promise.resolve(finish());
      var dates = [];
      for (var i = 0; i < CONCURRENCY && (done + i) < MAX_DAYS; i++) dates.push(addDays(beforeDate, -(done + i + 1)));
      done += dates.length;
      return batch(dates.map(function (d) { return '/new-match/jc/football-list?date=' + d + '&page=1'; }))
        .then(function (res) {
          res.forEach(function (d, k) {
            var ml = (d && d.match_list) || {};
            Object.keys(ml).forEach(function (day) {
              (ml[day] || []).forEach(function (e) {
                var mi = e.match_info || {}, ti = e.team_info || {};
                if (!mi.match_id || !mi.is_end) return;
                if (String(mi.tournament_id) !== String(tournamentId)) return;   // ★ 同联赛
                teamIds.forEach(function (t, ti2) {
                  if (want[ti2].length >= n) return;
                  var hv = String(mi.home_team_id), av = String(mi.away_team_id);
                  if (hv !== String(t) && av !== String(t)) return;
                  var mid = String(mi.match_id);
                  if (want[ti2].some(function (x) { return x.mid === mid; })) return;
                  var isHome = hv === String(t);
                  want[ti2].push({
                    mid: mid, fullDate: day,
                    isHome: isHome,
                    gf: Number(isHome ? mi.home_team_score : mi.away_team_score) || 0,
                    ga: Number(isHome ? mi.away_team_score : mi.home_team_score) || 0,
                    opp: isHome ? (ti.away_team_name || '') : (ti.home_team_name || ''),
                    oppRank: Number(isHome ? ti.away_rank : ti.home_rank) || null
                  });
                });
              });
            });
          });
          if (onStep) onStep(want.map(function (w) { return w.length; }), done, false);
          return step();
        });
    }

    function finish() {
      var out = want.map(function (w) {
        return w.sort(function (a, b) { return a.fullDate < b.fullDate ? 1 : -1; }).slice(0, n);
      });
      try {
        _persist.team = _persist.team || {};
        var key = teamIds.join('|') + '@' + tournamentId + '@' + beforeDate;
        _persist.team[key] = { at: Date.now(), data: out };
        saveCache();
      } catch (e) { }
      return out;
    }

    return step();
  }

  function tryCache(teamIds, tournamentId, beforeDate, n) {
    try {
      var key = teamIds.join('|') + '@' + tournamentId + '@' + beforeDate;
      var hit = (_persist.team || {})[key];
      if (!hit || !hit.data || !hit.data[0] || !hit.data[1]) return null;
      if (hit.data[0].length < n && hit.data[1].length < n && Date.now() - hit.at > 30 * 60 * 1000) return null;
      return hit.data;
    } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- 主流程 */

  function parseId(input) {
    var m = String(input || '').match(/(\d{7,9})/);
    return m ? m[1] : '';
  }
  function ts2date(ts) {
    var d = new Date(Number(ts) * 1000), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function ts2local(ts) {
    var d = new Date(Number(ts) * 1000), p = function (x) { return String(x).padStart(2, '0'); };
    return ts2date(ts) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 抓一场比赛 → { patch, report, matchId }
   * patch 只含「确实抓到并校验通过」的字段；抓不到的一律不出现（不会覆盖你手填的值）。
   */
  function buildPatch(input, onProgress) {
    var rep = { filled: [], failed: [], warns: [] };
    var say = function (s) { if (onProgress) onProgress(s); };
    var matchId = parseId(input);
    if (!matchId) return Promise.reject(new Error('没认出比赛 ID（链接里应有 8 位数字，例如 …-13892692）'));

    var patch = {}, base = null, weiRes = null, me = null;

    say('① 读取比赛基础信息…');
    return baseInfo(matchId).then(function (b) {
      base = b;
      if (b.home_team_name) patch.home = b.home_team_name;
      if (b.away_team_name) patch.away = b.away_team_name;
      if (b.tournament && b.tournament.tournament_name) patch.league = b.tournament.tournament_name;
      if (b.round_info) patch.round = String(b.round_info).replace(/[^\d]/g, '') || String(b.round_info);
      var hp = String(b.home_rank || '').match(/(\d+)\s*$/);
      var ap = String(b.away_rank || '').match(/(\d+)\s*$/);
      if (hp) patch.hRank = hp[1];
      if (ap) patch.aRank = ap[1];
      rep.filled.push('联赛 / 主客队 / 轮次 / 当时排名（' + (hp ? hp[1] : '?') + ' vs ' + (ap ? ap[1] : '?') + '）');
    }, function (e) {
      rep.failed.push('基础信息：' + e.message);
      throw new Error('拿不到比赛信息，先确认链接/ID 对不对');
    }).then(function () {
      say('② 读取「韦*」初盘/终盘/水位/两个时间…');
      return weiHistory(matchId);
    }).then(function (w) {
      weiRes = w;
      patch.open = String(w.open);
      patch.close = String(w.close);
      patch.openWater = String(w.openWater);
      patch.closeWater = String(w.closeWater);
      patch.openTime = ts2local(w.openTs);
      patch.closeTime = ts2local(w.closeTs);
      /* 一致性自检：初盘/终盘盘口符号突变（比如 +1 → −1）提示一下 */
      if (w.open * w.close < 0 && Math.abs(w.open) > 1 && Math.abs(w.close) > 1) {
        rep.warns.push('初盘和终盘方向相反（' + w.open + ' → ' + w.close + '），请核对后再保存');
      }
      rep.filled.push('韦* 初盘 ' + fmtPlate(w.open) + '(' + w.openWater + ') → 终盘 ' + fmtPlate(w.close) +
        '(' + w.closeWater + ')，初盘 ' + patch.openTime + ' / 终盘 ' + patch.closeTime + '（共 ' + w.count + ' 次变化）');
    }, function (e) {
      rep.failed.push('韦* 盘口：' + e.message + '（这项请手动填，我不猜）');
    }).then(function () {
      var matchDate = ts2date(base.match_time);
      say('③ 读取比分…');
      return dayMatches(matchDate).then(function (list) {
        me = list.filter(function (x) { return x.mid === matchId; })[0] || null;
        if (me && me.isEnd) {
          patch.scoreText = me.hs + ':' + me.as;
          rep.filled.push('最终比分 ' + patch.scoreText);
        } else if (me) {
          rep.warns.push('这场还没结束（未开赛或进行中），比分先不填');
        }
        return true;
      }, function (e) {
        rep.failed.push('比分：' + e.message);
        return false;
      });
    }).then(function () {
      say('④ 读取近期赛事（同赛事≤关注）…');
      return latelyRecord(matchId);
    }).then(function (near) {
      var hid = String(base.home_team_id), aid = String(base.away_team_id);
      var tid = String(base.tournament_id);
      /* 全部赛事（用于赛程疲劳：杯赛/亚冠也算） */
      RECENT_ALL.h = teamHistory(near.home_history_match, hid, null);
      RECENT_ALL.a = teamHistory(near.away_history_match, aid, null);
      /* 同赛事近 6 场（用于⑦近6场明细 + 连赢连负） */
      var sameH = teamHistory(near.home_history_match, hid, tid).slice(0, 6);
      var sameA = teamHistory(near.away_history_match, aid, tid).slice(0, 6);
      say('④ 近6场（同赛事）：主 ' + sameH.length + '/6 · 客 ' + sameA.length + '/6，正在补当时的对手排名…');
      return fillOppRanks(sameH.concat(sameA), function (d, t) {
        if (d === t) say('④ 对手排名：' + t + ' 天的日榜已取');
      }).then(function () { return { h: sameH, a: sameA }; });
    }).then(function (arr) {
      fillRecent(patch, 'h', arr.h, rep, '主队');
      fillRecent(patch, 'a', arr.a, rep, '客队');
      /* ★ 赛程疲劳 + 连赢连负：用刚抓到的近 6 场（日期 / 主客 / 比分）推算 */
      try {
        var md = ts2date(base.match_time);
        /* ★ 疲劳必须用「全部赛事」（亚冠/杯赛也算赛程），否则间隔会算错 */
        var fh = fatigueCalc(md, (RECENT_ALL.h.length ? RECENT_ALL.h : arr.h));
        var fa = fatigueCalc(md, (RECENT_ALL.a.length ? RECENT_ALL.a : arr.a));
        if (fh.label) patch.hFatigue = fh.label;
        if (fa.label) patch.aFatigue = fa.label;
        patch.hStreak = streakCalc(arr.h);
        patch.aStreak = streakCalc(arr.a);
        var prevH = (RECENT_ALL.h[0] || null), prevA = (RECENT_ALL.a[0] || null);
        rep.filled.push('赛程疲劳（主）' + (fh.label || '—') + '：' + fh.why +
          (prevH ? '（上一场 ' + prevH.fullDate + ' ' + prevH.tname + ' ' + prevH.opp + '）' : ''));
        rep.filled.push('赛程疲劳（客）' + (fa.label || '—') + '：' + fa.why +
          (prevA ? '（上一场 ' + prevA.fullDate + ' ' + prevA.tname + ' ' + prevA.opp + '）' : ''));
        rep.filled.push('连赢连负：主 ' + patch.hStreak + ' / 客 ' + patch.aStreak);
      } catch (e) {
        rep.failed.push('赛程疲劳推算：' + e.message);
      }
    }).then(function () {
      if (me && me.homeRank && !patch.hRank) patch.hRank = String(me.homeRank);
      if (me && me.awayRank && !patch.aRank) patch.aRank = String(me.awayRank);
      say('⑤ 读取主客场战绩 + 历史交锋…');
      return Promise.all([
        analysisData(matchId).catch(function (e) { rep.failed.push('主客场战绩：' + e.message); return null; }),
        h2hData(matchId).catch(function (e) { rep.failed.push('历史交锋：' + e.message); return null; })
      ]);
    }).then(function (x) {
      fillStandings(patch, x[0], rep);
      fillH2H(patch, x[1], base, rep);
      return { patch: patch, report: rep, matchId: matchId, wei: weiRes };
    });
  }


  /* ============================================================
   * 赛程疲劳 / 连赢连负 —— 用近 6 场的「日期 + 主客 + 比分」推算
   *
   * ★ 输出必须是调参中心「加减分库」里存在的标签，否则引擎查表查不到 = 等于没填：
   *     fatigue: 间隔4-5天(0) / 一周双赛(≤3天)(-0.125) / 休息充足(≥6天)(+0.05)
   *              连续2个客场(-0.1) / 连续3个客场(-0.15) / 下场有欧战，本场可能轮换(-0.15)
   *     streak : 其他情况(0) / 连续3场胜利(+0.1) / 连续3场失利(-0.1)
   * ★ 疲劳只有一个字段，多个信号同时成立时取「扣分最重」的那个，并把全部依据写进报告。
   * ============================================================ */

  /* ============================================================
   * 主客场战绩 + 历史交锋（V站的「数据分析」页，两个接口）
   *
   *   /new-match/football/detail/data-analysis  → data.table_score_rank.whole
   *        home_table.home  = 主队【主场】{matches_count, points, …}   → hGames / hPts
   *        home_table.away  = 主队【客场】{matches_count, points, …}   → aGames / aPts
   *        home_table.total.position → 主队排名 ; home_table.grade = （中游）→ hTier
   *   /new-match/football/detail/history-battle → data.match_list（历史交锋，倒序）
   *        → 按【主队视角】数近 3 次 胜/平/负，映射成加减分库的「近3次对战X胜Y平Z负」
   * ============================================================ */
  function analysisData(matchId) {
    return once('/new-match/football/detail/data-analysis?match_id=' + matchId);
  }
  function h2hData(matchId) {
    return once('/new-match/football/detail/history-battle?match_id=' + matchId);
  }

  /* 加减分库 hist 的全部标签（键 = 胜-平-负），一个都不能拼错，拼错引擎查不到 */
  var H2H_LABEL = {
    '3-0-0': '近3次对战3胜', '2-1-0': '近3次对战2胜1平', '2-0-1': '近3次对战2胜1负',
    '1-2-0': '近3次对战1胜2平', '1-1-1': '近3次对战1胜1平1负', '0-3-0': '近3次对战3平',
    '1-0-2': '近3次对战1胜2负', '0-2-1': '近3次对战2平1负', '0-1-2': '近3次对战1平2负',
    '0-0-3': '近3次对战3负'
  };

  function gradeToTier(g) {
    var s = String(g || '');
    if (s.indexOf('上游') >= 0) return '上游';
    if (s.indexOf('下游') >= 0) return '下游';
    if (s.indexOf('中游') >= 0) return '中游';
    return '';
  }

  /** 把主客场战绩写进 patch（只填空格，不覆盖你手填的） */
  function fillStandings(patch, data, rep) {
    if (!data || !data.table_score_rank || !data.table_score_rank.whole) {
      rep.failed.push('主客场战绩：接口没返回 table_score_rank');
      return;
    }
    var w = data.table_score_rank.whole;
    var ht = w.home_table || {}, at = w.away_table || {};
    var hHome = ht.home || {}, hAway = ht.away || {}, hTotal = ht.total || {};

    var g1 = Number(hHome.matches_count), p1 = Number(hHome.points);
    if (isFinite(g1)) patch.hGames = g1;
    if (isFinite(p1)) patch.hPts = p1;
    var g2 = Number(hAway.matches_count), p2 = Number(hAway.points);
    if (isFinite(g2)) patch.aGames = g2;          /* ★ 注意：这是「主队客场」的场次 */
    if (isFinite(p2)) patch.aPts = p2;
    if (!patch.hRank && hTotal.position) patch.hRank = String(hTotal.position);
    if (!patch.aRank && (at.total || {}).position) patch.aRank = String(at.total.position);
    if (!patch.hTier) { var t = gradeToTier(ht.grade); if (t) patch.hTier = t; }

    rep.filled.push('主队主场 ' + hHome.matches_count + ' 场 / ' + hHome.points + ' 分（' +
      hHome.win_count + '胜' + hHome.draw_count + '平' + hHome.loss_count + '负，进失 ' + hHome.goals + '）' +
      '　客场 ' + hAway.matches_count + ' 场 / ' + hAway.points + ' 分（' +
      hAway.win_count + '胜' + hAway.draw_count + '平' + hAway.loss_count + '负，进失 ' + hAway.goals + '）');
    if (ht.grade) rep.filled.push('主队排名区间（V站给的）：' + String(ht.grade).replace(/[（）]/g, '') +
      '（客队 ' + String(at.grade || '—').replace(/[（）]/g, '') + '）');
  }

  /**
   * 历史交锋：按主队视角数近 3 次
   *
   * ★ 用户校对（截图红框）：必须勾【同赛事】，只算同一个联赛的交手。
   *   不筛的话会把亚冠/杯赛的碰面也算进来 → 胜负数和标签都错。
   */
  function fillH2H(patch, data, base, rep) {
    var all = (data && data.match_list) || [];
    if (!all.length) { rep.failed.push('历史交锋：接口没返回比赛列表'); return; }

    /* 只保留同赛事（tournament_id 相同） */
    var tid = String(base.tournament_id || '');
    var same = all.filter(function (m) { return String(m.tournament_id) === tid; });
    if (!same.length) {
      rep.warns.push('历史交锋：同赛事居然一场都没有（可能首次交手），这一项留空');
      return;
    }
    if (same.length < all.length) {
      rep.filled.push('历史交锋：共 ' + all.length + ' 次交手，其中同赛事 ' + same.length + ' 次（其余是杯赛/亚冠，已排除）');
    }
    if (same.length < 3) {
      rep.warns.push('历史交锋：同赛事只有 ' + same.length + ' 场，凑不满 3 场，这一项留空（不猜）');
      return;
    }

    var sorted = same.slice().sort(function (a, b) { return Number(b.match_time) - Number(a.match_time); });
    var hid = String(base.home_team_id);
    var w = 0, d = 0, l = 0, names = [];
    sorted.slice(0, 3).forEach(function (m) {
      var isHome = String(m.home_team_id) === hid;
      var hs = Number(m.home_team_score), as = Number(m.away_team_score);
      if (!isFinite(hs) || !isFinite(as)) return;
      var gf = isHome ? hs : as, ga = isHome ? as : hs;
      if (gf > ga) w++; else if (gf < ga) l++; else d++;
      names.push(ts2date(m.match_time) + ' ' + (m.home_team_name || '') + ' ' + hs + ':' + as + ' ' + (m.away_team_name || '') +
        '（' + (m.tournament_name || '') + '）');
    });
    var lab = H2H_LABEL[w + '-' + d + '-' + l];
    if (!lab) { rep.warns.push('历史交锋：胜负组合 ' + w + '-' + d + '-' + l + ' 不在加减分库里，留空'); return; }
    patch.hHist = lab;
    rep.filled.push('历史交锋（同赛事·主队视角近 3 次）：' + w + '胜' + d + '平' + l + '负 → ' + lab +
      '　[' + names.join(' / ') + ']');
  }

  /* ============================================================
   * 近期赛事（v15.7.3，修「近6场不准 / 疲劳间隔不对」）
   *
   *   ① 近 6 场 = 页面「近期赛事」+ 勾【同赛事】那张表
   *   ② 赛程疲劳 = 「未来赛事」里的【间隔】= 上一场距今几天，**所有赛事都算**
   *   ③ 对手排名 = 那场比赛左侧的【赛前积分榜】（pre-ranking 接口）
   *
   * 一个接口拿全：/new-match/football/detail/lately-record?match_id=
   *   一次返回 20 场（含亚冠/杯赛），带 tournament_id / 比分 / 主客 / 日期 / 队 id。
   * ============================================================ */
  var RECENT_ALL = { h: [], a: [] };

  function latelyRecord(matchId) {
    return once('/new-match/football/detail/lately-record?match_id=' + matchId);
  }

  /** 把接口里的一场比赛，转成「某队视角」的统一结构 */
  function normItem(m, teamId) {
    var isHome = String(m.home_team_id) === String(teamId);
    var hs = Number(m.home_team_score), as = Number(m.away_team_score);
    if (!isFinite(hs) || !isFinite(as)) return null;
    return {
      mid: String(m.match_id),
      fullDate: ts2date(m.match_time),
      ts: Number(m.match_time) || 0,
      isHome: isHome,
      gf: isHome ? hs : as,
      ga: isHome ? as : hs,
      opp: isHome ? (m.away_team_name || '') : (m.home_team_name || ''),
      oppId: String(isHome ? m.away_team_id : m.home_team_id),
      tid: String(m.tournament_id),
      tname: m.tournament_name || '',
      oppRank: null
    };
  }

  /** 取一队的历史比赛（新的在前），tid 给了就按赛事过滤 */
  function teamHistory(list, teamId, tid) {
    return (list || []).map(function (m) { return normItem(m, teamId); })
      .filter(function (x) { return x && x.ts > 0; })
      .filter(function (x) { return !tid || x.tid === String(tid); })
      .sort(function (a, b) { return b.ts - a.ts; });
  }

  /**
   * 给每场补「当时对手排名」= 那场比赛的【赛前积分榜】
   *
   * ★ 接口：/new-match/football/detail/pre-ranking?match_id=X&sport_id=1
   *   → data.pre_match_ranking = [{team_id, team_name, points, sort}]，sort 就是名次
   *   这是页面左侧红框「赛前积分榜」的同一数据源。
   * ★ 不能用 data-analysis 的 total.position（那是【赛后】的榜，
   *   例：10-31 利雅得青年 赛后第10、赛前第12，差 2 名）。
   * ★ 也不用竞彩日榜（日榜没有亚冠/杯赛）。
   * ★ 定位对手用 team_id 精确匹配；结果按 match_id 缓存。
   */
  function fillOppRanks(list, onStep) {
    if (!list.length) return Promise.resolve(list);
    _persist.preRank = _persist.preRank || {};
    var cache = _persist.preRank;
    var todo = [];
    list.forEach(function (m) {
      var hit = cache[m.mid];
      if (hit && hit[String(m.oppId)] !== undefined) { m.oppRank = Number(hit[String(m.oppId)]); return; }
      todo.push(m);
    });
    if (!todo.length) return Promise.resolve(list);

    var i = 0, done = 0;
    function worker() {
      if (i >= todo.length) return Promise.resolve();
      var m = todo[i++];
      return once('/new-match/football/detail/pre-ranking?match_id=' + m.mid + '&sport_id=1').then(function (d) {
        var arr = (d && d.pre_match_ranking) || [];
        if (!arr.length) throw new Error('没有赛前积分榜');
        var map = {};
        arr.forEach(function (x) {
          if (x && x.team_id !== undefined && x.team_id !== null) map[String(x.team_id)] = String(x.sort || '');
        });
        cache[m.mid] = map;
        var r = map[String(m.oppId)];
        if (r) m.oppRank = Number(r);
        else throw new Error('赛前积分榜里找不到对手 ' + m.opp);
      }, function () { }).then(function () {
        done++;
        if (onStep) onStep(done, todo.length);
        return worker();
      });
    }
    var ws = [];
    for (var k = 0; k < Math.min(CONCURRENCY, todo.length); k++) ws.push(worker());
    return Promise.all(ws).then(function () {
      try {
        var ks = Object.keys(cache);
        if (ks.length > 400) ks.slice(0, ks.length - 400).forEach(function (x) { delete cache[x]; });
        localStorage.setItem(LS_CACHE, JSON.stringify(_persist));
      } catch (e) { }
      return list;
    });
  }

  function daysBetween(d1, d2) {
    var a = Date.parse(String(d1) + 'T00:00:00Z'), b = Date.parse(String(d2) + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  /**
   * 赛程疲劳
   *
   * ★ 用户拍板的读法（1.docx 红框）：「未来赛事」那一列的【间隔】= 上一场距今几天。
   *   所以 **间隔优先**：
   *     间隔 ≤3 天      → 一周双赛(≤3天)   -0.125
   *     间隔 4~5 天     → 间隔4-5天         0      ← 这一档不扣分，才让「连续客场」接管
   *     间隔 ≥6 天      → 休息充足(≥6天)   +0.05
   *   连续客场只作为补充信号：间隔那一档是 0 分时，改用 连续2/3个客场。
   *
   * ★ 关键：间隔必须按【所有赛事】算（亚冠/杯赛也算赛程），不能只算同联赛。
   *   用 lately-record 的全量列表（RECENT_ALL），别再按 tournament_id 过滤。
   */
  function fatigueCalc(matchDate, recents) {
    if (!recents || !recents.length) return { label: '', why: '没有近期比赛数据' };
    var notes = [], interval = null, away = null;

    var gap = daysBetween(recents[0].fullDate, matchDate);
    if (gap !== null && gap >= 0) {
      if (gap <= 3) interval = { label: '一周双赛(≤3天)', w: -0.125, why: '间隔 ' + gap + ' 天' };
      else if (gap <= 5) interval = { label: '间隔4-5天', w: 0, why: '间隔 ' + gap + ' 天' };
      else interval = { label: '休息充足(≥6天)', w: 0.05, why: '间隔 ' + gap + ' 天' };
      notes.push(interval.why);
    }

    var awayRun = 0;
    for (var i = 0; i < recents.length; i++) {
      if (recents[i].isHome) break;
      awayRun++;
    }
    if (awayRun >= 3) away = { label: '连续3个客场', w: -0.15, why: '最近 ' + awayRun + ' 场都是客场' };
    else if (awayRun === 2) away = { label: '连续2个客场', w: -0.1, why: '最近 2 场都是客场' };
    if (away) notes.push(away.why);

    var pick = interval || away;
    /* 间隔落在「4-5 天」这一档（0 分）时，让连续客场决定 */
    if (interval && away && Math.abs(interval.w) < 1e-9) pick = away;
    if (!pick) return { label: '', why: '日期不详' };

    return {
      label: pick.label,
      why: notes.join('；'),
      gap: gap, awayRun: awayRun, interval: interval, away: away
    };
  }

  function streakCalc(recents) {
    if (!recents || recents.length < 3) return '其他情况';
    var r = recents.slice(0, 3).map(function (m) {
      return m.gf > m.ga ? 'W' : (m.gf < m.ga ? 'L' : 'D');
    });
    if (r[0] === 'W' && r[1] === 'W' && r[2] === 'W') return '连续3场胜利';
    if (r[0] === 'L' && r[1] === 'L' && r[2] === 'L') return '连续3场失利';
    return '其他情况';
  }

  function fmtPlate(v) {
    if (v === 0) return '平手';
    var s = v > 0 ? '受' : '';
    var a = Math.abs(v);
    var map = { 0.25: '平半', 0.5: '半球', 0.75: '半一', 1: '一球', 1.25: '一球/球半', 1.5: '球半', 1.75: '球半/两球', 2: '两球', 2.5: '两球半', 3: '三球' };
    return s + (map[a] || (a + '球'));
  }

  /** 近6场写入：第 6 场 = 最近一场（与表单一致）；hO = 对手排名 */
  function fillRecent(patch, pre, list, rep, who) {
    if (!list || !list.length) { rep.failed.push(who + '近6场：一场都没找到'); return; }
    var n = Math.min(6, list.length);
    for (var i = 0; i < n; i++) {
      var m = list[i], idx = 6 - i;
      patch[pre + 'G' + idx] = String(m.gf);
      patch[pre + 'C' + idx] = String(m.ga);
      if (m.oppRank) patch[pre + 'O' + idx] = String(m.oppRank);
    }
    rep.filled.push(who + '近6场 ' + n + ' 场（对手排名 ' +
      list.slice(0, n).map(function (x) { return x.oppRank || '?'; }).join(' / ') + '）');
    if (n < 6) rep.warns.push(who + '只找到 ' + n + ' 场同联赛比赛（赛季刚开始或休赛期，属正常）');
  }

  global.VZ = {
    parseId: parseId,
    buildPatch: buildPatch,
    weiHistory: weiHistory,
    baseInfo: baseInfo,
    dayMatches: dayMatches,
    recentForTeams: recentForTeams,
    fatigueCalc: fatigueCalc,
    streakCalc: streakCalc,
    fmtPlate: fmtPlate,
    BOOK_WEI: BOOK_WEI,
    clearCache: function () {
      _day = {};
      try { localStorage.removeItem(LS_CACHE); } catch (e) { }
      _persist = {};
    }
  };
})(window);
