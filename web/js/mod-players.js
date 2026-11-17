/* =========================================================================
 * mod-players.js — 球员库 / 伤停量化 / 转会窗口
 *
 *   ① 球员库   上传 .xls / .xlsx / .csv（可多选、可替换、可合并），
 *              手动编辑号码·姓名·位置·身价，新增联赛/球队/球员，删除改错
 *   ② 伤停量化 一场比赛主客两队并排录；每队 3 组号码：
 *              ①上一场首发 ②上一场替补 ③本场比赛伤停（伤病+停赛合一，号码后标 (是)/(否)/(停)/(新)）
 *              → 按「本次优化规则」自动算出 伤病等级 / 阵容深度 / 停赛等级 三个文本标签
 *   ③ 转会窗口 英超/西甲/意甲/德甲/法甲 夏窗冬窗日期 + 倒计时提醒（可增删改，支持其它联赛）
 *
 *   存储：benxin.players.v1（球员库） / benxin.injury.v1（最近一次伤停录入）
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const LS_PL = 'benxin.players.v1';
  const LS_INJ = 'benxin.injury.v2';

  /* ==================== 状态 ==================== */
  const S = {
    tab: 'lib',
    lg: '', team: '',
    q: '',                       // 球员搜索
    editNum: null,               // 正在改的球员（原号码）
    imp: null,                   // 待确认的导入结果
    inj: {
      lg: '', home: '', away: '',
      h: { starters: '', subs: '', injured: '' },
      a: { starters: '', subs: '', injured: '' },
      newSign: '',
    },
    injRes: null,
    injMsg: '', injMsgKind: '',
    tmsg: '', tmsgKind: '',
  };

  /* ==================== 球员库数据 ==================== */
  function blank() {
    return { v: 1, positions: [], leagues: [], teams: {}, meta: {}, players: {} };
  }
  /* ============================================================
   * 🔄 从球探（titan007）更新球队/球员库
   *
   * ★ 只能走本地后端：zq.titan007.com 只支持 TLS 1.0，浏览器 fetch 握不上手。
   * ★ 球探限流很凶（连续请求会被临时断连）→ 一次别选太多联赛；支持断点续抓。
   * ============================================================ */
  const TITAN_ST = { data: null, busy: false, msg: '', timer: null, picked: null, source: 'tm', season: '' };

  function titanBases() {
    const out = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') out.push(location.origin);
    ['http://127.0.0.1:8765', 'http://127.0.0.1:8766', 'http://127.0.0.1:8767'].forEach(function (b) {
      if (out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }

  function titanFetch(path, opt) {
    const bases = titanBases();
    let i = 0;
    function next() {
      if (i >= bases.length) return Promise.reject(new Error('连不上本地后端（先双击 启动.bat）'));
      const base = bases[i++];
      return fetch(window.withToken ? window.withToken(base + path) : (base + path), opt).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function () { return next(); });
    }
    return next();
  }

  function titanSyncCard() {
    const libLeagues = Object.keys((C.store.LIB && C.store.LIB.leagues) || {});
    if (!TITAN_ST.picked) TITAN_ST.picked = libLeagues.slice(0, 2);

    const c = U.el('div', { class: 'card', style: { borderColor: 'var(--line-2)' } });
    c.appendChild(U.el('h2', {}, [document.createTextNode('🔄 更新球队 / 球员库'),
      U.el('span', { class: 'hint', text: '数据来自球探网，转会 / 升降级后点一下' })]));

    /* 数据源切换 */
    const srcRow = U.el('div', { class: 'chips', style: { marginBottom: '6px' } });
    [['tm', 'Transfermarkt（推荐）'], ['titan', '球探 titan007（有中文名）']].forEach(function (t) {
      const chip = U.el('span', { class: 'chip' + (TITAN_ST.source === t[0] ? ' on' : ''), text: t[1] });
      chip.addEventListener('click', function () {
        TITAN_ST.source = t[0]; TITAN_ST.data = null; window.App.refresh();
      });
      srcRow.appendChild(chip);
    });
    c.appendChild(srcRow);

    /* 赛季（留空 = 各联赛当前赛季；下赛季/补历史就填一个，例如 2027） */
    const sRow = U.el('div', { class: 'row', style: { marginBottom: '8px', alignItems: 'center' } });
    sRow.appendChild(U.field('赛季（留空=当前）', U.input(TITAN_ST.season, function (v) { TITAN_ST.season = v; },
      { placeholder: '例如 2027；留空自动' })));
    c.appendChild(sRow);

    /* ★ 站点身份提醒：localhost 和 netlify 是两份独立的本地存储，抓到的数据不互通 */
    /* file:// 也是本机页面（能连 127.0.0.1 后端），别当成外站 */
    const isLocal = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) || location.protocol === 'file:';
    const banner = U.el('div', {
      style: {
        margin: '0 0 10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.3px', lineHeight: '1.75',
        background: isLocal ? 'rgba(210,153,34,.12)' : 'rgba(77,156,246,.12)',
        border: '1px solid ' + (isLocal ? 'rgba(210,153,34,.35)' : 'rgba(77,156,246,.35)')
      },
      html: isLocal
        ? '⚠ <b>你现在在「本机页面」</b>（127.0.0.1）。抓到的数据<b>只存在这里</b>，不会出现在 netlify 那个页面。<br>' +
          '要让平时用的那份也更新：抓完点下面 <b>「⬇ 导出球员库 JSON」</b> → 打开 ' +
          '<b>https://benxin-pankou.netlify.app</b> → 球员库 → <b>「⬆ 导入球员库 JSON」</b>。'
        : 'ℹ <b>你在 netlify 页面</b>。浏览器不允许 https 页面访问本机服务，所以<b>抓取要去本机页面做</b>：<br>' +
          '双击桌面「本心盘口」→ 抓取 → 导入 → <b>「⬇ 导出球员库 JSON」</b> → 回到本页 → <b>「⬆ 导入球员库 JSON」</b>。'
    });
    c.appendChild(banner);

    const info = U.el('div', { class: 'mini', style: { lineHeight: '1.8', marginBottom: '8px' }, text: '正在读取…' });
    c.appendChild(info);

    /* 已选数量 + 全选/清空（之前默认只选前 2 个，用户以为别的抓不到） */
    const pickRow = U.el('div', { class: 'row', style: { marginBottom: '4px', alignItems: 'center' } });
    pickRow.appendChild(U.el('span', {
      class: 'mini',
      text: '已选 ' + TITAN_ST.picked.length + ' / ' + libLeagues.length + ' 个联赛　　点下面的名字可以加选/取消'
    }));
    pickRow.appendChild(U.btn('全选', function () {
      TITAN_ST.picked = libLeagues.slice(); window.App.refresh();
    }, 'sm ghost'));
    pickRow.appendChild(U.btn('清空', function () {
      TITAN_ST.picked = []; window.App.refresh();
    }, 'sm ghost'));
    c.appendChild(pickRow);

    const chips = U.el('div', { class: 'chips', style: { marginBottom: '8px' } });
    libLeagues.forEach(function (name) {
      const on = TITAN_ST.picked.indexOf(name) >= 0;
      const chip = U.el('span', { class: 'chip' + (on ? ' on' : ''), text: name });
      chip.addEventListener('click', function () {
        const i = TITAN_ST.picked.indexOf(name);
        if (i >= 0) TITAN_ST.picked.splice(i, 1); else TITAN_ST.picked.push(name);
        window.App.refresh();
      });
      chips.appendChild(chip);
    });
    c.appendChild(chips);

    const row = U.el('div', { class: 'row' });
    row.appendChild(U.btn('🔄 更新选中联赛（' + TITAN_ST.picked.length + '）', function () { titanStart(false); }, 'pri'));
    row.appendChild(U.btn('⟳ 强制全量重抓', function () {
      U.confirmBox('会把选中联赛的阵容全部重新抓一遍（慢，而且更容易被球探限流）。继续？', function () {
        titanStart(true);
      });
    }, 'ghost'));
    row.appendChild(U.btn('⬇ 导入到球员库（全部）', function () { titanImport(); }, 'pri'));
    row.appendChild(U.btn('🔀 合并中英文队名', function () { mergeTeamNames(); }, 'ghost'));
    row.appendChild(U.btn('🆔 补齐 TM 球员 ID', function () { fillPlayerIds(); }, 'ghost'));
    c.appendChild(row);

    /* 上一次「合并中英文队名」的结果 */
    if (TITAN_ST.mergeReport) {
      const mr = U.el('div', {
        class: 'mini',
        style: { marginTop: '8px', padding: '9px 11px', borderRadius: '9px', background: 'var(--bg)', border: '1px solid var(--line-2)', lineHeight: '1.7' },
        html: TITAN_ST.mergeReport
      });
      c.appendChild(mr);
    }

    const st = U.el('div', {
      class: 'mini', 'data-titan-st': '1',
      style: { marginTop: '8px', minHeight: '17px', color: 'var(--txt-2)' },
      text: TITAN_ST.msg || ''
    });
    c.appendChild(st);

    c.appendChild(U.note('说明：<b>只能由本地后端抓</b>（两个源都不让浏览器直连：Transfermarkt 封装服务没开 CORS，' +
      '球探的服务器只支持老式 TLS），所以先双击 <code>竞彩计算器\\启动.bat</code>，再用 <code>http://127.0.0.1:8765</code> 打开本页面。<br>' +
      '★ <b>Transfermarkt</b>：字段最全（号码/位置/年龄/身高/惯用脚/身价/合同），英文名，快而稳。<br>' +
      '★ <b>球探</b>：有简体中文名，但限流很凶（一次别超 2~3 个联赛）。<br>' +
      '★ 断了不要紧：再点一次会从断掉的地方接着抓（已抓过的球队默认跳过）；想重抓全部就点「强制全量重抓」。', ''));

    titanFetch('/api/titan/db?source=' + TITAN_ST.source).then(function (j) {
      TITAN_ST.data = j;
      renderTitanInfo(info);
      if (j.status && j.status.running) { TITAN_ST.busy = true; titanPoll(); }
    }, function (e) {
      info.innerHTML = '<span style="color:var(--warn)">⚠ ' + U.esc(e.message) + '</span>' +
        '<br>这个功能需要本地后端：双击 <code>竞彩计算器\\启动.bat</code>，然后用 <code>http://127.0.0.1:8765</code> 打开本页面。';
    });

    return c;
  }

  function renderTitanInfo(el) {
    const d = TITAN_ST.data;
    if (!d || !d.ok) { el.textContent = '还没读过数据'; return; }
    const s = d.summary || {};
    if (!s.leagues) { el.innerHTML = '还没有抓过。选好联赛后点「🔄 更新选中联赛」。'; return; }

    /* ---- 2B：多久没更新了 → 顶部提醒 ---- */
    let stale = '';
    const at = String(s.updated_at || '');
    const t0 = Date.parse(at.replace(' ', 'T'));
    if (isFinite(t0)) {
      const days = Math.floor((Date.now() - t0) / 86400000);
      if (days >= 7) {
        stale = '<div style="margin:0 0 8px;padding:8px 10px;border-radius:9px;background:rgba(210,153,34,.12);' +
          'border:1px solid rgba(210,153,34,.35);color:var(--txt)">⚠ 球员库已经 <b>' + days + ' 天没更新</b>了 —— ' +
          '转会窗/赛季初尤其要刷新。勾上联赛点「🔄 更新选中联赛」，跑完再点「⬇ 导入到球员库」和「🆔 补齐 TM 球员 ID」。</div>';
      }
    }

    /* ---- 2A：谁进谁出 明细 ---- */
    const rows = (d.leagues || []).map(function (l) {
      const tag = l.label || ((l.name || '') + (l.tm_id ? '（' + l.tm_id + '）' : ''));
      const season = l.season ? '赛季 ' + U.esc(String(l.season)) + (l.season_name ? '(' + U.esc(l.season_name) + ')' : '') + '　' : '';
      let chg = '';
      const list = l.changeList || [];
      if (list.length) {
        const lines = list.slice(0, 40).map(function (c) {
          const plus = (c.added || []).map(function (x) { return '<span style="color:var(--ok)">+' + U.esc(x) + '</span>'; }).join('、');
          const minus = (c.removed || []).map(function (x) { return '<span style="color:var(--bad)">−' + U.esc(x) + '</span>'; }).join('、');
          return '<div>' + U.esc(c.team) + '　' + (plus || '') + (plus && minus ? '　' : '') + (minus || '') +
            (c.at ? '<span style="color:var(--txt-3)">（' + U.esc(c.at) + '）</span>' : '') + '</div>';
        }).join('');
        chg = '　<details style="display:inline-block;vertical-align:top"><summary style="cursor:pointer;color:var(--warn)">' +
          '有 ' + list.length + ' 队阵容变动（点开看谁进谁出）</summary>' +
          '<div class="mini" style="margin-top:5px;line-height:1.7">' + lines +
          (list.length > 40 ? '<div>…还有 ' + (list.length - 40) + ' 队</div>' : '') + '</div></details>';
      }
      return '<div>' + U.esc(tag) + '　' + season + l.teams + ' 队 / ' + l.players + ' 人' + chg + '</div>';
    }).join('');

    el.innerHTML = stale +
      '上次更新：<b>' + U.esc(s.updated_at || '?') + '</b>　共 ' + s.leagues + ' 联赛 / ' +
      s.teams + ' 球队 / <b>' + s.players + '</b> 球员' +
      '<div style="margin-top:4px">' + rows + '</div>' +
      (TITAN_ST.idReport ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">' + TITAN_ST.idReport + '</div>' : '');
  }

  function titanStart(force) {
    if (!TITAN_ST.picked.length) return U.toast('先点选至少一个联赛', 'warn');
    if (TITAN_ST.busy) return U.toast('上一次还在跑，等它结束', 'warn');
    TITAN_ST.busy = true;
    titanFetch('/api/titan/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagues: TITAN_ST.picked, force: !!force, source: TITAN_ST.source, season: TITAN_ST.season || '' })
    }).then(function (j) {
      if (!j.ok) { TITAN_ST.busy = false; return U.toast(j.error || '启动失败', 'bad'); }
      U.toast('开始更新：' + TITAN_ST.picked.join('、') + '（可以切到别的页面，后台会继续）', 'ok', 4200);
      window.App.refresh();
    }, function (e) {
      TITAN_ST.busy = false;
      U.toast(e.message, 'bad', 4200);
    });
  }

  /* Transfermarkt 英文位置 → 本心球员库的 16 档中文位置 */
  const TM_POS = {
    'Goalkeeper': '守门员',
    'Centre-Back': '中卫', 'Left-Back': '左后卫', 'Right-Back': '右后卫',
    'Defensive Midfield': '后腰', 'Central Midfield': '中前卫', 'Attacking Midfield': '前腰',
    'Left Midfield': '左中场', 'Right Midfield': '右中场',
    'Left Winger': '左边锋', 'Right Winger': '右边锋',
    'Centre-Forward': '中锋', 'Second Striker': '影锋',
    'Attack': '前锋', 'Midfield': '中场', 'Defender': '后卫'
  };
  function tmPos(p) {
    const byEn = TM_POS[p.pos_en] || TM_POS[(p.pos_en || '').trim()];
    if (byEn) return byEn;
    const s = String(p.pos || '');
    if (pl().positions.indexOf(s) >= 0) return s;
    if (/门/.test(s)) return '守门员';
    if (/后卫|卫/.test(s)) return '中卫';
    if (/前锋|锋/.test(s)) return '中锋';
    return '中场';
  }

  /** 把后端抓到的阵容写进模型自带的球员库（伤停量化用的那张表） */
  function titanImport() {
    titanFetch('/api/titan/db?source=' + TITAN_ST.source + '&full=1').then(function (j) {
      const raw = j && j.raw;
      const lgObj = (raw && raw.leagues) || {};
      const names = Object.keys(lgObj);
      if (!names.length) return U.toast('还没有抓过数据，先点「更新选中联赛」', 'warn');

      let nLg = 0, nTeam = 0, nPl = 0;
      const plan = [];
      names.forEach(function (lg) {
        const teams = (lgObj[lg] && lgObj[lg].teams) || [];
        teams.forEach(function (t) {
          const arr = (t.players || []).map(function (p) {
            return {
              num: (p.num === '' || p.num === null || p.num === undefined) ? null : p.num,
              name: p.name || '',
              pos: tmPos(p),
              val: (p.mv === null || p.mv === undefined) ? null : Math.round(Number(p.mv) / 10000),
              id: p.id ? String(p.id) : null
            };
          }).filter(function (x) { return x.name; });
          if (!arr.length) return;
          plan.push({ lg: lg, team: (t.name || '').trim(), arr: arr });
          nTeam++; nPl += arr.length;
        });
        nLg++;
      });
      if (!plan.length) return U.toast('抓到的球队里没有球员数据', 'warn');

      U.confirmBox('即将写入球员库：\n\n' + nLg + ' 个联赛 / ' + nTeam + ' 支球队 / ' + nPl + ' 名球员\n\n' +
        '· 同名球队会【覆盖】号码和位置（这正是转会更新想要的效果）\n' +
        '· 新球队会以英文名新增（Transfermarkt 原名），想改中文可用「球队改名」\n' +
        '· 你手填的其它球队不受影响\n\n继续？', function () {
        const P = pl();
        let addLg = 0, addTeam = 0, updTeam = 0;
        plan.forEach(function (it) {
          if (P.leagues.indexOf(it.lg) < 0) { P.leagues.push(it.lg); addLg++; }
          if (!P.teams[it.lg]) P.teams[it.lg] = [];
          if (P.teams[it.lg].indexOf(it.team) < 0) { P.teams[it.lg].push(it.team); addTeam++; }
          else updTeam++;
          setPlayers(it.lg, it.team, it.arr);
        });
        savePL();
        U.toast('已导入：新增 ' + addLg + ' 联赛 / ' + addTeam + ' 队，更新 ' + updTeam + ' 队，共 ' + nPl + ' 人', 'ok', 6000);
        window.App.refresh();
      });
    }, function (e) {
      U.toast(e.message, 'bad', 5000);
    });
  }

  /* ============================================================
   * 🔀 合并中英文队名
   *
   * 背景：Transfermarkt 只给英文队名（Arsenal FC），而你库里原来存的是中文（阿森纳）。
   * 巧的是你库里每支队的 meta.full 都带着英文别名，形如「阿森纳（Arsenal）」，
   * 所以可以自动对号：把英文队改名成中文，并把两边球员合并成一支队。
   * ============================================================ */
  const EN2CN = {
    "Stade Brestois 29": "布雷斯特", "Académico Viseu FC": "维塞乌",
    "Paris FC": "巴黎FC", "Le Havre AC": "勒阿弗尔", "Angers SCO": "昂热",
    "FC Lorient": "洛里昂", "Le Mans FC": "勒芒", "ESTAC Troyes": "特鲁瓦",
    "AJ Auxerre": "欧塞尔", "Toulouse FC": "图卢兹", "OGC Nice": "尼斯",
    "Lille OSC": "里尔", "RC Lens": "朗斯", "Olympique Marseille": "马赛",
    "AS Monaco": "摩纳哥", "Olympique Lyon": "里昂", "Paris Saint-Germain": "巴黎圣日耳曼",
    "RC Strasbourg Alsace": "斯特拉斯堡", "Stade Rennais FC": "雷恩",
    "FC Alverca": "艾华卡", "Estrela Amadora": "阿马多拉", "SC Farense": "法鲁人",
    "West Ham United": "西汉姆联",
    "Wolverhampton Wanderers": "狼队",
    "Middlesbrough FC": "米德尔斯堡",
    "Southampton FC": "南安普顿",
    "Burnley FC": "伯恩利",
    "Swansea City": "斯旺西",
    "Sheffield United": "谢菲尔德联",
    "Norwich City": "诺维奇",
    "Stoke City": "斯托克城",
    "Wrexham AFC": "雷克瑟姆",
    "Birmingham City": "伯明翰",
    "Watford FC": "沃特福德",
    "Millwall FC": "米尔沃尔",
    "West Bromwich Albion": "西布罗姆维奇",
    "Bristol City": "布里斯托城",
    "Derby County": "德比郡",
    "Queens Park Rangers": "女王公园巡游者",
    "Preston North End": "普雷斯顿",
    "Charlton Athletic": "查尔顿",
    "Portsmouth FC": "朴茨茅斯",
    "Blackburn Rovers": "布莱克本",
    "Bolton Wanderers": "博尔顿",
    "Cardiff City": "卡迪夫城",
    "Lincoln City": "林肯城",
    "PSV Eindhoven": "埃因霍温",
    "Feyenoord Rotterdam": "费耶诺德",
    "Ajax Amsterdam": "阿贾克斯",
    "AZ Alkmaar": "阿尔克马尔",
    "FC Twente Enschede": "特温特",
    "FC Utrecht": "乌得勒支",
    "NEC Nijmegen": "奈梅亨",
    "SC Heerenveen": "海伦芬",
    "FC Groningen": "格罗宁根",
    "Sparta Rotterdam": "鹿特丹斯巴达",
    "PEC Zwolle": "兹沃勒",
    "Go Ahead Eagles": "前进之鹰",
    "Willem II Tilburg": "蒂尔堡威廉二世",
    "Excelsior Rotterdam": "鹿特丹精英",
    "ADO Den Haag": "海牙",
    "Fortuna Sittard": "西塔德福图纳",
    "SC Cambuur Leeuwarden": "坎布尔",
    "SC Telstar": "特尔斯达",
    "Al-Hilal SFC": "利雅得新月",
    "Al-Ahli SFC": "吉达国民",
    "Al-Qadsiah FC": "卡达西亚",
    "Al-Ittihad Club": "吉达联合",
    "Al-Nassr FC": "利雅得胜利",
    "NEOM SC": "新未来城体育",
    "Al-Diriyah FC": "迪雷禾",
    "Al-Shabab FC": "利雅得青年人",
    "Al-Ettifaq FC": "达曼协作",
    "Al-Taawoun FC": "布赖代合作",
    "Al-Fateh SC": "哈萨征服",
    "Al-Khaleej FC": "塞哈特海湾",
    "Abha Club": "艾卜哈",
    "Al-Kholood Club": "哈鲁德",
    "Al-Fayha FC": "费哈",
    "Al-Riyadh SC": "利雅得体育",
    "Al-Faisaly FC": "费萨里哈曼",
    "Al-Hazem SC": "哈森姆",
    "Inter Miami CF": "迈阿密国际",
    "New York City FC": "纽约城",
    "FC Cincinnati": "辛辛那提",
    "Columbus Crew": "哥伦布机员",
    "Vancouver Whitecaps FC": "温哥华白浪",
    "Atlanta United FC": "亚特兰大联",
    "Orlando City SC": "奥兰多城",
    "Los Angeles FC": "洛杉矶FC",
    "Real Salt Lake City": "皇家盐湖城",
    "Chicago Fire FC": "芝加哥火焰",
    "Portland Timbers": "波特兰伐木者",
    "Seattle Sounders FC": "西雅图海湾人",
    "Philadelphia Union": "费城联合",
    "Colorado Rapids": "科罗拉多急流",
    "Red Bull New York": "纽约红牛",
    "San Diego FC": "圣地亚哥FC",
    "New England Revolution": "新英格兰革命",
    "FC Dallas": "达拉斯FC",
    "Toronto FC": "多伦多FC",
    "Nashville SC": "纳什威尔",
    "Los Angeles Galaxy": "洛杉矶银河",
    "Charlotte FC": "夏洛特FC",
    "St. Louis CITY SC": "圣路易斯城",
    "Sporting Kansas City": "堪萨斯城竞技",
    "Minnesota United FC": "明尼苏达联",
    "San Jose Earthquakes": "圣何塞地震",
    "Austin FC": "奥斯汀FC",
    "CF Montréal": "蒙特利尔",
    "Houston Dynamo FC": "休斯敦迪纳摩",
    "D.C. United": "华盛顿联",
    "FK Bodø/Glimt": "波杜基林特",
    "Viking FK": "维京",
    "Molde FK": "莫尔德",
    "Rosenborg BK": "罗森博格",
    "SK Brann": "布兰",
    "Tromsø IL": "特罗姆瑟",
    "Sarpsborg 08 FF": "萨尔普斯堡",
    "Sandefjord Fotball": "桑德菲尤尔",
    "Lillestrøm SK": "利勒斯特罗姆",
    "Kristiansund BK": "克里斯蒂安松",
    "Fredrikstad FK": "弗雷德里克斯塔",
    "Aalesunds FK": "阿勒松",
    "Vålerenga Fotball Elite": "瓦勒伦加",
    "Hamarkameratene": "哈马尔",
    "KFUM-Kameratene Oslo": "KFUM奥斯陆",
    "IK Start": "斯塔特",
    "Kashima Antlers": "鹿岛鹿角",
    "Kawasaki Frontale": "川崎前锋",
    "Sanfrecce Hiroshima": "广岛三箭",
    "Kashiwa Reysol": "柏太阳神",
    "FC Tokyo": "东京FC",
    "Vissel Kobe": "神户胜利船",
    "Machida Zelvia": "町田泽维亚",
    "Gamba Osaka": "大阪钢巴",
    "Urawa Red Diamonds": "浦和红钻",
    "Cerezo Osaka": "大阪樱花",
    "JEF United Chiba": "市原千叶",
    "Kyoto Sanga": "京都不死鸟",
    "Shimizu S-Pulse": "清水心跳",
    "V-Varen Nagasaki": "长崎航海",
    "Yokohama F. Marinos": "横滨水手",
    "Tokyo Verdy": "东京绿茵",
    "Nagoya Grampus": "名古屋鲸鱼",
    "Fagiano Okayama": "冈山绿雉",
    "Avispa Fukuoka": "福冈黄蜂",
    "Mito HollyHock": "水户蜀葵",
    "Jeonbuk Hyundai Motors": "全北现代",
    "Ulsan HD FC": "蔚山HD",
    "Daejeon Hana Citizen": "大田市民",
    "Gimcheon Sangmu": "金泉尚武",
    "FC Seoul": "FC首尔",
    "Gangwon FC": "江原FC",
    "FC Anyang": "安养FC",
    "Jeju SK": "济州SK",
    "Incheon United": "仁川联",
    "Bucheon FC 1995": "富川FC",
    "Gwangju FC": "光州FC",
    "Pohang Steelers": "浦项制铁",
    "Kuopion Palloseura": "库奥皮奥",
    "HJK Helsinki": "赫尔辛基",
    "FC Inter Turku": "国际图尔库",
    "AC Oulu": "奥卢",
    "SJK Seinäjoki": "塞伊奈约基",
    "IF Gnistan": "格尼斯塔",
    "Vaasan Palloseura": "瓦萨",
    "Ilves Tampere": "伊尔韦斯",
    "IFK Mariehamn": "马里港",
    "FC Lahti": "拉赫蒂",
    "Turun Palloseura": "图尔库",
    "FF Jaro": "雅罗",
    "Melbourne City FC": "墨尔本城",
    "Adelaide United": "阿德莱德联",
    "Sydney FC": "悉尼FC",
    "Macarthur FC": "麦克阿瑟",
    "Perth Glory": "珀斯光荣",
    "Melbourne Victory": "墨尔本胜利",
    "Newcastle United Jets": "纽卡斯尔喷气机",
    "Auckland FC": "奥克兰FC",
    "Wellington Phoenix": "惠灵顿凤凰",
    "Western Sydney Wanderers": "西悉尼流浪者",
    "Brisbane Roar": "布里斯班狮吼",
    "Central Coast Mariners": "中央海岸水手"
  };

  /* 有些联赛的 meta.full 里没写英文（意甲就是这样），用这张内置表兜底 */
  const BUILTIN_EN = {
    '尤文图斯': 'Juventus', '莱切': 'Lecce', '亚特兰大': 'Atalanta', '国际米兰': 'Inter',
    'AC米兰': 'AC Milan', '博洛尼亚': 'Bologna', '卡利亚里': 'Cagliari', '拉齐奥': 'Lazio',
    '佛罗伦萨': 'Fiorentina', '罗马': 'Roma', '都灵': 'Torino', '威尼斯': 'Venezia',
    '热那亚': 'Genoa', '帕尔马': 'Parma', '乌迪内斯': 'Udinese', '萨索洛': 'Sassuolo',
    '蒙扎': 'Monza', '那不勒斯': 'Napoli', '科莫': 'Como', '弗罗西诺内': 'Frosinone',
    '亚特兰大联': 'Atalanta United'
  };

  const TEAM_STOP = new Set(('fc cf ac as sc sl rc cd ud sv vfb vfl tsg fsv spvgg bk fk if sk al sad ssc ss us ' +
    'asd cs csd ca ec aa clube club de do da del la el the').split(' '));

  function teamTokens(s) {
    let t = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    t = t.replace(/[.'’`]/g, '').replace(/[-/]/g, ' ').replace(/[^a-z0-9\s]/g, ' ');
    return t.split(/\s+/).filter(function (x) { return x && !TEAM_STOP.has(x) && !/^\d{2,4}$/.test(x); });
  }
  function enOf(full) {
    const m = String(full || '').match(/[（(]([^）)]+)[）)]/);
    return m ? m[1] : '';
  }
  function hasCJK(s) { return /[\u4e00-\u9fa5]/.test(String(s || '')); }

  function bestMatch(enName, cands) {
    const a = teamTokens(enName);
    if (!a.length) return null;
    const aj = a.join(' ');
    let best = null, bestScore = 0;
    cands.forEach(function (c) {
      const b = teamTokens(c.en);
      if (!b.length) return;
      const bj = b.join(' ');
      let score = 0;
      if (aj === bj) score = 100;
      else if (aj.indexOf(bj) >= 0 || bj.indexOf(aj) >= 0) score = 70;
      else {
        const shared = a.filter(function (x) { return b.indexOf(x) >= 0; }).length;
        if (shared > 0) score = Math.round(50 * shared / Math.max(a.length, b.length) * 2);
      }
      if (score > bestScore) { bestScore = score; best = c; }
    });
    return bestScore >= 40 ? best : null;
  }

  /**
   * 🆔 补齐 TM 球员 ID
   *
   * 为什么要它：查伤病要用 TM 的球员 ID（/players/{id}/injuries），
   *   而现在库里只有号码/姓名/身价。补齐之后：
   *     · 按号码查伤病不用再"球队名→TM阵容"翻译（省请求、也不怕库里缺这支队）
   *     · 换个赛季/转会后，再点一次就同步
   *
   * 怎么补：从后端读 TM 数据库（每队阵容带号码 + ID），
   *   按【联赛 + 球队 + 号码】一对一填进去。号码对得上才填，绝不瞎填。
   * 只加第 5 位 ID，号码/姓名/位置/身价一个字都不动。
   */
  function fillPlayerIds() {
    titanFetch('/api/titan/db?source=tm&full=1').then(function (j) {
      const raw = (j && j.raw) || {};
      const lgObj = raw.leagues || {};
      const P = pl();
      let filled = 0, teams = 0, missNum = 0, missTeam = 0;
      const missSample = [];

      Object.keys(lgObj).forEach(function (lg) {
        if (P.leagues.indexOf(lg) < 0) return;
        const dbTeams = (lgObj[lg] && lgObj[lg].teams) || [];
        dbTeams.forEach(function (t) {
          const tname = (t.name || '').trim();
          if (!tname) return;
          /* 库里找这支球队：中文名对不上，就走 meta.full 里的英文别名（合并后库里都是中文） */
          let local = (P.teams[lg] || []).indexOf(tname) >= 0 ? tname : null;
          if (!local) {
            const hits = (P.teams[lg] || []).filter(function (x) {
              return x.indexOf(tname) >= 0 || tname.indexOf(x) >= 0;
            });
            if (hits.length === 1) local = hits[0];
          }
          if (!local) {
            const cands = (P.teams[lg] || []).map(function (x) {
              const m = (P.meta[key(lg, x)] || {});
              const en = enOf(m.full) || BUILTIN_EN[x] || '';
              return { name: x, en: en };
            }).filter(function (c) { return c.en; });
            const hit = bestMatch(tname, cands);
            if (hit) local = hit.name;
          }
          if (!local) { missTeam++; return; }
          teams++;

          /* TM 侧：号码 → ID（同号多人就跳过，不猜） */
          const map = {};
          const dup = {};
          (t.players || []).forEach(function (p) {
            const n = (p.num === null || p.num === undefined) ? '' : String(p.num).trim();
            if (!n || !p.id) return;
            if (map[n] !== undefined) { dup[n] = 1; return; }
            map[n] = String(p.id);
          });
          Object.keys(dup).forEach(function (n) { delete map[n]; });

          /* 写回：只补没有 ID 的 */
          const arr = P.players[key(lg, local)] || [];
          let changed = false;
          const out = arr.map(function (a) {
            const n = (a[0] === null || a[0] === undefined) ? '' : String(a[0]).trim();
            if (a[4]) return a;                       /* 已经有 ID，不动 */
            if (n && map[n]) { filled++; changed = true; return [a[0], a[1], a[2], a[3], map[n]]; }
            if (n) { missNum++; if (missSample.length < 8) missSample.push(lg + '·' + local + ' #' + n); }
            return a;
          });
          if (changed) P.players[key(lg, local)] = out;
        });
      });

      savePL();
      /* 统计全库覆盖率，比"填了 0 人"有用得多 */
      let total = 0, withId = 0;
      const P2 = pl();
      Object.keys(P2.players || {}).forEach(function (k) {
        (P2.players[k] || []).forEach(function (a) { total++; if (a[4]) withId++; });
      });
      const pct = total ? Math.round(withId * 1000 / total) / 10 : 0;
      let msg = 'TM 球员 ID：全库 <b>' + withId + ' / ' + total + ' 人（' + pct + '%）有 ID</b>' +
        '　本次新补 ' + filled + ' 人（扫了 ' + teams + ' 支队）';
      if (!filled) msg += '<br>👉 <b>新补 0 人 = 之前就已经补齐了</b>（导入 + 合并时就把 ID 带过来了），不是失败。';
      if (missNum) msg += '<br>号码在 TM 里对不上的：' + missNum + ' 人' +
        (missSample.length ? '（例：' + U.esc(missSample.join('、')) + '…）' : '') +
        '<br>这些人多半是<b>青年队/预备队</b>号码，TM 一线队名单里没有 —— 不影响主力伤停判断。';
      if (missTeam) msg += '<br>库里没有这些队：' + missTeam + ' 支（跳过）';
      TITAN_ST.idReport = msg;
      window.App.refresh();
      U.toast('补齐 TM ID：' + filled + ' 人', filled ? 'ok' : 'warn', 5000);
    }, function (e) {
      U.toast(e.message, 'bad', 5000);
    });
  }

  function mergeTeamNames() {
    const P = pl();
    const report = { merged: [], unmatched: [], leagues: 0 };
    P.leagues.slice().forEach(function (lg) {
      const teams = (P.teams[lg] || []).slice();
      const cn = [], en = [];
      teams.forEach(function (t) {
        (hasCJK(t) ? cn : en).push(t);
      });
      if (!en.length) return;          /* 没有英文队 → 没事可做 */
      report.leagues++;                /* cn 为空也要继续：靠内置表把英文改成中文 */
      const cands = cn.map(function (t) {
        const meta = P.meta[key(lg, t)] || {};
        const en = enOf(meta.full) || BUILTIN_EN[t] || '';
        return { name: t, en: en, used: false };
      }).filter(function (x) { return x.en; });
      const handled = {};
      en.forEach(function (et) {
        const pool = cands.filter(function (x) { return !x.used; });   /* ★ 一对一：用过的不再参与 */
        const hit = bestMatch(et, pool);
        if (!hit) return;                                              /* 留给第二遍 */
        hit.used = true;
        handled[et] = hit;
      });
      /* —— 第二遍：没有中文对照的英文队，直接按内置表改成中文 —— */
      const leftover = en.filter(function (et) { return !handled[et]; });
      leftover.forEach(function (et) {
        const cn = EN2CN[et] || EN2CN[String(et).trim()];
        if (!cn) { report.unmatched.push(lg + ' · ' + et); return; }
        handled[et] = { name: cn, renameOnly: true };
      });

      Object.keys(handled).forEach(function (et) {
        const hit = handled[et];
        /* 中文队可能还不存在（第二遍改名的情况）→ 先建出来 */
        if (P.teams[lg].indexOf(hit.name) < 0) P.teams[lg].push(hit.name);
        /* 合并球员：以中文队为主，英文队的人补进去（同号码去重） */
        const aList = P.players[key(lg, hit.name)] || [];
        const bList = P.players[key(lg, et)] || [];
        const seen = {};
        const merged = aList.slice();
        aList.forEach(function (x) { seen[String(x[0])] = 1; });
        /* ★ 同号码撞车时：中文条目优先（名字好看），但要把英文条目的 TM ID 补过去 */
        const idOfNum = {};
        bList.forEach(function (x) { if (x[4]) idOfNum[String(x[0])] = x[4]; });
        for (let mi = 0; mi < merged.length; mi++) {
          const x = merged[mi];
          if (!x[4] && idOfNum[String(x[0])]) {
            merged[mi] = [x[0], x[1], x[2], x[3], idOfNum[String(x[0])]];
          }
        }
        bList.forEach(function (x) {
          if (!seen[String(x[0])]) { merged.push(x); seen[String(x[0])] = 1; }
        });
        P.players[key(lg, hit.name)] = merged;
        delete P.players[key(lg, et)];
        delete P.meta[key(lg, et)];
        P.teams[lg] = P.teams[lg].filter(function (t) { return t !== et; });
        /* 把英文全名记进 meta，方便以后再次自动对号 */
        const mk = key(lg, hit.name);
        P.meta[mk] = P.meta[mk] || {};
        if (!P.meta[mk].full) P.meta[mk].full = hit.name + '（' + et + '）';
        report.merged.push(lg + ' · ' + et + ' → ' + hit.name + '（' + merged.length + ' 人）');
      });
    });
    if (!report.merged.length && !report.unmatched.length) {
      return U.toast('没有需要合并的（库里都是中文队名，或缺少英文别名）', 'warn', 4200);
    }
    savePL();

    const box = U.el('div', {});
    box.appendChild(U.el('div', { html: '<b>合并完成</b>：' + report.leagues + ' 个联赛，合并 ' +
      report.merged.length + ' 支队' + (report.unmatched.length ? '，' + report.unmatched.length + ' 支没匹配上' : '') }));
    if (report.merged.length) {
      box.appendChild(U.el('div', { class: 'mini', style: { marginTop: '6px', maxHeight: '180px', overflow: 'auto' },
        html: report.merged.slice(0, 60).map(function (x) { return U.esc(x); }).join('<br>') }));
    }
    if (report.unmatched.length) {
      box.appendChild(U.el('div', { class: 'mini', style: { marginTop: '6px', color: 'var(--warn)' },
        html: '没匹配上的（建议手动改名）：<br>' + report.unmatched.map(function (x) { return U.esc(x); }).join('<br>') }));
    }
    TITAN_ST.mergeReport = box.innerHTML;
    window.App.refresh();
    U.toast('已合并 ' + report.merged.length + ' 支队（中英同名）', 'ok', 5000);
  }

  function titanPoll() {
    if (TITAN_ST.timer) clearTimeout(TITAN_ST.timer);
    TITAN_ST.timer = setTimeout(function () {
      titanFetch('/api/titan/status').then(function (s) {
        const el = document.querySelector('[data-titan-st]');
        if (el) {
          el.textContent = (s.running ? '⏳ ' : (s.error ? '✘ ' : '✔ ')) + (s.msg || '') +
            (s.running && s.total ? '　' + Math.round(100 * s.done / s.total) + '%' : '');
        }
        if (s.running) { TITAN_ST.busy = true; titanPoll(); }
        else {
          TITAN_ST.busy = false;
          if (s.error) U.toast('更新出错：' + s.error, 'bad', 6000);
          else if (s.finished_at) U.toast('更新完成：' + s.msg, 'ok', 5000);
          titanFetch('/api/titan/db?source=' + TITAN_ST.source).then(function (j) {
            TITAN_ST.data = j;
            window.App.refresh();
          }, function () { });
        }
      }, function () { TITAN_ST.busy = false; });
    }, 1500);
  }

  function loadPL() {
    let o = null;
    try { const raw = localStorage.getItem(LS_PL); if (raw) o = JSON.parse(raw); } catch (e) { o = null; }
    if (!o || !o.players) {
      const seed = window.SEED_PLAYERS;
      o = seed ? JSON.parse(JSON.stringify(seed)) : blank();
      o.fromSeed = !!seed;
    }
    if (!o.positions) o.positions = [];
    if (!o.leagues) o.leagues = [];
    if (!o.teams) o.teams = {};
    if (!o.meta) o.meta = {};
    if (!o.players) o.players = {};
    return o;
  }
  let PL = null;
  function pl() { if (!PL) PL = loadPL(); return PL; }
  function savePL() {
    try { localStorage.setItem(LS_PL, JSON.stringify(pl())); }
    catch (e) { U.toast('保存失败（本地存储可能已满）：' + e.message, 'bad'); }
  }
  function key(lg, team) { return lg + '|' + team; }
  function teamsOf(lg) { return pl().teams[lg] || []; }
  function playersOf(lg, team) {
    const list = pl().players[key(lg, team)] || [];
    return list.map(function (a, i) {
      return { i: i, num: a[0], name: a[1], pos: pl().positions[a[2]] || '', val: a[3], id: a[4] || null };
    });
  }
  function setPlayers(lg, team, arr) {
    pl().players[key(lg, team)] = arr.map(function (p) {
      let pi = pl().positions.indexOf(p.pos);
      if (pi < 0) { pl().positions.push(p.pos); pi = pl().positions.length - 1; }
      /* [号码, 姓名, 位置索引, 身价(万欧), TM球员ID] —— 第 5 位是新增的，老数据没有就是 null */
      var out = [p.num === '' || p.num === null || p.num === undefined ? null : Number(p.num), p.name || '', pi,
        p.val === '' || p.val === null || p.val === undefined ? null : Number(p.val)];
      if (p.id) out.push(String(p.id));
      return out;
    });
  }
  /** 取来给伤停量化引擎用的球员数组 */
  function roster(lg, team) {
    return playersOf(lg, team).map(function (p) {
      return { num: p.num, name: p.name, pos: p.pos, val: p.val, id: p.id || null };
    });
  }
  function playerCount(lg) {
    let n = 0;
    teamsOf(lg).forEach(function (t) { n += (pl().players[key(lg, t)] || []).length; });
    return n;
  }

  /* ==================== 导入解析 ==================== */
  /** 把任意一种表格 grid 解析成 {teams:{队名:[球员]}, league} */
  function parseGrid(grid, hintLeague) {
    if (!grid || !grid.length) return null;
    // 找表头行：包含「球队」+（「号码」或「姓名」或「位置」）
    let hi = -1;
    for (let i = 0; i < Math.min(grid.length, 12); i++) {
      const row = (grid[i] || []).map(function (v) { return String(v === null || v === undefined ? '' : v).trim(); });
      const has = function (n) { return row.indexOf(n) >= 0; };
      if (has('球队') && (has('号码') || has('姓名') || has('位置') || has('预计身价'))) { hi = i; break; }
    }
    const headerRow = hi >= 0 ? grid[hi] : null;
    let ci, ni, mi, pi, vi;
    if (headerRow) {
      const h = headerRow.map(function (v) { return String(v === null || v === undefined ? '' : v).trim(); });
      ci = h.indexOf('球队'); ni = h.indexOf('号码'); mi = h.indexOf('姓名') >= 0 ? h.indexOf('姓名') : h.indexOf('球员');
      pi = h.indexOf('位置'); vi = h.indexOf('预计身价') >= 0 ? h.indexOf('预计身价') : h.indexOf('身价');
    } else {
      // 无表头：按 球队|号码|姓名|位置|国籍|身价 猜测
      ci = 0; ni = 1; mi = 2; pi = 3; vi = 5;
    }
    const need = [ci, ni, mi, pi, vi].filter(function (x) { return x >= 0; });
    if (ci < 0 || ni < 0 || mi < 0 || pi < 0) return null;

    const teams = {}, meta = {};
    let league = hintLeague || '';
    for (let i = (hi >= 0 ? hi + 1 : 0); i < grid.length; i++) {
      const row = grid[i] || [];
      const g = function (k) { return k >= 0 && row[k] !== undefined && row[k] !== null ? row[k] : ''; };
      const team = String(g(ci)).trim();
      const pos = String(g(pi)).trim();
      const name = String(g(mi)).trim();
      if (!team || team === 'None') continue;
      if (pos === '主教练' || pos === '教练' || (!name && !pos)) continue;
      if (!pos) continue;
      let num = g(ni);
      if (typeof num === 'number') num = Math.round(num);
      else {
        const s = String(num).trim();
        num = /^\d+(\.\d+)?$/.test(s) ? Math.round(parseFloat(s)) : null;
      }
      const val = C.parseValue(g(vi));
      (teams[team] = teams[team] || []).push({ num: num, name: name, pos: pos, val: val });
      if (!meta[team] || meta[team].full !== String(g(ci))) meta[team] = { full: String(g(ci)) };
    }
    // 球队信息（长表：球队|项目|内容）也能顺带吸收
    for (let i = 0; i < grid.length; i++) {
      const row = grid[i] || [];
      if (row.length < 3) continue;
      const t = String(row[0] || '').trim(), k = String(row[1] || '').trim();
      if (k === '球队' || k === '粤语首译名' || k === '球队主场' || k === '主教练' || k === '市值') {
        const m = meta[t] = meta[t] || {};
        if (k === '球队') m.full = String(row[2]); 
        else if (k === '粤语首译名') m.yue = String(row[2]);
        else if (k === '球队主场') m.stadium = String(row[2]);
        else if (k === '主教练') m.coach = String(row[2]);
        else if (k === '市值') m.mv = row[2];
      }
    }
    Object.keys(teams).forEach(function (t) { if (!meta[t]) meta[t] = {}; });
    return { league: league, teams: teams, meta: meta, headerRow: headerRow };
  }
  /** 从文件名猜联赛 */
  function leagueFromName(name) {
    const n = String(name || '');
    if (/英超|Premier|EPL/i.test(n)) return '英超';
    if (/西甲|LaLiga|La Liga|西班牙/i.test(n)) return '西甲';
    if (/意甲|Serie\s*A|意大利/i.test(n)) return '意甲';
    if (/德甲|Bundesliga|德国/i.test(n)) return '德甲';
    if (/法甲|Ligue|法国/i.test(n)) return '法甲';
    if (/葡超|Primeira|葡萄牙/i.test(n)) return '葡超';
    const m = /^([\u4e00-\u9fa5]{2,4})(总|球员|球队)/.exec(n);
    return m ? m[1] : '';
  }

  async function doUpload(files, mode, hintLg) {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const r = await window.XlsRead.readFile(f);
        let parsed = null, used = '';
        for (let k = 0; k < r.sheets.length; k++) {
          const p = parseGrid(r.sheets[k].grid, leagueFromName(f.name));
          if (p && Object.keys(p.teams).length) { parsed = p; used = r.sheets[k].name; break; }
        }
        if (!parsed) { results.push({ file: f.name, ok: false, err: '没找到「球队 / 号码 / 姓名 / 位置」这样的球员表（读了 ' + r.sheets.length + ' 个工作表）' }); continue; }
        const lg = hintLg || parsed.league || leagueFromName(f.name) || f.name.replace(/\.[^.]+$/, '');
        parsed.league = lg;
        results.push({ file: f.name, ok: true, kind: r.kind, sheet: used, lg: lg, teams: parsed.teams, meta: parsed.meta });
      } catch (e) {
        results.push({ file: f.name, ok: false, err: e.message });
      }
    }
    return results;
  }
  function applyImport(res, mode) {
    const P = pl();
    let addedTeams = 0, addedPlayers = 0, replacedTeams = 0, newLg = 0;
    res.forEach(function (r) {
      if (!r.ok) return;
      const lg = r.lg;
      if (P.leagues.indexOf(lg) < 0) { P.leagues.push(lg); P.teams[lg] = []; newLg++; }
      P.teams[lg] = P.teams[lg] || [];
      const tnames = Object.keys(r.teams);
      if (mode === 'replace') {
        // 整联赛替换
        P.teams[lg].forEach(function (t) { delete P.players[key(lg, t)]; });
        P.teams[lg] = [];
      }
      tnames.forEach(function (t) {
        const exist = P.teams[lg].indexOf(t) >= 0;
        if (exist && mode === 'replace-team') { delete P.players[key(lg, t)]; replacedTeams++; }
        if (!exist) { P.teams[lg].push(t); addedTeams++; }
        else if (mode !== 'replace-team') { replacedTeams++; }
        const before = (P.players[key(lg, t)] || []).length;
        setPlayers(lg, t, r.teams[t]);
        addedPlayers += Math.max(0, r.teams[t].length - (mode === 'replace-team' ? 0 : before));
        const m = P.meta[key(lg, t)] = P.meta[key(lg, t)] || {};
        Object.keys(r.meta[t] || {}).forEach(function (k) { if (r.meta[t][k]) m[k] = r.meta[t][k]; });
      });
    });
    savePL();
    return { addedTeams: addedTeams, addedPlayers: addedPlayers, replacedTeams: replacedTeams, newLg: newLg };
  }

  /* ==================== ① 球员库 ==================== */
  function tabLib(host) {
    const P = pl();
    const lg = S.lg || P.leagues[0] || '';
    S.lg = lg;
    const teams = teamsOf(lg);
    if (!S.team || teams.indexOf(S.team) < 0) S.team = teams[0] || '';
    const team = S.team;

    /* 顶部：上传 / 管理 */
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('球员库 · 上传与维护'),
      U.el('span', { class: 'hint', text: '支持 .xls / .xlsx / .csv，可多选、可替换、可追加联赛' })]));
    c0.appendChild(U.el('p', {
      class: 'desc', html:
        '按你的表结构读取：<code>球队 | 号码 | 姓名 | 位置 | 国籍 | 预计身价 | 合同截止</code>。' +
        '「位置」以<b>你表格里的写法为准</b>（守门员 / 中卫 / 左后卫 / 后腰 / 中前卫 / 前腰 / 左边锋 / 中锋 …），' +
        '程序内部再映射到门将·中后卫·边后卫·后腰·中前卫·前腰·边前卫·中锋八档去算伤害系数。' +
        '<br>出厂已预置 <b>英超 / 西甲 / 意甲 / 德甲 / 法甲 / 葡超</b> 共 ' +
        Object.keys(P.leagues).length + ' 个联赛、' +
        P.leagues.reduce(function (a, l) { return a + teamsOf(l).length; }, 0) + ' 支球队、' +
        P.leagues.reduce(function (a, l) { return a + playerCount(l); }, 0) + ' 名球员，随时可以改。'
    }));

    const r1 = U.el('div', { class: 'row' });
    r1.appendChild(U.btn('⬆ 上传球员表（可多选）', function () {
      U.pickFiles('.xls,.xlsx,.xlsm,.csv,.txt', function (fs) {
        U.toast('正在解析 ' + fs.length + ' 个文件…', '');
        doUpload(fs, null, null).then(function (res) {
          S.imp = res; S.tab = 'lib'; window.App.refresh();
        });
      });
    }, 'pri'));
    r1.appendChild(U.btn('＋ 新增联赛', function () {
      const name = window.prompt('新联赛名称（例如：荷甲）');
      if (!name) return;
      const n = String(name).trim();
      if (!n) return;
      if (P.leagues.indexOf(n) < 0) { P.leagues.push(n); P.teams[n] = []; savePL(); }
      S.lg = n; S.team = ''; window.App.refresh();
    }, 'ghost'));
    r1.appendChild(U.btn('＋ 在当前联赛新增球队', function () {
      if (!lg) { U.toast('先选一个联赛', 'warn'); return; }
      const name = window.prompt('球队名称');
      if (!name) return;
      const n = String(name).trim();
      if (!n) return;
      if (teamsOf(lg).indexOf(n) < 0) { P.teams[lg].push(n); P.players[key(lg, n)] = []; savePL(); }
      S.team = n; window.App.refresh();
    }, 'ghost'));
    r1.appendChild(U.btn('⇩ 导出球员库 JSON', function () {
      U.download('球员库_' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify(P, null, 0), 'application/json');
      U.toast('已导出（换电脑时在原位置「导入 JSON」即可）', 'ok');
    }, 'ghost'));
    r1.appendChild(U.btn('⇧ 导入球员库 JSON', function () {
      U.pickFile('.json,application/json', function (f) {
        const fr = new FileReader();
        fr.onload = function () {
          try {
            const o = JSON.parse(fr.result);
            if (!o.players) throw new Error('缺少 players 字段');
            U.confirmBox('将用这份 JSON 覆盖当前球员库（' + P.leagues.length + ' 联赛），继续？', function () {
              PL = o; savePL(); S.team = ''; U.toast('球员库已恢复', 'ok'); window.App.refresh();
            });
          } catch (e) { U.toast('导入失败：' + e.message, 'bad'); }
        };
        fr.readAsText(f, 'utf-8');
      });
    }, 'ghost'));
    r1.appendChild(U.btn('↺ 恢复出厂球员库', function () {
      U.confirmBox('丢弃所有上传与手工修改，恢复成出厂预置的 6 大联赛？', function () {
        try { localStorage.removeItem(LS_PL); } catch (e) { /* ignore */ }
        PL = null; S.team = ''; U.toast('已恢复出厂球员库', 'ok'); window.App.refresh();
      });
    }, 'danger ghost'));
    c0.appendChild(r1);
    host.appendChild(c0);

    /* —— 🔄 更新球队/球员库 ——
     * ★ 只在电脑上显示：抓取必须走本机后端（球探只支持老式 TLS、Transfermarkt 没开 CORS），
     *   手机浏览器两条路都走不通，放上去只会让人以为"点了没反应"，所以手机端直接不显示。 */
    const SHOW_SYNC_ON_MOBILE = false;
    const _isMobileNow = !!(window.App && window.App.isMobile && window.App.isMobile());
    if (!_isMobileNow || SHOW_SYNC_ON_MOBILE) host.appendChild(titanSyncCard());

    /* 导入预览 */
    if (S.imp) host.appendChild(renderImport());

    /* 联赛 / 球队选择 */
    if (!P.leagues.length) {
      const c = U.el('div', { class: 'card' });
      c.appendChild(U.note('球员库是空的。点上面「⬆ 上传球员表」把你的 .xls 传进来即可。', 'warn'));
      host.appendChild(c);
      return;
    }
    const c1 = U.el('div', { class: 'card' });
    const r2 = U.el('div', { class: 'row' });
    r2.appendChild(U.field('联赛', U.select(P.leagues.map(function (l) {
      return { v: l, n: l + '（' + teamsOf(l).length + ' 队 / ' + playerCount(l) + ' 人）' };
    }), lg, function (v) { S.lg = v; S.team = ''; S.q = ''; window.App.refresh(); },
      { style: { minWidth: '260px' } })));
    if (teams.length) {
      r2.appendChild(U.field('球队', U.select(teams.map(function (t) {
        return { v: t, n: t + '（' + (playersOf(lg, t)).length + ' 人）' };
      }), team, function (v) { S.team = v; S.q = ''; window.App.refresh(); }, { style: { minWidth: '260px' } })));
    }
    r2.appendChild(U.field('搜索球员', U.input(S.q, function (v) { S.q = v; renderTableOnly(); },
      { placeholder: '号码 / 姓名 / 位置' })));
    c1.appendChild(r2);

    if (teams.length) {
      const r3 = U.el('div', { class: 'row' });
      r3.appendChild(U.btn('＋ 新增球员', function () {
        const arr = playersOf(lg, team);
        arr.push({ num: null, name: '新球员', pos: pl().positions[0] || '中场', val: null });
        setPlayers(lg, team, arr); savePL(); window.App.refresh();
      }, 'sm pri'));
      r3.appendChild(U.btn('重命名球队', function () {
        const nn = window.prompt('新队名', team);
        if (!nn || nn === team) return;
        const n = String(nn).trim();
        if (!n) return;
        const idx = P.teams[lg].indexOf(team);
        P.teams[lg][idx] = n;
        P.players[key(lg, n)] = P.players[key(lg, team)]; delete P.players[key(lg, team)];
        if (P.meta[key(lg, team)]) { P.meta[key(lg, n)] = P.meta[key(lg, team)]; delete P.meta[key(lg, team)]; }
        S.team = n; savePL(); U.toast('已改名', 'ok'); window.App.refresh();
      }, 'sm ghost'));
      r3.appendChild(U.btn('删除球队', function () {
        U.confirmBox('删除「' + lg + ' · ' + team + '」及其全部球员？', function () {
          P.teams[lg] = P.teams[lg].filter(function (t) { return t !== team; });
          delete P.players[key(lg, team)]; delete P.meta[key(lg, team)];
          S.team = ''; savePL(); U.toast('已删除', 'ok'); window.App.refresh();
        });
      }, 'sm danger'));
      r3.appendChild(U.btn('删除联赛', function () {
        U.confirmBox('删除整个「' + lg + '」联赛（' + teamsOf(lg).length + ' 队）？', function () {
          teamsOf(lg).forEach(function (t) { delete P.players[key(lg, t)]; delete P.meta[key(lg, t)]; });
          P.teams[lg] = []; P.leagues = P.leagues.filter(function (l) { return l !== lg; });
          S.lg = ''; S.team = ''; savePL(); U.toast('已删除', 'ok'); window.App.refresh();
        });
      }, 'sm danger'));
      c1.appendChild(r3);
      const meta = P.meta[key(lg, team)] || {};
      const bits = [];
      if (meta.full) bits.push('全称 ' + meta.full);
      if (meta.coach) bits.push('主教练 ' + meta.coach);
      if (meta.stadium) bits.push('主场 ' + meta.stadium);
      if (meta.mv) bits.push('市值 ' + meta.mv);
      if (bits.length) c1.appendChild(U.el('div', { class: 'mini', style: { marginTop: '4px' }, text: bits.join('　·　') }));
    }
    host.appendChild(c1);

    /* 球员表 */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('球员名单（可直接改）'),
      U.el('span', { class: 'hint', text: '号码错了就改号码——伤停量化认的就是号码' })]));
    const box = U.el('div', { id: 'pl-table-box' });
    c2.appendChild(box);
    host.appendChild(c2);
    renderTable(box, lg, team);

    /* 位置系数说明 */
    host.appendChild(posCard());
  }

  function renderTableOnly() {
    const box = document.getElementById('pl-table-box');
    if (box) { renderTable(box, S.lg, S.team); }
    else window.App.refresh();
  }

  function renderTable(box, lg, team) {
    box.innerHTML = '';
    if (!team) { box.appendChild(U.note('这个联赛还没有球队。点「＋ 新增球队」或上传表格。', 'warn')); return; }
    const all = playersOf(lg, team);
    const q = String(S.q || '').trim().toLowerCase();
    const shown = all.filter(function (p) {
      if (!q) return true;
      return String(p.num).toLowerCase().indexOf(q) >= 0 || String(p.name).toLowerCase().indexOf(q) >= 0 ||
        String(p.pos).toLowerCase().indexOf(q) >= 0;
    });
    const stats = (function () {
      const pos = {};
      all.forEach(function (p) { pos[p.pos] = (pos[p.pos] || 0) + 1; });
      const gk = all.filter(function (p) { return C.posClass(p.pos) === 'GK'; }).length;
      const noVal = all.filter(function (p) { return p.val === null; }).length;
      const noNum = all.filter(function (p) { return p.num === null; }).length;
      return { pos: pos, gk: gk, noVal: noVal, noNum: noNum };
    })();
    const k = U.el('div', { class: 'grid g4', style: { marginBottom: '8px' } });
    k.appendChild(kpi('球员总数', all.length, (q ? '筛出 ' + shown.length + ' 人' : '该队全部')));
    k.appendChild(kpi('门将数', stats.gk, stats.gk >= 2 ? '门将保护判定需要 ≥2' : '⚠ 少于 2 名，门将保护会一直触发'));
    k.appendChild(kpi('身价缺失', stats.noVal, stats.noVal ? '计算时会用队内平均身价兜底' : '全部有身价'));
    k.appendChild(kpi('号码缺失', stats.noNum, stats.noNum ? '号码是伤停量化的唯一钥匙，建议补上' : '全部有号码'));
    box.appendChild(k);

    const rows = shown.map(function (p) {
      const cls = C.posClass(p.pos);
      const w = U.el('div', { class: 'pl-row' });
      w.appendChild(U.number(p.num === null ? '' : p.num, function (v) {
        upPlayer(lg, team, p.i, { num: v === '' ? null : Number(v) });
      }, { step: '1', style: { width: '62px' } }));
      w.appendChild(U.input(p.name, function (v) { upPlayer(lg, team, p.i, { name: v }); },
        { style: { flex: '1 1 0', minWidth: '90px' } }));
      w.appendChild(U.select(pl().positions.map(function (x) { return { v: x, n: x }; }), p.pos,
        function (v) { upPlayer(lg, team, p.i, { pos: v }); }, { style: { width: '104px' } }));
      w.appendChild(U.number(p.val === null ? '' : p.val, function (v) {
        upPlayer(lg, team, p.i, { val: v === '' ? null : Number(v) });
      }, { step: '10', style: { width: '86px' } }));
      w.appendChild(U.el('span', { class: 'mini', style: { width: '52px', textAlign: 'right' },
        text: '×' + U.fmt(C.posFacOf(p.pos, C.store.P, C.store.LIB), 2) }));
      w.appendChild(U.el('span', { class: 'mini', style: { width: '34px' }, text: cls }));
      w.appendChild(U.btn('×', function () {
        const arr = playersOf(lg, team);
        arr.splice(p.i, 1);
        setPlayers(lg, team, arr); savePL(); renderTableOnly();
      }, 'danger sm'));
      return w;
    });
    const wrap = U.el('div', { class: 'pl-grid' });
    wrap.appendChild(U.el('div', { class: 'pl-head', html:
      '<span style="width:62px">号码</span><span style="flex:1">姓名</span>' +
      '<span style="width:104px">位置</span><span style="width:86px">身价(万€)</span>' +
      '<span style="width:52px;text-align:right">系数</span><span style="width:34px">类别</span><span style="width:30px"></span>' }));
    rows.forEach(function (w) { wrap.appendChild(w); });
    box.appendChild(wrap);
    if (!shown.length) box.appendChild(U.note('没有匹配的球员。搜索词：' + U.esc(S.q), 'warn'));
    box.appendChild(U.note('「伤害系数」= 该位置缺阵时的伤害权重（门将 1.20 最高，边锋/中锋 0.95 最低）。' +
      '改完号码/位置/身价会立刻存到本地。', ''));
  }
  function upPlayer(lg, team, idx, patch) {
    const arr = playersOf(lg, team);
    const p = arr[idx];
    if (!p) return;
    if (patch.num !== undefined) p.num = patch.num;
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.pos !== undefined) p.pos = patch.pos;
    if (patch.val !== undefined) p.val = patch.val;
    setPlayers(lg, team, arr);
    savePL();
    if (patch.pos !== undefined || patch.num !== undefined) renderTableOnly();
  }
  function kpi(l, v, s, tone) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', style: { fontSize: '17px', color: tone || 'var(--txt)' }, text: String(v) }));
    b.appendChild(U.el('div', { class: 'l', text: l }));
    if (s) b.appendChild(U.el('div', { class: 'mini', style: { marginTop: '2px' }, text: s }));
    return b;
  }

  function renderImport() {
    const c = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    const ok = S.imp.filter(function (r) { return r.ok; });
    c.appendChild(U.el('h2', {}, [document.createTextNode('上传结果 · 确认导入'),
      U.el('span', { class: 'hint', text: '选好模式再点导入，不会自动动你的库' })]));
    c.appendChild(U.el('div', {
      html: U.table([
        { k: 'f', n: '文件', w: '220px' }, { k: 'k', n: '格式', w: '60px' }, { k: 's', n: '工作表', w: '140px' },
        { k: 'lg', n: '识别为联赛', w: '110px' }, { k: 't', n: '球队', w: '70px', num: 1 },
        { k: 'p', n: '球员', w: '70px', num: 1 }, { k: 'st', n: '状态', w: '300px' },
      ], S.imp.map(function (r) {
        const n = r.ok ? Object.keys(r.teams).length : 0;
        let pc = 0;
        if (r.ok) Object.keys(r.teams).forEach(function (t) { pc += r.teams[t].length; });
        return {
          f: U.esc(r.file), k: r.kind || '—', s: U.esc(r.sheet || '—'),
          lg: U.esc(r.lg || '—'), t: n, p: pc,
          st: r.ok ? '<b style="color:var(--ok)">可导入</b>' : '<b style="color:var(--bad)">' + U.esc(r.err) + '</b>',
        };
      }))
    }));
    if (ok.length) {
      const r = U.el('div', { class: 'row', style: { marginTop: '8px' } });
      const modes = [
        ['merge', '合并（同名球队用新数据覆盖球员，其它保留）'],
        ['replace-team', '按球队替换（只替换文件里出现的球队）'],
        ['replace', '整联赛替换（清空该联赛再导入）'],
        ['newleague', '作为新联赛追加（联赛名后面加「(新)」）'],
      ];
      let mode = S.impMode || 'merge';
      r.appendChild(U.field('导入模式', U.select(modes.map(function (m) { return { v: m[0], n: m[1] }; }), mode,
        function (v) { S.impMode = v; })));
      r.appendChild(U.btn('✔ 执行导入', function () {
        let rr = ok;
        if (mode === 'newleague') rr = ok.map(function (x) { return Object.assign({}, x, { lg: x.lg + '(新)' }); });
        const st = applyImport(rr, mode === 'newleague' ? 'merge' : mode);
        S.imp = null; S.impMode = null;
        U.toast('导入完成：新增 ' + st.addedTeams + ' 队（' + st.addedPlayers + ' 名球员），覆盖 ' + st.replacedTeams + ' 队', 'ok');
        window.App.refresh();
      }, 'pri'));
      r.appendChild(U.btn('取消', function () { S.imp = null; window.App.refresh(); }, 'ghost'));
      c.appendChild(r);
    } else {
      c.appendChild(U.btn('取消', function () { S.imp = null; window.App.refresh(); }, 'ghost'));
    }
    c.appendChild(U.note('识别不准时：先导入，然后在球员表里手动改号码/位置/身价即可。' +
      '如果整列都对不上（比如表头不是「球队/号码/姓名/位置」），把文件另存成 CSV 再传，或者手工新增球队。', 'warn'));
    return c;
  }

  /** 位置命名 → 系数 对照卡（第 5 点：以表格命名为准） */
  function posCard() {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('位置命名与伤害系数对照'),
      U.el('span', { class: 'hint', text: '左边是你表格里的写法，右边是程序算伤害用的系数' })]));
    c.appendChild(U.el('p', {
      class: 'desc', html:
        '规则文档里写的是 <code>GK / CB / WB / CM / WM / ST-CF</code> 六档，但你的球员表用的是' +
        '<b>守门员 / 中卫 / 左后卫 / 右后卫 / 后腰 / 中前卫 / 中场 / 前腰 / 左边锋 / 右边锋 / 左中场 / 右中场 / 中锋 / 前锋 / 影锋 / 后卫</b>' +
        '共 16 种写法。这里是两边的对照，<b>系数可以在「调参中心 → 映射表 → 位置伤害系数」里改</b>。'
    }));
    const fac = C.store.LIB.posFac || C.POS_FAC_DEF;
    const cls = C.store.LIB.posClass || C.POS_CLASS_DEF;
    const groups = {};
    Object.keys(cls).forEach(function (k) {
      const c2 = cls[k];
      (groups[c2] = groups[c2] || []).push(k);
    });
    const order = ['GK', 'CB', 'FB', 'DM', 'CM', 'AM', 'WM', 'ST'];
    const rows = order.filter(function (k) { return groups[k]; }).map(function (k) {
      const names = groups[k];
      // 统计表格里这些位置各有多少人
      let n = 0;
      pl().leagues.forEach(function (l) {
        teamsOf(l).forEach(function (t) {
          (pl().players[key(l, t)] || []).forEach(function (a) {
            if (cls[pl().positions[a[2]]] === k) n++;
          });
        });
      });
      return {
        cls: k, cn: C.POS_CLASS_NAME[k] || k,
        names: names.map(function (x) { return U.esc(x); }).join('、'),
        fac: U.fmt(fac[k], 2), n: n,
        why: k === 'DM' ? '<b style="color:var(--acc)">规则没列，我补的</b>：后腰是防线前屏障，稀缺度介于中卫与中前卫之间'
          : k === 'AM' ? '<b style="color:var(--acc)">规则没列，我补的</b>：前腰创造力核心，但防守贡献低、现代足球常被边锋替代'
            : k === 'CB' ? '规则原值 1.10；表里的「后卫」是没细分的中卫，一并归这里'
              : k === 'CM' ? '规则原值 1.05；表里的「中场」是泛称，一并归这里'
                : k === 'ST' ? '规则原值 0.95；表里的「前锋 / 影锋」一并归这里'
                  : k === 'WM' ? '规则原值 0.95；表里的「左/右中场」一并归这里' : '规则原值',
      };
    });
    c.appendChild(U.el('div', {
      html: U.table([
        { k: 'cls', n: '类别', w: '54px' }, { k: 'cn', n: '中文', w: '96px' },
        { k: 'names', n: '你表格里的写法', w: '300px' },
        { k: 'fac', n: '伤害系数', w: '72px' }, { k: 'n', n: '库里人数', w: '70px', num: 1 },
        { k: 'why', n: '说明', w: '330px' },
      ], rows)
    }));
    c.appendChild(U.note('系数的含义：<b>越不可替代的位置系数越高</b>。它乘在「出场权重 W × 身价占比 S」之后，' +
      '所以同一名身价的球员，缺阵在门将位置上扣得比边锋多。门将 1.20 是六档里最高的。', ''));
    return c;
  }

  /* ==================== ② 伤停量化（一场比赛 · 两队同时录） ==================== */
  const GROUPS = [
    { k: 'starters', n: '① 上一场首发', ph: '例：1 2 3 4 6 9 10 17 19 42 44', tip: 'W = 1.00' },
    {
      k: 'subs', n: '② 上一场替补', ph: '例：12 13(是) 14(是) 15 16(是) 17 18(是) 19(是)',
      tip: '★ 替补里<b>登场踢了的</b>号码后面写 (是)，其余留空 → W 0.45 / 0.15',
      marks: 'sub',
    },
    {
      k: 'injured', n: '③ 本场比赛伤停', ph: '例：9(是) 10(否) 6(停)',
      tip: '★ 号码后可标 (是)/(否)/(停)/(新)',
      marks: 'inj',
    },
  ];
  function blankSide() { return { starters: '', subs: '', injured: '' }; }
  /** 取某一侧某个名单的标注表：{号码: {played, suspend, isNew}} */
  function sideMarks(side, k) { return C.markMap(C.parseNumList(side[k] || ''), null); }

  let TI_TIP = '';
  let TI_BUSY = false;
  let TI_URL = '';

  /** 从任意文本里抽号码（形如 "39 (中前卫)" 或 "9 10 11"） */
  function extractNums(txt) {
    const out = [];
    const s = String(txt || '');
    const re1 = /\b(\d{1,3})\s*[（(]/g;
    let m;
    while ((m = re1.exec(s))) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && out.indexOf(n) < 0) out.push(n);
    }
    if (!out.length) {
      const re2 = /\b(\d{1,3})\b/g;
      while ((m = re2.exec(s))) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && out.indexOf(n) < 0) out.push(n);
      }
    }
    return out;
  }

  function titanInjCard() {
    const c = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    c.appendChild(U.el('h2', {}, [document.createTextNode('⚕ 从球探(titan007) 抓伤停'),
      U.el('span', { class: 'hint', text: '一个请求，自动填三组号码' })]));

    c.appendChild(U.el('p', {
      class: 'desc', html:
        '贴 <b>球探那场比赛的分析页链接</b>（形如 <code>zq.titan007.com/analysis/3003849cn.htm</code>），' +
        '点一下就会把 <b>①上一场首发 ②上一场替补 ③本场伤停</b> 三组号码自动填好，并列出每个人的伤情。' +
        '<br>抓完直接点下面的「▶ 一场比赛 · 两队一起算」就能出伤病/深度/停赛三个标签。'
    }));

    const row = U.el('div', { class: 'row' });
    row.appendChild(U.field('球探比赛链接 / 比赛ID',
      U.input(TI_URL, function (v) { TI_URL = v; }, { placeholder: 'zq.titan007.com/analysis/3003849cn.htm 或 3003849' })));
    row.appendChild(U.btn('⚕ 抓取并填入号码', function () {
      const v = String(TI_URL || '').trim();
      if (!v) return U.toast('先把球探那个链接贴上', 'warn');
      titanInjFetch(v);
    }, 'pri'));
    c.appendChild(row);

    const tip = U.el('div', {
      class: 'mini', id: 'ti-tip',
      style: { marginTop: '8px', lineHeight: '1.75', color: 'var(--txt-2)', whiteSpace: 'pre-wrap' }
    });
    if (TI_TIP) tip.textContent = TI_TIP;
    c.appendChild(tip);

    /* 兜底：手动粘贴 */
    const mp = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    let pasteBox = null;
    mp.appendChild(U.btn('📋 抓不到？手动粘贴缺阵名单', function () {
      if (pasteBox) { pasteBox.style.display = pasteBox.style.display === 'none' ? '' : 'none'; return; }
      pasteBox = U.el('div', { style: { marginTop: '8px' } });
      const ta = U.el('textarea', {
        rows: '3',
        style: { width: '100%', minHeight: '70px', fontFamily: 'inherit', fontSize: '12.5px' },
        placeholder: '把页面上的缺阵名单粘进来，比如：\n39 (中前卫) 布鲁诺·吉马良斯 伤病\n2 (中卫) 威廉.萨利巴 背部损伤'
      });
      pasteBox.appendChild(ta);
      const r2 = U.el('div', { class: 'row', style: { marginTop: '6px' } });
      r2.appendChild(U.btn('填进【主队】伤停', function () {
        const nums = extractNums(ta.value);
        if (!nums.length) return U.toast('没从文本里找到号码', 'warn');
        S.inj.h.injured = nums.join(' ');
        S.injRes = null; saveInj(); window.App.refresh();
        U.toast('已把 ' + nums.length + ' 个号码填进主队伤停', 'ok');
      }, 'sm ghost'));
      r2.appendChild(U.btn('填进【客队】伤停', function () {
        const nums = extractNums(ta.value);
        if (!nums.length) return U.toast('没从文本里找到号码', 'warn');
        S.inj.a.injured = nums.join(' ');
        S.injRes = null; saveInj(); window.App.refresh();
        U.toast('已把 ' + nums.length + ' 个号码填进客队伤停', 'ok');
      }, 'sm ghost'));
      pasteBox.appendChild(r2);
      c.appendChild(pasteBox);
      pasteBox.style.display = '';
    }, 'sm ghost'));
    c.appendChild(mp);

    c.appendChild(U.note('说明：<b>抓不到不会乱填</b>。链接不对、页面改版、被限流，都会直接报错，不会给你一串假号码。' +
      '被限流的话后端会自动停手 10 分钟（避免像上次那样被封）。', ''));
    return c;
  }

  function titanInjFetch(matchArg) {
    if (TI_BUSY) return U.toast('上一次还在抓，等它返回', 'warn');
    TI_BUSY = true;
    TI_TIP = '⏳ 正在抓球探那一页（1 个请求，约 2 秒；抓过的当场秒出）…';
    const el = document.getElementById('ti-tip');
    if (el) el.textContent = TI_TIP;
    titanFetch('/api/titan/injury?match=' + encodeURIComponent(matchArg)).then(function (r) {
      TI_BUSY = false;
      if (!r || !r.ok) {
        TI_TIP = '✘ ' + ((r && r.error) || '后端没返回') +
          '\n（如果是被限流，等 10 分钟再试；也可以先用手动粘贴。）';
        const el2 = document.getElementById('ti-tip');
        if (el2) el2.textContent = TI_TIP;
        return U.toast('抓取失败：' + ((r && r.error) || '未知'), 'bad', 6000);
      }
      const d = r;
      const inj = S.inj;
      const pageHome = String((d.home && d.home.name) || '').trim();
      const pageAway = String((d.away && d.away.name) || '').trim();

      /* ★★ 主客队必须对上，否则号码会填到错误的队上（这是最危险的错）★★
       *   ① 名字一致 → 直接填
       *   ② 只是主客颠倒 → 自动交换，再填
       *   ③ 完全不是同一场 → 去库里找这两支队：找到就自动切对阵；找不到就【拒绝填】并说清
       */
      const norm = function (x) { return String(x || '').replace(/\s+/g, ''); };
      const same = function (a, b) { return norm(a) === norm(b); };
      const libTeams = teamsOf(inj.lg) || [];
      /* 球探页给的是**中文**队名；但英冠/荷甲/沙特联这些联赛，你库里是**英文**名。
       * 所以要用 EN2CN 反查表把中文翻回英文，再去库里找。 */
      const CN2EN = (function () {
        const m = {};
        Object.keys(EN2CN).forEach(function (en) {
          const cn = String(EN2CN[en] || '').replace(/\s+/g, '');
          if (cn && !m[cn]) m[cn] = en;
        });
        return m;
      })();
      const findInLib = function (name) {
        const raw = String(name || '').trim();
        if (!raw) return '';
        if (libTeams.indexOf(raw) >= 0) return raw;
        const en = CN2EN[raw.replace(/\s+/g, '')] || '';
        const cands = en ? [raw, en] : [raw];
        for (let ci = 0; ci < cands.length; ci++) {
          const c = cands[ci];
          if (libTeams.indexOf(c) >= 0) return c;
          const hit = libTeams.filter(function (t) {
            return norm(t).indexOf(norm(c)) >= 0 || norm(c).indexOf(norm(t)) >= 0;
          });
          if (hit.length === 1) return hit[0];
        }
        return '';
      };

      let swapped = false, switched = false;
      if (!(same(pageHome, inj.home) && same(pageAway, inj.away))) {
        if (same(pageHome, inj.away) && same(pageAway, inj.home)) {
          const tmpT = inj.home; inj.home = inj.away; inj.away = tmpT;
          const tmpS = inj.h; inj.h = inj.a; inj.a = tmpS;
          swapped = true;
        } else {
          const nh = findInLib(pageHome), na = findInLib(pageAway);
          if (nh && na && nh !== na) {
            inj.home = nh; inj.away = na;
            inj.h = blankSide(); inj.a = blankSide();
            switched = true;
          } else {
            /* ③ 库里的联赛没有这两支队 → 不填，别搞错 */
            TI_BUSY = false;
            TI_TIP = '✘ 这场对不上，**没有填任何号码**（防止张冠李戴）\n\n' +
              '球探页是：' + pageHome + ' vs ' + pageAway + '\n' +
              '你上面选的是：' + inj.home + ' vs ' + inj.away + '\n\n' +
              '而「' + inj.lg + '」的球员库里没有「' +
              [nh ? '' : pageHome, na ? '' : pageAway].filter(Boolean).join('」「') +
              '」，所以没法换算号码权重。\n' +
              '两个办法：① 先把这两支队加进球员库（球员库 → ＋新增球队/＋新增球员）；' +
              '② 或者上面手动改成库里已有的同城对手再试。';
            const elx = document.getElementById('ti-tip');
            if (elx) elx.textContent = TI_TIP;
            window.App.refresh();
            return U.toast('对阵对不上，已拒绝填入（避免搞错队）', 'bad', 6000);
          }
        }
      }

      const put = function (side, data) {
        const parts = [];
        (data.out || []).forEach(function (o) { parts.push(o.num + (o.suspend ? '(停)' : '')); });
        side.starters = (data.starters || []).join(' ');
        side.subs = (data.subs || []).join(' ');
        side.injured = parts.join(' ');
      };
      put(inj.h, d.home || {});
      put(inj.a, d.away || {});

      TI_TIP = (d.text || '') + '\n\n' +
        (switched ? '✔ 已按球探页自动切换到「' + inj.home + ' vs ' + inj.away + '」并填好。'
          : swapped ? '✔ 你选的主客是反的，已自动交换并填好。'
            : '✔ 主客队对得上，可以直接点「▶ 一场比赛 · 两队一起算」。') +
        (d.cached ? '\n（来自缓存，没再发请求）' : '');
      S.injRes = null;
      saveInj();
      window.App.refresh();
      U.toast('已抓取并填入三组号码（' + (d.home ? (d.home.out || []).length : 0) + ' + ' +
        (d.away ? (d.away.out || []).length : 0) + ' 人伤停）', 'ok', 5000);
    }, function (e) {
      TI_BUSY = false;
      TI_TIP = '✘ ' + e.message;
      const el3 = document.getElementById('ti-tip');
      if (el3) el3.textContent = TI_TIP;
    });
  }

  function tabInj(host) {
    const P = pl();
    const inj = S.inj;
    if (!inj.lg) inj.lg = S.lg || P.leagues[0] || '';
    const teams = teamsOf(inj.lg);
    if (!inj.home || teams.indexOf(inj.home) < 0) inj.home = teams[0] || '';
    if (!inj.away || teams.indexOf(inj.away) < 0 || inj.away === inj.home) inj.away = teams[1] || teams[0] || '';
    inj.h = inj.h || blankSide();
    inj.a = inj.a || blankSide();
    const rH = roster(inj.lg, inj.home), rA = roster(inj.lg, inj.away);

    /* ---- 顶部：选一场比赛（同联赛两队） ---- */
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('伤停量化 · 一场比赛两队一起录'),
      U.el('span', { class: 'hint', text: '同联赛主客队 → 一次算出两队的伤病等级 / 阵容深度 / 停赛等级' })]));
    c0.appendChild(U.el('p', {
      class: 'desc', html:
        '每队 <b>3 组号码</b>：<b>①上一场首发 ②上一场替补 ③本场比赛伤停</b>（伤病 + 停赛都填这一栏）。' +
        '重点是 <b>③</b> —— 每个号码后面可以标 <code>(是)</code> 或 <code>(否)</code>，' +
        '表示他<b>上一场到底有没有上场</b>（伤停的人里面，有的上一场还在踢、有的早就没上了，不标的话权重算不准）。' +
        '<br>标了就以标注为准；没标就按 ①② 自动推断。另外 <code>(停)</code> 表示本场是停赛（不乘阵容深度系数）、<code>(新)</code> 表示新援。'
    }));
    const r0 = U.el('div', { class: 'row' });
    r0.appendChild(U.field('联赛', U.select(P.leagues.map(function (l) { return { v: l, n: l }; }), inj.lg,
      function (v) { inj.lg = v; inj.home = ''; inj.away = ''; S.injRes = null; window.App.refresh(); },
      { style: { minWidth: '140px' } })));
    r0.appendChild(U.field('主队', U.select(teams.map(function (t) {
      return { v: t, n: t + '（' + (pl().players[key(inj.lg, t)] || []).length + ' 人）' };
    }), inj.home, function (v) { inj.home = v; S.injRes = null; window.App.refresh(); }, { style: { minWidth: '210px' } })));
    r0.appendChild(U.el('span', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--txt-3)', padding: '0 4px' }, text: 'VS' }));
    r0.appendChild(U.field('客队', U.select(teams.map(function (t) {
      return { v: t, n: t + '（' + (pl().players[key(inj.lg, t)] || []).length + ' 人）' };
    }), inj.away, function (v) { inj.away = v; S.injRes = null; window.App.refresh(); }, { style: { minWidth: '210px' } })));
    r0.appendChild(U.btn('⇩ 从比赛记录载入对阵', function () { inj._picking = true; window.App.refresh(); }, 'ghost'));
    r0.appendChild(U.btn('⇄ 交换主客', function () {
      const t = inj.home; inj.home = inj.away; inj.away = t;
      const s = inj.h; inj.h = inj.a; inj.a = s;
      S.injRes = null; saveInj(); window.App.refresh();
    }, 'ghost'));
    r0.appendChild(U.btn('清空全部号码', function () {
      inj.h = blankSide(); inj.a = blankSide(); S.injRes = null; saveInj(); window.App.refresh();
    }, 'ghost'));
    c0.appendChild(r0);

    /* ============================================================
     * ⚕ 从球探(titan007) 抓伤停 —— 一个请求自动填三组号码
     *
     * 为什么加这个：球探那一页直接给「号码 (位置) 姓名 + 缺阵原因」，
     *   还有「上一场首发 / 后备」的号码 —— 正是这个模块要的三组号码。
     *   TM 的伤停滞后 1~2 天，而且不给号码。
     *
     * 防封：串行 + 间隔 2 秒 + 同一场缓存 6 小时 + 连错 2 次停 10 分钟（后端做的）。
     * 兜底：真被抓不了，就手动把缺阵名单粘进来，只抽号码。
     * ============================================================ */
    host.appendChild(titanInjCard());

    c0.appendChild(U.note('<b>标注写法</b>：<code>9</code> 未标注（按 ①②③ 自动推断）· ' +
      '<code>9(是)</code> 上一场有上场 · <code>9(否)</code> 上一场没上场 · ' +
      '<code>9(停)</code> 本场停赛 · <code>9(新)</code> 新援。' +
      '中英文括号、<code>9:是</code>、<code>9 (是)</code> 都认；也能直接写姓名如 <code>凯恩(是)</code>。', 'ok'));
    host.appendChild(c0);

    if (inj._picking) host.appendChild(pickFromRecord());

    if (!rH.length || !rA.length) {
      const c = U.el('div', { class: 'card' });
      c.appendChild(U.note('球员库里缺少「' + (rH.length ? inj.away : inj.home) + '」的球员。' +
        '先去「① 球员库」上传或手动补。', 'warn'));
      host.appendChild(c);
      return;
    }

    /* ---- 两队并排录入 ---- */
    const c1 = U.el('div', { class: 'card' });
    c1.appendChild(U.el('h2', {}, [document.createTextNode('第一步 · 填号码（两队同时）'),
      U.el('span', { class: 'hint', text: '逗号 / 空格 / 顿号 / 换行 都行；号码后可标 (是)(否)(停)(新)' })]));
    const g = U.el('div', { class: 'grid g2' });
    const sideBox = function (which, teamName, ros) {
      const box = U.el('div', { style: { border: '1px solid var(--line)', borderRadius: '9px', padding: '9px 11px', background: 'var(--bg)' } });
      const head = U.el('div', { class: 'flexline', style: { gap: '8px', flexWrap: 'wrap' } });
      head.appendChild(U.el('span', { style: { fontSize: '14px', fontWeight: '700', color: 'var(--acc)' },
        text: (which === 'h' ? '主队' : '客队') + ' · ' + teamName }));
      head.appendChild(U.el('span', { class: 'mini', text: ros.length + ' 人在库' }));
      const fillBtn = U.btn('按号码表占位填 ①②', function () {
        const ps = ros.slice().sort(function (a, b) {
          return (a.num === null ? 999 : a.num) - (b.num === null ? 999 : b.num);
        });
        inj[which].starters = ps.slice(0, 11).map(function (p) { return p.num; }).filter(function (n) { return n !== null; }).join(' ');
        inj[which].subs = ps.slice(11, 19).map(function (p) { return p.num; }).filter(function (n) { return n !== null; }).join(' ');
        S.injRes = null; saveInj();
        U.toast('已按号码填好 —— 这只是占位，务必按实际改', 'warn');
        window.App.refresh();
      }, 'sm ghost');
      head.appendChild(fillBtn);
      box.appendChild(head);
      GROUPS.forEach(function (gr) {
        const wrap = U.el('div', { style: { marginTop: '7px' } });
        const h2 = U.el('div', { class: 'flexline', style: { gap: '7px', flexWrap: 'wrap' } });
        h2.appendChild(U.el('span', { style: { fontSize: '12.4px', fontWeight: '650' }, text: gr.n }));
        const cnt = U.el('span', { class: 'mini' });
        const upd = function () { cnt.textContent = C.parseNumList(inj[which][gr.k]).length + ' 项'; };
        h2.appendChild(cnt);
        h2.appendChild(U.el('span', { class: 'mini', style: { color: gr.marks ? 'var(--acc)' : 'var(--txt-3)' }, html: gr.tip }));
        wrap.appendChild(h2);
        const ta = U.el('textarea', {
          style: {
            width: '100%', minHeight: gr.k === 'injured' ? '56px' : '44px', fontFamily: 'monospace', fontSize: '12.4px',
            borderColor: gr.marks ? 'var(--acc)' : null,
          },
          placeholder: gr.ph,
        });
        ta.value = inj[which][gr.k] || '';
        ta.addEventListener('input', function () { inj[which][gr.k] = ta.value; upd(); saveInj(); });
        upd();
        wrap.appendChild(ta);

        /* ---- 逐项预览：每个号码被理解成什么 ---- */
        const prev = U.el('div', { style: { marginTop: '3px' } });
        const updPrev = function () {
          prev.innerHTML = '';
          const side0 = inj[which];
          const list = C.parseRosterList(side0[gr.k] || '');
          if (!list.length) {
            prev.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: '（还没填）' }));
            return;
          }
          const inSet = function (k) {
            const m = {};
            C.parseNumList(side0[k] || '').forEach(function (t) {
              const o = C.parseRosterList(String(t))[0];
              if (o) m[o.num === null ? o.tok : String(o.num)] = true;
            });
            return m;
          };
          const sSta = inSet('starters'), sSub = inSet('subs');
          const subMk = sideMarks(side0, 'subs');
          const Wb = C.store.P.W_BENCH, Wp = C.store.P.W_SUB_PLAYED;

          if (gr.marks === 'sub') {
            /* ② 替补：标 (是) = 登场 */
            let y = 0, n0 = 0;
            list.forEach(function (o) {
              const tok = o.num === null ? o.tok : String(o.num);
              const played = o.played === true;
              if (played) y++; else n0++;
              const tone = played ? 'var(--ok)' : 'var(--txt-3)';
              const chip = U.el('span', {
                style: {
                  display: 'inline-block', margin: '2px 4px 0 0', padding: '1px 6px', borderRadius: '4px',
                  border: '1px solid ' + tone, fontSize: '11.5px', color: tone,
                },
                html: '<b>' + U.esc(tok) + '</b> ' + (played ? '(是)' : (o.played === false ? '(否)' : '未标')) +
                  ' · ' + (played ? '替补登场' : '坐板凳') + ' · W ' + (played ? Wp : Wb)
              });
              if (o.unknownMark) {
                chip.style.borderColor = 'var(--bad)';
                chip.innerHTML += ' <span style="color:var(--bad)">⚠ 没看懂「' + U.esc(o.unknownMark) + '」</span>';
              }
              prev.appendChild(chip);
            });
            prev.appendChild(U.el('div', {
              class: 'mini', style: { marginTop: '3px' },
              html: '替补 <b>' + list.length + '</b> 人：<b style="color:var(--ok)">登场 ' + y + '</b>（W ' + Wp +
                '）· <b>坐板凳 ' + n0 + '</b>（W ' + Wb + '）'
            }));
          } else {
            /* ③ 本场伤停：标 (是)/(否) + (停)/(新) */
            let y = 0, n0 = 0, s = 0;
            list.forEach(function (o) {
              const tok = o.num === null ? o.tok : String(o.num);
              let w, tone, kind, mark;
              if (o.suspend) {
                kind = '停赛'; tone = 'var(--bad)'; w = '不乘深度系数'; mark = '(停)'; s++;
              } else {
                kind = '伤病'; tone = 'var(--warn)';
                if (o.played === true) {
                  mark = '(是)'; y++;
                  w = sSta[tok] ? '1.00 首发' : (Wp + ' 替补登场');
                } else if (o.played === false) {
                  mark = '(否)'; n0++;
                  w = sSub[tok] ? (Wb + ' 坐板凳') : '0.02 没进大名单';
                } else if (o.isNew) {
                  mark = '(新)'; w = '0.60 新援';
                } else {
                  mark = '未标';
                  const sm = subMk[tok];
                  if (sSta[tok]) w = '1.00 首发（自动）';
                  else if (sSub[tok]) {
                    w = (sm && sm.played === true)
                      ? (Wp + ' 替补登场（②标了是）')
                      : (Wb + ' 坐板凳（自动）');
                  } else w = '0.02 没进大名单（自动）';
                }
              }
              const chip = U.el('span', {
                style: {
                  display: 'inline-block', margin: '2px 4px 0 0', padding: '1px 6px', borderRadius: '4px',
                  border: '1px solid ' + tone, fontSize: '11.5px', color: tone,
                },
                html: '<b>' + U.esc(tok) + '</b> ' + mark + ' · ' + kind + ' · W ' + U.esc(w)
              });
              if (o.unknownMark) {
                chip.style.borderColor = 'var(--bad)';
                chip.innerHTML += ' <span style="color:var(--bad)">⚠ 没看懂「' + U.esc(o.unknownMark) + '」</span>';
              }
              prev.appendChild(chip);
            });
            prev.appendChild(U.el('div', {
              class: 'mini', style: { marginTop: '3px' },
              html: '已标注：<b style="color:var(--ok)">(是) ' + y + '</b>　' +
                '<b style="color:var(--warn)">(否) ' + n0 + '</b>　' +
                '<b style="color:var(--bad)">(停) ' + s + '</b>　' +
                '未标注 ' + (list.length - y - n0 - s) + '（按 ①② 自动推断）'
            }));
          }
        };
        ta.addEventListener('input', updPrev);
        updPrev();
        wrap.appendChild(prev);

        /* ---- ③ 专属：快捷标停赛 ---- */
        if (gr.k === 'injured') {
          const hb = U.el('div', { class: 'row', style: { marginTop: '3px' } });
          hb.appendChild(U.btn('＋ 把某些号码标成停赛', function () {
            const s = window.prompt('输入本场停赛的号码（多个用空格/逗号分隔），\n会自动在③里给它们加上 (停) 标记：', '');
            if (!s || !String(s).trim()) return;
            const want = C.parseNumList(s).map(function (x) { return String(x).trim(); });
            const list = C.parseRosterList(inj[which].injured);
            const have = {};
            list.forEach(function (o) { have[o.num === null ? o.tok : String(o.num)] = o; });
            const parts = [];
            list.forEach(function (o) {
              const tok = o.num === null ? o.tok : String(o.num);
              const marks = [];
              if (o.suspend) marks.push('停');
              if (o.isNew) marks.push('新');
              if (o.played === true) marks.push('是');
              else if (o.played === false) marks.push('否');
              parts.push(tok + (marks.length ? '(' + marks.join('/') + ')' : ''));
            });
            want.forEach(function (tk) {
              if (have[tk]) {
                const o = have[tk];
                if (o.suspend) return;
                const i = parts.findIndex(function (x) { return x.indexOf(tk + '(') === 0 || x === tk; });
                if (i >= 0) {
                  const marks = [];
                  if (o.played === true) marks.push('是'); else if (o.played === false) marks.push('否');
                  marks.push('停');
                  parts[i] = tk + '(' + marks.join('/') + ')';
                }
              } else {
                parts.push(tk + '(停)');
              }
            });
            inj[which].injured = parts.join(' ');
            S.injRes = null; saveInj(); upd(); updPrev();
            U.toast('已标好停赛', 'ok');
          }, 'sm ghost'));
          hb.appendChild(U.el('span', { class: 'mini', style: { color: 'var(--txt-3)' },
            text: '停赛不乘阵容深度系数，所以要和伤病分开标' }));
          wrap.appendChild(hb);
        }
        box.appendChild(wrap);
      });
      return box;
    };
    g.appendChild(sideBox('h', inj.home, rH));
    g.appendChild(sideBox('a', inj.away, rA));
    c1.appendChild(g);

    const r1 = U.el('div', { class: 'row', style: { marginTop: '8px' } });
    r1.appendChild(U.btn('▶ 一场比赛 · 两队一起算', function () { calc(); }, 'pri'));
    r1.appendChild(U.field('新援号码（两队共用，可选）', U.input(inj.newSign, function (v) { inj.newSign = v; saveInj(); },
      { placeholder: '刚转会、没有上一轮记录的球员，W=' + U.fmt(C.store.P.W_NEW, 2) })));
    c1.appendChild(r1);
    c1.appendChild(U.note('<b>②上一场替补怎么标</b>：把整份替补名单的号码都填进去，' +
      '其中<b>真的登场踢了的</b>就在号码后面写 <code>(是)</code> —— 他们按 W=' + U.fmt(C.store.P.W_SUB_PLAYED, 2) +
      ' 算；其余没写标记的按坐板凳 W=' + U.fmt(C.store.P.W_BENCH, 2) + ' 算。<br>' +
      '例：<code>12 13(是) 14(是) 15 16(是) 17 18(是) 19(是)</code> → 5 人登场、3 人坐板凳，' +
      '下面那排预览 chip 会实时告诉你每个人的 W 是多少。', ''));
    host.appendChild(c1);

    if (S.injMsg) {
      const cm = U.el('div', { class: 'card' });
      cm.appendChild(U.note(S.injMsg, S.injMsgKind || ''));
      host.appendChild(cm);
    }

    /* ---- 结果 ---- */
    if (S.injRes) host.appendChild(renderInjResult(S.injRes, inj));

    /* ---- 算法说明 ---- */
    const c3 = U.el('div', { class: 'card' });
    c3.appendChild(U.el('h2', {}, [document.createTextNode('算法说明（从原始数据到文本标签）')]));
    const li = U.el('ol', { style: { paddingLeft: '22px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '2', margin: 0 } });
    [
      '<b>步骤 1 · 有效阵容池</b>：号码 &gt; ' + C.store.P.EDGE_NUM + ' <b>且</b> 身价处于队内后 ' +
      C.pct(C.store.P.EDGE_PCT) + ' 的球员标记为「边缘候选」并剔出池子 → 得到有效池与 <code>ValidSumVal</code>。' +
      '两条保护：剔除后人数 &lt; ' + C.store.P.POOL_MIN + ' 就放回；池内门将 ≤ ' + C.store.P.GK_KEEP + ' 就把门将放回。' +
      '<br><span style="color:var(--warn)">伤停球员即使被判边缘候选，损失计算时照样计入</span>（边缘过滤只用于算基数）。',
      '<b>步骤 2 · 个体权重</b>：W（上一场出场状态）× S（身价占有效池总身价）× PosFac（位置系数）→ 逐人求和得 <code>Loss_Est</code>。' +
      '<br>W 的取法：<b>③的标注优先</b>（<code>(是)</code>→首发 ' + C.store.P.W_START + ' 或替补登场 ' + C.store.P.W_SUB_PLAYED +
      '；<code>(否)</code>→坐板凳 ' + C.store.P.W_BENCH + ' 或没进大名单 ' + C.store.P.W_OUT + '），' +
      '没标注就按 ①首发 ' + C.store.P.W_START + ' → ②替补（' + C.store.P.W_SUB_PLAYED + ' 登场 / ' + C.store.P.W_BENCH +
      ' 坐板凳，看②里标没标 <code>(是)</code>）→ 没进大名单 ' + C.store.P.W_OUT + ' 依次推断。' +
      '<br>③里标了 <code>(停)</code> 的人<b>不算伤病</b>（走停赛那条线，不乘阵容深度系数）。',
      '<b>步骤 3 · 伤病等级</b>：Loss_Est 对照 ' + C.store.P.LOSS_T1 + ' / ' + C.store.P.LOSS_T2 + ' / ' +
      C.store.P.LOSS_T3 + ' / ' + C.store.P.LOSS_T4 + ' / ' + C.store.P.LOSS_T5 +
      ' 五档 → 输出伤病文本标签（查表 0 ~ −0.6）。',
      '<b>步骤 4 · 阵容深度</b>：<span style="color:var(--acc)">★ 已修正重复惩罚</span> —— 用<b>球队固有板凳厚度</b> ' +
      '<code>DepthRatio = 替补席平均身价 ÷ 首发平均身价</code>，与伤病完全解耦。' +
      '阈值 ' + C.store.P.DEPTH_LO + ' / ' + C.store.P.DEPTH_HI + ' → 雄厚（×0.7）/ 一般（×1.0）/ 薄弱（×1.4）。' +
      '<br>两条保护：无伤病强制「一般」；主力门将伤停强制降一档。',
      '<b>步骤 5 · 停赛等级</b>：停赛球员按 W 判定 —— W = ' + C.store.P.W_START + ' → 首发主力红牌停赛（−0.1），' +
      '否则轮换球员红牌停赛（−0.05）。<b>停赛不乘深度系数</b>。',
      '<b>两队合并</b>：<code>净分差 = 主队最终贡献 − 客队最终贡献</code>，再按「每 ' + C.store.P.HCP_STEP +
      ' 分 = ' + C.store.P.HCP_UNIT + ' 球」折算成盘口球数（封顶 ' + C.store.P.HCP_CAP + ' 球）—— ' +
      '这就是加减分项 T3 里「伤停」这一块对最终盘口的净影响。',
    ].forEach(function (t) { li.appendChild(U.el('li', { html: t })); });
    c3.appendChild(li);
    c3.appendChild(U.note('<b>★ 关于「阵容深度」已做的修正</b>：规则原文里 ' +
      '<code>ResidualRatio ≡ 1 − Loss_Est</code>，与「伤病等级」是同一个数，两个乘数会同向叠加、' +
      '等于对缺人重复惩罚两次（违背规则自己「禁止重复惩罚」的原则）。' +
      '现在把深度改成<b>球队固有板凳厚度</b>，与伤病完全解耦 —— 这恰好回到规则文档自己的定位：' +
      '「阵容深度系数仅仅是伤病项事后的缩放乘数」。<br>' +
      '实测：同样三人伤，旧口径下阿森纳 / 伊普斯维奇 / 皇马 / 拜仁 / 美因茨的 ResidualRatio ' +
      '全在 0.997~0.999（清一色「雄厚」，没有区分度）；新口径下分别是 ' +
      '0.40 / 0.35 / 0.24 / 0.20 / 0.12 → 雄厚 / 雄厚 / 一般 / 一般 / 薄弱。', 'ok'));
    host.appendChild(c3);
  }

  function saveInj() {
    try { localStorage.setItem(LS_INJ, JSON.stringify(S.inj)); } catch (e) { /* ignore */ }
  }
  function loadInj() {
    try {
      const raw = localStorage.getItem(LS_INJ);
      if (!raw) return;
      const o = JSON.parse(raw);
      Object.keys(S.inj).forEach(function (k) { if (o[k] !== undefined) S.inj[k] = o[k]; });
      if (!S.inj.h || typeof S.inj.h !== 'object') S.inj.h = blankSide();
      if (!S.inj.a || typeof S.inj.a !== 'object') S.inj.a = blankSide();
    } catch (e) { /* ignore */ }
  }
  function pickFromRecord() {
    const recs = C.store.rows;
    const box = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    box.appendChild(U.el('h2', {}, [document.createTextNode('从比赛记录载入对阵')]));
    if (!recs.length) {
      box.appendChild(U.note('记录库里还没有比赛。', 'warn'));
      box.appendChild(U.btn('关闭', function () { S.inj._picking = false; window.App.refresh(); }, 'ghost'));
      return box;
    }
    const opts = recs.slice().reverse().map(function (r) {
      return { v: String(r.seq), n: '#' + r.seq + ' ' + (r.inp.league || '?') + ' ' + (r.inp.home || '?') + ' vs ' + (r.inp.away || '?') };
    });
    const tryMatch = function (name) {
      if (!name) return null;
      const P = pl();
      for (let i = 0; i < P.leagues.length; i++) {
        const l = P.leagues[i];
        if (teamsOf(l).indexOf(name) >= 0) return { lg: l, team: name };
      }
      for (let i = 0; i < P.leagues.length; i++) {
        const l = P.leagues[i];
        const t = teamsOf(l).filter(function (x) { return x.indexOf(name) >= 0 || name.indexOf(x) >= 0; })[0];
        if (t) return { lg: l, team: t };
      }
      return null;
    };
    box.appendChild(U.field('选择比赛', U.select(opts, String(S.inj._seq || ''), function (v) {
      S.inj._seq = Number(v);
      const rec = recs.filter(function (r) { return String(r.seq) === String(v); })[0];
      if (!rec) return;
      const gh = tryMatch(rec.inp.home), ga = tryMatch(rec.inp.away);
      if (gh && ga && gh.lg === ga.lg) {
        S.inj.lg = gh.lg; S.inj.home = gh.team; S.inj.away = ga.team;
        U.toast('已载入：' + gh.lg + '　' + gh.team + ' vs ' + ga.team, 'ok');
      } else if (gh || ga) {
        const g0 = gh || ga;
        S.inj.lg = g0.lg;
        if (gh) S.inj.home = gh.team;
        if (ga) S.inj.away = ga.team;
        U.toast('只匹配上一队（' + ((gh ? rec.inp.home : rec.inp.away)) + '）。另一队请手动选。', 'warn');
      } else {
        U.toast('球员库里找不到「' + rec.inp.home + '」「' + rec.inp.away + '」，请手动选队', 'warn');
      }
      S.injRes = null;
      window.App.refresh();
    }, { style: { minWidth: '460px' } })));
    box.appendChild(U.note('会自动在球员库里按队名匹配（支持部分匹配），并保证主客队来自同一个联赛。', ''));
    box.appendChild(U.btn('关闭', function () { S.inj._picking = false; window.App.refresh(); }, 'ghost'));
    return box;
  }
  function calc() {
    const inj = S.inj;
    const rH = roster(inj.lg, inj.home), rA = roster(inj.lg, inj.away);
    if (!rH.length || !rA.length) {
      S.injMsg = '球员库里缺少这支球队的球员，先去「① 球员库」补。'; S.injMsgKind = 'bad';
      window.App.refresh(); return;
    }
    const mkCtx = function (side, ros) {
      // ★ ③本场比赛伤停 = 伤病 + 停赛合并一栏；停赛由号码后的 (停) 标记区分
      return {
        injured: C.parseNumList(side.injured),
        suspended: [],
        starters: C.parseNumList(side.starters),
        subs: C.parseNumList(side.subs),
        newSign: C.parseNumList(inj.newSign),
      };
    };
    const res = C.computeMatch(rH, rA, {
      home: mkCtx(inj.h, rH),
      away: mkCtx(inj.a, rA),
    }, C.store.P, C.store.LIB);
    // 找不到的号码提示
    [['主队', res.home, rH, inj.h], ['客队', res.away, rA, inj.a]].forEach(function (t) {
      const tag = t[0], r = t[1], ros = t[2], side = t[3];
      const bad = [];
      [['伤停', side.injured]].forEach(function (f) {
        C.parseNumList(f[1]).forEach(function (tok) {
          const o = C.parseRosterList(String(tok))[0];
          if (!o) return;
          const hit = o.num !== null
            ? ros.some(function (p) { return Number(p.num) === o.num; })
            : ros.some(function (p) { return p.name === o.tok; });
          if (!hit) bad.push(f[0] + '「' + tok + '」');
        });
      });
      if (bad.length) r.notes = (r.notes || []).concat([tag + '这些号码/姓名在花名册里找不到：' + bad.join('、')]);
    });
    S.injRes = res;
    S.injMsg = '算完了：主队 ' + res.home.injuryLabel + ' / ' + res.home.depthLabel + ' / ' + res.home.suspendLabel +
      '　·　客队 ' + res.away.injuryLabel + ' / ' + res.away.depthLabel + ' / ' + res.away.suspendLabel;
    S.injMsgKind = 'ok';
    window.App.refresh();
  }

  function renderInjResult(m, inj) {
    const box = U.el('div');
    const c = U.el('div', { class: 'card', style: { borderColor: 'var(--acc)' } });
    c.appendChild(U.el('h2', {}, [document.createTextNode('第二步 · 两队结果'),
      U.el('span', { class: 'hint', text: inj.lg + '　' + inj.home + ' vs ' + inj.away })]));

    /* 两队三个标签并排 */
    const grid = U.el('div', { class: 'grid g2' });
    [['主队', m.home, 'h'], ['客队', m.away, 'a']].forEach(function (t) {
      const sd = t[0], r = t[1], which = t[2];
      const box2 = U.el('div', { style: { border: '1px solid var(--line)', borderRadius: '9px', padding: '9px 11px', background: 'var(--bg)' } });
      const hh = U.el('div', { class: 'flexline', style: { gap: '8px' } });
      hh.appendChild(U.el('span', { style: { fontSize: '14px', fontWeight: '700', color: 'var(--acc)' },
        text: sd + ' · ' + (which === 'h' ? inj.home : inj.away) }));
      hh.appendChild(U.el('span', { class: 'mini', text: '最终贡献 ' + U.fmt(r.finalContribution, 3) }));
      box2.appendChild(hh);
      const rows = [
        ['① 伤病等级 → C2/I2', r.injuryLabel,
          'Loss_Est ' + U.fmt(r.loss, 5) + '　查表 ' + U.fmt(r.injScore, 3) + ' ×深度 ' + U.fmt(r.depMul, 2) + ' → ' + U.fmt(r.injFinal, 3),
          r.band >= 3 ? 'var(--bad)' : r.band >= 1 ? 'var(--warn)' : 'var(--ok)'],
        ['② 阵容深度 → D2/J2', r.depthLabel,
          'DepthRatio ' + U.fmt(r.depthRatio, 4) + '　乘数 ' + U.fmt(r.depMul, 2) + (r.gkDown ? '　（门将特例已降档）' : ''),
          r.depthLabel === '深度薄弱' ? 'var(--bad)' : r.depthLabel === '深度雄厚' ? 'var(--ok)' : 'var(--txt)'],
        ['③ 停赛等级 → E2/K2', r.suspendLabel,
          '停赛 ' + r.suspended.length + ' 人　查表 ' + U.fmt(r.susScore, 3) + '（不乘深度）',
          r.suspendLabel === '首发主力红牌停赛' ? 'var(--bad)' : r.suspendLabel === '轮换球员红牌停赛' ? 'var(--warn)' : 'var(--ok)'],
      ];
      rows.forEach(function (rr) {
        const line = U.el('div', { style: { marginTop: '6px', paddingLeft: '8px', borderLeft: '3px solid ' + rr[3] } });
        line.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: rr[0] }));
        line.appendChild(U.el('div', { style: { fontSize: '14.5px', fontWeight: '700', color: rr[3] }, text: rr[1] }));
        line.appendChild(U.el('div', { class: 'mini', text: rr[2] }));
        box2.appendChild(line);
      });
      box2.appendChild(U.el('div', {
        class: 'mini', style: { marginTop: '6px' },
        html: '本次伤停贡献 = MIN(伤病 ' + U.fmt(r.injFinal, 3) + ', 停赛 ' + U.fmt(r.susScore, 3) + ') = ' +
          '<b style="color:var(--acc)">' + U.fmt(r.finalContribution, 3) + '</b>　（两者<b>不相加</b>）' +
          '<br>③标注：<span style="color:var(--ok)">(是) ' + r.markedPlayedYes + '</span>　' +
          '<span style="color:var(--warn)">(否) ' + r.markedPlayedNo + '</span>　' +
          '伤病 ' + r.injured.length + ' 人 · 停赛 ' + r.suspended.length + ' 人'
      }));
      // 写入按钮
      const rb = U.el('div', { class: 'row', style: { marginTop: '7px' } });
      rb.appendChild(U.btn('写入 ② 盘（这个队）', function () {
        if (window.Batch && window.Batch.applyInjury) {
          window.Batch.applyInjury(which === 'h' ? 'home' : 'away',
            { injury: r.injuryLabel, depth: r.depthLabel, suspend: r.suspendLabel });
          U.toast('已写入 ' + sd + ' 的加减分项', 'ok');
          window.App.go('batch');
        } else U.toast('批量计算模块还没加载', 'bad');
      }, 'sm'));
      box2.appendChild(rb);
      grid.appendChild(box2);
    });
    c.appendChild(grid);

    /* 净影响 */
    const netBox = U.el('div', {
      style: {
        marginTop: '9px', padding: '9px 12px', borderRadius: '9px',
        border: '2px solid ' + (Math.abs(m.net) < 1e-9 ? 'var(--line)' : 'var(--acc)'), background: 'var(--panel)'
      }
    });
    netBox.appendChild(U.el('div', { class: 'mini', style: { color: 'var(--txt-3)' }, text: '两队对冲后的净影响（对应加减分项 T3 里的伤停部分）' }));
    netBox.appendChild(U.el('div', {
      style: { fontSize: '17px', fontWeight: '800', color: Math.abs(m.net) < 1e-9 ? 'var(--txt-3)' : 'var(--acc)', marginTop: '2px' },
      text: (m.net > 0 ? '主队占优 ' : m.net < 0 ? '客队占优 ' : '两边持平 ') + U.fmt(Math.abs(m.net), 3) + ' 分' +
        (m.ball > 0 ? '　≈　' + m.ballText : '')
    }));
    netBox.appendChild(U.el('div', {
      class: 'mini', style: { marginTop: '3px' },
      html: '主队 ' + U.fmt(m.home.finalContribution, 3) + ' − 客队 ' + U.fmt(m.away.finalContribution, 3) + ' = ' + U.fmt(m.net, 3) +
        '　·　折算规则：每 ' + C.store.P.HCP_STEP + ' 分 = ' + C.store.P.HCP_UNIT + ' 球，封顶 ' + C.store.P.HCP_CAP + ' 球' +
        '<br>正数 = 主队短期占优（主队缺人更少）→ 盘口方向偏主让；负数 = 客队占优。'
    }));
    c.appendChild(netBox);

    /* 一键写入两队 */
    const r = U.el('div', { class: 'row', style: { marginTop: '9px' } });
    r.appendChild(U.btn('→ 一键写入 ② 盘（主队 + 客队一起）', function () {
      if (window.Batch && window.Batch.applyInjuryBoth) {
        window.Batch.applyInjuryBoth(
          { injury: m.home.injuryLabel, depth: m.home.depthLabel, suspend: m.home.suspendLabel },
          { injury: m.away.injuryLabel, depth: m.away.depthLabel, suspend: m.away.suspendLabel });
        U.toast('已把两队的伤病/深度/停赛写进 ② 盘', 'ok');
        window.App.go('batch');
      } else U.toast('批量计算模块还没加载', 'bad');
    }, 'pri'));
    r.appendChild(U.btn('复制两队的三个标签', function () {
      U.copy('主队\t' + m.home.injuryLabel + '\t' + m.home.depthLabel + '\t' + m.home.suspendLabel + '\n' +
        '客队\t' + m.away.injuryLabel + '\t' + m.away.depthLabel + '\t' + m.away.suspendLabel);
    }, 'ghost'));
    r.appendChild(U.btn('复制完整报告', function () { U.copy(reportText(m, inj)); }, 'ghost'));
    c.appendChild(r);

    /* 逐人明细（两队） */
    [['主队', m.home], ['客队', m.away]].forEach(function (t) {
      const sd = t[0], rr = t[1];
      if (rr.injured.length) {
        c.appendChild(U.el('div', { class: 'sec-title', text: sd + ' · 伤病球员逐人明细' }));
        c.appendChild(U.el('div', {
          html: U.table([
            { k: 'num', n: '号码', w: '48px' }, { k: 'name', n: '姓名', w: '160px' },
            { k: 'pos', n: '位置', w: '78px' }, { k: 'cls', n: '类别', w: '48px' },
            { k: 'val', n: '身价(万€)', w: '80px', num: 1 },
            { k: 'w', n: 'W', w: '50px' }, { k: 'why', n: 'W 的依据', w: '260px' },
            { k: 's', n: 'S 占比', w: '80px' }, { k: 'pf', n: 'PosFac', w: '58px' },
            { k: 'loss', n: '个体损失', w: '80px' }, { k: 'share', n: '占总损失', w: '80px' },
          ], rr.injured.map(function (d) {
            return {
              num: d.num === null ? '—' : d.num, name: U.esc(d.name), pos: U.esc(d.pos), cls: d.cls,
              val: U.fmt(d.val, 0) + (d.valMissing ? '（缺，用均值）' : ''),
              w: U.fmt(d.w, 2), why: d.why, s: U.fmt(d.s, 5), pf: U.fmt(d.posFac, 2),
              loss: U.fmt(d.lossInd, 5), share: rr.loss > 0 ? C.pct(d.lossInd / rr.loss) : '—',
            };
          }))
        }));
      } else {
        c.appendChild(U.note(sd + '：本场没有伤病球员 → 伤病等级固定「阵容齐整或无影响缺阵」，深度强制「深度一般」。', ''));
      }
      if (rr.suspended.length) {
        c.appendChild(U.el('div', { class: 'sec-title', text: sd + ' · 停赛球员' }));
        c.appendChild(U.el('div', {
          html: U.table([
            { k: 'num', n: '号码', w: '48px' }, { k: 'name', n: '姓名', w: '170px' },
            { k: 'pos', n: '位置', w: '86px' }, { k: 'w', n: 'W', w: '50px' },
            { k: 'kind', n: '判定', w: '140px' }, { k: 'why', n: '依据', w: '240px' },
          ], rr.suspended.map(function (d) {
            return {
              num: d.num, name: U.esc(d.name), pos: U.esc(d.pos), w: U.fmt(d.w, 2),
              kind: d.main ? '<b style="color:var(--bad)">首发主力红牌停赛</b>' : '轮换球员红牌停赛',
              why: d.why,
            };
          }))
        }));
      }
      if (rr.notes && rr.notes.length) {
        c.appendChild(U.note(sd + ' 备注：<br>· ' + rr.notes.map(U.esc).join('<br>· '), 'warn'));
      }
    });

    /* 深度两种口径对照 */
    {
      const chk = function (r, sd) {
        const oldLv = r.residual >= C.num(C.store.P.DEPTH_RES_HI, 0.88) ? '深度雄厚'
          : r.residual >= C.num(C.store.P.DEPTH_RES_LO, 0.75) ? '深度一般' : '深度薄弱';
        return sd + '：DepthRatio ' + U.fmt(r.depthRatio, 4) + ' → ' + r.depthLabel +
          '（阈值 ' + C.store.P.DEPTH_LO + '/' + C.store.P.DEPTH_HI + '）　|　' +
          '旧口径 residual ' + U.fmt(r.residual, 5) + ' → ' + oldLv +
          '（阈值 ' + C.num(C.store.P.DEPTH_RES_LO, 0.75) + '/' + C.num(C.store.P.DEPTH_RES_HI, 0.88) + '）';
      };
      c.appendChild(U.note('<b>阵容深度两种口径对照</b><br>· ' + chk(m.home, '主队') + '<br>· ' + chk(m.away, '客队') +
        '<br><span style="color:var(--warn)">注意：ResidualRatio ≡ 1 − Loss_Est，与「伤病等级」是同一个数。' +
        '若用它，同一批伤病会被扣两次。默认已切到独立口径（调参中心 → 映射表 → 阵容深度口径）。</span>', 'warn'));
    }

    box.appendChild(c);
    return box;
  }

  function reportText(m, inj) {
    const one = function (sd, team, r) {
      let t = '【' + sd + ' ' + team + '】\n';
      t += '伤病等级：' + r.injuryLabel + '（Loss_Est=' + r.loss.toFixed(5) + '，查表 ' + r.injScore +
        ' ×深度 ' + r.depMul + ' → ' + r.injFinal.toFixed(3) + '）\n';
      t += '阵容深度：' + r.depthLabel + '（DepthRatio=' + r.depthRatio.toFixed(4) + '，乘数 ' + r.depMul + '）\n';
      t += '停赛等级：' + r.suspendLabel + '（查表 ' + r.susScore + '）\n';
      t += '最终伤停贡献：MIN(' + r.injFinal.toFixed(3) + ', ' + r.susScore + ') = ' + r.finalContribution.toFixed(3) + '\n';
      if (r.injured.length) {
        t += '伤病明细：\n';
        r.injured.forEach(function (d) {
          t += '  #' + d.num + ' ' + d.name + ' ' + d.pos + ' 身价' + d.val + ' W=' + d.w +
            ' S=' + d.s.toFixed(5) + ' PosFac=' + d.posFac + ' → ' + d.lossInd.toFixed(5) + '  [' + d.why + ']\n';
        });
      }
      return t;
    };
    let t = inj.lg + '　' + inj.home + ' vs ' + inj.away + '\n\n';
    t += one('主队', inj.home, m.home) + '\n';
    t += one('客队', inj.away, m.away) + '\n';
    t += '净影响：' + m.home.finalContribution.toFixed(3) + ' − ' + m.away.finalContribution.toFixed(3) +
      ' = ' + m.net.toFixed(3) + (m.ball > 0 ? '　≈ ' + m.ballText : '') + '\n\n';
    t += '原始输入：\n';
    [['主队', inj.h], ['客队', inj.a]].forEach(function (x) {
      const s = x[1];
      t += x[0] + ' 首发[' + s.starters + '] 替补[' + s.subs + '] 本场伤停[' + s.injured + ']\n';
    });
    return t;
  }

  /* ==================== ③ 转会窗口 ==================== */
  function tabWin(host) {
    const LIB = C.store.LIB;
    if (!LIB.transferWindows) LIB.transferWindows = JSON.parse(JSON.stringify(C.TRANSFER_WINDOWS));
    const list = LIB.transferWindows;
    const st = C.transferStatus(LIB);

    /* 提醒横幅 */
    const alerts = [];
    st.forEach(function (x) {
      [['夏季转会窗', x.summer], ['冬季转会窗', x.winter]].forEach(function (t) {
        const w = t[1];
        if (w.state === '进行中' && w.days <= 7) alerts.push({ tone: 'warn', t: x.lg + ' ' + t[0] + '还剩 ' + w.days + ' 天关闭（' + w.toText + ' ' + w.hm + ' ' + w.tz + '）' });
        else if (w.state === '进行中') alerts.push({ tone: 'ok', t: x.lg + ' ' + t[0] + '进行中，还有 ' + w.days + ' 天' });
        else if (w.state === '未开启' && w.days <= 14) alerts.push({ tone: 'warn', t: x.lg + ' ' + t[0] + '还有 ' + w.days + ' 天开启（' + w.fromText + '）' });
      });
    });
    const c0 = U.el('div', { class: 'card' });
    c0.appendChild(U.el('h2', {}, [document.createTextNode('转会窗口提醒'),
      U.el('span', { class: 'hint', text: '夏窗 / 冬窗的开启与关闭日期，临近自动高亮' })]));
    c0.appendChild(U.el('p', {
      class: 'desc', html: '今天是 <b>' + new Date().toLocaleDateString('zh-CN') + '</b>。' +
        '窗口期外的转会不会生效（球员不能注册）—— 排阵容时如果看到「新援」，先确认转会窗是开着的。' +
        '<br>日期和时分都可以改；<b>在「调参中心 → 映射表 → 转会窗口」里能增删联赛</b>（比如加上荷甲、巴甲）。'
    }));
    if (alerts.length) {
      const box = U.el('div', { style: { marginBottom: '8px' } });
      alerts.forEach(function (a) {
        box.appendChild(U.note(a.t, a.tone));
      });
      c0.appendChild(box);
    } else {
      c0.appendChild(U.note('当前没有任何转会窗在进行中，也没有 14 天内要开启的窗口。', ''));
    }
    host.appendChild(c0);

    const c1 = U.el('div', { class: 'card' });
    c1.appendChild(U.el('h2', {}, [document.createTextNode('各联赛窗口表（可直接改）')]));
    c1.appendChild(U.grid([
      { n: '联赛', w: '76px' },
      { n: '夏窗开始', w: '84px' }, { n: '夏窗结束', w: '84px' }, { n: '时分', w: '62px' },
      { n: '夏窗状态', w: '150px' },
      { n: '冬窗开始', w: '84px' }, { n: '冬窗结束', w: '84px' }, { n: '时分', w: '62px' },
      { n: '冬窗状态', w: '150px' },
      { n: '时区', w: '50px' }, { n: '', w: '34px' },
    ], st.map(function (x, i) {
      const row = list[i];
      const inp = function (which, k2, w) {
        return U.input(row[which][k2], function (v) { row[which][k2] = v; C.saveLib(); },
          { style: { flex: '0 0 ' + w + 'px', width: w + 'px' } });
      };
      const stTxt = function (w) {
        const tone = w.state === '进行中' ? (w.days <= 7 ? 'var(--warn)' : 'var(--ok)') : w.state === '未开启' ? 'var(--txt-2)' : 'var(--txt-3)';
        return '<span style="color:' + tone + '">' + w.state + '</span>　' +
          (w.state === '进行中' ? ('剩 ' + w.days + ' 天') : w.state === '未开启' ? (w.days + ' 天后开启') : (w.days + ' 天前关闭'));
      };
      return [
        '<b>' + U.esc(x.lg) + '</b>',
        inp('sum', 'from', 84), inp('sum', 'to', 84), inp('sum', 'hm', 62),
        stTxt(x.summer),
        inp('win', 'from', 84), inp('win', 'to', 84), inp('win', 'hm', 62),
        stTxt(x.winter),
        U.input(row.sum.tz, function (v) { row.sum.tz = v; row.win.tz = v; C.saveLib(); },
          { style: { flex: '0 0 50px', width: '50px' } }),
        U.btn('×', function () {
          U.confirmBox('删除「' + x.lg + '」的转会窗口？', function () {
            list.splice(i, 1); C.saveLib(); window.App.refresh();
          });
        }, 'danger sm'),
      ];
    })));
    const r = U.el('div', { class: 'row' });
    r.appendChild(U.btn('＋ 新增联赛窗口', function () {
      list.push({
        lg: '新联赛', sum: { from: '07-01', to: '09-01', hm: '23:59', tz: 'CET' },
        win: { from: '01-01', to: '02-01', hm: '23:59', tz: 'CET' }
      });
      C.saveLib(); window.App.refresh();
    }, 'sm pri'));
    r.appendChild(U.btn('↺ 恢复默认窗口', function () {
      U.confirmBox('恢复成 英超/西甲/意甲/德甲/法甲 的默认窗口？', function () {
        LIB.transferWindows = JSON.parse(JSON.stringify(C.TRANSFER_WINDOWS));
        C.saveLib(); U.toast('已恢复', 'ok'); window.App.refresh();
      });
    }, 'sm ghost'));
    c1.appendChild(r);
    c1.appendChild(U.note('提示：窗口「关闭」只是转会注册截止。自由球员（无合同）在窗口外也能签，' +
      '但那类球员本工具算不出来 —— 一律按「新援 W=' + U.fmt(C.store.P.W_NEW, 2) + '」处理即可。', ''));
    host.appendChild(c1);

    /* 日历视图 */
    const c2 = U.el('div', { class: 'card' });
    c2.appendChild(U.el('h2', {}, [document.createTextNode('全年窗口日历（按当前日期）')]));
    const now = new Date();
    const y = now.getFullYear();
    const rows = [];
    st.forEach(function (x) {
      [['夏季', x.summer], ['冬季', x.winter]].forEach(function (t) {
        rows.push({
          lg: x.lg, w: t[0], from: t[1].fromText + ' ' + t[1].hm, to: t[1].toText + ' ' + t[1].hm,
          tz: t[1].tz, days: Math.round((t[1].to - t[1].from) / 86400000),
          st: '<span style="color:' + (t[1].state === '进行中' ? 'var(--ok)' : 'var(--txt-3)') + '">' + t[1].state + '</span>',
        });
      });
    });
    rows.sort(function (a, b) { return String(a.from).localeCompare(String(b.from)); });
    c2.appendChild(U.el('div', {
      html: U.table([
        { k: 'lg', n: '联赛', w: '80px' }, { k: 'w', n: '窗口', w: '60px' },
        { k: 'from', n: '开始', w: '150px' }, { k: 'to', n: '结束', w: '150px' },
        { k: 'tz', n: '时区', w: '60px' }, { k: 'days', n: '持续天数', w: '80px', num: 1 },
        { k: 'st', n: '现在', w: '80px' },
      ], rows)
    }));
    host.appendChild(c2);
  }

  /* ==================== 注册 ==================== */
  const API = {
    setTab: function (t) { if (['lib', 'inj', 'win'].indexOf(t) >= 0) S.tab = t; },
    getTab: function () { return S.tab; },
    state: S,
    PL: function () { return pl(); },
    savePL: savePL,
    reload: function () { PL = null; },
    leagues: function () { return pl().leagues; },
    teamsOf: teamsOf,
    roster: roster,
    playerCount: playerCount,
    playersOf: playersOf,
    setPlayers: setPlayers,
    parseGrid: parseGrid,
    leagueFromName: leagueFromName,
    doUpload: doUpload,
    applyImport: applyImport,
    renderLib: tabLib,
    renderInj: tabInj,
    renderWin: tabWin,
    saveInj: saveInj,
    calc: calc,
    reportText: reportText,
  };
  window.Players = API;
  loadInj();
})();
