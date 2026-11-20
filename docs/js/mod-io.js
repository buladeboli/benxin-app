/* =========================================================================
 * mod-io.js — 导入 / 跨电脑迁移
 *   支持把「导出」出来的文件读回来重建记录：
 *     · .json  整站备份（记录 + 参数 + 映射表）—— 无损
 *     · .json  表格导出（含参数快照）
 *     · .csv   表格导出
 *     · .xlsx  Excel（本工具导出的、或用 Excel 另存过的都能读）
 *     · .xls   本工具导出的 HTML 表格
 *   冲突处理：跳过 / 覆盖 / 都保留
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;

  /* ================= 1. 解压：ZIP（XLSX 用） ================= */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** 解析 ZIP 的中央目录，返回 {name: {method, dataOffset, compSize, size}} */
  function zipEntries(u8) {
    let eocd = -1;
    const from = Math.max(0, u8.length - 66000);
    for (let i = u8.length - 22; i >= from; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是合法的 ZIP/XLSX 文件（找不到目录结尾）');
    const count = u16(u8, eocd + 10);
    let p = u32(u8, eocd + 16);
    const out = {};
    for (let i = 0; i < count; i++) {
      if (u32(u8, p) !== 0x02014b50) break;
      const method = u16(u8, p + 10);
      const compSize = u32(u8, p + 20);
      const size = u32(u8, p + 24);
      const nameLen = u16(u8, p + 28);
      const extraLen = u16(u8, p + 30);
      const cmtLen = u16(u8, p + 32);
      const localOff = u32(u8, p + 42);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
      // 本地头里的 nameLen/extraLen 可能与中央目录不同，必须按本地头取
      const lNameLen = u16(u8, localOff + 26);
      const lExtraLen = u16(u8, localOff + 28);
      out[name] = { method: method, dataOffset: localOff + 30 + lNameLen + lExtraLen, compSize: compSize, size: size };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  async function rawInflate(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压（DecompressionStream 不可用）。请改用 CSV 导入，或换 Chrome / Edge 新版本。');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function zipRead(u8, name) {
    const list = zipEntries(u8);
    const e = list[name];
    if (!e) return null;
    const raw = u8.subarray(e.dataOffset, e.dataOffset + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return await rawInflate(raw);
    throw new Error('ZIP 用了不支持的压缩方式 ' + e.method);
  }

  /* ================= 2. 解析 XLSX ================= */
  function xmlUnesc(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&amp;/g, '&');
  }
  function colIdx(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }
  function xmlText(inner) {
    let s = '', m;
    const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
    while ((m = re.exec(inner)) !== null) s += m[1];
    return xmlUnesc(s);
  }

  async function parseXLSX(u8) {
    const sharedXml = await zipRead(u8, 'xl/sharedStrings.xml');
    const shared = [];
    if (sharedXml) {
      const sd = new TextDecoder('utf-8').decode(sharedXml);
      let m;
      const re = /<si>([\s\S]*?)<\/si>/g;
      while ((m = re.exec(sd)) !== null) shared.push(xmlText(m[1]));
    }
    // 优先找名字像记录表的那个工作表
    let sheetPath = null, sheetName = '';
    const wbXml = await zipRead(u8, 'xl/workbook.xml');
    const relXml = await zipRead(u8, 'xl/_rels/workbook.xml.rels');
    if (wbXml && relXml) {
      const wb = new TextDecoder('utf-8').decode(wbXml);
      const rels = {};
      let m;
      const rre = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
      while ((m = rre.exec(new TextDecoder('utf-8').decode(relXml))) !== null) rels[m[1]] = m[2];
      const sheets = [];
      const sre = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
      while ((m = sre.exec(wb)) !== null) sheets.push({ name: xmlUnesc(m[1]), id: m[2] });
      const pick = sheets.filter(function (s) { return /记录|导出|明细|数据/.test(s.name); })[0] || sheets[0];
      if (pick && rels[pick.id]) {
        sheetPath = 'xl/' + rels[pick.id].replace(/^\/?xl\//, '').replace(/^\//, '');
        sheetName = pick.name;
      }
    }
    if (!sheetPath) sheetPath = 'xl/worksheets/sheet1.xml';
    let sxml = await zipRead(u8, sheetPath);
    if (!sxml) sxml = await zipRead(u8, 'xl/worksheets/sheet1.xml');
    if (!sxml) throw new Error('XLSX 里找不到工作表');

    const xml = new TextDecoder('utf-8').decode(sxml);
    const grid = [];
    let rm;
    const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    while ((rm = rowRe.exec(xml)) !== null) {
      const rIdx = parseInt(rm[1], 10) - 1;
      const line = grid[rIdx] = grid[rIdx] || [];
      const body = rm[2];
      let cm;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      while ((cm = cellRe.exec(body)) !== null) {
        const attrs = cm[1] || '', inner = cm[2] || '';
        const rf = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
        if (!rf) continue;
        const ci = colIdx(rf);
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        let val = '';
        if (t === 's') {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          val = shared[parseInt(v, 10)] || '';
        } else if (t === 'inlineStr') val = xmlText(inner);
        else if (t === 'str') val = xmlText(inner);
        else if (t === 'b') val = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] === '1' ? 'TRUE' : '';
        else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          val = v === undefined ? '' : v;
        }
        line[ci] = val;
      }
    }
    const table = grid.filter(function (r) { return r && r.length; }).map(function (r) {
      const out = [];
      for (let i = 0; i < r.length; i++) out[i] = r[i] === undefined ? '' : r[i];
      return out;
    });
    return { name: sheetName, rows: table };
  }

  /* ================= 3. 解析 CSV / HTML 表格 ================= */
  function parseCSVTable(text) {
    return { name: 'CSV', rows: U.parseCSV(text) };
  }
  function parseHTMLTable(text) {
    const doc = new DOMParser().parseFromString(String(text), 'text/html');
    const tb = doc.querySelector('table');
    if (!tb) throw new Error('文件里找不到表格');
    const rows = [];
    Array.prototype.forEach.call(tb.querySelectorAll('tr'), function (tr) {
      const cells = [];
      Array.prototype.forEach.call(tr.children, function (td) {
        cells.push((td.textContent || '').trim());
      });
      if (cells.length) rows.push(cells);
    });
    return { name: 'HTML表格', rows: rows };
  }

  /* ================= 4. 表格 → 记录输入 ================= */
  /** 用表头名映射；若表头缺失/认不出，退回按位置顺序匹配 */
  function tableToInputs(table) {
    const rows = table.rows;
    if (!rows.length) return { inps: [], report: { mode: '空文件', header: [], skippedUnknown: 0 } };
    const first = rows[0].map(function (x) { return String(x == null ? '' : x).trim(); });
    const known = {};
    first.forEach(function (h, i) { if (h && (h in C.H2F || C.INPUT_FIELDS.some(function (f) { return f.n === h; }))) known[h] = i; });
    const byName = Object.keys(known).length >= 12;   // 表头可信
    const inps = [], ignored = {};
    let skippedUnknown = 0;
    // 记录必须有一个「认识的联赛」；统计块 / 汇总行会被这条规则挡掉
    const okLeague = function (inp) { return inp.league && C.store.LIB.leagues[inp.league]; };
    if (byName) {
      for (let r = 1; r < rows.length; r++) {
        const map = {};
        first.forEach(function (h, i) { if (h) map[h] = rows[r][i] === undefined ? '' : rows[r][i]; });
        if (!objectHasData(map)) continue;
        const res = C.inpFromRowMap(map);
        Object.keys(res.ignored).forEach(function (k) { ignored[k] = 1; });
        if (!Object.keys(res.inp).length) continue;
        if (!okLeague(res.inp)) { skippedUnknown++; continue; }
        inps.push(res.inp);
      }
      return {
        inps: inps, report: {
          mode: '按表头名匹配（' + Object.keys(known).length + ' 个表头）', header: first,
          ignored: Object.keys(ignored), skippedUnknown: skippedUnknown
        }
      };
    }
    // 位置匹配
    let start = 0;
    const asNum = first.filter(function (s) { return /^\d+$/.test(s); }).length;
    if (asNum >= first.length - 1 && first.length > 10) start = 1;   // 首行大概是表头
    for (let r = start; r < rows.length; r++) {
      const inp = {}; let filled = 0;
      C.INPUT_FIELDS.forEach(function (f, i) {
        if (C.PLACEHOLDER_INPUT.indexOf(f.k) >= 0) return;
        const res = C.coerceField(f.k, rows[r][i]);
        if (!res.skip) { inp[f.k] = res.v; filled++; }
      });
      if (!filled) continue;
      if (!okLeague(inp)) { skippedUnknown++; continue; }
      inps.push(inp);
    }
    return {
      inps: inps, report: {
        mode: '按列位置匹配（未识别到表头）', header: [], skippedUnknown: skippedUnknown
      }
    };
  }
  function objectHasData(o) {
    for (const k in o) { const v = String(o[k] == null ? '' : o[k]).trim(); if (v !== '') return true; }
    return false;
  }

  /* ================= 5. 读取文件 ================= */
  function readAsText(file) {
    return new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }
  function readAsBytes(file) {
    return new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (ext === 'json') {
      return { kind: 'json', json: JSON.parse(await readAsText(file)) };
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      const table = await parseXLSX(await readAsBytes(file));
      return { kind: 'table', table: table };
    }
    if (ext === 'xls') {
      const text = await readAsText(file);
      if (/^\s*(?:\ufeff)?\s*</.test(text)) return { kind: 'table', table: parseHTMLTable(text) };
      return { kind: 'table', table: parseCSVTable(text) };
    }
    const text = await readAsText(file);
    if (/^\s*(?:\ufeff)?\s*</.test(text)) return { kind: 'table', table: parseHTMLTable(text) };
    return { kind: 'table', table: parseCSVTable(text) };
  }

  /* ================= 6. 导入执行 ================= */
  const S = { pending: null, msg: '', msgKind: '', conflict: 'skip', applyParams: false, lastReport: '' };

  function existingKeys() {
    const m = {};
    C.store.rows.forEach(function (r) {
      const i = r.inp || {};
      m[keyOf(i)] = r;
    });
    return m;
  }
  function keyOf(i) {
    return [i.league || '', i.round === undefined ? '' : i.round, i.home || '', i.away || ''].join('|');
  }

  function analyse(inps) {
    const ex = existingKeys();
    let dup = 0, bad = 0;
    inps.forEach(function (i) {
      if (ex[keyOf(i)]) dup++;
      if (!i.league) bad++;
    });
    return { total: inps.length, dup: dup, bad: bad };
  }

  function doImport(inps, mode) {
    const ex = existingKeys();
    let added = 0, replaced = 0, skipped = 0;
    inps.forEach(function (inp) {
      const k = keyOf(inp);
      const hit = ex[k];
      if (hit) {
        if (mode === 'skip') { skipped++; return; }
        if (mode === 'replace') {
          const idx = C.store.rows.indexOf(hit);
          if (idx >= 0) {
            const merged = Object.assign({}, hit.inp, inp);
            C.store.rows[idx].inp = merged;
            C.store.rows[idx].note = merged.note || C.store.rows[idx].note;
            replaced++;
            return;
          }
        }
        // keep：都保留
      }
      const clean = {};
      for (const f in inp) if (inp[f] !== '' && inp[f] !== undefined && inp[f] !== null) clean[f] = inp[f];
      const rec = C.newRecord(clean);
      rec.note = clean.note || ('导入 ' + new Date().toLocaleString());
      C.store.rows.push(rec);
      added++;
    });
    C.saveRows();
    return { added: added, replaced: replaced, skipped: skipped };
  }

  /* ================= 7. UI ================= */
  function card(host) {
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('导入 / 换电脑迁移'),
      U.el('span', { class: 'hint', text: '把导出的文件读回来' })]));
    c.appendChild(U.el('p', { class: 'desc', html:
      '数据保存在<b>本机浏览器</b>里，所以换电脑必须靠导出 + 导入来搬。拖下面的框，或点它选文件。' }));
    c.appendChild(U.el('div', { html: U.table([
      { k: 'way', n: '文件类型', w: '190px' }, { k: 'what', n: '能搬什么', w: '330px' }, { k: 'how', n: '说明', w: '330px' },
    ], [
      {
        way: '<b>JSON 备份</b><br><span class="pill ok">换电脑用这个</span>',
        what: '记录 + <b>全部参数</b> + 映射表 + 调参历史。导回来一模一样。',
        how: '整站覆盖导入。'
      },
      {
        way: '<b>表格文件</b><br><span class="pill info">只搬记录</span>',
        what: '只有比赛记录（含赛果）。参数不会跟过来，需要单独在「调参中心」导出/导入。',
        how: '支持 .csv / .xlsx / .xls / .txt，可按列名或按位置匹配。'
      },
    ]) }));
    c.appendChild(U.note('用本工具导出的 CSV / XLSX 再导回来是<b>无损</b>的（引擎算出来的列会被忽略并重算，输入列照抄）。', ''));

    // 拖放区
    const dz = U.el('div', {
      style: {
        marginTop: '12px', border: '1px dashed var(--line-2)', borderRadius: '10px', padding: '22px',
        textAlign: 'center', color: 'var(--txt-3)', fontSize: '12.5px', cursor: 'pointer'
      },
      html: '把文件拖到这里，或点击选择<br><span class="mini">支持 .json（备份/导出）· .csv · .xlsx · .xls · .txt</span>'
    });
    dz.addEventListener('click', function () { pick(); });
    dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.style.borderColor = 'var(--acc)'; });
    dz.addEventListener('dragleave', function () { dz.style.borderColor = 'var(--line-2)'; });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); dz.style.borderColor = 'var(--line-2)';
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f);
    });
    c.appendChild(dz);

    if (S.msg) c.appendChild(U.note(S.msg, S.msgKind));

    if (S.pending) {
      const P = S.pending;
      const a = analyse(P.inps);
      c.appendChild(U.el('div', { class: 'sec-title', text: '导入预览' }));
      const g = U.el('div', { class: 'grid g4' });
      [['来源文件', P.fileName], ['格式', P.kindText], ['识别到比赛', a.total + ' 场'],
      ['与现有重复', a.dup + ' 场'], ['缺联赛', a.bad + ' 场'],
      ['忽略的行', (P.report.skippedUnknown || 0) + ' 行'], ['匹配方式', P.report.mode]].forEach(function (t) {
        const b = U.el('div', { class: 'kpi', style: { padding: '9px 11px' } });
        b.appendChild(U.el('div', { class: 'v', style: { fontSize: '14px', whiteSpace: 'normal', wordBreak: 'break-all' }, text: String(t[1]) }));
        b.appendChild(U.el('div', { class: 'l', text: t[0] }));
        g.appendChild(b);
      });
      c.appendChild(g);

      if (P.report.ignored && P.report.ignored.length) {
        c.appendChild(U.note('已忽略这些「引擎算出来」的列（导入后会自动重算，不需要你填）：<br><code>' +
          P.report.ignored.slice(0, 14).map(U.esc).join('</code> <code>') + '</code>' +
          (P.report.ignored.length > 14 ? ' …' : ''), ''));
      }

      c.appendChild(U.el('div', { class: 'sec-title', text: '重复记录怎么处理（重复 = 联赛+轮次+主队+客队 相同）' }));
      const chips = U.el('div', { class: 'chips' });
      [['skip', '跳过重复（只补新的）'], ['replace', '覆盖已有（用导入的）'], ['keep', '都保留（可能重复）']].forEach(function (t) {
        const ch = U.el('span', { class: 'chip' + (S.conflict === t[0] ? ' on' : ''), text: t[1] });
        ch.addEventListener('click', function () { S.conflict = t[0]; window.App.refresh(); });
        chips.appendChild(ch);
      });
      c.appendChild(chips);

      // 参数快照（只有 JSON 导出里才有）
      if (P.params) {
        const pw = U.el('div', { style: { marginTop: '10px' } });
        const pc = U.el('input', { type: 'checkbox', style: { width: 'auto' } });
        pc.checked = !!S.applyParams;
        pc.addEventListener('change', function () { S.applyParams = pc.checked; });
        const pl = U.el('label', { class: 'flexline', style: { fontSize: '12.5px', color: 'var(--txt-2)', gap: '6px' } });
        pl.appendChild(pc);
        pl.appendChild(U.el('span', { html: '同时应用文件里的<b>参数快照</b>（' + Object.keys(P.params).length + ' 项' +
          (P.lib ? ' + 映射表' : '') + '）—— 会把当前「调参中心」的参数覆盖掉，默认不勾。' }));
        pw.appendChild(pl);
        c.appendChild(pw);
      }

      const t2 = U.el('div', { class: 'tw', style: { marginTop: '10px', maxHeight: '300px' } });
      let h = '<table><thead><tr><th>#</th><th>联赛</th><th>轮次</th><th>对阵</th><th>初盘</th><th>近6场场次</th><th>比分</th><th>重复?</th></tr></thead><tbody>';
      const ex = existingKeys();
      P.inps.slice(0, 200).forEach(function (i, k) {
        const isDup = !!ex[keyOf(i)];
        h += '<tr><td>' + (k + 1) + '</td><td>' + U.esc(i.league || '—') + '</td><td>' + U.esc(i.round === undefined ? '' : i.round) +
          '</td><td>' + U.esc((i.home || '?') + ' vs ' + (i.away || '?')) + '</td><td>' + U.esc(i.open === undefined ? '' : i.open) +
          '</td><td>' + U.esc((i.hADGames === undefined ? '—' : i.hADGames) + ' / ' + (i.aADGames === undefined ? '—' : i.aADGames)) +
          '</td><td>' + U.esc(i.scoreText || '') + '</td><td>' + (isDup ? U.pill('重复', 'warn') : U.pill('新', 'ok')) + '</td></tr>';
      });
      h += '</tbody></table>';
      t2.innerHTML = h;
      c.appendChild(t2);
      if (P.inps.length > 200) c.appendChild(U.el('div', { class: 'mini', text: '（只预览前 200 条，共 ' + P.inps.length + ' 条）' }));

      const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });
      row.appendChild(U.btn('✔ 确认导入 ' + P.inps.length + ' 场', function () {
        const r = doImport(P.inps, S.conflict);
        let extra = '';
        if (P.params && S.applyParams) {
          let n = 0;
          for (const k in P.params) if (k in C.store.P) { C.store.P[k] = P.params[k]; n++; }
          if (P.lib) for (const k in P.lib) C.store.LIB[k] = P.lib[k];
          C.saveParams(); C.saveLib();
          extra = ' 同时应用了 <b>' + n + '</b> 项参数' + (P.lib ? ' 与映射表' : '') + '。';
        }
        S.pending = null;
        S.msgKind = 'ok';
        S.msg = '导入完成：新增 <b>' + r.added + '</b> 条，覆盖 <b>' + r.replaced + '</b> 条，跳过 <b>' + r.skipped + '</b> 条。' +
          extra + ' 当前共 ' + C.store.rows.length + ' 条记录。';
        U.toast('导入完成：+' + r.added + ' / 覆盖 ' + r.replaced + ' / 跳过 ' + r.skipped, 'ok');
        window.App.refresh(); window.App.updateFoot();
      }, 'pri'));
      row.appendChild(U.btn('取消', function () { S.pending = null; S.msg = ''; window.App.refresh(); }, 'ghost'));
      c.appendChild(row);
    }
    host.appendChild(c);
  }

  function pick() {
    U.pickFile('.json,.csv,.xlsx,.xls,.xlsm,.txt,application/json,text/csv', function (f) { handle(f); });
  }

  async function handle(file) {
    S.msg = '正在读取 ' + U.esc(file.name) + ' …'; S.msgKind = ''; S.pending = null;
    window.App.refresh();
    try {
      const res = await readFile(file);
      if (res.kind === 'json') {
        const o = res.json;
        if (!o || typeof o !== 'object') throw new Error('JSON 内容不是对象');
        // 形态一：整站备份 / 表格导出
        if (Array.isArray(o.rows) && o.rows.length && (o.rows[0]['联赛'] !== undefined || o.rows[0].league !== undefined)) {
          const inps = rowsToInputs(o.rows);
          S.pending = {
            inps: inps, fileName: file.name, kindText: 'JSON（含参数快照）',
            report: { mode: '按 JSON 字段名', ignored: [], skippedUnknown: 0 },
            params: o.params || null, lib: o.lib || null,
          };
          S.msgKind = 'ok';
          S.msg = '识别为<b>整站导出/备份</b>：' + inps.length + ' 条记录' +
            (o.params ? '，含参数快照（' + Object.keys(o.params).length + ' 项）。' : '。') +
            '默认只导入记录；想连参数一起搬，勾上下面的复选框，或用上面的「从备份恢复」（那个连调参历史一起还原）。';
        } else if (Array.isArray(o)) {
          S.pending = { inps: rowsToInputs(o), fileName: file.name, kindText: 'JSON 数组', report: { mode: '按 JSON 字段名', ignored: [], skippedUnknown: 0 } };
          S.msgKind = 'ok'; S.msg = '识别为 JSON 数组：' + S.pending.inps.length + ' 条记录。';
        } else {
          throw new Error('认不出这个 JSON 的结构（既没有 rows，也不是数组）');
        }
      } else {
        const t = tableToInputs(res.table);
        if (!t.inps.length) throw new Error('没有解析到任何有效比赛记录');
        S.pending = { inps: t.inps, fileName: file.name, kindText: '表格（' + res.table.name + '）', report: t.report };
        S.msgKind = 'ok';
        S.msg = '读取成功。请核对下面的预览，选好重复处理方式，再点「确认导入」。';
      }
      window.__pendingParams = null;
    } catch (e) {
      S.msgKind = 'bad';
      S.msg = '读取失败：' + U.esc(e.message) +
        '<br><span class="mini">支持 .json（本工具导出/备份）· .csv · .xlsx · .xls · .txt</span>';
    }
    window.App.refresh();
  }

  function rowsToInputs(rows) {
    // rows 可能是「表头→值」的对象（本工具导出），也可能是输入对象
    return rows.map(function (o) {
      if (o && (o.league !== undefined || o.home !== undefined) && o['联赛'] === undefined) {
        const inp = {};
        C.INPUT_FIELDS.forEach(function (f) {
          if (C.PLACEHOLDER_INPUT.indexOf(f.k) >= 0) return;
          const r = C.coerceField(f.k, o[f.k]);
          if (!r.skip) inp[f.k] = r.v;
        });
        return inp;
      }
      const res = C.inpFromRowMap(o || {});
      // 附加上工具列
      if (o && o['主队近6场实际场次'] !== undefined) {
        const r1 = C.coerceField('hADGames', o['主队近6场实际场次']); if (!r1.skip) res.inp.hADGames = r1.v;
      }
      if (o && o['客队近6场实际场次'] !== undefined) {
        const r2 = C.coerceField('aADGames', o['客队近6场实际场次']); if (!r2.skip) res.inp.aADGames = r2.v;
      }
      return res.inp;
    }).filter(function (x) { return Object.keys(x).length; });
  }

  window.ImportKit = {
    card: card, readFile: readFile, tableToInputs: tableToInputs, rowsToInputs: rowsToInputs,
    doImport: doImport, parseXLSX: parseXLSX, parseCSVTable: parseCSVTable, parseHTMLTable: parseHTMLTable,
    zipEntries: zipEntries, zipRead: zipRead, keyOf: keyOf, analyse: analyse,
    state: S,
  };
})();
