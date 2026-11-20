/* =========================================================================
 * mod-batch.js — 模块 ③ 批量计算
 *   ① 整行快录：粘贴一行或多行（逗号 / 全角逗号 / 制表符分隔）→ 解析预览 → 入库或送去校对
 *   ② 单场录入 · 盘：下拉表单逐项填，右侧实时出「盘」的完整结果
 *   ③ 记录库 · 赛果：明细表 + 逐场录比分 / 自动判上盘是否赢盘 / 批量改
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const state = {
    // 手机端只做单场测试 → 默认直接进「② 单场录入 · 盘」；桌面端仍从「① 整行快录」开始
    tab: (window.matchMedia && window.matchMedia('(max-width: 767px)').matches) ? 'form' : 'quick', form: null, msg: '', msgKind: '',
    quickText: '', quickRows: null, focusSeq: null, desc: true, editSeq: null, pickIdx: 0,
    page: 1, pageSize: 50,        // ★ v15 记录库分页
    vzInput: '',                  // ★ 自动填充：上次输入的链接/ID
    vzReport: null,               // ★ 自动填充：上次的抓取报告（✔/!/✘ 三色）
  };
  let vzBusy = false;

  function nowStr() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 右侧实时结果区 + 当前表单引用（只重画右侧，不重建表单 → 不跳顶、不丢焦点） */
  let liveBox = null, formRef = null;

  /* ============================================================ ① 整行快录 */
  /** 出厂示例的那一行（给「填入示例」按钮用） */
  function sampleLine() {
    const s = (window.SEED_ROWS || [])[10] || (window.SEED_ROWS || [])[0];
    return s ? C.inputToComma(s) : '';
  }

  function panelQuick(host) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('① 整行快录'),
      U.el('span', { class: 'hint', text: '粘贴一行或多行 → 一次入库多场，不用逐项下拉' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '从<b>任何地方</b>复制一行数据粘进来就行：<b>Excel 里选中整行</b>（制表符分隔）、' +
        '逗号分隔、全角逗号分隔，程序会自动认。<br>' +
        '一行一场，可以一次贴很多行。列的顺序见下面的「字段顺序」。' +
        '引擎自己算的那几列（本心实力盘 / 场景 / 仲裁 / 评分 / 强度 / 赛果）随便填，填 <code>无</code> 或留空都行 —— ' +
        '反正入库后会按当前参数重算。'
    }));

    /* —— 字段顺序（可折叠） —— */
    const det = U.el('details');
    det.appendChild(U.el('summary', { text: '展开字段顺序（共 ' + C.INPUT_FIELDS.length + ' 列）' }));
    const legend = U.el('div', { class: 'legend' });
    C.INPUT_FIELDS.forEach(function (f, i) {
      const isEngine = C.PLACEHOLDER_INPUT.indexOf(f.k) >= 0;
      const isExtra = (i + 1) > C.INPUT_FIELDS.length - 2;
      legend.appendChild(U.el('span', {
        text: (i + 1) + '.' + f.n,
        style: isEngine ? { color: 'var(--txt-3)' } : (isExtra ? { color: 'var(--warn)' } : null),
        title: isEngine ? '引擎自己算的列，随便填' : (isExtra ? '可选输入' : ''),
      }));
    });
    det.appendChild(legend);
    det.appendChild(U.note('灰色的是<b>引擎自己算的列</b>（填 <code>无</code> 或留空即可，入库后会重算）；' +
      '黄色的是<b>两个可选输入</b>「主队/客队近 6 场实际场次」—— ' +
      '它和前面的「主队主场场次」是<b>两个不同字段</b>，别混。不填时程序按近 6 场非空槽位数估算。', ''));
    c.appendChild(det);

    /* —— 输入区 —— */
    const ta = U.textarea(state.quickText || '', function (v) { state.quickText = v; }, {
      rows: 9,
      placeholder: sampleLine() || '把整行粘到这里…',
    });
    c.appendChild(ta);

    const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    row.appendChild(U.btn('▶ 解析预览', function () { doQuickParse(false); }, 'pri'));
    row.appendChild(U.btn('解析并全部写入记录库', function () { doQuickParse(true); }));
    row.appendChild(U.btn('填入示例（大阪钢巴 vs 神户胜利船）', function () {
      state.quickText = sampleLine(); state.quickRows = null; state.msg = '';
      window.App.refresh();
    }, 'ghost'));
    row.appendChild(U.btn('从 CSV / TXT 文件读入', function () {
      U.pickFile('.csv,.txt,text/csv,text/plain', function (f) {
        const fr = new FileReader();
        fr.onload = function () { state.quickText = String(fr.result); state.quickRows = null; window.App.refresh(); };
        fr.readAsText(f, 'utf-8');
      });
    }, 'ghost'));
    row.appendChild(U.btn('清空', function () {
      state.quickText = ''; state.quickRows = null; state.msg = ''; window.App.refresh();
    }, 'ghost'));
    c.appendChild(row);

    if (state.msg) c.appendChild(U.note(state.msg, state.msgKind));

    /* —— 解析结果 —— */
    const qr = state.quickRows;
    if (qr) {
      c.appendChild(U.el('div', { class: 'sec-title', text: '解析结果（' + qr.rows.length + ' 场）' }));
      if (qr.rows.length) {
        c.appendChild(U.el('div', { html: U.table([
          { k: 'i', n: '#', w: '36px' },
          { k: 'line', n: '原行', w: '52px' },
          { k: 'sep', n: '分隔符', w: '66px' },
          { k: 'league', n: '联赛', w: '56px' },
          { k: 'match', n: '对阵', w: '170px' },
          { k: 'open', n: '初盘', w: '62px' },
          { k: 'close', n: '终盘', w: '62px' },
          { k: 'water', n: '水位', w: '86px' },
          { k: 'up', n: '上盘方', w: '64px' },
          { k: 'ok', n: '检查', w: '64px' },
          { k: 'calc', n: '试算', w: '250px' },
        ], qr.rows.map(function (r, i) {
          const ev = C.evaluate(r.inp, C.store.P, C.store.LIB);
          return {
            i: i + 1,
            line: r.line,
            sep: r.delim === '\t' ? '制表符' : r.delim === '，' ? '全角逗号' : '逗号',
            league: U.esc(r.inp.league || '—'),
            match: U.esc((r.inp.home || '?') + ' vs ' + (r.inp.away || '?')),
            open: ev.J === null ? '—' : U.fmt(ev.J, 2),
            close: ev.K === null ? '' : U.fmt(ev.K, 2),
            water: U.fmt(ev.Lw, 2) + '→' + U.fmt(ev.Mw, 2),
            up: ev.upSide === '平手' ? U.pill('平手', 'mute') : U.pill(ev.upSide, 'info'),
            ok: r.bad.length ? U.pill(r.bad.length + ' 项提示', 'warn') : U.pill('齐', 'ok'),
            calc: '<span class="pill info">' + U.esc(ev.corePanText) + '</span> <span class="mini">' +
              U.esc(ev.scene) + ' · 分 ' + U.fmt(ev.total, 1) + ' · ' + U.esc(ev.strength) + '</span>',
          };
        })) }));

        const r2 = U.el('div', { class: 'row' });
        r2.appendChild(U.btn('把第 1 场送去「② 单场录入」逐项校对', function () { toQuickForm(0); }, 'pri'));
        r2.appendChild(U.btn('全部写入记录库（' + qr.rows.length + ' 场）', function () { commitQuick(); }));
        c.appendChild(r2);
      }
      if (qr.bad.length) {
        c.appendChild(U.note('<b>' + qr.bad.length + ' 条提示</b>（不影响入库，但建议先看一眼）：<br>· ' +
          qr.bad.slice(0, 12).map(U.esc).join('<br>· ') + (qr.bad.length > 12 ? '<br>· …' : ''), 'warn'));
      }
      if (qr.skipped.length) {
        c.appendChild(U.note('跳过了 ' + qr.skipped.length + ' 行：<br>· ' +
          qr.skipped.slice(0, 8).map(U.esc).join('<br>· '), ''));
      }
    }
    host.appendChild(c);
  }

  function doQuickParse(writeNow) {
    const res = C.parseCommaText(state.quickText || '');
    state.quickRows = res;
    const n = res.rows.length;
    state.msgKind = n ? (res.bad.length ? 'warn' : 'ok') : 'bad';
    state.msg = n
      ? ('解析到 <b>' + n + '</b> 场' + (res.bad.length ? '，有 ' + res.bad.length + ' 条提示' : '，没有问题') +
        (res.skipped.length ? '，跳过 ' + res.skipped.length + ' 行' : '') + '。')
      : '没解析出任何一场 —— 检查一下有没有粘进来、分隔符对不对。';
    if (writeNow && n) { commitQuick(); return; }
    window.App.refresh();
  }

  function commitQuick() {
    const qr = state.quickRows;
    if (!qr || !qr.rows.length) return U.toast('先点「解析预览」', 'warn');
    let n = 0;
    qr.rows.forEach(function (r) {
      const clean = {};
      for (const k in r.inp) {
        if (r.inp[k] !== '' && r.inp[k] !== undefined && r.inp[k] !== null) clean[k] = r.inp[k];
      }
      const rec = C.newRecord(clean);
      rec.note = clean.note || ('快录 ' + nowStr());
      C.store.rows.push(rec); n++;
    });
    C.saveRows();
    state.quickRows = null; state.quickText = ''; state.msg = '';
    U.toast('已写入 ' + n + ' 场（记录库共 ' + C.store.rows.length + ' 条）', 'ok');
    state.tab = 'res';
    window.App.refresh(); window.App.updateFoot();
  }

  function toQuickForm(i) {
    const qr = state.quickRows;
    if (!qr || !qr.rows[i || 0]) return U.toast('先点「解析预览」', 'warn');
    state.form = Object.assign(C.blankInput(), qr.rows[i || 0].inp);
    state.editSeq = null;
    state.tab = 'form';
    U.toast('已送入「② 单场录入」，可逐项改', 'ok');
    window.App.refresh();
  }


  /* ============================================================
   * ⚡ 阵容深度自动推算（用球员库的位置结构，不联网）
   *
   * 输出必须是「调参中心 → 加减分库 → depth」里的标签：
   *   深度雄厚(0.7) / 深度一般(1.0) / 深度薄弱(1.4)
   * 它是个**倍数**（越大越吃亏）：伤停权重 = 伤病值 × 深度倍数。
   *
   * 判定思路（可解释、不掺玄学）：
   *   · 先按 8 个位置档点人数：门将 / 中卫 / 边后卫 / 后腰 / 中前卫 / 前腰 / 边路 / 中锋
   *   · 有 2 个以上"位置不够人"（门将<2、中卫<3、后卫<6、中场<5、前锋<3、总人数<18）→ 薄弱
   *   · 只有 1 个短板 → 一般
   *   · 全都不缺 且 总人数≥24 且 门将≥3 且 后卫≥8 且 中场≥8 且 前锋≥5 → 雄厚
   * ============================================================ */
  const DEPTH_BUCKET = {
    '守门员': 'GK',
    '中卫': 'CB', '后卫': 'CB',
    '左后卫': 'FB', '右后卫': 'FB',
    '后腰': 'DM',
    '中前卫': 'CM', '中场': 'CM',
    '前腰': 'AM',
    '左边锋': 'W', '右边锋': 'W', '左中场': 'W', '右中场': 'W',
    '中锋': 'ST', '前锋': 'ST', '影锋': 'ST'
  };

  let DEPTH_TIP = '';

  function findTeamInLib(lg, name) {
    const Pl = window.Players;
    if (!Pl || !lg || !name) return null;
    const teams = Pl.teamsOf(lg) || [];
    const n = String(name).trim();
    if (teams.indexOf(n) >= 0) return n;
    const hit = teams.filter(function (t) {
      return t.indexOf(n) >= 0 || n.indexOf(t) >= 0;
    });
    /* 只接受唯一匹配，避免「曼城」撞到「曼城U21」之类 */
    return hit.length === 1 ? hit[0] : null;
  }

  /** 同联赛各队的总身价（万欧），用来算「本队在全联赛的深度分位」 */
  function leagueValues(lg) {
    const Pl = window.Players;
    const out = [];
    (Pl.teamsOf(lg) || []).forEach(function (t) {
      const list = Pl.roster(lg, t);
      if (!list.length) return;
      let sum = 0, cnt = 0;
      list.forEach(function (p) { const v = Number(p.val); if (isFinite(v) && v > 0) { sum += v; cnt++; } });
      out.push({ team: t, total: sum, priced: cnt, n: list.length });
    });
    return out.sort(function (a, b) { return a.total - b.total; });
  }

  function depthOf(list, lgValues, teamName) {
    const c = { GK: 0, CB: 0, FB: 0, DM: 0, CM: 0, AM: 0, W: 0, ST: 0 };
    list.forEach(function (p) { c[DEPTH_BUCKET[p.pos] || 'CM']++; });
    const total = list.length;
    const def = c.CB + c.FB, mid = c.DM + c.CM + c.AM, att = c.W + c.ST;

    /* ① 结构硬伤：位置都不够人 → 直接薄弱（这是真短板，比身价更硬） */
    const thin = [];
    if (c.GK < 2) thin.push('门将只有 ' + c.GK + ' 人');
    if (c.CB < 3) thin.push('中卫只有 ' + c.CB + ' 人');
    if (def < 5) thin.push('后卫只有 ' + def + ' 人');
    if (mid < 4) thin.push('中场只有 ' + mid + ' 人');
    if (att < 2) thin.push('前锋只有 ' + att + ' 人');

    /* ② 身价分位：本队总身价在全联赛排第几（这才是"深度/板凳含金量"） */
    let sum = 0;
    list.forEach(function (p) { const v = Number(p.val); if (isFinite(v) && v > 0) sum += v; });
    let pct = null, rank = 0, all = 0;
    if (lgValues && lgValues.length >= 4 && sum > 0) {
      all = lgValues.length;
      const idx = lgValues.findIndex(function (x) { return x.team === teamName; });
      if (idx >= 0) {
        rank = all - idx;              /* ★ 从高到低排，第1=最贵 */
        pct = all > 1 ? idx / (all - 1) : 0.5;
      }
    }

    let label, by;
    if (thin.length >= 2) { label = '深度薄弱'; by = '位置硬伤：' + thin.join('、'); }
    else if (thin.length === 1) { label = '深度一般'; by = '位置短板：' + thin.join('、'); }
    else if (pct !== null && pct >= 0.67) { label = '深度雄厚'; by = '总身价全联赛第 ' + rank + '/' + all + '（最富的三分之一）'; }
    else if (pct !== null && pct <= 0.33) { label = '深度薄弱'; by = '总身价全联赛第 ' + rank + '/' + all + '（最穷的三分之一）'; }
    else { label = '深度一般'; by = pct !== null ? ('总身价全联赛第 ' + rank + '/' + all + '（中游）') : '身价数据不足，按位置结构判'; }

    return {
      label: label, total: total, c: c, def: def, mid: mid, att: att, thin: thin,
      sum: sum, rank: rank, all: all, pct: pct,
      why: '共 ' + total + ' 人（门将 ' + c.GK + '/后卫 ' + def + '/中场 ' + mid + '/前锋 ' + att + '）' +
        (sum > 0 ? '，总身价 ' + Math.round(sum) + ' 万欧' : '') + '；' + by
    };
  }

  /* ============================================================
   * ⚕ 用 Transfermarkt 自动算「伤病修正 / 阵容深度 / 停赛修正」
   *
   * 走本地后端（TM 封装服务没开 CORS，浏览器直连不了）：
   *   POST /api/tm/injuries {league, home, away, homeTm, awayTm}
   * 后端逻辑见 竞彩计算器/tm_injury.py：
   *   每队按身价取前 13 人 → 查 injuries / absences → 判断「现在还在伤/还在停」
   *   → 数核心(前3)/主力(前11)缺阵人数 → 映射成加减分库原文标签
   * ★ 不覆盖你手填过的东西？—— 这里是"自动算"按钮，点了就以 TM 为准（可再手动改）。
   * ============================================================ */
  let TM_TIP = '';

  function apiBases() {
    const out = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') out.push(location.origin);
    ['http://127.0.0.1:8765', 'http://127.0.0.1:8766', 'http://127.0.0.1:8767'].forEach(function (b) {
      if (out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }

  function apiPost(path, body) {
    const bases = apiBases();
    let i = 0;
    function next() {
      if (i >= bases.length) return Promise.reject(new Error('连不上本地后端（先双击 竞彩计算器\\启动.bat）'));
      const base = bases[i++];
      const _u = window.withToken ? window.withToken(base + path) : (base + path);
      return fetch(_u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function () { return next(); });
    }
    return next();
  }

  /** 从球员库 meta.full（阿森纳（Arsenal FC））里取 TM 英文名 */
  function tmNameOf(lg, team) {
    try {
      const P = window.Players && window.Players.PL();
      if (!P || !P.meta) return '';
      const meta = P.meta[lg + '|' + team] || {};
      const m = String(meta.full || '').match(/[（(]([^）)]+)[）)]/);
      return m ? m[1].trim() : '';
    } catch (e) { return ''; }
  }

  /** 取库里的名单（只挑带 TM 球员 ID 的）；没有 ID 就返回 null，让后端走"按队名找队" */
  function idSquadOf(lg, team) {
    try {
      if (!window.Players) return null;
      const t = findTeamInLib(lg, team);
      if (!t) return null;
      const list = (window.Players.roster(lg, t) || []).filter(function (p) { return p.id; });
      if (!list.length) return null;
      return list.map(function (p) {
        return { id: String(p.id), num: p.num, name: p.name, pos: p.pos, val: p.val };
      });
    } catch (e) { return null; }
  }

  let TM_BUSY = false;

  function autoTmInjury() {
    const inp = state.form;
    if (!inp) return U.toast('先打开「单场录入」', 'warn');
    if (!inp.league) return U.toast('先在「① 基本信息」选联赛', 'warn');
    if (!inp.home || !inp.away) return U.toast('先把主队、客队名称填上', 'warn');
    if (TM_BUSY) return U.toast('上一次还在查，等它返回', 'warn');
    TM_BUSY = true;
    TM_TIP = '⏳ 正在查 Transfermarkt：每队按身价取前 13 名球员的伤病/停赛，首次约 5~8 秒，之后走缓存秒出…';
    window.App.refresh();
    /* ★ 库里已经有 TM 球员 ID 的话，直接把名单发过去 —— 后端就不用再"按队名找队"了 */
    const hSq = idSquadOf(inp.league, inp.home);
    const aSq = idSquadOf(inp.league, inp.away);
    apiPost('/api/tm/injuries', {
      league: inp.league, home: inp.home, away: inp.away,
      homeTm: tmNameOf(inp.league, inp.home), awayTm: tmNameOf(inp.league, inp.away),
      homeSquad: hSq, awaySquad: aSq
    }).then(function (r) {
      TM_BUSY = false;
      if (!r || !r.ok) {
        TM_TIP = '✘ ' + ((r && r.error) || '后端没返回');
        window.App.refresh();
        return U.toast(TM_TIP, 'bad', 6000);
      }
      const h = r.home || {}, a = r.away || {};
      if (h.ok) {
        inp.hInjury = h.injury; inp.hDepth = h.depth; inp.hSuspend = h.suspend;
      }
      if (a.ok) {
        inp.aInjury = a.injury; inp.aDepth = a.depth; inp.aSuspend = a.suspend;
      }
      const via = (hSq && aSq) ? '用你库里的球员 ID 直接查（没走队名翻译）'
        : (hSq || aSq) ? '一边用库里的 ID，一边按队名去 TM 找'
          : '库里还没有 TM 球员 ID，按队名去 TM 找的阵容（先点「🆔 补齐 TM 球员 ID」会更快更准）';
      TM_TIP = (r.text || '') + '\n\n查询方式：' + via +
        '\nTM 请求余额 ' + r.budgetLeft + '/' + r.budgetMax + '（算完可手动改）';
      state.form = inp;
      window.App.refresh();
      U.toast('已按 Transfermarkt 填好伤病/深度/停赛', 'ok', 5000);
    }, function (e) {
      TM_BUSY = false;
      TM_TIP = '✘ ' + e.message;
      window.App.refresh();
    });
  }

  function autoDepth() {
    const inp = state.form;                    /* ★ 表单状态就是 state.form（模块级 inp 在 renderForm 里） */
    if (!inp) return U.toast('先打开「单场录入」', 'warn');
    const lg = inp.league;
    if (!lg) return U.toast('先在「① 基本信息」里选联赛', 'warn');
    if (!window.Players) return U.toast('球员库没加载', 'warn');
    const out = [];
    const lgVals = leagueValues(lg);
    [['主队', 'home', 'hDepth'], ['客队', 'away', 'aDepth']].forEach(function (x) {
      const name = inp[x[1]];
      if (!name) { out.push('<b>' + x[0] + '</b>：还没填队名'); return; }
      const t = findTeamInLib(lg, name);
      if (!t) { out.push('<b>' + x[0] + '</b>「' + U.esc(name) + '」球员库里没有这支队（先去球员库导入/合并）'); return; }
      const list = window.Players.roster(lg, t);
      if (!list.length) { out.push('<b>' + x[0] + '</b>「' + U.esc(t) + '」在球员库里是空名单'); return; }
      const d = depthOf(list, lgVals, t);
      inp[x[2]] = d.label;
      out.push('<b>' + x[0] + ' ' + U.esc(t) + '</b> → <b style="color:var(--acc)">' + d.label + '</b>　' + d.why);
    });
    DEPTH_TIP = out.join('<br>');
    window.__depthTip = DEPTH_TIP;
    window.App.refresh();
    setTimeout(function () {
      const el = document.getElementById('depth-tip');
      if (el) el.innerHTML = window.__depthTip;
    }, 60);
    U.toast('已按球员库推算阵容深度（可手动改）', 'ok', 4000);
  }

  function panelForm(host) {
    if (!state.form) state.form = C.blankInput();
    refreshAgg();     // 每次都按当前记录库重算分组胜率，保证决策树的「模型规律提示」是最新的
    const inp = state.form;
    formRef = inp;

    /* —— 从「伤停量化」写入 —— */
    if (state.pendingInjury) {
      const pi = state.pendingInjury;
      const sd = pi.side === 'home' ? '主队' : '客队';
      const box = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)', marginBottom: '12px' } });
      box.appendChild(U.el('h2', {}, [document.createTextNode('伤停量化结果待写入（' + sd + '）')]));
      box.appendChild(U.el('div', { class: 'grid g3' }));
      const b = box.children[box.children.length - 1];
      [['伤病修正', pi.data.injury], ['阵容深度', pi.data.depth], ['停赛修正', pi.data.suspend]].forEach(function (t) {
        const k = U.el('div', { class: 'kpi' });
        k.appendChild(U.el('div', { class: 'v', style: { fontSize: '14px' }, text: t[1] }));
        k.appendChild(U.el('div', { class: 'l', text: t[0] }));
        b.appendChild(k);
      });
      const r = U.el('div', { class: 'row' });
      r.appendChild(U.btn('✔ 写入' + sd + '的这三项', function () {
        const pre = pi.side === 'home' ? 'h' : 'a';
        inp[pre + 'Injury'] = pi.data.injury;
        inp[pre + 'Depth'] = pi.data.depth;
        inp[pre + 'Suspend'] = pi.data.suspend;
        state.pendingInjury = null;
        U.toast('已写入 ' + sd + ' 的伤病修正 / 阵容深度 / 停赛修正', 'ok');
        window.App.refresh();
      }, 'pri'));
      r.appendChild(U.btn('改用另一个队（写入对方）', function () {
        pi.side = pi.side === 'home' ? 'away' : 'home';
        window.App.refresh();
      }, 'ghost'));
      r.appendChild(U.btn('取消', function () { state.pendingInjury = null; window.App.refresh(); }, 'ghost'));
      box.appendChild(r);
      box.appendChild(U.note('写入后自动填进下面「⑥ 加减分项」的对应下拉，你仍然可以手动改。', ''));
      host.appendChild(box);
    }

    const L = C.store.LIB;

    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('① 单场录入 · 盘'),
      U.el('span', { class: 'hint', text: '改任何一项，右侧实时结果立即更新，页面不会跳' })]));

    /* —— ⚡ 自动填充（从 V站 抓本场数据） —— */
    if (window.VZ) {
      const vzBox = U.el('div', {
        class: 'card',
        style: { background: 'var(--bg)', marginBottom: '12px', borderColor: 'var(--acc)' }
      });
      vzBox.appendChild(U.el('div', { class: 'sec-title', style: { marginTop: '0' }, text: '⚡ 自动填充（从 V站 抓本场）' }));
      const vrow = U.el('div', { class: 'row' });
      const vin = U.el('input', {
        type: 'text',
        placeholder: '粘贴比赛链接，或直接填 8 位 ID（例：…-13892692）',
        value: state.vzInput || '',
        style: { flex: '1 1 300px' }
      });
      vin.addEventListener('input', function () { state.vzInput = vin.value; });
      vrow.appendChild(vin);
      vrow.appendChild(U.btn('⚡ 抓取并填充', function () {
        state.vzInput = vin.value;
        doVzFill(vin.value);
      }, 'pri'));
      vzBox.appendChild(vrow);
      vzBox.appendChild(U.el('div', { id: 'vzStatus', class: 'mini', style: { marginTop: '6px', minHeight: '17px' } }));

      if (state.vzReport) {
        const r = state.vzReport;
        const rb = U.el('div', { style: { marginTop: '6px', fontSize: '12.2px', lineHeight: '1.8' } });
        (r.filled || []).forEach(function (t) {
          rb.appendChild(U.el('div', { html: '<span style="color:var(--ok)">✔</span> ' + U.esc(t) }));
        });
        (r.warns || []).forEach(function (t) {
          rb.appendChild(U.el('div', { html: '<span style="color:var(--warn)">!</span> ' + U.esc(t) }));
        });
        (r.failed || []).forEach(function (t) {
          rb.appendChild(U.el('div', { html: '<span style="color:var(--bad)">✘</span> ' + U.esc(t) }));
        });
        vzBox.appendChild(rb);
      }

      /* 联赛不在库里 → 给一个「点一下才加」的按钮（绝不偷偷改你的联赛库） */
      if (state.vzMissingLeague) {
        const nm = state.vzMissingLeague;
        const lb = U.el('div', { class: 'row', style: { marginTop: '8px' } });
        lb.appendChild(U.btn('➕ 把「' + nm + '」加进联赛库（默认 20 队 / 系数 1.00）', function () {
          C.store.LIB.leagues[nm] = { N: 20, coef: 1.0, R: 38, cap: 1.2 };
          if (C.saveLib) C.saveLib();
          state.form.league = nm;
          state.vzMissingLeague = '';
          U.toast('已加入联赛库：' + nm + '　建议去「调参中心」校正队数与系数', 'ok', 4500);
          window.App.refresh();
        }, 'pri'));
        lb.appendChild(U.btn('我去调参中心手动加', function () {
          U.toast('调参中心 → 联赛库，可精确填队数/系数/轮数', 'warn', 4200);
          window.App.go('params');
        }, 'ghost'));
        vzBox.appendChild(lb);
      }

      vzBox.appendChild(U.note('自动填：联赛 / 轮次 / 主客队 / <b>当时排名</b>、韦* <b>初盘终盘（盘口+双水位+初盘时间+终盘时间）</b>、最终比分、' +
        '<b>近6场（对手排名 + 进球 + 失球）</b>。<br>抓不到的一律<b>留空，绝不覆盖你已经填的内容</b>；' +
        '伤病 / 停赛 / 阵容深度 / 战意 / 空场 这 5 项网站没有，仍需手动填。', ''));
      c.appendChild(vzBox);
    }

    /* —— 从赛果录入载入 / 回写 —— */
    const loadBox = U.el('div', { class: 'card', style: { background: 'var(--bg)', marginBottom: '12px' } });
    loadBox.appendChild(U.el('div', { class: 'sec-title', style: { marginTop: '0' }, text: '从「赛果录入」载入已有比赛（下拉里能看到 序号 · 联赛 · 轮次 · 主队 vs 客队）' }));
    const recOpts = [{ v: '', n: '— 不载入，新建一场（用下面这张空表单）—' }];
    C.store.rows.slice().reverse().forEach(function (rec) {
      const i = rec.inp || {};
      recOpts.push({
        v: String(rec.seq),
        n: '#' + rec.seq + '　' + (i.league || '未知联赛') + '　第' + (i.round === undefined || i.round === '' ? '?' : i.round) + '轮　' +
          (i.home || '?') + ' vs ' + (i.away || '?') +
          (i.scoreText ? '　[' + i.scoreText + ']' : '')
      });
    });
    const lrow = U.el('div', { class: 'row' });
    const sel = U.select(recOpts, state.editSeq === null ? '' : String(state.editSeq), function (v) {
      if (v === '') {
        state.editSeq = null;
        state.form = C.blankInput();
      } else {
        const rec = C.store.rows.filter(function (r) { return String(r.seq) === v; })[0];
        if (!rec) return;
        state.editSeq = rec.seq;
        state.form = C.blankInput();
        for (const k in rec.inp) if (rec.inp[k] !== undefined && rec.inp[k] !== null) state.form[k] = rec.inp[k];
        state.form.note = rec.note || state.form.note || '';
      }
      window.App.refresh();
    }, { style: { minWidth: '460px', maxWidth: '100%' } });
    lrow.appendChild(sel);
    lrow.appendChild(U.btn('载入这条', function () {
      if (state.editSeq === null) return U.toast('先在下拉里选一条', 'warn');
      const rec = C.store.rows.filter(function (r) { return r.seq === state.editSeq; })[0];
      if (rec) { state.form = C.blankInput(); for (const k in rec.inp) state.form[k] = rec.inp[k]; }
      window.App.refresh();
    }, 'ghost'));
    lrow.appendChild(U.btn('刷新下拉（记录有变时点）', function () { window.App.refresh(); }, 'ghost'));
    loadBox.appendChild(lrow);

    if (state.editSeq !== null) {
      const rec = C.store.rows.filter(function (r) { return r.seq === state.editSeq; })[0];
      if (rec) {
        const i = rec.inp || {};
        loadBox.appendChild(U.note('正在编辑 <b>#' + rec.seq + '</b>：' + U.esc(i.league || '') + ' 第' +
          (i.round === undefined || i.round === '' ? '?' : i.round) + '轮　<b>' + U.esc(i.home || '?') + ' vs ' + U.esc(i.away || '?') + '</b>' +
          '　（底部「保存并回写这条记录」会把修改写回它，不会新增）', 'ok'));
      }
    } else {
      loadBox.appendChild(U.note('当前是<b>新建模式</b>：底部「写入赛果录入」会新增一条。' +
        '想改已存在的比赛，请在上面下拉里选它。', ''));
    }
    c.appendChild(loadBox);

    const t1 = U.el('div', { class: 'row' });
    t1.appendChild(U.btn('清空表单', function () { state.form = C.blankInput(); state.editSeq = null; window.App.refresh(); }, 'ghost'));
    t1.appendChild(U.btn('用出厂示例填充（大阪钢巴 vs 神户胜利船）', function () {
      const demo = (window.SEED_ROWS || [])[10];
      if (!demo) return U.toast('示例数据缺失', 'warn');
      state.form = Object.assign(C.blankInput(), demo);
      state.editSeq = null;
      U.toast('已填入示例，可直接改', 'ok');
      window.App.refresh();
    }, 'ghost'));
    if (state.editSeq === null) {
      t1.appendChild(U.btn('写入记录库（新增）', function () { saveForm(); }, 'pri'));
    } else {
      t1.appendChild(U.btn('保存并回写 #' + state.editSeq, function () { saveForm(); }, 'pri'));
      t1.appendChild(U.btn('另存为新记录', function () { saveForm(true); }, 'ghost'));
    }
    c.appendChild(t1);

    const split = U.el('div', { class: 'split two' });
    const left = U.el('div');
    const right = U.el('div');
    liveBox = right;

    /* —— 基本信息 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '① 基本信息' }));
    const g1 = U.el('div', { class: 'grid g3' });
    g1.appendChild(fld('联赛 *', U.select([{ v: '', n: '— 必选 —' }].concat(
      Object.keys(L.leagues).map(function (k) { return { v: k, n: k + '（' + L.leagues[k].N + '队/系数' + L.leagues[k].coef + '）' }; })
    ), inp.league, set('league'))));
    g1.appendChild(fld('轮次', U.number(inp.round, set('round'), { step: '1', min: '0' })));
    g1.appendChild(fld('主队名称', U.input(inp.home, set('home'))));
    g1.appendChild(fld('客队名称', U.input(inp.away, set('away'))));
    g1.appendChild(fld('备注', U.input(inp.note, set('note'))));
    left.appendChild(g1);

    /* —— 盘口 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '② 机构盘口与水位（★ 一律填数字：负数 = 主队让球，正数 = 客队让球）' }));
    const g2 = U.el('div', { class: 'grid g3' });
    g2.appendChild(handiField('open', '机构初盘 *（示例：-0.5 = 主让半球）', '-0.25 / -0.5 / 0 / 0.5 …', false));
    g2.appendChild(handiField('close', '机构终盘（留空 = 与初盘相同）', '-0.5 / 0 / 0.5 …', true));
    g2.appendChild(fld('初盘水位 *', U.number(inp.openWater, set('openWater'), { step: '0.01', inputmode: 'decimal' })));
    g2.appendChild(fld('终盘水位', U.number(inp.closeWater, set('closeWater'), { step: '0.01', inputmode: 'decimal' })));
    g2.appendChild(fld('初盘时间', dtInput(inp.openTime, set('openTime'))));
    g2.appendChild(fld('终盘时间', dtInput(inp.closeTime, set('closeTime'))));
    g2.appendChild(fld('机构让球方（上盘方）', U.select([
      { v: '', n: '自动判定（按盘口符号；平手盘按水位）' },
      { v: '主队', n: '手动：主队让球 → 主队是上盘' },
      { v: '客队', n: '手动：客队让球 → 客队是上盘' },
      { v: '平手', n: '手动：不设上盘（按走水算）' },
    ], inp.upSideManual, set('upSideManual')), '摸不准时用它定音'));
    left.appendChild(g2);
    left.appendChild(U.note('平手盘（初盘终盘都是 0 球）时，程序默认按「初盘水位 = 主队一侧、终盘水位 = 客队一侧」比大小来判上盘。' +
      '如果你的记法不是这样，直接在上面「机构让球方」里手动点一下，<b>本场以你点的为准</b>。' +
      '没填水位也不会再瞎猜成「超低水」—— 会直接提示缺数据。', ''));

    /* —— 赛果（可后补） —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '③ 赛果（可先留空，比赛结束后回来补）' }));
    const g3 = U.el('div', { class: 'grid g3' });
    g3.appendChild(fld('最终比分', U.input(inp.scoreText, set('scoreText'), { placeholder: '2:1' })));
    g3.appendChild(fld('上盘是否赢盘（留空=按比分自动判）', U.select(
      [{ v: '', n: '自动判定' }, '赢盘', '输盘', '走水'], inp.actual, set('actual'))));
    left.appendChild(g3);

    /* —— 排名与战绩 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '④ 排名与主客场战绩（主战绩系数偏差用）' }));
    const g4 = U.el('div', { class: 'grid g4' });
    g4.appendChild(fld('主队当前排名', U.number(inp.hRank, set('hRank'), { step: '1', min: '0' })));
    g4.appendChild(fld('客队当前排名', U.number(inp.aRank, set('aRank'), { step: '1', min: '0' })));
    g4.appendChild(fld('主队主场场次', U.number(inp.hGames, set('hGames'), { step: '1', min: '0' })));
    g4.appendChild(fld('主队主场总得分', U.number(inp.hPts, set('hPts'), { step: '1', min: '0' })));
    g4.appendChild(fld('主队客场场次', U.number(inp.aGames, set('aGames'), { step: '1', min: '0' })));
    g4.appendChild(fld('主队客场总得分', U.number(inp.aPts, set('aPts'), { step: '1', min: '0' })));
    g4.appendChild(fld('是否空场', U.select([{ v: '', n: '否' }, { v: 'TRUE', n: '是（空场）' }], inp.empty, set('empty'))));
    g4.appendChild(fld('排名区间（留空自动）', U.select([{ v: '', n: '自动' }].concat(C.TIERS), inp.hTier, set('hTier')), '主队'));
    left.appendChild(g4);

    /* —— 攻防积分场次 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '⑤ 近 6 场实际场次（留空 = 按非空槽位数）' }));
    const g5 = U.el('div', { class: 'grid g3' });
    g5.appendChild(fld('主队近6场实际场次', U.number(inp.hADGames, set('hADGames'), { step: '1', min: '0' })));
    g5.appendChild(fld('客队近6场实际场次', U.number(inp.aADGames, set('aADGames'), { step: '1', min: '0' })));
    left.appendChild(g5);

    /* —— 加减分项 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '⑥ 加减分项（下拉内容 = 调参中心 → 加减分库）' }));
    const tables = [
      ['hHist', 'aHist', '历史交锋', L.hist],
      ['hInjury', 'aInjury', '伤病修正', L.injury],
      ['hDepth', 'aDepth', '阵容深度', L.depth],
      ['hSuspend', 'aSuspend', '停赛修正', L.suspend],
      ['hFatigue', 'aFatigue', '赛程疲劳', L.fatigue],
      ['hStreak', 'aStreak', '连赢连负', L.streak],
      ['hMotive', 'aMotive', '战意状态', L.motive],
    ];
    const g6 = U.el('div', { class: 'grid g3' });
    tables.forEach(function (t) {
      const box = U.el('div', { class: 'kpi' });
      box.appendChild(U.el('div', { class: 'l', text: t[2] }));
      [['主队', t[0]], ['客队', t[1]]].forEach(function (sd) {
        const opts = [{ v: '', n: '— ' + sd[0] + ' 未填 —' }].concat(Object.keys(t[3]).map(function (k) {
          return { v: k, n: k + '（' + C.num(t[3][k], 0) + '）' };
        }));
        const w = U.el('div', { style: { marginTop: '6px' } });
        // ★ v15：客队历史交锋恒为 0（业务约定），标签上直接写明，避免以为填了有用
        const lab = sd[0] + (t[0] === 'hHist' && sd[0] === '客队' ? '（不计分）' : '');
        w.appendChild(fld(lab, U.select(opts, inp[sd[1]], set(sd[1]))));
        box.appendChild(w);
      });
      if (t[0] === 'hHist') {
        box.appendChild(U.el('div', {
          class: 'mini', style: { color: 'var(--warn)', marginTop: '5px' },
          text: '⚠ 客队这一栏恒等于 0（模型里客队没有「历史交锋」这一项）：可以照实记录，但填什么都不影响任何结论',
        }));
      }
      g6.appendChild(box);
    });
    left.appendChild(g6);

    /* ⚡ 阵容深度自动推算：用球员库的人数 + 位置结构（门将/后卫/中场/前锋各几人） */
    const depthRow = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    depthRow.appendChild(U.btn('⚡ 按球员库推算阵容深度', function () { autoDepth(); }, 'sm ghost'));
    depthRow.appendChild(U.btn('⚕ 自动算伤病/深度/停赛（Transfermarkt）', function () { autoTmInjury(); }, 'sm pri'));
    left.appendChild(depthRow);
    const depthTip = U.el('div', { class: 'mini', id: 'depth-tip', style: { marginTop: '6px', lineHeight: '1.7', color: 'var(--txt-2)' } });
    left.appendChild(depthTip);
    const tmTip = U.el('div', {
      class: 'mini', id: 'tm-inj-tip',
      style: { marginTop: '6px', lineHeight: '1.75', color: 'var(--txt-2)', whiteSpace: 'pre-wrap' }
    });
    left.appendChild(tmTip);
    /* 后端状态：让"点了没反应"变成"一眼知道缺什么" */
    const bkBadge = U.el('div', {
      class: 'mini', id: 'backend-badge',
      style: { marginTop: '6px', color: 'var(--txt-3)' }, text: '后端状态：检查中…'
    });
    left.appendChild(bkBadge);
    (function checkBackend() {
      const bases = apiBases();
      let i = 0;
      function next() {
        if (i >= bases.length) {
          bkBadge.innerHTML = '<span style="color:var(--warn)">后端：<b>没连上</b></span>　' +
            '⚠「⚕ 自动算伤病」和「球员库更新」需要它 —— 双击 <code>竞彩计算器\\启动.bat</code>，' +
            '然后把本页刷新一下（本页是 ' + U.esc(location.protocol === 'file:' ? 'file://' : location.origin) + '，' +
            '连的是 127.0.0.1:8765）。<br>V站的抓取（⚡ 抓取并填充）<b>不需要</b>后端，照常能用。';
          return;
        }
        const base = bases[i++];
        fetch(window.withToken ? window.withToken(base + '/api/health') : (base + '/api/health'), { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('bad');
          return r.json();
        }).then(function () {
          bkBadge.innerHTML = '<span style="color:var(--ok)">后端：<b>已连接</b></span>（' + U.esc(base) + '）' +
            '　⚕ 自动算伤病 / 球员库更新 都可以用';
        }).catch(next);
      }
      next();
    })();
    if (DEPTH_TIP) depthTip.innerHTML = DEPTH_TIP;
    if (TM_TIP) tmTip.textContent = TM_TIP;

    /* —— 近 6 场 —— */
    left.appendChild(U.el('div', { class: 'sec-title', text: '⑦ 近 6 场明细（攻防积分用；第 6 场=最近一场）' }));
    const g7 = U.el('div', { class: 'grid g2' });
    [['h', '主队近 6 场'], ['a', '客队近 6 场']].forEach(function (sd) {
      const box = U.el('div', { class: 'kpi' });
      box.appendChild(U.el('div', { class: 'l', text: sd[1] }));
      const tb = U.el('table');
      tb.innerHTML = '<thead><tr><th>场次</th><th>进球</th><th>失球</th><th>对手排名</th></tr></thead>';
      const bd = U.el('tbody');
      for (let i = 6; i >= 1; i--) {
        const tr = U.el('tr');
        tr.appendChild(U.el('td', { text: '第' + i + '场' + (i === 6 ? '（最近）' : '') }));
        ['G', 'C', 'O'].forEach(function (suf) {
          const k = sd[0] + suf + i;
          const td = U.el('td');
          td.appendChild(U.number(inp[k], set(k), { step: '1', min: '0' }));
          tr.appendChild(td);
        });
        bd.appendChild(tr);
      }
      tb.appendChild(bd); box.appendChild(tb);
      g7.appendChild(box);
    });
    left.appendChild(g7);

    split.appendChild(left);
    split.appendChild(right);
    c.appendChild(split);
    host.appendChild(c);
    renderLive(inp);
  }

  function set(k) {
    return function (v) {
      const el = (document.activeElement && document.activeElement.tagName) ? document.activeElement : null;
      formRef[k] = v;
      renderLive(formRef);            // 只重画右侧实时区，不重建表单 → 不跳顶、不丢焦点
      if (el && el.tagName === 'SELECT') { /* 下拉保持原生行为 */ }
    };
  }

  /** 右侧实时结果（原地更新，不触碰左侧输入）
   *  结构（从上到下）：
   *   ① 投注方向大卡 —— 「买 客队（下盘）」最大最醒目，下面只列两三条理由
   *   ② 推荐情形 + 模型置信度（一行）
   *   ③ 核心数值一行
   *   ④ 三步决策树 / 四分量 / 四维评分（全部折叠，默认收起） */
  function renderLive(inp) {
    if (!liveBox) return;
    const r = C.evaluate(inp, C.store.P, C.store.LIB);
    const d = C.decide(r, agg);
    const rc = C.recommend(r, agg);
    const conf = C.confidence(r, agg, C.store.P);
    liveBox.innerHTML = '';
    const card = U.el('div', { class: 'card', style: { position: 'sticky', top: '0' } });
    card.appendChild(U.el('h2', {}, [document.createTextNode('盘 · 实时结果'),
      U.el('span', { class: 'hint', text: '改左边任意一项，这里立即更新' })]));

    /* ⓪ 数据不完整警告 —— 放在最上面，先说「这场的结论可不可信」 */
    if (r.warn && r.warn.length) {
      const wn = U.el('div', { class: 'note bad', style: { margin: '0 0 9px' } });
      wn.appendChild(U.el('div', { html: '<b>⚠ 数据不完整（' + r.warn.length + ' 项），下面的结论可能不准：</b>' }));
      const ulw = U.el('ul', { style: { paddingLeft: '18px', margin: '4px 0 0', fontSize: '12.2px', lineHeight: '1.75' } });
      r.warn.forEach(function (w) { ulw.appendChild(U.el('li', { text: w.t })); });
      wn.appendChild(ulw);
      card.appendChild(wn);
    }

    /* ① 投注方向大卡 —— 只讲「买哪边」+ 简短理由 */
    const col = rc.dir === 'none' ? 'var(--txt-3)' : (rc.dir === 'down' ? 'var(--bad)' : 'var(--ok)');
    const vc = U.el('div', {
      style: { border: '2px solid ' + col, borderRadius: '10px', padding: '11px 13px', background: 'var(--bg)', marginBottom: '9px' }
    });
    vc.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: '投注方向' }));
    const big = U.el('div', { class: 'flexline', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'baseline' } });
    big.appendChild(U.el('div', {
      style: { fontSize: '26px', fontWeight: '800', color: col, lineHeight: '1.15' },
      text: rc.dir === 'none' ? '不参与' : ('买 ' + rc.side)
    }));
    if (rc.dir !== 'none') {
      big.appendChild(U.el('div', { style: { fontSize: '17px', fontWeight: '700', color: col }, text: rc.team }));
    }
    big.appendChild(U.el('span', {
      class: 'mini',
      style: { border: '1px solid ' + col, color: col, borderRadius: '4px', padding: '1px 6px' },
      text: rc.caseName + '　可信度 ' + rc.conf
    }));
    vc.appendChild(big);
    const ul = U.el('ul', { style: { paddingLeft: '18px', margin: '7px 0 0', fontSize: '12.4px', color: 'var(--txt-2)', lineHeight: '1.8' } });
    rc.reasons.forEach(function (t) { ul.appendChild(U.el('li', { html: U.esc(t) })); });
    vc.appendChild(ul);
    card.appendChild(vc);

    /* ② 推荐情形 + 置信度 */
    const cRow = U.el('div', { class: 'grid g2', style: { gap: '7px' } });
    const info = U.el('div', { style: { padding: '6px 9px', borderRadius: '8px', background: 'var(--panel)', border: '1px solid var(--line)' } });
    info.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: '推荐情形（v13 两大情况）' }));
    info.appendChild(U.el('div', { style: { fontSize: '12.6px', fontWeight: '650' }, text: rc.caseName }));
    info.appendChild(U.el('div', { class: 'mini', text: '基本面 X2 = ' + rc.X + ' → ' + rc.ak + '　·　上盘 = ' + rc.upTeam }));
    if (r.isMidScene) info.appendChild(U.el('div', { class: 'mini', text: '中水二次判定：' + rc.al }));
    else if (r.scene === C.LABELS.scene.fh || r.scene === C.LABELS.scene.fl || r.scene === C.LABELS.scene.fm) {
      info.appendChild(U.el('div', { class: 'mini', text: 'AM 盘口不变建议：' + rc.am }));
    }
    cRow.appendChild(info);
    const cb = U.el('div', {
      style: {
        padding: '6px 9px', borderRadius: '8px', background: 'var(--panel)',
        border: '1px solid ' + (conf.tone === 'ok' ? 'var(--ok)' : conf.tone === 'bad' ? 'var(--bad)' : 'var(--line)')
      }
    });
    const ch = U.el('div', { class: 'flexline', style: { gap: '6px', flexWrap: 'wrap' } });
    ch.appendChild(U.el('span', { class: 'mini', style: { color: 'var(--txt-3)' }, text: conf.name }));
    ch.appendChild(U.el('span', {
      style: { fontSize: '17px', fontWeight: '700', color: conf.tone === 'ok' ? 'var(--ok)' : conf.tone === 'bad' ? 'var(--bad)' : 'var(--warn)' },
      text: String(conf.score)
    }));
    ch.appendChild(U.el('span', { style: { fontSize: '12px', color: 'var(--txt-2)' }, text: conf.band }));
    cb.appendChild(ch);
    cb.appendChild(U.el('div', {
      class: 'mini',
      text: conf.parts.map(function (p) { return p.n.replace(/^[①②③④]\s*/, '') + ' ' + p.v; }).join(' / ')
    }));
    cRow.appendChild(cb);
    card.appendChild(cRow);

    /* ③ 核心数值一行 */
    card.appendChild(U.el('div', { class: 'sec-title', text: '核心数值' }));
    const g = U.el('div', { class: 'grid g4', style: { gap: '7px' } });
    [
      ['八大场景', r.scene],
      ['本心实力盘', r.corePanText + (r.crit ? '（临界）' : '')],
      ['机构 初盘→终盘', (r.jText || '—') + ' → ' + (r.kText || '—') + '（' + U.fmt(r.J, 2) + ' → ' + U.fmt(r.K, 2) + '）'],
      ['水位 / 升跌盘', r.water + ' · ' + (r.hcpUp ? '升盘' : r.hcpDown ? '降盘' : (r.hcpSame ? '不变' : '判不出'))],
      ['仲裁结论', r.arb],
      ['长期 L / 短期 S', U.fmt(r.arbL, 4) + ' / ' + U.fmt(r.arbS, 4)],
      ['综合评分 / 强度', U.fmt(r.total, 2) + ' / ' + r.strength],
      ['机构让球方', r.upSide + '　来源：' + C.upperFromLabel(r.upFrom)],
      ['四票一致 X2', r.consensus + '/4（主队视角，仅供参考）'],
      ['结果', r.actual ? ('上盘' + r.actual) : '待录比分'],
    ].forEach(function (t) {
      const b = U.el('div', { class: 'kpi', style: { padding: '6px 9px' } });
      b.appendChild(U.el('div', {
        style: { fontSize: '12.6px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        title: t[1], text: t[1]
      }));
      b.appendChild(U.el('div', { class: 'l', style: { fontSize: '11px', marginTop: '1px' }, text: t[0] }));
      g.appendChild(b);
    });
    card.appendChild(g);
    if (r.upFrom === 'water' && r.upNote) {
      card.appendChild(U.note((r.upSide === '平手' ? '⚠ ' : '') + r.upNote, r.upSide === '平手' ? 'warn' : ''));
    }

    /* ④ 折叠：三步决策树 */
    const det0 = U.el('details', { style: { marginTop: '8px' } });
    det0.appendChild(U.el('summary', { text: '展开：三步决策树（场景 → 仲裁 → 强度）' }));
    const steps = U.el('div', { style: { marginTop: '6px' } });
    d.steps.forEach(function (s) {
      const sc2 = s.status === 'veto' ? 'var(--bad)'
        : s.status === 'invalid' || s.status === 'mid' ? 'var(--warn)'
          : s.status === 'strong' || s.status === 'valid' || s.status === 'scene' ? 'var(--ok)'
            : s.status === 'weak' ? 'var(--txt-3)' : 'var(--txt-2)';
      const row = U.el('div', {
        style: { borderLeft: '3px solid ' + sc2, background: 'var(--bg)', borderRadius: '0 6px 6px 0', padding: '5px 9px', marginBottom: '5px' }
      });
      const l1 = U.el('div', { class: 'flexline', style: { gap: '6px', flexWrap: 'wrap' } });
      l1.appendChild(U.el('span', { class: 'mini', style: { color: 'var(--txt-3)', minWidth: '112px' }, text: s.title }));
      l1.appendChild(U.el('span', { style: { fontWeight: '650', color: sc2 }, text: s.value }));
      l1.appendChild(U.el('span', { style: { fontSize: '11.5px', color: 'var(--txt-2)' }, text: s.pass ? '→ 通过' : '→ 止步' }));
      row.appendChild(l1);
      row.appendChild(U.el('div', { class: 'mini', style: { marginTop: '2px' }, html: s.text }));
      steps.appendChild(row);
    });
    det0.appendChild(steps);
    card.appendChild(det0);

    /* ④ 明细折叠 */
    const det1 = U.el('details', { style: { marginTop: '6px' } });
    det1.appendChild(U.el('summary', { text: '展开：四分量明细' }));
    det1.appendChild(U.el('div', { html: U.table([
      { k: 'n', n: '项目', w: '104px' }, { k: 'v', n: '数值', w: '86px' }, { k: 'd', n: '方向', w: '48px' }, { k: 'e', n: '说明', w: '300px' }
    ], [
      { n: '攻防净分差', v: U.fmt(r.raw.adDiff, 4), d: dirTxt(r.raw.adDiff), e: '主 ' + U.fmt(r.H.score, 4) + '（D=' + U.fmt(r.H.D, 3) + '，场均' + U.fmt(r.H.avgG, 3) + '/' + U.fmt(r.H.avgC, 3) + '，' + r.H.games + '场） / 客 ' + U.fmt(r.A.score, 4) + '（' + r.A.games + '场）' },
      { n: '主战绩系数偏差', v: U.fmt(r.raw.formDiff, 4), d: dirTxt(r.raw.formDiff), e: '系数 ' + U.fmt(r.F.coef, 4) + ' × ' + C.store.P.FORM_STEP + '（K=' + U.fmt(r.F.K, 3) + '）' },
      { n: '排名净分差', v: U.fmt(r.raw.rankDiff, 4), d: dirTxt(r.raw.rankDiff), e: '区间 ' + r.R.hTier + ' vs ' + r.R.aTier + '，衰减 ' + r.R.decay },
      { n: '加减净分差', v: U.fmt(r.raw.adjNet, 4), d: dirTxt(r.raw.adjNet), e: '主 ' + U.fmt(r.ADJ.hTotal, 4) + ' / 客 ' + U.fmt(r.ADJ.aTotal, 4) },
      { n: '合计', v: U.fmt(r.netRaw, 4), d: dirTxt(r.netRaw), e: '主队总分 ' + U.fmt(r.E, 4) + ' − 客队总分 ' + U.fmt(r.F2, 4) },
    ]) }));
    card.appendChild(det1);

    const det2 = U.el('details', { style: { marginTop: '6px' } });
    det2.appendChild(U.el('summary', { text: '展开：四维评分明细' }));
    det2.appendChild(U.el('div', { html: U.table([
      { k: 'n', n: '评分项', w: '90px' }, { k: 'v', n: '得分', w: '58px' }, { k: 'e', n: '依据', w: '330px' }
    ], [
      { n: '偏差评分', v: U.fmt(r.devScore, 2), e: '|初盘 ' + U.fmt(r.J === null ? 0 : r.J) + ' − 心盘 ' + U.fmt(r.corePan, 3) + '| = ' + U.fmt(Math.abs((r.J || 0) - r.corePan), 4) },
      { n: '联动评分', v: U.fmt(r.linkScore, 2), e: '盘口 ' + (r.hcpUp ? '升盘' : r.hcpDown ? '降盘' : '不变') +
        '（|终盘 ' + U.fmt(r.absK, 2) + '| vs |初盘 ' + U.fmt(r.absJ, 2) + '|）、水位 ' + U.fmt(r.Lw) + '→' + U.fmt(r.Mw) +
        '（' + (r.Mw > r.Lw ? '升水' : r.Mw < r.Lw ? '降水' : '平水') + '）→ ' +
        (r.linkScore === C.store.P.LINK_HI ? '盘口与水位反向 = 联动强' :
          r.linkScore === C.store.P.LINK_MID ? '盘口不变 = 中性' : '盘口与水位同向 = 联动弱') },
      { n: '仲裁评分', v: U.fmt(r.arbScore, 2), e: r.arb + '　·　' + (r.arbWhy || '') },
      { n: '时间评分', v: U.fmt(r.timeScore, 2), e: (inp.openTime && inp.closeTime) ? ('观察 ' + U.fmt(C.hoursBetween(inp.openTime, inp.closeTime), 1) + ' 小时') : '时间缺失，取默认' },
      { n: '合计', v: U.fmt(r.total, 2), e: '≥' + C.store.P.STRONG_SCORE + ' 强；≥' + C.store.P.MED_SCORE + ' 中；否则弱' },
    ]) }));
    card.appendChild(det2);

    liveBox.appendChild(card);
  }
  function dirTxt(v) { return v > 0 ? '正' : v < 0 ? '负' : '零'; }
  function fld(label, el, hint) { return U.field(label, el, hint); }

  /* ---------------- 盘口一行：数字框 + 快捷点选 + 实时「识别为」提示 ----------------
   * ★ v15：一律以**数字**为准（负数 = 主队让球）。中文只作为显示与导入兼容，
   *   再也不会出现「填中文符号反了」这种坑。 */
  const HCP_QUICK = [
    ['主让平半 −0.25', -0.25], ['主让半球 −0.5', -0.5], ['主让半一 −0.75', -0.75], ['主让一球 −1', -1],
    ['平手 0', 0],
    ['客让平半 +0.25', 0.25], ['客让半球 +0.5', 0.5], ['客让半一 +0.75', 0.75], ['客让一球 +1', 1],
  ];
  function handiField(key, label, placeholder, allowEmpty) {
    const inp = formRef || state.form;
    const wrap = U.el('div', { style: { gridColumn: 'span 2' } });
    const num = U.input(inp[key], function (v) {
      inp[key] = v;
      paint();
      renderLive(inp);
    }, { placeholder: placeholder, inputmode: 'decimal' });
    const tip = U.el('div', { class: 'mini', style: { marginTop: '3px', minHeight: '16px' } });
    const chips = U.el('div', { class: 'chips', style: { marginTop: '4px' } });
    HCP_QUICK.forEach(function (q) {
      const c = U.el('span', { class: 'chip', style: { fontSize: '11px' }, text: q[0] });
      c.addEventListener('click', function () {
        inp[key] = q[1]; num.value = String(q[1]);
        paint(); renderLive(inp);
      });
      chips.appendChild(c);
    });
    wrap.appendChild(U.field(label, num));
    wrap.appendChild(chips);
    wrap.appendChild(tip);
    function paint() {
      const raw = inp[key];
      const blank = raw === '' || raw === null || raw === undefined || String(raw).trim() === '';
      if (blank) {
        tip.textContent = allowEmpty
          ? '未填 = 与初盘相同（盘口没变动）'
          : '未填 —— 必填项，留空会让场景判不出来';
        tip.style.color = allowEmpty ? 'var(--txt-3)' : 'var(--bad)';
        num.classList.remove('dirty');
        return;
      }
      const v = C.inputLine(raw, C.store.P, C.store.LIB);
      if (v === null) {
        tip.textContent = '⚠ 认不出来 —— 请填数字（−0.5 = 主让半球，0.5 = 客让半球），或写「主让半球」';
        tip.style.color = 'var(--bad)';
        num.classList.add('dirty');
        return;
      }
      tip.textContent = '识别为：' + C.lineTextOfBall(v, C.store.P, C.store.LIB) + '（' + v + '）' +
        (typeof raw === 'string' && !/^-?\d/.test(raw.trim()) ? '　⚠ 你填的是中文，建议改填数字' : '');
      tip.style.color = v < 0 ? 'var(--acc)' : (v > 0 ? 'var(--warn)' : 'var(--txt-2)');
      num.classList.toggle('dirty', typeof raw === 'string' && !/^-?\d/.test(String(raw).trim()));
    }
    paint();
    return wrap;
  }
  function dtInput(val, on) {
    const v = val ? String(val).replace(' ', 'T').slice(0, 16) : '';
    const i = U.el('input', { type: 'datetime-local', value: v });
    i.addEventListener('change', function () { on(i.value ? i.value.replace('T', ' ') : ''); });
    return i;
  }
  /* ============================================================
   * ⚡ 自动填充：从 V站 抓本场数据 → 写进表单
   * ★ 只覆盖「确实抓到了」的字段；抓不到的留空，不动你手填的值
   * ============================================================ */
  function doVzFill(input) {
    if (vzBusy) return U.toast('正在抓取，稍等一下…', 'warn');
    const id = window.VZ.parseId(input);
    if (!id) return U.toast('没认出比赛 ID（链接里应有 8 位数字，例如 …-13892692）', 'bad');
    vzBusy = true;
    state.vzInput = String(input || '');
    state.vzReport = null;
    const st = document.getElementById('vzStatus');
    const setSt = function (s) { if (st) st.textContent = s; };
    setSt('开始抓取 ' + id + ' …');

    window.VZ.buildPatch(id, setSt).then(function (res) {
      /* 联赛单独处理：不在联赛库里就【不填】，避免用一个没有参数（队数/系数）的联赛去算 */
      const leagueVal = res.patch.league || '';
      delete res.patch.league;
      state.vzMissingLeague = '';

      let n = 0;
      for (const k in res.patch) {
        const v = res.patch[k];
        if (v !== undefined && v !== null && v !== '') { state.form[k] = v; n++; }
      }

      const LIBL = (C.store.LIB && C.store.LIB.leagues) || {};
      if (leagueVal) {
        if (LIBL[leagueVal]) {
          state.form.league = leagueVal;
          res.report.filled.push('联赛 ' + leagueVal);
          n++;
        } else {
          state.vzMissingLeague = leagueVal;
          res.report.warns.push('联赛「' + leagueVal + '」不在你的联赛库里（现在只有 ' + Object.keys(LIBL).join(' / ') +
            '）→ 没自动选。点下面那个按钮把它加进联赛库，或手动挑一个最接近的');
        }
      }

      /* 机构让球方：盘口符号 vs 初盘水位，两条都指向同一方才填 */
      const w = res.wei || {};
      const openV = Number(res.patch.open);
      let signSide = null;
      if (res.patch.open !== undefined && isFinite(openV)) {
        if (openV < 0) signSide = '主队';        // 负数=主队让球 → 主队是上盘
        else if (openV > 0) signSide = '客队';   // 正数=主队受让 → 客队让球
      }
      let waterSide = null;
      if (w.openWater && w.openWaterAway) waterSide = (w.openWater < w.openWaterAway) ? '主队' : '客队';
      if (signSide && waterSide) {
        if (signSide === waterSide) {
          state.form.upSideManual = signSide;
          res.report.filled.push('机构让球方＝' + signSide + '（盘口符号与初盘水位一致，已填）');
          n++;
        } else {
          res.report.warns.push('盘口符号指向「' + signSide + '」让球，但初盘水位更低的是「' + waterSide +
            '」→ 两条对不上，让球方没敢填，请手动确认');
        }
      } else if (signSide) {
        state.form.upSideManual = signSide;
        res.report.filled.push('机构让球方＝' + signSide + '（按盘口符号）');
        n++;
      }

      state.vzReport = res.report;
      vzBusy = false;
      window.App.refresh();
      U.toast('已自动填入 ' + n + ' 项，请核对后保存', 'ok', 3600);
    }).catch(function (e) {
      vzBusy = false;
      state.vzReport = { filled: [], warns: [], failed: ['抓取失败：' + e.message + '　（可以手动填，或稍后重试）'] };
      window.App.refresh();
    });
  }

  function saveForm(asNew) {
    const inp = formRef || state.form;
    const clean = {};
    for (const k in inp) if (inp[k] !== '' && inp[k] !== undefined && inp[k] !== null) clean[k] = inp[k];
    const editing = state.editSeq !== null && !asNew;
    if (editing) {
      const rec = C.store.rows.filter(function (r) { return r.seq === state.editSeq; })[0];
      if (!rec) { state.editSeq = null; return saveForm(asNew); }
      rec.inp = clean;
      rec.note = clean.note || rec.note || ('单场录入 ' + nowStr());
      C.saveRows();
      refreshAgg();
      U.toast('已回写 #' + rec.seq + '（没有新增）', 'ok');
      state.editSeq = null;
    } else {
      const rec = C.newRecord(clean);
      rec.note = clean.note || ('单场录入 ' + nowStr());
      C.store.rows.push(rec); C.saveRows();
      refreshAgg();
      U.toast('已新增 1 条（共 ' + C.store.rows.length + ' 条）', 'ok');
    }
    state.form = C.blankInput();
    state.tab = 'res';
    window.App.refresh(); window.App.updateFoot();
  }

  /* ================= ② 记录库 · 赛果录入 ================= */
  function statMap() { return C.computeStats(C.store.rows, C.store.P, C.store.LIB); }
  /** 分组历史胜率（决策树的「模型规律提示」用它） */
  let agg = null;
  function refreshAgg() { agg = C.groupRates(C.store.rows, C.store.P, C.store.LIB); return agg; }

  /**
   * 分页器（★ v15 新增：记录多了不再一次性把上千行 DOM 全画出来）
   * 明细表和赛果录入共用同一套页码，翻页时两边一起翻。
   */
  function pagerBar(total, per) {
    const pages = Math.max(1, Math.ceil(total / per));
    const cur = Math.min(Math.max(1, state.page || 1), pages);
    state.page = cur;
    const box = U.el('div', { class: 'row', style: { alignItems: 'center', gap: '8px', margin: '4px 0 8px' } });
    box.appendChild(U.el('span', { class: 'mini', text: '共 ' + total + ' 条，本页 ' + Math.min(per, Math.max(0, total - (cur - 1) * per)) + ' 条' }));
    const go = function (to) { return function () { state.page = to; window.App.refresh(); }; };
    if (pages > 1) {
      const prev = U.btn('‹ 上一页', go(Math.max(1, cur - 1)), 'sm');
      if (cur <= 1) prev.disabled = true;
      box.appendChild(prev);
      const opts = [];
      for (let p = 1; p <= pages; p++) opts.push({ v: String(p), n: '第 ' + p + ' / ' + pages + ' 页' });
      box.appendChild(U.select(opts, String(cur), function (v) { state.page = Number(v) || 1; window.App.refresh(); }, { style: { width: '160px' } }));
      const next = U.btn('下一页 ›', go(Math.min(pages, cur + 1)), 'sm');
      if (cur >= pages) next.disabled = true;
      box.appendChild(next);
    }
    box.appendChild(U.field('每页', U.select([
      { v: '20', n: '20 条' }, { v: '50', n: '50 条（默认）' }, { v: '100', n: '100 条' }, { v: '0', n: '全部（慢）' },
    ], String(state.pageSize === undefined ? 50 : state.pageSize), function (v) {
      state.pageSize = Number(v); state.page = 1; window.App.refresh();
    }, { style: { width: '130px' } })));
    return box;
  }

  function panelResults(host) {
    agg = null;                 // 记录有变动，作废缓存的分组胜率
    const all = C.store.rows.map(function (rec, i) { return { rec: rec, r: C.evaluate(rec.inp), i: i }; });
    const rs = state.desc === false ? all : all.slice().reverse();   // 默认最新在前
    const sm = statMap();

    /* 分页：把「要看的数据」和「要画的 DOM」分开 —— 卡的是 DOM，不是计算 */
    const per = (state.pageSize === 0) ? Math.max(1, rs.length) : (state.pageSize || 50);
    const pages = Math.max(1, Math.ceil(rs.length / per));
    if (!state.page || state.page < 1) state.page = 1;
    if (state.page > pages) state.page = pages;
    const pageRows = rs.slice((state.page - 1) * per, state.page * per);

    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('记录库 · 结果明细'),
      U.el('span', { class: 'hint', text: '共 ' + all.length + ' 条' })]));
    c.appendChild(U.el('p', { class: 'desc', text: '上下两部分：先是记录的结算结果，下面是逐场填比分的录入区。改任何参数都会立刻在这里重算。' }));
    const row = U.el('div', { class: 'row' });
    row.appendChild(U.btn('重新计算全部', function () { U.toast('已按当前参数重算 ' + all.length + ' 条', 'ok'); window.App.refresh(); }, 'pri'));
    row.appendChild(U.btn('清空记录库', function () {
      U.confirmBox('确定删除全部 ' + all.length + ' 条记录？不可撤销。', function () {
        C.store.rows = []; C.saveRows(); U.toast('已清空', 'ok'); window.App.refresh(); window.App.updateFoot();
      });
    }, 'danger'));
    row.appendChild(U.btn('导出 CSV（精简表）', function () { window.Export.exportCSV(window.Export.allResults(), 'summary'); }));
    row.appendChild(U.btn('导出 XLSX（多表页）', function () { window.Export.exportXLSX(window.Export.allResults(), 'summary'); }));
    c.appendChild(row);

    // 排序切换
    const srow = U.el('div', { class: 'row', style: { marginTop: '8px' } });
    srow.appendChild(U.el('span', { class: 'mini', text: '排序：' }));
    const chips = U.el('div', { class: 'chips' });
    [['最新在前（推荐，新场次不用往下滚）', true], ['最早在前', false]].forEach(function (t) {
      const ch = U.el('span', { class: 'chip' + ((state.desc !== false) === t[1] ? ' on' : ''), text: t[0] });
      ch.addEventListener('click', function () { state.desc = t[1]; state.page = 1; window.App.refresh(); });
      chips.appendChild(ch);
    });
    srow.appendChild(chips);
    c.appendChild(srow);

    // 数据完整性提醒
    const audit = C.auditRows();
    if (audit.length) {
      c.appendChild(U.note('⚠ <b>' + audit.length + ' 条记录缺关键字段</b>（多为「近 6 场实际场次」或「初盘水位」）。' +
        '缺「近 6 场实际场次」时程序按非空槽位数估算，<b>心盘会算偏</b>；缺「初盘水位」会<b>直接判不出场景</b>。' +
        '去 <a href="#dash" style="color:var(--acc)">数据总览 → 记录库体检</a> 可就地补齐。', 'warn'));
    }

    c.appendChild(U.el('div', { class: 'sec-title', text: '结果明细' }));
    c.appendChild(pagerBar(rs.length, per));
    c.appendChild(U.el('div', { html: U.table(resultCols(), pageRows.map(function (x) { return resultRow(x, sm); })) }));
    host.appendChild(c);

    /* —— 赛果录入区（默认最新在前） —— */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('赛果录入 · 逐场填比分'),
      U.el('span', { class: 'hint', text: '最新场次排在最上面 · 填完立即算「上盘是否赢盘」' })]));
    c2.appendChild(U.el('p', { class: 'desc', text: '输入格式：2:1 或 2-1 或 2：1。留空 = 未开奖。上盘方按「初盘 → 终盘 → 水位」判定，赢盘判定：上盘方净胜球 > 让球数。' }));
    if (!rs.length) {
      c2.appendChild(U.note('还没有记录。去「① 单场录入 · 盘」填一场，或去「导出 / 导入」恢复一份备份。', 'warn'));
    } else {
      c2.appendChild(pagerBar(rs.length, per));
      const inputs = U.el('div', { class: 'grid g3' });
      pageRows.forEach(function (x) { inputs.appendChild(scoreCard(x)); });
      c2.appendChild(inputs);
      setTimeout(function () { pageRows.forEach(function (x) { renderLiveResult(x.rec.seq); }); }, 0);
    }
    host.appendChild(c2);
  }

  /** 单场比分录入卡 */
  function scoreCard(x) {
    const box = U.el('div', { class: 'kpi', id: 'sr-' + x.rec.seq });
    const head = U.el('div', { class: 'flexline' });
    head.appendChild(U.el('span', { class: 'badge-num', text: '#' + x.rec.seq }));
    head.appendChild(U.el('span', {
      class: 'ellip', title: x.rec.inp.league + ' 第' + x.rec.inp.round + '轮 ' + (x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?'),
      text: (x.rec.inp.home || '?') + ' vs ' + (x.rec.inp.away || '?'),
      style: { flex: '1 1 0', fontWeight: '600' }
    }));
    box.appendChild(head);
    box.appendChild(U.el('div', {
      class: 'mini',
      text: (x.rec.inp.league || '') + ' 第' + (x.rec.inp.round === undefined || x.rec.inp.round === '' ? '?' : x.rec.inp.round) + '轮 · ' +
        x.r.corePanText + ' · 上盘=' + x.r.upSide
    }));

    const line = U.el('div', { class: 'flexline', style: { marginTop: '6px' } });
    const ti = U.el('input', { type: 'text', value: x.rec.inp.scoreText || '', placeholder: '比分 如 2:1' });
    ti.addEventListener('change', function () {
      const v = ti.value.trim();
      x.rec.inp.scoreText = v;
      delete x.rec.inp.actual;               // 让引擎按比分自动判
      C.saveRows();
      renderLiveResult(x.rec.seq);
      U.toast('#' + x.rec.seq + ' 已记 ' + (v || '（空）'), 'ok');
    });
    line.appendChild(ti);
    box.appendChild(line);

    box.appendChild(U.el('div', { style: { marginTop: '6px' }, id: 'srres-' + x.rec.seq }));

    const btns = U.el('div', { class: 'row', style: { marginTop: '6px' } });
    btns.appendChild(U.btn('导入统计分析', function () {
      window.Stats.focus(x.rec.seq);
      U.toast('已在统计分析里选中 #' + x.rec.seq, 'ok');
      window.App.go('stats');
    }, 'sm pri'));
    btns.appendChild(U.btn('在「盘」里打开', function () {
      window.Batch.editRecord(x.rec.seq);
      U.toast('已在「盘 · 单场计算」里打开 #' + x.rec.seq + '（可修改后回写）', 'ok');
    }, 'sm'));
    btns.appendChild(U.btn('删除', function () {
      const idx = C.store.rows.indexOf(x.rec);
      if (idx >= 0) { C.store.rows.splice(idx, 1); C.saveRows(); window.App.refresh(); window.App.updateFoot(); }
    }, 'sm danger'));
    box.appendChild(btns);
    return box;
  }

  /** 只更新某一场的赛果判定小块（纯文字） */
  function renderLiveResult(seq) {
    const box = document.getElementById('srres-' + seq);
    if (!box) return;
    const rec = C.store.rows.filter(function (r) { return r.seq === seq; })[0];
    box.innerHTML = '';
    if (!rec) { box.appendChild(U.el('span', { class: 'mini', text: '（已删除）' })); return; }
    const r = C.evaluate(rec.inp, C.store.P, C.store.LIB);
    if (!rec.inp.scoreText) { box.appendChild(U.el('span', { class: 'mini', text: '待录赛果' })); return; }
    if (!r.actual) { box.appendChild(U.el('span', { class: 'mini', text: '比分无法解析，请用 2:1 这种写法' })); return; }
    box.appendChild(U.el('span', {
      style: { fontSize: '13px', fontWeight: '600', color: r.actual === '赢盘' ? 'var(--ok)' : r.actual === '输盘' ? 'var(--bad)' : 'var(--txt-2)' },
      text: '上盘（' + r.upSide + '）：' + r.actual +
        (r.goalDiff === null || r.goalDiff === undefined ? '' : '，净胜 ' + r.goalDiff)
    }));
  }

  function resultCols() {
    return [
      { k: 'seq', n: '#', w: '46px' },
      { k: 'league', n: '联赛', w: '54px' },
      { k: 'round', n: '轮次', w: '46px', num: 1 },
      { k: 'match', n: '对阵', w: '168px' },
      { k: 'core', n: '本心实力盘', w: '112px' },
      { k: 'open', n: '机构初盘', w: '112px' },
      { k: 'close', n: '机构终盘', w: '112px' },
      { k: 'water', n: '盘口变动 / 水位', w: '140px' },
      { k: 'tag', n: '深开/浅开', w: '66px' },
      { k: 'scene', n: '八大场景匹配', w: '196px' },
      { k: 'arb', n: '冲突仲裁结论', w: '168px' },
      { k: 'score', n: '四维评分 偏差/联动/仲裁/时间', w: '200px' },
      { k: 'total', n: '综合评分', w: '64px', num: 1 },
      { k: 'str', n: '信号强度', w: '62px' },
      { k: 'sc', n: '最终比分', w: '70px' },
      { k: 'act', n: '上盘是否赢盘', w: '92px' },
      { k: 'stat', n: '同场景统计 场次/已开奖/投注盈利(概率)', w: '230px' },
      { k: 'del', n: '', w: '44px' },
    ];
  }
  /** 结果明细：只输出纯文字与数值，不带任何彩色标签 / 图标 / 代码样式 */
  function resultRow(x, sm) {
    const r = x.r, inp = x.rec.inp;
    const st = sm && sm[x.rec.seq];
    const nvTxt = (r.hcpUp ? '升盘 ' : r.hcpDown ? '降盘 ' : '盘口不变 ') + U.fmt(r.Nv, 2) + ' / ' + r.move;
    return {
      seq: x.rec.seq + (r.warn && r.warn.length ? ' ⚠' : ''),
      league: inp.league || '',
      round: inp.round === undefined || inp.round === '' ? '' : inp.round,
      match: (inp.home || '?') + ' vs ' + (inp.away || '?'),
      core: r.corePanText + (r.crit ? '（临界）' : ''),
      open: r.J === null ? '' : U.fmt(r.J) + ' ' + r.jText,
      close: r.K === null ? '' : U.fmt(r.K) + ' ' + r.kText,
      water: nvTxt + ' / ' + r.water,
      tag: r.Q,
      scene: r.scene,
      arb: r.arb,
      score: U.fmt(r.devScore, 2) + ' / ' + U.fmt(r.linkScore, 2) + ' / ' + U.fmt(r.arbScore, 2) + ' / ' + U.fmt(r.timeScore, 2),
      total: U.fmt(r.total, 2),
      str: r.strength,
      sc: inp.scoreText || '',
      act: r.actual || '待录',
      stat: st ? (st['场次'] + ' 场 / 开 ' + st['已开奖'] + ' / 盈利 ' + st['投注盈利场次'] +
        (st['投注盈利概率'] === '' ? '（—）' : '（' + U.pct(st['投注盈利概率']) + '）') +
        (st['场景验证准确率'] === '' ? '' : ' · 意图' + U.pct(st['场景验证准确率']))) : '',
      del: '<button class="sm danger" data-del="' + x.i + '">删</button>',
    };
  }

  /* ================= 页面注册 ================= */
  window.App.register({
    id: 'batch', title: '批量计算', icon: '∑', group: '计算',
    desc: '三个标签页：① 整行快录（粘贴一行或多行，一次入库多场）→ ② 单场录入 · 盘（表单逐项填，右侧实时出完整结果）→ ③ 记录库 · 赛果（结算明细 + 逐场填比分，自动判上盘是否赢盘）。',
    render: function (host) {
      const chips = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
      [['quick', '① 整行快录'], ['form', '② 单场录入 · 盘'], ['res', '③ 记录库 · 赛果']].forEach(function (t) {
        const ch = U.el('span', { class: 'chip' + (state.tab === t[0] ? ' on' : ''), text: t[1] });
        ch.addEventListener('click', function () { state.tab = t[0]; window.App.refresh(); });
        chips.appendChild(ch);
      });
      host.appendChild(chips);
      if (state.tab === 'res') panelResults(host);
      else if (state.tab === 'form') panelForm(host);
      else panelQuick(host);
    }
  });

  // 结果表里的删除按钮
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t && t.dataset && t.dataset.del !== undefined) {
      const i = Number(t.dataset.del);
      if (isNaN(i)) return;
      C.store.rows.splice(i, 1); C.saveRows();
      U.toast('已删除 1 条', 'ok');
      window.App.refresh(); window.App.updateFoot();
    }
  });

  window.Batch = {
    statMap: statMap,
    state: state,
    /** 供「生成录入」一键送入：把一份输入对象装进表单并切到「盘 · 单场计算」 */
    acceptFromEntry: function (inp) {
      state.form = Object.assign(C.blankInput(), inp || {});
      state.editSeq = null;
      state.tab = 'form';
      window.App.refresh();
    },
    /** 打开某条已有记录进「盘」编辑（回写模式） */
    editRecord: function (seq) {
      const rec = C.store.rows.filter(function (r) { return r.seq === seq; })[0];
      if (!rec) return false;
      state.form = Object.assign(C.blankInput(), rec.inp);
      state.editSeq = rec.seq;
      state.tab = 'form';
      window.App.refresh();
      return true;
    },
    /** 外部指定要打开的标签页 */
    openForm: function (inp) { window.Batch.acceptFromEntry(inp); },
    /** 供「伤停量化」把三个文本标签送到 ② 盘的加减分项 */
    applyInjury: function (side, data) {
      if (!state.form) state.form = C.blankInput();
      state.pendingInjury = { side: side === 'away' ? 'away' : 'home', data: data || {} };
      state.tab = 'form';
      return true;
    },
    /** ★ 一场比赛两队一起写入（伤停量化「两队同时录」时用这个） */
    applyInjuryBoth: function (homeData, awayData) {
      if (!state.form) state.form = C.blankInput();
      const put = function (d, p) {
        if (!d) return;
        if (d.injury !== undefined) state.form[p + 'Injury'] = d.injury;
        if (d.depth !== undefined) state.form[p + 'Depth'] = d.depth;
        if (d.suspend !== undefined) state.form[p + 'Suspend'] = d.suspend;
      };
      put(homeData, 'h');
      put(awayData, 'a');
      state.pendingInjury = null;
      state.tab = 'form';
      return true;
    },
    /** 供自检 / 深链使用：直接切到某个标签页 */
    setTab: function (t) { if (['quick', 'form', 'res'].indexOf(t) >= 0) state.tab = t; },
    getTab: function () { return state.tab; },
    /** 整行快录：把文本灌进输入框并解析（外部模块也能用） */
    quickFill: function (text, parse) {
      state.quickText = String(text == null ? '' : text);
      state.quickRows = parse ? C.parseCommaText(state.quickText) : null;
      state.tab = 'quick';
      window.App.refresh();
      return state.quickRows;
    },
    // 供自动化测试使用
    __resultRow: resultRow, __resultCols: resultCols, __saveFormForTest: saveForm,
    __state: state,
  };
})();
