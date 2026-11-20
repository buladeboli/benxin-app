/* =========================================================================
 * mod-entry.js — 模块 ② 生成录入
 *   五个页签：
 *     球员库    上传 / 编辑 / 替换球员信息表（.xls / .xlsx / .csv），可新增联赛、手改号码
 *     伤停量化  一场比赛主客两队并排录，每队 3 组号码 → 算伤病 / 深度 / 停赛三个文本标签
 *     转会窗口  六大联赛的夏窗冬窗日期 + 倒计时提醒
 *     截图识别  截图 → AI 视觉识别（可选，用你自己的 OpenAI 兼容 Key），结果送入 ② 单场录入或 ① 整行快录
 *     使用说明  本模块怎么用
 *
 *   实际功能实现在 mod-players.js（球员库 / 伤停量化 / 转会窗口），本文件负责页签与识图。
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  const S = { tab: 'players', raw: '', parsed: null, img: null, msg: '', msgKind: '', ocrResult: '', mode: 'auto' };
  const STANDARD_SAMPLE =
    '# 第1行：标准整行（字段顺序见「使用说明」页；末尾两列是「近6场实际场次」）\n' +
    '1,葡超,8,大阪钢巴,神户胜利船,无,0.5,0.5,1.04,1.03,无,无,无,无,无,无,无,无,' +
    '1,1,9,1,3,18,0,0,4,2,2,18,0,2,20,0,2,6,' +
    '2,2,4,0,1,6,1,0,9,2,0,3,3,1,18,2,1,3,' +
    '3,4,4,2,FALSE,16,4,下游,上游,' +
    '近3次对战1胜1平1负,阵容齐整或无影响缺阵,无停赛,间隔4-5天,深度一般,其他情况,争分,' +
    '近3次对战1胜1平1负,阵容齐整或无影响缺阵,无停赛,一周双赛(≤3天),深度一般,连续3场胜利,争分,' +
    '2026/9/18 16:11,2026/9/20 13:16,8,8';

  /* ---------------- 下拉值反查（文本 → 库里最接近的键） ---------------- */
  function bestKey(tbl, text) {
    if (!text) return '';
    const t = String(text).replace(/\s/g, '');
    const keys = Object.keys(tbl);
    for (const k of keys) if (k.replace(/\s/g, '') === t) return k;
    for (const k of keys) {
      const kk = k.replace(/\s/g, '');
      if (kk.indexOf(t) >= 0 || t.indexOf(kk) >= 0) return k;
    }
    // 关键词匹配
    const kw = {
      hist: [['3胜', '近3次对战3胜'], ['2胜1平', '近3次对战2胜1平'], ['2胜1负', '近3次对战2胜1负'], ['1胜2平', '近3次对战1胜2平'], ['1胜1平1负', '近3次对战1胜1平1负'], ['3平', '近3次对战3平'], ['1胜2负', '近3次对战1胜2负'], ['2平1负', '近3次对战2平1负'], ['1平2负', '近3次对战1平2负'], ['3负', '近3次对战3负']],
      injury: [['齐整', '阵容齐整或无影响缺阵'], ['普通主力', '单名普通主力缺阵'], ['绝对核心', '单名绝对核心缺阵'], ['双核', '双核或攻防双主力缺阵'], ['三核', '三核缺阵或半套主力'], ['伤病潮', '大面积伤病潮']],
      suspend: [['无停赛', '无停赛'], ['首发', '首发主力红牌停赛'], ['轮换', '轮换球员红牌停赛']],
      fatigue: [['4-5', '间隔4-5天'], ['双赛', '一周双赛(≤3天)'], ['充足', '休息充足(≥6天)'], ['2个客场', '连续2个客场'], ['3个客场', '连续3个客场'], ['欧战', '下场有欧战，本场可能轮换']],
      depth: [['雄厚', '深度雄厚'], ['一般', '深度一般'], ['薄弱', '深度薄弱']],
      streak: [['连胜', '连续3场胜利'], ['连败', '连续3场失利'], ['其他', '其他情况']],
      motive: [['生死战', '争冠/保级生死战'], ['争分', '争分'], ['德比', '德比/死敌'], ['死敌', '德比/死敌'], ['普通', '普通'], ['摆烂', '摆烂']]
    };
    for (const grp in kw) {
      if (tbl !== C.store.LIB[grp]) continue;
      for (const [needle, key] of kw[grp]) if (t.indexOf(needle) >= 0) return key;
    }
    return '';
  }

  /* ---------------- 智能解析 ---------------- */
  function parseSmart(text, opts) {
    opts = opts || {};
    const out = { fields: {}, warn: [], matched: [] };
    const F = out.fields;
    let s = String(text || '').replace(/\r/g, '');
    // 全角转半角（保留中文）
    s = s.replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/\u3000/g, ' ');
    const lines = s.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    // —— 联赛 / 轮次 ——
    if (!F.league) {
      const lgNames = Object.keys(C.store.LIB.leagues);
      for (const l of lines) {
        for (const nm of lgNames) if (l.indexOf(nm) >= 0) { F.league = nm; out.matched.push('联赛：' + nm); break; }
        if (F.league) break;
      }
    }
    if (F.round === undefined) {
      const m = s.match(/(?:第\s*)?(\d{1,2})\s*轮/);
      if (m) { F.round = Number(m[1]); out.matched.push('轮次：' + m[1]); }
    }

    // —— 球队：优先「A vs B / A - B / A 对 B」 ——
    if (!F.home) {
      for (const l of lines) {
        const m = l.match(/^([\u4e00-\u9fa5A-Za-z0-9·\.\-]{2,20})\s*(?:vs|VS|Vs|v\.?s\.?|对|—|–|-|～|~)\s*([\u4e00-\u9fa5A-Za-z0-9·\.\-]{2,20})$/);
        if (m) { F.home = m[1].trim(); F.away = m[2].trim(); out.matched.push('对阵：' + F.home + ' vs ' + F.away); break; }
      }
    }
    if (!F.home) {
      // 「主队：xxx」形式
      const mh = s.match(/主队[名称]*\s*[:：]\s*([^\n]{2,24})/);
      const ma = s.match(/客队[名称]*\s*[:：]\s*([^\n]{2,24})/);
      if (mh) { F.home = mh[1].trim(); out.matched.push('主队：' + F.home); }
      if (ma) { F.away = ma[1].trim(); out.matched.push('客队：' + F.away); }
    }
    if (!F.home && opts.homeHint) F.home = opts.homeHint;
    if (!F.away && opts.awayHint) F.away = opts.awayHint;

    // —— 盘口：主让/客让 文本 或 纯数值 ——
    const plateRe = /(主让|客让|受让|平手)\s*([^\s,，|]{0,12})/g;
    const plates = [];
    let pm;
    while ((pm = plateRe.exec(s)) !== null) plates.push({ txt: pm[0].replace(/\s/g, ''), idx: pm.index });
    // 从「初盘 / 终盘」所在行抽水位（支持全角小数点与冒号）
    const waterOn = function (kw) {
      for (const raw of lines) {
        if (!new RegExp(kw).test(raw)) continue;
        const l = raw.replace(/[０-９．]/g, function (c) { return c === '．' ? '.' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
        const m = l.match(/(\d\.\d{2})(?=\s|[）)]|$|[,，|])/);
        if (m) return parseFloat(m[1]);
      }
      return undefined;
    };
    if (plates.length) {
      const toVal = function (t) {
        /* ★ v15：符号一律由 Core.plateValue 决定（负 = 主队让球）。
         *   旧写法在这里又按「客让/受让」翻了一次负号，跟 plateValue 自己的符号叠加，
         *   结果「主让半球」被当成客队让球 —— 截图识别的盘口方向一直是反的。 */
        const v = C.plateValue(t, C.store.P, C.store.LIB);
        return v === null || v === undefined ? undefined : v;
      };
      if (plates[0]) { F.open = toVal(plates[0].txt); out.matched.push('初盘（文本）：' + plates[0].txt + ' → ' + F.open); }
      if (plates[1]) { F.close = toVal(plates[1].txt); out.matched.push('终盘（文本）：' + plates[1].txt + ' → ' + F.close); }
      else if (plates[0]) { F.close = F.open; }
      if (F.openWater === undefined) F.openWater = waterOn('初盘|初赔|开盘');
      if (F.closeWater === undefined) F.closeWater = waterOn('终盘|终赔|收盘|即时盘');
      if (F.openWater === undefined) F.openWater = waterOn('');
    }

    // —— 「初盘 0.5 1.04 / 终盘 0.5 1.03」形式（仅在文本里没有中文盘口名时才用，避免互相覆盖） ——
    const lineKV = function (kw) {
      for (const l of lines) {
        if (!new RegExp(kw).test(l)) continue;
        const m = l.match(/(-?\d+(?:\.\d+)?)[^\d\-]{1,8}(\d\.\d{2})/);
        if (m) return [parseFloat(m[1]), parseFloat(m[2])];
      }
      return null;
    };
    if (F.open === undefined) {
      const op = lineKV('初盘|初赔|开盘');
      if (op) { F.open = op[0]; F.openWater = op[1]; out.matched.push('初盘：' + op[0] + ' 水位 ' + op[1]); }
    }
    if (F.close === undefined) {
      const cl = lineKV('终盘|终赔|收盘|即时盘');
      if (cl) { F.close = cl[0]; F.closeWater = cl[1]; out.matched.push('终盘：' + cl[0] + ' 水位 ' + cl[1]); }
    }

    // —— 水位单独行 ——
    if (F.openWater === undefined) {
      const m = s.match(/初盘水位[^\d]{0,6}(\d\.\d{2})/) || s.match(/初水[^\d]{0,6}(\d\.\d{2})/);
      if (m) { F.openWater = parseFloat(m[1]); out.matched.push('初盘水位：' + m[1]); }
    }
    if (F.closeWater === undefined) {
      const m = s.match(/终盘水位[^\d]{0,6}(\d\.\d{2})/) || s.match(/终水[^\d]{0,6}(\d\.\d{2})/);
      if (m) { F.closeWater = parseFloat(m[1]); out.matched.push('终盘水位：' + m[1]); }
    }

    // —— 比分 ——
    const ms = s.match(/(\d{1,2})\s*[:：\-]\s*(\d{1,2})/g);
    if (ms) {
      // 排除盘口行
      for (const cand of ms) {
        const idx = s.indexOf(cand);
        const line = s.slice(s.lastIndexOf('\n', idx) + 1, s.indexOf('\n', idx) < 0 ? s.length : s.indexOf('\n', idx));
        if (/比分|完场|终场|FT|结果/.test(line)) { F.scoreText = cand; out.matched.push('比分：' + cand); break; }
      }
    }

    // —— 排名 ——
    let mr = s.match(/主队[^\n]{0,6}排名[^\d]{0,4}(\d{1,2})/); if (mr) { F.hRank = Number(mr[1]); out.matched.push('主队排名：' + mr[1]); }
    mr = s.match(/客队[^\n]{0,6}排名[^\d]{0,4}(\d{1,2})/); if (mr) { F.aRank = Number(mr[1]); out.matched.push('客队排名：' + mr[1]); }

    // —— 主客场战绩 ——
    const mg = s.match(/主场[^\d]{0,6}(\d{1,2})\s*场[^\d]{0,6}(\d{1,3})\s*分/);
    if (mg) { F.hGames = Number(mg[1]); F.hPts = Number(mg[2]); out.matched.push('主场战绩：' + mg[1] + '场' + mg[2] + '分'); }
    const mg2 = s.match(/客场[^\d]{0,6}(\d{1,2})\s*场[^\d]{0,6}(\d{1,3})\s*分/);
    if (mg2) { F.aGames = Number(mg2[1]); F.aPts = Number(mg2[2]); out.matched.push('客场战绩：' + mg2[1] + '场' + mg2[2] + '分'); }

    // —— 加减分项文本 ——
    const map = [
      ['hHist', 'hist'], ['aHist', 'hist'],
      ['hInjury', 'injury'], ['aInjury', 'injury'],
      ['hSuspend', 'suspend'], ['aSuspend', 'suspend'],
      ['hFatigue', 'fatigue'], ['aFatigue', 'fatigue'],
      ['hDepth', 'depth'], ['aDepth', 'depth'],
      ['hStreak', 'streak'], ['aStreak', 'streak'],
      ['hMotive', 'motive'], ['aMotive', 'motive']
    ];
    map.forEach(function (m) {
      const key = m[0], grp = m[1];
      const side = key[0] === 'h' ? '主' : '客';
      const label = { hist: '历史交锋|交锋', injury: '伤病', suspend: '停赛', fatigue: '疲劳|赛程', depth: '阵容深度|深度', streak: '连胜|连负|连赢连负', motive: '战意' }[grp];
      const re = new RegExp(side + '[队]?\\s*(?:' + label + ')\\s*[:：]?\\s*([^\\n,，|]{2,20})');
      const mm = s.match(re);
      if (mm) {
        const k = bestKey(C.store.LIB[grp], mm[1]);
        if (k) { F[key] = k; out.matched.push(side + '队 ' + grp + '：' + k); }
        else out.warn.push(side + '队 ' + label + ' 文本「' + mm[1].trim() + '」没能对上库里的选项，请手动选');
      }
    });

    // —— 近 6 场：形如 「主队近6场：1-1(9) 1-3(18) ...」 ——
    const sixRe = /(主队|客队|主|客)\s*近\s*6\s*场\s*[:：]?\s*([^\n]{4,300})/g;
    const scoreRe = /(\d{1,3})\s*[-:：]\s*(\d{1,3})(?:\s*[\(（]\s*(\d{1,3})\s*[\)）])?/g;
    let s6;
    while ((s6 = sixRe.exec(s)) !== null) {
      const side = s6[1].indexOf('主') >= 0 ? 'h' : 'a';
      const arr = [];
      let sm;
      scoreRe.lastIndex = 0;
      while ((sm = scoreRe.exec(s6[2])) !== null) {
        arr.push({ g: Number(sm[1]), c: Number(sm[2]), o: sm[3] ? Number(sm[3]) : 0 });
        if (arr.length >= 6) break;
      }
      if (!arr.length) continue;
      // 约定：文本里最左边是最新一场 → 第6场，最右边是最早一场 → 第1场
      for (let i = 0; i < arr.length; i++) {
        const n = 6 - i;
        F[side + 'G' + n] = arr[i].g; F[side + 'C' + n] = arr[i].c; F[side + 'O' + n] = arr[i].o;
      }
      out.matched.push((side === 'h' ? '主队' : '客队') + '近6场解析 ' + arr.length + ' 场（最左为最近一场）');
    }

    // —— 时间 ——
    const t1 = s.match(/(?:初盘|开盘)时间\s*[:：]?\s*([\d\/\-\.\s:]{8,20})/);
    const t2 = s.match(/(?:终盘|收盘)时间\s*[:：]?\s*([\d\/\-\.\s:]{8,20})/);
    if (t1) { F.openTime = normTime(t1[1]); out.matched.push('初盘时间：' + F.openTime); }
    if (t2) { F.closeTime = normTime(t2[1]); out.matched.push('终盘时间：' + F.closeTime); }

    // 必填检查
    if (!F.league) out.warn.push('未识别到联赛，请手动选择');
    if (F.open === undefined) out.warn.push('未识别到机构初盘，请手动填写');
    if (F.openWater === undefined) out.warn.push('未识别到初盘水位，请手动填写');
    return out;
  }
  function normTime(t) {
    t = String(t).trim().replace(/[\.\/]/g, '-').replace(/\s+/g, ' ');
    const m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})[\sT]*(\d{1,2})?:?(\d{2})?/);
    if (!m) return t;
    const p = function (x) { return String(x === undefined ? 0 : x).padStart(2, '0'); };
    return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + ' ' + p(m[4]) + ':' + p(m[5]);
  }

  /* ---------------- 生成输出 ---------------- */
  // 用内核定义的字段顺序，保证与「批量计算 → ② 单场录入」一致
  function toCommaLine(F) { return C.inputToComma(F); }
  function toFullRow(F, seq) {
    const rec = { seq: seq || 1, inp: JSON.parse(JSON.stringify(F)), note: F.note || '' };
    return C.recordToRow(rec);
  }

  /* ---------------- 页面：A 文本解析 ---------------- */
  function detectInputKind(text) {
    const t = String(text || '');
    const lines = t.split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return 'empty';
    // 统计每行分隔符数量，>=20 视为「标准整行」
    const counts = lines.map(function (l) { return (l.match(/[,\t，]/g) || []).length; });
    const maxC = Math.max.apply(null, counts);
    return maxC >= 20 ? 'line' : 'free';
  }

  /* 路径 A · 文本解析 已按需求删除（解析内核 parseSmart/toCommaLine 保留，供其它模块调用） */

  /* ---------------- 页面：B 截图识别 ---------------- */
  function panelOCR(host) {
    const st = C.store.settings;
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('路径 B · 截图 → 录入文本'),
      U.el('span', { class: 'hint', text: '可选模块 · 需要 AI，或手动复制 Prompt 去网页 AI' })]));
    c.appendChild(U.el('p', { class: 'desc', text: 'AI 返回的是一段结构化文本，贴回本页下面，点「解析并送入 ② 单场录入」即可。三种用法，任选其一：' }));
    const ol = U.el('ol', { style: { paddingLeft: '20px', fontSize: '12.5px', color: 'var(--txt-2)' } });
    ol.appendChild(U.el('li', { html: '<b>不花钱的做法（推荐先用这个）</b>：点「生成识图 Prompt 并复制」，把 Prompt + 截图一起发给你已经在用的 AI 网页（DeepSeek / 豆包 / ChatGPT / Kimi 等，多数免费），' +
      '把它回的那段贴到本页下面的「识别结果」，再点「解析并送入 ② 单场录入」。' }));
    ol.appendChild(U.el('li', { html: '<b>一键做法</b>：在下面填 OpenAI 兼容的 Base URL / Key / 模型（需支持图片输入的视觉模型，如 gpt-4o-mini、qwen-vl-max、glm-4v），' +
      '然后上传或粘贴截图，直接出结果。费用按你的 API 账号 token 结算（一次约几分钱）。' }));
    ol.appendChild(U.el('li', { html: '<b>纯离线做法</b>：把 Tesseract.js 放到 <code>vendor/tesseract/</code>（含 <code>chi_sim.traineddata</code>）后会出现「本地离线识别」按钮。不下载也能用前两种。' }));
    c.appendChild(ol);
    c.appendChild(U.note('为什么 Prompt 要写得这么长？因为盘口数字很敏感（<b>0.9 与 0.99、半球与一球</b>），' +
      '一次性把「字段顺序 + 可选值清单 + 示例」都给 AI，它才不会自由发挥。这也正是「识图 Prompt」比直接 OCR 更准的原因。', 'warn'));

    const g = U.el('div', { class: 'grid g2' });
    g.appendChild(U.field('Base URL', U.input(st.apiBase || '', function (v) { st.apiBase = v.trim(); C.saveSettings(); }, { placeholder: 'https://api.deepseek.com/v1' })));
    g.appendChild(U.field('API Key', U.input(st.apiKey || '', function (v) { st.apiKey = v.trim(); C.saveSettings(); window.App.updateFoot(); }, { type: 'password' })));
    g.appendChild(U.field('视觉模型名', U.input(st.visionModel || st.apiModel || '', function (v) { st.visionModel = v.trim(); C.saveSettings(); }, { placeholder: 'gpt-4o-mini / qwen-vl-max / glm-4v' })));
    c.appendChild(g);

    const promptText = ocrPrompt();
    const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
    row.appendChild(U.btn('生成识图 Prompt 并复制', function () { U.copy(promptText); S.ocrPrompt = promptText; U.toast('Prompt 已复制，请连同截图一起发给 AI', 'ok'); }, 'pri'));
    row.appendChild(U.btn('下载 Prompt.txt', function () { U.download('识图Prompt.txt', promptText, 'text/plain;charset=utf-8'); }, 'ghost'));

    const fileBtn = U.btn('选择截图（上传）', function () { pickImage(); });
    row.appendChild(fileBtn);
    row.appendChild(U.btn('从剪贴板粘贴截图', function () { pasteImage(); }));
    if (window.Tesseract || window.__localTesseractReady) {
      row.appendChild(U.btn('本地离线识别（Tesseract）', function () { localOCR(); }));
    }
    c.appendChild(row);

    // 拖放区
    const dz = U.el('div', {
      style: {
        marginTop: '12px', border: '1px dashed var(--line-2)', borderRadius: '10px', padding: '22px',
        textAlign: 'center', color: 'var(--txt-3)', fontSize: '12.5px', cursor: 'pointer'
      },
      html: '把截图拖到这里，或点击选择文件<br><span class="mini">支持 PNG / JPG / WebP / GIF</span>'
    });
    dz.addEventListener('click', pickImage);
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.style.borderColor = 'var(--acc)'; });
    dz.addEventListener('dragleave', function () { dz.style.borderColor = 'var(--line-2)'; });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.style.borderColor = 'var(--line-2)';
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readImage(f);
    });
    c.appendChild(dz);

    if (S.img) {
      const prev = U.el('div', { style: { marginTop: '12px' } });
      prev.appendChild(U.el('img', { src: S.img, style: { maxWidth: '100%', maxHeight: '340px', borderRadius: '8px', border: '1px solid var(--line)' } }));
      const r2 = U.el('div', { class: 'row' });
      r2.appendChild(U.btn('▶ 用视觉模型识别这张图', function () { visionOCR(); }, 'pri'));
      r2.appendChild(U.btn('移除图片', function () { S.img = null; window.App.refresh(); }, 'ghost'));
      prev.appendChild(r2);
      c.appendChild(prev);
    }
    if (S.msg) c.appendChild(U.note(S.msg, S.msgKind));
    if (S.ocrResult) {
      c.appendChild(U.el('div', { class: 'sec-title', text: '识别结果（可编辑）' }));
      c.appendChild(U.el('p', { class: 'desc', text: '视觉模型可能认错队名或盘口数字，<b>务必对着截图核一遍</b>。改完有两种去处：' +
        '想逐项确认就送「② 单场录入」，想和其它场一起批量入库就送「① 整行快录」。' }));
      const ta2 = U.textarea(S.ocrResult, function (v) { S.ocrResult = v; S.ocrParsed = null; }, { rows: 12 });
      c.appendChild(ta2);
      const rb = U.el('div', { class: 'row' });
      rb.appendChild(U.btn('▶ 解析并送入「② 单场录入」', function () {
        const inp = parseSmart(S.ocrResult, {});
        const F = inp.fields || {};
        if (!Object.keys(F).length) {
          S.msg = '没认出可用字段 —— 请确认文本里至少有联赛、主队、客队、机构初盘、初盘水位。';
          S.msgKind = 'bad'; window.App.refresh(); return;
        }
        S.ocrParsed = F;
        window.Batch.acceptFromEntry(F);
        U.toast('已送入「批量计算 → ② 单场录入」，请逐项核对', 'ok');
      }, 'pri'));
      rb.appendChild(U.btn('→ 送入「① 整行快录」', function () {
        if (!window.Batch || !window.Batch.quickFill) return U.toast('批量计算模块未加载', 'warn');
        window.Batch.quickFill(S.ocrResult, true);
        U.toast('已送到「批量计算 → ① 整行快录」，核对后点「全部写入记录库」', 'ok');
      }));
      rb.appendChild(U.btn('只解析看看（不跳页）', function () {
        const inp = parseSmart(S.ocrResult, {});
        S.ocrParsed = inp.fields || {};
        window.App.refresh();
      }));
      rb.appendChild(U.btn('复制文本', function () { U.copy(S.ocrResult); U.toast('已复制', 'ok'); }, 'ghost'));
      rb.appendChild(U.btn('清空', function () { S.ocrResult = ''; S.ocrParsed = null; window.App.refresh(); }, 'ghost'));
      c.appendChild(rb);

      if (S.ocrParsed && Object.keys(S.ocrParsed).length) {
        const F = S.ocrParsed;
        c.appendChild(U.el('div', { class: 'sec-title', text: '解析出的字段' }));
        c.appendChild(U.el('div', { html: U.table([
          { k: 'k', n: '字段', w: '190px' }, { k: 'v', n: '值', w: '260px' },
        ], Object.keys(F).map(function (k) {
          const def = C.INPUT_FIELDS.filter(function (f) { return f.k === k; })[0];
          return { k: U.esc(def ? def.n : k), v: U.esc(F[k]) };
        })) }));
      }
    }
    host.appendChild(c);
  }

  /** 识图 Prompt：要求 AI 输出「标准整行」，贴回本页解析后送入「② 单场录入」或「① 整行快录」 */
  function ocrPrompt() {
    const lg = Object.keys(C.store.LIB.leagues).join(' / ');
    const order = C.INPUT_FIELDS.map(function (f, i) { return (i + 1) + '=' + f.n; }).join('  ');
    return [
      '你是盘口数据录入助手。请把这张截图里的比赛信息，转成【一行逗号分隔的数据】，',
      '字段顺序必须严格照下面这个格式，一个都不能错位；没有的字段写 无。',
      '',
      '【字段顺序（共 ' + C.INPUT_FIELDS.length + ' 列）】',
      order,
      '',
      '【必须遵守的规则】',
      '1. 只输出那一行数据本身。不要解释、不要标题、不要 Markdown 代码块、不要换行。',
      '2. 用半角逗号 , 分隔；不要用中文逗号。',
      '3. 以下这些列是程序自己算的，一律写 无：',
      '   第6列 本心实力盘、第11列 深开/浅开标签、第12列 八大场景匹配、',
      '   第13列 冲突仲裁结论、第14列 综合评分、第15列 信号强度标签。',
      '4. 第16列 最终比分、第17列 上盘是否赢盘、第18列 备注：若截图还没开赛，都写 无。',
      '5. 第55~58列（主队主场场次/总分、主队客场场次/总分）如果截图里有就填，没有写 无。',
      '6. 第59列 是否空场：填 TRUE 或 FALSE；不确定写 无。',
      '7. 第62/63列 排名区间：只能填 上游 / 中游 / 下游，不确定写 无（程序会自动判）。',
      '8. 第64~77列 是加减分项的文字，必须从下面这些固定选项里挑（原样照抄，含括号）：',
      '   历史交锋：近3次对战3胜 / 近3次对战2胜1平 / 近3次对战2胜1负 / 近3次对战1胜2平 /',
      '             近3次对战1胜1平1负 / 近3次对战3平 / 近3次对战1胜2负 / 近3次对战2平1负 /',
      '             近3次对战1平2负 / 近3次对战3负',
      '   伤病：阵容齐整或无影响缺阵 / 单名普通主力缺阵 / 单名绝对核心缺阵 / 双核或攻防双主力缺阵 /',
      '         三核缺阵或半套主力 / 大面积伤病潮',
      '   停赛：无停赛 / 首发主力红牌停赛 / 轮换球员红牌停赛',
      '   赛程疲劳：间隔4-5天 / 一周双赛(≤3天) / 休息充足(≥6天) / 连续2个客场 / 连续3个客场 / 下场有欧战，本场可能轮换',
      '   阵容深度：深度雄厚 / 深度一般 / 深度薄弱',
      '   连赢连负：其他情况 / 连续3场胜利 / 连续3场失利',
      '   战意：争冠/保级生死战 / 争分 / 德比/死敌 / 普通 / 摆烂',
      '9. 第19~54列 是近6场明细，格式：进球,失球,对手排名，最近的比赛放【第6场】。',
      '   例如截图显示最近三场是 1-1(第9名)、1-3(第18名)、0-0(第4名)，则：',
      '   第19列=1  第20列=1  第21列=9  第22列=1  第23列=3  第24列=18  第25列=0  第26列=0  第27列=4',
      '   其余的场次如果截图没有，对应列全部写 无。',
      '10. 第78/79列 时间格式：2026/9/18 16:11（没有就写 无）。',
      '11. 联赛只能从这些里选：' + lg + '。',
      '12. 第80/81列（主队/客队近6场实际场次）如果截图能看到「近6场实际场次」或「场次」数字就填，看不到就写 无。',
      '',
      '【看不清怎么办】写 无，绝对不要编造数字。盘口数字（0.9 与 0.99、半球与一球）看错会毁掉整条数据。',
      '',
      '【输出示例（只输出这一行）】',
      '无,葡超,8,大阪钢巴,神户胜利船,无,0.5,0.5,1.04,1.03,无,无,无,无,无,无,无,无,' +
      '1,1,9,1,3,18,0,0,4,2,2,18,0,2,20,0,2,6,' +
      '2,2,4,0,1,6,1,0,9,2,0,3,3,1,18,2,1,3,' +
      '3,4,4,2,FALSE,16,4,下游,上游,' +
      '近3次对战1胜1平1负,阵容齐整或无影响缺阵,无停赛,间隔4-5天,深度一般,其他情况,争分,' +
      '近3次对战1胜1平1负,阵容齐整或无影响缺阵,无停赛,一周双赛(≤3天),深度一般,连续3场胜利,争分,' +
      '2026/9/18 16:11,2026/9/20 13:16,8,8'
    ].join('\n');
  }

  function pickImage() {
    U.pickFile('image/*', readImage);
  }
  function readImage(file) {
    if (!file || !/^image\//.test(file.type)) return U.toast('请选择图片文件', 'bad');
    if (file.size > 6 * 1024 * 1024) return U.toast('图片超过 6MB，请先压缩', 'bad');
    const fr = new FileReader();
    fr.onload = function () { S.img = fr.result; S.msg = ''; window.App.refresh(); };
    fr.readAsDataURL(file);
  }
  function pasteImage() {
    S.msgKind = ''; S.msg = '已开启粘贴：请按 Ctrl+V 粘贴截图。'; window.App.refresh();
    const h = function (e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          readImage(it.getAsFile());
          document.removeEventListener('paste', h);
          break;
        }
      }
    };
    document.addEventListener('paste', h);
    setTimeout(function () { document.removeEventListener('paste', h); }, 15000);
  }

  async function visionOCR() {
    const st = C.store.settings;
    let base = (st.apiBase || '').replace(/\/+$/, '');
    if (!base || !st.apiKey) { S.msgKind = 'bad'; S.msg = '请先填写 Base URL 与 API Key。'; window.App.refresh(); return; }
    const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
    S.msgKind = ''; S.msg = '正在把截图交给视觉模型识别…'; window.App.refresh();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.apiKey },
        body: JSON.stringify({
          model: st.visionModel || st.apiModel || 'gpt-4o-mini',
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: ocrPrompt() },
              { type: 'image_url', image_url: { url: S.img } }
            ]
          }]
        })
      });
      const t = await resp.text();
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + t.slice(0, 300));
      const j = JSON.parse(t);
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('返回结构异常');
      S.ocrResult = content;
      S.msgKind = 'ok';
      S.msg = '识别完成，请核对下面文本（模型也会看错，务必人工比对截图），确认后点「送去解析」。';
    } catch (e) {
      S.msgKind = 'bad';
      S.msg = '识别失败：' + U.esc(e.message) + '<br>若报跨域错误，请改用「生成识图 Prompt」方式。';
    }
    window.App.refresh();
  }

  function localOCR() {
    S.msgKind = 'warn';
    S.msg = '本地 Tesseract 识别需要 <code>vendor/tesseract/</code> 下的 worker 与 chi_sim 语言包（约 15MB）。' +
      '放好后刷新页面即可使用；未放置时请用前两种方式。';
    window.App.refresh();
  }

  /* ---------------- 使用说明 ---------------- */
  function panelGuide(host) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('生成录入 · 五个页签怎么用')]));
    const tbl = [
      {
        p: '<b>球员库</b>', cost: '完全免费', net: '离线可用', acc: '最高（就是你自己的表）',
        how: '上传 .xls / .xlsx / .csv（可多选）→ 选合并或替换 → 入库后逐格手改号码/姓名/位置/身价；也能新增联赛、新增球队、删除改错。出厂已预置六大联赛 ' +
          window.Players.leagues().length + ' 个联赛。'
      },
      {
        p: '<b>伤停量化</b>', cost: '完全免费', net: '离线可用', acc: '取决于你填的号码准不准',
        how: '一场比赛<b>主客两队并排录</b>，每队 3 组号码（①上一场首发 ②上一场替补 ③本场比赛伤停）。' +
          '③ 里每个号码后面可标 (是)/(否) 表示上一场有没有上场，标 (停) 表示本场停赛。' +
          '点计算 → 一次得到两队各三个文本标签 + 净影响 → 一键写进 ② 盘。'
      },
      {
        p: '<b>转会窗口</b>', cost: '完全免费', net: '离线可用', acc: '官方日期，可自己改',
        how: '英超/西甲/意甲/德甲/法甲的夏窗与冬窗日期 + 倒计时。窗口临近自动高亮提醒。可增删联赛。'
      },
      { p: 'B-1 · 识图 Prompt + 网页 AI', cost: '免费（用你已有的 AI 网页额度）', net: '需联网', acc: '较高（视觉模型偶尔认错队名/数字）', how: '复制 Prompt → 连同截图发给 AI → 把它回的那段贴进「截图识别」，点「解析并送入单场录入」' },
      { p: 'B-2 · 视觉模型直连（填 Key）', cost: '按 token 计费，一次约几分钱', net: '需联网', acc: '较高', how: '填 Base URL / Key / 视觉模型 → 拖入截图 → 一键识别' },
      { p: 'B-3 · 本地 Tesseract', cost: '免费', net: '离线可用', acc: '中（需要自己放约 15MB 语言包）', how: '把 Tesseract.js 放到 vendor/tesseract/' },
    ];
    c.appendChild(U.el('div', { html: U.table([
      { k: 'p', n: '页签 / 路径', w: '200px' }, { k: 'cost', n: '要不要花钱', w: '170px' },
      { k: 'net', n: '联网', w: '90px' }, { k: 'acc', n: '准确率', w: '220px' }, { k: 'how', n: '怎么用', w: '340px' }
    ], tbl) }));

    c.appendChild(U.el('div', { class: 'sec-title', text: '推荐的日常流程' }));
    const tips = U.el('ul', { style: { paddingLeft: '20px', fontSize: '12.6px', color: 'var(--txt-2)', lineHeight: '1.95' } });
    [
      '<b>第一次用</b>：先去「球员库」把你的球员信息表传进来（六大联赛一次全传也行）。传完逐格核对，号码错了就改 —— 后面所有伤停计算都认号码。',
      '<b>每场比赛</b>：让别的 AI 识别截图拿到号码 → 填进「伤停量化」→ 计算 → 一键写进「批量计算 → ② 单场录入」的②盘。' +
      '这样伤停三件套（伤病修正 / 阵容深度 / 停赛修正）就是客观算出来的，不再靠手感填。',
      '<b>排列组合前</b>：看一眼「转会窗口」。窗口关着的时候不会有真实新援，看到「新援」标记就该怀疑数据。',
      '不管走哪条路径，<b>入库前都建议先去「批量计算 → ② 单场录入」核一遍</b> —— 右侧会实时显示本心实力盘 / 场景 / 仲裁 / 推荐方向 / 评分，一眼就能看出有没有录错。',
      '想批量搬运，用「导出 / 导入」：那边支持 CSV / XLSX，也支持整站 JSON 备份。',
    ].forEach(function (t) { tips.appendChild(U.el('li', { html: t })); });
    c.appendChild(tips);
    host.appendChild(c);
  }

  window.App.register({
    id: 'entry', title: '生成录入', icon: '⌸', group: '录入',
    desc: '球员库（上传/编辑球员信息表 + 转会窗口提醒）· 伤停量化（自动算伤病/深度/停赛三个文本标签）· B 截图识别。',
    render: function (host) {
      const chips = U.el('div', { class: 'chips', style: { marginBottom: '12px' } });
      [['players', '球员库'], ['injury', '伤停量化'], ['window', '转会窗口'],
      ['ocr', 'B · 截图识别'], ['guide', '使用说明']].forEach(function (t) {
        const c = U.el('span', { class: 'chip' + (S.tab === t[0] ? ' on' : ''), text: t[1] });
        c.addEventListener('click', function () { S.tab = t[0]; window.App.refresh(); });
        chips.appendChild(c);
      });
      host.appendChild(chips);
      if (S.tab === 'players') { window.Players.setTab('lib'); window.Players.renderLib(host); }
      else if (S.tab === 'injury') { window.Players.setTab('inj'); window.Players.renderInj(host); }
      else if (S.tab === 'window') { window.Players.setTab('win'); window.Players.renderWin(host); }
      else if (S.tab === 'ocr') panelOCR(host);
      else panelGuide(host);
    }
  });

  window.Entry = window.Entry || {};
  window.Entry.parseSmart = parseSmart;
  window.Entry.toCommaLine = toCommaLine;
  window.Entry.toFullRow = toFullRow;
  window.Entry.detectInputKind = detectInputKind;
  window.Entry.ocrPrompt = ocrPrompt;
  window.Entry.STANDARD_SAMPLE = STANDARD_SAMPLE;
  window.Entry.getRows = function () { return (C.store.rows || []).map(function (r) { return r.inp; }); };
  window.Entry.__setTab = function (t) { if (['players', 'injury', 'window', 'ocr', 'guide'].indexOf(t) >= 0) S.tab = t; };
})();
