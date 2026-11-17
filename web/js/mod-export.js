/* =========================================================================
 * mod-export.js — 模块 ⑦ 导出
 *   把记录库导出成几种可用的格式：
 *     · 精简表（SUMMARY_HEADERS，一行一场，给人看/给 Excel 用）
 *     · 完整明细（ALL_HEADERS，含每场输入与全部中间量，可无损回导）
 *     · 统计块（按场景/水位/仲裁… 分组的投注盈利）
 *     · 分组分析（Wilson 区间 + 置信度）
 *     · JSON 备份（含参数与映射表快照，换电脑用）
 *   格式：CSV(UTF-8 BOM) / XLSX(纯手写 OOXML，不联网) / HTML(.xls，带颜色) / JSON
 * ========================================================================= */
(function () {
  'use strict';
  const C = window.Core, U = window.UI;
  /** scope: 'summary'（精简）| 'full'（完整明细） */
  const S = { scope: 'full' };

  function headersOf(scope) {
    return (scope || S.scope) === 'summary' ? C.SUMMARY_HEADERS : C.ALL_HEADERS;
  }

  function stamp() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function allResults() { return C.store.rows.map(function (rec, i) { return { rec: rec, r: C.evaluate(rec.inp), i: i }; }); }

  /** 记录 → 输出行；scope = 'summary' 走精简列，否则走完整列（含逐行统计块） */
  function outRows(rs, scope) {
    const recs = (rs && rs.length ? rs : C.store.rows.map(function (r) { return { rec: r }; }))
      .map(function (x) { return x.rec; });
    if ((scope || S.scope) === 'summary') return recs.map(function (rec) { return C.recordToSummary(rec); });
    const sm = C.computeStats(recs, C.store.P, C.store.LIB);
    return recs.map(function (rec) { return C.recordToRow(rec, sm); });
  }
  /** 兼容旧名 */
  function fullRows(rs) { return outRows(rs, 'full'); }

  /**
   * 统计块（v12 改成「投注盈利」口径，5 列）：
   *   统计分类 / 统计项 / 场次 / 投注盈利场次 / 投注盈利概率
   * 「投注盈利」= 按该场景的方向下注（上盘或下盘，看场景名指向）并且赢盘。
   * 维度额外加了「场景合计」与「全部合计」，对应 v12 表格里的『场景合计』行。
   */
  const STAT_KEYS = ['统计分类', '统计项', '场次', '投注盈利场次', '投注盈利概率'];
  function statBlocks(rs) {
    const rows = [];
    const hitOf = function (x) {
      const d = C.sideOf(x.r, C.store.LIB).dir;
      if (d !== 'up' && d !== 'down') return null;
      if (x.r.actual !== '赢盘' && x.r.actual !== '输盘') return null;
      const upWin = x.r.actual === '赢盘';
      return d === 'up' ? upWin : !upWin;
    };
    const add = function (cat, key, list) {
      const d = list.filter(function (x) { return hitOf(x) !== null; });
      const w = d.filter(function (x) { return hitOf(x) === true; }).length;
      const o = {};
      STAT_KEYS.forEach(function (h) { o[h] = ''; });
      o['统计分类'] = cat; o['统计项'] = key;
      o['场次'] = list.length;
      o['投注盈利场次'] = w;
      o['投注盈利概率'] = d.length ? w / d.length : '';
      return o;
    };
    const dims = [
      ['场景', function (x) { return x.r.scene; }],
      ['深浅开', function (x) { return x.r.Q; }],
      ['水位', function (x) { return x.r.water; }],
      ['变动幅度', function (x) { return x.r.move; }],
      ['仲裁', function (x) { return x.r.arb; }],
      ['强度', function (x) { return x.r.strength; }],
      ['联赛', function (x) { return x.rec.inp.league || '未知'; }],
      ['模型置信度', function (x) {
        const c = C.confidence(x.r, C.statAgg || C.groupRates(C.store.rows, C.store.P, C.store.LIB), C.store.P);
        return c.band;
      }],
    ];
    dims.forEach(function (d) {
      const map = {};
      rs.forEach(function (x) { const k = String(d[1](x)); (map[k] = map[k] || []).push(x); });
      const keys = Object.keys(map).sort();
      // 场景维度额外插一行「场景合计」（对应 v12 表格）
      if (d[0] === '场景') {
        const sub = {};
        keys.forEach(function (k) { sub[k] = add('场景', k, map[k]); });
        // 只汇总「按场景方向可下注」的场次
        const merge = function (pred) {
          const arr = [];
          keys.forEach(function (k) { if (pred(k)) arr.push(sub[k]); });
          return arr;
        };
        const tot = function (arr) {
          const o = {};
          STAT_KEYS.forEach(function (h) { o[h] = ''; });
          o['统计分类'] = '场景'; o['统计项'] = '场景合计';
          let n = 0, w = 0, dn = 0;
          arr.forEach(function (o2) {
            n += (Number(o2['场次']) || 0);
            w += (Number(o2['投注盈利场次']) || 0);
            if (o2['投注盈利概率'] !== '') dn += (Number(o2['场次']) || 0);
          });
          o['场次'] = n; o['投注盈利场次'] = w;
          o['投注盈利概率'] = dn ? w / dn : '';
          return o;
        };
        const all = merge(function () { return true; });
        keys.forEach(function (k) { rows.push(sub[k]); });
        rows.push(tot(all));
      } else {
        keys.forEach(function (k) { rows.push(add(d[0], k, map[k])); });
      }
    });
    // 全部合计
    const g = add('全部', '全部合计', rs);
    rows.push(g);
    return rows;
  }

  /* -------- CSV -------- */
  function exportCSV(rs, scope) {
    rs = rs || allResults();
    scope = scope || S.scope;
    const HD = headersOf(scope);
    const rows = outRows(rs, scope);
    const lines = [];
    lines.push(HD.map(q).join(','));
    rows.forEach(function (o) { lines.push(HD.map(function (h) { return q(o[h]); }).join(',')); });
    if (scope !== 'summary') {
      // 空行 + 统计块（列位对齐到统计列，回导时不会被误当成记录行）
      const stats = statBlocks(rs);
      lines.push('');
      const statStart = C.RECORD_HEADERS.length + C.MATCH_HEADERS.length + C.VERDICT_HEADERS.length;
      const zero = [];
      for (let i = 0; i < HD.length; i++) zero[i] = '';
      stats.forEach(function (o) {
        const arr = zero.slice();
        C.STAT_HEADERS.forEach(function (h, i) { arr[statStart + i] = o[h] === undefined ? '' : o[h]; });
        lines.push(arr.map(q).join(','));
      });
    }
    U.download('记录导出_' + stamp() + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    U.toast('已导出 CSV（' + rows.length + ' 场 · ' + HD.length + ' 列）', 'ok');
  }
  function q(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* -------- 纯手写 XLSX -------- */
  function colName(n) { // 1 -> A
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function xmlEsc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  /** sheets: [{name, rows:[[...]]}] */
  function buildXLSX(sheets) {
    const files = {};
    files['[Content_Types].xml'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>';
    files['_rels/.rels'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    files['xl/workbook.xml'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map(function (s, i) {
        return '<sheet name="' + xmlEsc(s.name).slice(0, 31) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets></workbook>';
    files['xl/_rels/workbook.xml.rels'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';
    files['xl/styles.xml'] =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3B57"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    sheets.forEach(function (s, si) {
      const rows = s.rows;
      const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetPr/><dimension ref="A1:' + colName(Math.max(1, (rows[0] || []).length)) + Math.max(1, rows.length) + '"/>' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="14.5"/><sheetData>'];
      rows.forEach(function (row, ri) {
        parts.push('<row r="' + (ri + 1) + '">');
        row.forEach(function (v, ci) {
          const ref = colName(ci + 1) + (ri + 1);
          const st = ri === 0 ? ' s="1"' : '';
          if (v === null || v === undefined || v === '') { parts.push('<c r="' + ref + '"' + st + '/>'); return; }
          if (typeof v === 'number' && isFinite(v)) parts.push('<c r="' + ref + '"' + st + '><v>' + v + '</v></c>');
          else parts.push('<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>');
        });
        parts.push('</row>');
      });
      parts.push('</sheetData><autoFilter ref="A1:' + colName(Math.max(1, (rows[0] || []).length)) + Math.max(1, rows.length) + '"/></worksheet>');
      files['xl/worksheets/sheet' + (si + 1) + '.xml'] = parts.join('');
    });
    return zipStore(files);
  }

  /* 最小 ZIP（store，无压缩）+ CRC32 */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
    const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    Object.keys(files).forEach(function (name) {
      const data = enc.encode(files[name]);
      const nameB = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameB.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameB.length, true); lv.setUint16(28, 0, true);
      local.set(nameB, 30);
      chunks.push(local); chunks.push(data);
      const cen = new Uint8Array(46 + nameB.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameB.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameB, 46);
      central.push(cen);
      offset += local.length + data.length;
    });
    let cenSize = 0; central.forEach(function (c) { cenSize += c.length; });
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    const all = chunks.concat(central, [end]);
    let total = 0; all.forEach(function (c) { total += c.length; });
    const out = new Uint8Array(total);
    let p = 0; all.forEach(function (c) { out.set(c, p); p += c.length; });
    if (window.Export && window.Export.__captureBytes) { try { window.Export.__captureBytes(out); } catch (e) { } }
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /**
   * 组装 XLSX 的三个工作表（不下载，纯数据）—— 自检直接调它，能抓到「某个字段/函数不存在」这类错。
   * 返回 [{ name, rows }]
   */
  function buildSheets(rs, scope) {
    rs = rs || allResults();
    scope = scope || S.scope;
    const headers = headersOf(scope);
    const rows = outRows(rs, scope);
    const sheet1 = [headers].concat(rows.map(function (o) { return headers.map(function (h) { return o[h]; }); }));

    const stats = statBlocks(rs);
    const sheet2 = [C.STAT_HEADERS].concat(stats.map(function (o) { return C.STAT_HEADERS.map(function (h) { return o[h]; }); }));

    const sheet3 = [['维度', '取值', '场次', '已开奖', '上盘赢', '上盘赢盘率',
      'Wilson下界', 'Wilson上界', '超保本线', '平均置信度']];
    const agg3 = C.groupRates(C.store.rows, C.store.P, C.store.LIB);
    dimensions().forEach(function (d) {
      const map = {};
      rs.forEach(function (x) { const k = String(d.f(x)); (map[k] = map[k] || []).push(x); });
      Object.keys(map).forEach(function (k) {
        const arr = map[k];
        const dec = arr.filter(function (x) { return x.r.actual === '赢盘' || x.r.actual === '输盘'; });
        const w = dec.filter(function (x) { return x.r.actual === '赢盘'; }).length;
        const ci = C.wilson(w, dec.length);
        // 置信度是「这一场判断有多可信」，分组看均值
        const confAvg = arr.length
          ? arr.reduce(function (s, x) { return s + C.confidence(x.r, agg3, C.store.P).score; }, 0) / arr.length
          : 0;
        sheet3.push([d.n, k, arr.length, dec.length, w, dec.length ? w / dec.length : '',
          ci.lo, ci.hi, dec.length ? w / dec.length - C.BREAKEVEN : '', Math.round(confAvg)]);
      });
    });
    return [
      { name: scope === 'summary' ? '记录表' : '完整明细', rows: sheet1 },
      { name: '统计', rows: sheet2 },
      { name: '分组分析', rows: sheet3 },
    ];
  }

  function exportXLSX(rs, scope) {
    const sheets = buildSheets(rs, scope);
    const blob = buildXLSX(sheets);
    U.download('记录导出_' + stamp() + '.xlsx', blob);
    U.toast('已导出 XLSX（' + sheets.length + ' 个工作表 · ' + sheets[0].rows.length + ' 行）', 'ok');
  }

  function dimensions() {
    return [
      { n: '场景', f: function (x) { return x.r.scene; } },
      { n: '深浅开', f: function (x) { return x.r.Q; } },
      { n: '水位', f: function (x) { return x.r.water; } },
      { n: '变动幅度', f: function (x) { return x.r.move; } },
      { n: '仲裁', f: function (x) { return x.r.arb; } },
      { n: '强度', f: function (x) { return x.r.strength; } },
      { n: '一致数', f: function (x) { return x.r.consensus + '/4'; } },
      { n: '联赛', f: function (x) { return x.rec.inp.league || '未知'; } },
      { n: '上盘方', f: function (x) { return x.r.upSide; } },
    ];
  }

  /* -------- HTML(.xls)：Excel 兼容、带颜色 -------- */
  function exportHTML(rs, scope) {
    rs = rs || allResults();
    scope = scope || S.scope;
    const headers = headersOf(scope);
    const rows = outRows(rs, scope);
    const h = ['<html><head><meta charset="utf-8"></head><body>'];
    h.push('<h3>本心盘口 · 记录表（' + new Date().toLocaleString() + '）</h3>');
    h.push('<table border="1" cellspacing="0" style="font-family:Microsoft YaHei;font-size:12px">');
    h.push('<tr style="background:#1F3B57;color:#fff;font-weight:bold">');
    headers.forEach(function (x) { h.push('<th>' + U.esc(x) + '</th>'); });
    h.push('</tr>');
    rows.forEach(function (o) {
      h.push('<tr>');
      headers.forEach(function (k) {
        let v = o[k];
        let bg = '';
        if (k === '上盘是否赢盘') bg = v === '赢盘' ? '#d7f5dc' : v === '输盘' ? '#fbdcdc' : '#f0f0f0';
        if (k === '冲突仲裁结论' || k === '仲裁结论') {
          const s = String(v);
          if (s.indexOf('一票否决') >= 0 || s.indexOf('全面背离') >= 0) bg = '#fbdcdc';
          else if (s.indexOf('短期反向') >= 0 || s.indexOf('信号无效') >= 0 || s.indexOf('长期背离') >= 0) bg = '#fdf6d8';
          else if (s.indexOf('信号有效') >= 0 || s.indexOf('三方一致') >= 0) bg = '#d7f5dc';
          else bg = '#eef4fb';
        }
        if (k === '最终比分') bg = v ? '#e8f0fb' : '#fafafa';
        h.push('<td' + (bg ? ' bgcolor="' + bg + '"' : '') + '>' + U.esc(v) + '</td>');
      });
      h.push('</tr>');
    });
    h.push('</table></body></html>');
    U.download('记录导出_' + stamp() + '.xls', '\ufeff' + h.join(''), 'application/vnd.ms-excel');
    U.toast('已导出 Excel 表格(.xls · ' + headers.length + ' 列)', 'ok');
  }

  /**
   * 整站备份（JSON）—— 换电脑 / 清缓存前必做
   * 含：记录（含赛果与备注）+ 全部参数 + 映射表 + 界面设置 + 调参历史 + 迭代日志。
   * rows 用「表头 → 值」的形式，导入模块的 rowsToInputs 能直接读回来。
   */
  function exportJSON(rs) {
    rs = rs || allResults();
    const recs = (rs && rs.length ? rs : C.store.rows.map(function (r) { return { rec: r }; }))
      .map(function (x) { return x.rec; });
    const sm = C.computeStats(recs, C.store.P, C.store.LIB);
    U.download('本心盘口_整站备份_' + stamp() + '.json', JSON.stringify({
      app: '本心盘口工作台',
      version: C.num(C.store.P.ITERATION, 12),
      at: new Date().toISOString(),
      counts: {
        rows: recs.length,
        players: window.Players ? window.Players.playerCount() : 0,
        params: Object.keys(C.store.P).length,
      },
      rows: recs.map(function (rec) { return C.recordToRow(rec, sm); }),
      params: C.store.P,
      lib: C.store.LIB,
      settings: C.store.settings,
      history: C.store.history,
      iters: C.store.iters,
    }, null, 1), 'application/json');
    U.toast('已导出整站备份（' + recs.length + ' 条记录 + 全部参数）', 'ok');
  }

  /* -------- 页面 -------- */
  /* ============================================================
   * 手机端专用的导出页：只要一个导出、一个导入
   * ============================================================ */
  function renderMobileExport(host) {
    const FS = window.FileStore;
    const st = FS ? FS.status() : null;
    const n = C.store.rows.length;

    /* 能力检测是异步的：还没就绪就先显示「检测中」，就绪后自动重绘一次 */
    if (FS && !(st && st.inited)) {
      FS.ready().then(function () { window.App.refresh(); }, function () { window.App.refresh(); });
    }

    /* ---------- 卡 1：保存到手机本地 ---------- */
    const c = U.el('div', { class: 'card' });
    c.appendChild(U.el('h2', {}, [document.createTextNode('① 保存到手机本地 '),
      U.el('span', { class: 'hint', text: n + ' 条记录' })]));
    c.appendChild(U.el('p', {
      class: 'desc',
      html: '每次点「保存」，记录都会<b>自动写进手机本地的文件</b>里（浏览器关了、手机重启了都还在）。' +
        '这些文件在手机的「浏览器私有目录」里，系统文件管理器看不到 —— 所以想给电脑用，用下面的<b>导出</b>。'
    }));

    const info = U.el('div', { class: 'kpi', style: { marginBottom: '10px' } });
    const modeText = !st ? '不可用'
      : st.mode === 'dir' ? '你选择的文件夹「' + (st.dirName || '?') + '」'
        : st.mode === 'opfs' ? '手机本地私有文件夹（OPFS）'
          : '不支持（只能用下面的导出）';
    info.appendChild(U.el('div', { class: 'l', text: '保存位置' }));
    info.appendChild(U.el('div', { class: 'v', style: { fontSize: '13.5px' }, text: modeText }));
    if (st && st.lastAt) {
      info.appendChild(U.el('div', { class: 'mini', style: { marginTop: '4px' },
        text: '上次保存：' + st.lastAt + '（' + st.lastCount + ' 条）→ ' + st.lastName }));
    } else {
      info.appendChild(U.el('div', { class: 'mini', style: { marginTop: '4px' }, text: '还没写过文件 —— 保存一次记录就会自动写' }));
    }
    if (st && st.lastError) {
      info.appendChild(U.el('div', { class: 'mini', style: { marginTop: '4px', color: 'var(--bad)' }, text: '上次出错：' + st.lastError }));
    }
    c.appendChild(info);

    const row = U.el('div', { class: 'row' });
    row.appendChild(U.btn('立即保存一份', function () {
      if (!FS) return U.toast('这个浏览器不支持本地文件', 'bad');
      FS.sync('手动保存').then(function (ok) {
        U.toast(ok ? '已写入：' + (FS.status().dirName || '手机本地文件夹') : '写入失败：' + FS.status().lastError, ok ? 'ok' : 'bad');
        window.App.refresh();
      });
    }, 'pri'));

    row.appendChild(U.btn('📤 导出文件（给电脑导入）', function () {
      if (!n) return U.toast('还没有记录可以导出', 'warn');
      FS.download().then(function (r) {
        if (r === 'shared') U.toast('已通过系统分享保存，选「存储到文件」即可', 'ok', 3600);
        else if (r === 'downloaded') U.toast('已下载到手机的「下载」文件夹', 'ok', 3600);
        else if (r === 'empty') U.toast('还没有记录', 'warn');
        else U.toast('导出失败，试试用电脑端打开', 'bad');
      });
    }, 'ghost'));

    if (st && st.dirPicker) {
      row.appendChild(U.btn('选择保存文件夹', function () {
        FS.pickFolder().then(function () {
          U.toast('已切换到文件夹「' + FS.status().dirName + '」', 'ok');
          return FS.sync('切换文件夹后同步');
        }).then(function () { window.App.refresh(); })
          .catch(function (e) { U.toast(e.message || '选择失败', 'bad'); });
      }, 'ghost'));
    }
    c.appendChild(row);
    host.appendChild(c);

    /* ---------- 卡 2：文件列表 ---------- */
    if (FS && st && st.mode !== 'none') {
      const c2 = U.el('div', { class: 'card' });
      c2.appendChild(U.el('h2', {}, [document.createTextNode('手机本地已有的文件 '),
        U.el('span', { class: 'hint', text: '点文件名可以重新导出一份' })]));
      const listBox = U.el('div', { class: 'picklist' });
      listBox.appendChild(U.el('div', { class: 'picknone', text: '读取中…' }));
      c2.appendChild(listBox);
      host.appendChild(c2);

      FS.list().then(function (files) {
        listBox.innerHTML = '';
        if (!files.length) {
          listBox.appendChild(U.el('div', { class: 'picknone', text: '还没有文件 —— 保存一次就会出现' }));
          return;
        }
        files.forEach(function (f) {
          const r = U.el('div', { class: 'pickrow' });
          r.appendChild(U.el('span', { class: 'nm', text: f.name }));
          r.appendChild(U.el('span', { class: 'val', text: Math.round(f.size / 102.4) / 10 + ' KB' }));
          r.appendChild(U.el('span', { class: 'val', style: { color: 'var(--txt-3)' },
            text: new Date(f.mtime).toLocaleString('zh-CN') }));
          listBox.appendChild(r);
        });
      }, function () {
        listBox.innerHTML = '';
        listBox.appendChild(U.el('div', { class: 'picknone', text: '读不出来（浏览器限制）' }));
      });
    }

    /* ---------- 卡 3：导入 ---------- */
    if (window.ImportKit) window.ImportKit.card(host);

    /* ---------- 卡 4：说明 ---------- */
    const c4 = U.el('div', { class: 'card' });
    c4.appendChild(U.el('h2', {}, [document.createTextNode('怎么把手机上的记录搬到电脑')]));
    const ol = U.el('ol', { style: { fontSize: '12.6px', lineHeight: '2', paddingLeft: '20px', margin: '6px 0' } });
    ol.appendChild(U.el('li', { html: '手机上：点 <b>「📤 导出文件（给电脑导入）」</b> → 系统分享 / 下载，选「存储到文件」' }));
    ol.appendChild(U.el('li', { html: '把那个 <code>本心手机端记录_日期.json</code> 传到电脑（微信 / QQ / 数据线 / 网盘都行）' }));
    ol.appendChild(U.el('li', { html: '电脑上：打开本心盘口 → <b>导出 / 导入</b> → 选这个 json → 会提示「识别为 JSON 数组：N 条记录」→ 确认导入' }));
    ol.appendChild(U.el('li', { html: '重复导入同一份不会重复建记录：选「跳过重复」即可' }));
    c4.appendChild(ol);
    c4.appendChild(U.note(
      '<b>为什么不能直接写进手机的文件夹？</b><br>' +
      '浏览器的安全规则：网页（包括 PWA）<b>不许</b>静默写入用户能看到的目录。' +
      '安卓 Chrome、苹果 Safari 都不开放这个能力（只有电脑版 Chrome/Edge 有「选择文件夹」）。<br>' +
      '所以现在的方案是：<b>自动写进浏览器自己的私有文件夹（关掉也还在）</b> + <b>一个按钮导出成文件</b>。' +
      '如果你要「真正写进手机文件管理里的文件夹」，得等原生 APK 版本（第四阶段）。', 'warn'));
    host.appendChild(c4);
  }

  /* ============================================================
   * 🔄 三端数据桥
   *
   * file:// / http://127.0.0.1:8765 / 手机 是**三个不同的 localStorage**。
   * 这里用本机后端当"中转站"：
   *   A 页面点【⬆ 上传】→ 存到 竞彩计算器\data\store.json
   *   B 页面点【⬇ 载入】→ 整包写回 B 的 localStorage 并刷新
   * ============================================================ */
  function bridgeBases() {
    const out = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') out.push(location.origin);
    ['http://127.0.0.1:8765', 'http://127.0.0.1:8766', 'http://127.0.0.1:8767'].forEach(function (b) {
      if (out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }
  function bridgeCall(path, opt) {
    const bases = bridgeBases();
    let i = 0;
    function next() {
      if (i >= bases.length) return Promise.reject(new Error('连不上本机后端（先双击 竞彩计算器\\启动.bat）'));
      const base = bases[i++];
      const _u = window.withToken ? window.withToken(base + path) : (base + path);
      return fetch(_u, opt || {}).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function () { return next(); });
    }
    return next();
  }

  function bridgeCard(host) {
    const c = U.el('div', { class: 'card', style: { borderColor: 'var(--line-2)' } });
    c.appendChild(U.el('h2', {}, [document.createTextNode('🔄 三端数据桥'),
      U.el('span', { class: 'hint', text: '把这一页的数据搬到另一页' })]));

    c.appendChild(U.el('div', {
      class: 'mini', style: { lineHeight: '1.8' },
      html: '你现在这一页是：<b>' +
        U.esc(location.protocol === 'file:' ? 'file://（双击 index.html 打开的那个）' : location.origin) + '</b><br>' +
        '每换一个入口就是<b>另一份数据</b>（file:// / 127.0.0.1 / 手机 各一份）。想统一就用下面三个按钮搬。'
    }));

    const tip = U.el('div', { class: 'mini', id: 'bridge-tip', style: { marginTop: '8px', lineHeight: '1.7', color: 'var(--txt-2)' } });
    const row = U.el('div', { class: 'row', style: { marginTop: '10px' } });

    row.appendChild(U.btn('⬆ 上传本页数据到本机', function () {
      const payload = {
        at: new Date().toISOString(),
        rows: C.store.rows,
        params: C.store.P,
        lib: C.store.LIB,
        settings: C.store.settings,
        history: C.store.history,
        iters: C.store.iters,
        players: window.Players ? window.Players.PL() : null,
      };
      tip.textContent = '上传中…';
      bridgeCall('/api/store', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error(r.error || '失败');
        tip.innerHTML = '✔ 已上传：<b>' + r.rows + '</b> 条记录，' + Math.round((r.size || 0) / 1024) +
          ' KB（存在 <code>竞彩计算器\\data\\store.json</code>）';
        U.toast('已上传到本机（' + r.rows + ' 条记录）', 'ok');
      }, function (e) { tip.innerHTML = '✘ ' + U.esc(e.message); });
    }, 'pri'));

    row.appendChild(U.btn('⬇ 从本机载入到这一页', function () {
      tip.textContent = '读取中…';
      bridgeCall('/api/store').then(function (r) {
        if (!r.ok) throw new Error(r.error || '本机还没有数据');
        const d = r.data || {};
        U.confirmBox('会用本机那份覆盖这一页的：\n\n' +
          '· 记录 ' + (d.rows || []).length + ' 条\n' +
          '· 全部参数 + 联赛库\n' +
          '· 球员库 ' + ((d.players && Object.keys(d.players.players || {}).length) || 0) + ' 支队\n\n' +
          '（这一页原来的会被替换，重要数据请先导出 JSON 备份）\n\n继续？', function () {
          try {
            if (d.rows) localStorage.setItem('benxin.rows.v1', JSON.stringify(d.rows));
            if (d.params) localStorage.setItem('benxin.params.v1', JSON.stringify(d.params));
            if (d.lib) localStorage.setItem('benxin.lib.v1', JSON.stringify(d.lib));
            if (d.settings) localStorage.setItem('benxin.settings.v1', JSON.stringify(d.settings));
            if (d.history) localStorage.setItem('benxin.history.v1', JSON.stringify(d.history));
            if (d.iters) localStorage.setItem('benxin.iters.v1', JSON.stringify(d.iters));
            if (d.players) localStorage.setItem('benxin.players.v1', JSON.stringify(d.players));
            U.toast('已从本机载入，正在刷新…', 'ok', 3000);
            setTimeout(function () { location.reload(); }, 800);
          } catch (e) { tip.innerHTML = '✘ 写入失败：' + U.esc(e.message); }
        });
      }, function (e) { tip.innerHTML = '✘ ' + U.esc(e.message); });
    }, 'ghost'));

    row.appendChild(U.btn('查本机有什么', function () {
      bridgeCall('/api/store').then(function (r) {
        if (!r.ok) throw new Error(r.error || '没有');
        const d = r.data || {};
        tip.innerHTML = '本机那份：上传时间 <b>' + U.esc(d.at || '?') + '</b>，' +
          (d.rows || []).length + ' 条记录，' + Math.round((r.size || 0) / 1024) + ' KB';
      }, function (e) { tip.innerHTML = '✘ ' + U.esc(e.message); });
    }, 'sm ghost'));

    c.appendChild(row);
    c.appendChild(tip);
    c.appendChild(U.note('用法：<b>file://</b> 里点「⬆ 上传」→ 打开 <b>127.0.0.1:8765</b> 点「⬇ 载入」，两边就一致了；反过来也行。<br>' +
      '⚠ 这是<b>手动</b>搬运，不会自动同步 —— 认一个主站（建议你平时用的 file://），别在两边同时改。', ''));
    host.appendChild(c);
    return c;
  }

  window.App.register({
    id: 'export', title: '导出 / 导入', icon: '⤓', group: '输出',
    desc: '把记录库导出成表格（精简表 / 完整明细）、统计、分组分析，或整站 JSON 备份；也能把备份导回来。',
    render: function (host) {
      /* ============================================================
       * 手机端：只要「一个导出按钮 + 一个导入」。
       *   · 记录每次保存会自动写进手机本地（OPFS / 你选的文件夹）
       *   · 导出 = 生成 JSON 文件 → 传到电脑 → 电脑端「导入」一键吃进去
       * ============================================================ */
      if (window.App.isMobile && window.App.isMobile()) {
        renderMobileExport(host);
        return;
      }

      const rs = allResults();
      const c = U.el('div', { class: 'card' });
      c.appendChild(U.el('h2', {}, [document.createTextNode('导出记录库'),
        U.el('span', { class: 'hint', text: '当前 ' + rs.length + ' 条记录' })]));

      const g = U.el('div', { class: 'grid g4' });
      g.appendChild(kpi('精简表', C.SUMMARY_HEADERS.length + ' 列', '一行一场：盘口 / 水位 / 上盘方 / 场景 / 推荐方向 / 评分 / 比分 —— 给人看'));
      g.appendChild(kpi('完整明细', C.ALL_HEADERS.length + ' 列', '每场输入（近 6 场 / 战绩 / 排名 / 加减文本）+ 引擎算出的全部列，可无损回导'));
      g.appendChild(kpi('统计 / 分组', '2 个表页', '按场景·水位·仲裁…分组的投注盈利 + Wilson 区间与置信度'));
      c.appendChild(g);

      // 导出范围
      const opt = U.el('div', { class: 'row', style: { marginTop: '10px' } });
      opt.appendChild(U.field('导出范围', U.select([
        { v: 'full', n: '完整明细 —— 含每场输入与全部中间量（可无损回导）' },
        { v: 'summary', n: '精简表 —— 只留一眼能读懂的列（给人看 / 贴给别人）' },
      ], S.scope, function (v) { S.scope = v; window.App.refresh(); }, { style: { minWidth: '420px' } })));
      c.appendChild(opt);

      const row = U.el('div', { class: 'row', style: { marginTop: '4px' } });
      row.appendChild(U.btn('⤓ 导出 XLSX（推荐 · 3 个表页）', function () { exportXLSX(rs); }, 'pri'));
      row.appendChild(U.btn('⤓ 导出 CSV', function () { exportCSV(rs); }));
      row.appendChild(U.btn('⤓ 导出 Excel 表格 (.xls，带颜色)', function () { exportHTML(rs); }));
      row.appendChild(U.btn('⤓ 导出 JSON 备份（含参数与映射表）', function () { exportJSON(rs); }, 'ghost'));
      c.appendChild(row);

      c.appendChild(U.note('XLSX 由本页直接生成（手写 OOXML + ZIP），<b>完全离线、不联网</b>；CSV 带 UTF-8 BOM，Excel 双击不乱码。<br>' +
        '<b>完整明细</b>里前 ' + C.RECORD_HEADERS.length + ' 列是比赛概要，中间 ' + C.MATCH_HEADERS.length +
        ' 列是每场输入与加减文本，后面是统计块。要长期保存、或换电脑，用 JSON 备份最稳。', 'ok'));
      host.appendChild(c);

      // 从文件导入记录
      if (window.ImportKit) window.ImportKit.card(host);

      /* —— 升级前自动备份（★ v15）—— */
      const cB = U.el('div', { class: 'card' });
      cB.appendChild(U.el('h2', {}, [document.createTextNode('升级前备份'),
        U.el('span', { class: 'hint', text: '出问题时把记录库退回上一个版本' })]));
      let bakN = 0;
      try {
        const raw = localStorage.getItem('benxin.rows.bak.v1');
        if (raw) bakN = (JSON.parse(raw) || []).length;
      } catch (e) { bakN = 0; }
      if (!bakN) {
        cB.appendChild(U.note('这一版升级时没有找到可用的自动备份（可能是全新安装，或者当时记录库为空）。' +
          '建议现在就点一次上面那个「导出 JSON 备份」。', ''));
      } else {
        cB.appendChild(U.note('这一版升级时，程序把你当时的记录库（<b>' + bakN + ' 条</b>）自动存了一份快照 —— ' +
          '因为这一版修了「中文盘口符号反了」「中水二次判定判反」两个 bug，历史记录的结论会跟着变。' +
          '如果发现某些记录的新结论不对，可以先用上面按钮导出当前 JSON 备份，再点下面退回。', 'warn'));
        const brow = U.el('div', { class: 'row' });
        brow.appendChild(U.btn('退回升级前的 ' + bakN + ' 条记录', function () {
          U.confirmBox('确定把记录库退回升级前的 ' + bakN + ' 条？当前 ' + C.store.rows.length +
            ' 条会被替换掉（建议先导出 JSON 备份）。', function () {
              try {
                const raw = localStorage.getItem('benxin.rows.bak.v1');
                const arr = raw ? JSON.parse(raw) : null;
                if (!Array.isArray(arr)) return U.toast('备份内容已损坏，无法恢复', 'bad');
                C.store.rows = arr;
                C.saveRows();
                U.toast('已退回 ' + arr.length + ' 条记录', 'ok');
                window.App.refresh(); window.App.updateFoot();
              } catch (e) { U.toast('恢复失败：' + e.message, 'bad'); }
            });
        }, 'danger'));
        cB.appendChild(brow);
      }
      host.appendChild(cB);

      // 列说明
      const c1 = U.el('div', { class: 'card' });      c1.appendChild(U.el('h2', {}, [document.createTextNode('列说明'),
        U.el('span', { class: 'hint', text: '完整明细的每一列是什么、从哪来' })]));
      const det = U.el('details');
      det.appendChild(U.el('summary', { text: '展开 ' + C.ALL_HEADERS.length + ' 列的来源说明' }));
      det.appendChild(U.el('div', { html: U.table([
        { k: 'i', n: '#', w: '46px' }, { k: 'h', n: '列名', w: '220px' },
        { k: 'f', n: '输入字段', w: '150px' }, { k: 'src', n: '来源', w: '240px' }
      ], C.ALL_HEADERS.map(function (h, i) {
        const f = C.H2F[h];
        const nRec = C.RECORD_HEADERS.length, nMatch = C.MATCH_HEADERS.length;
        const midAt = nRec + nMatch;
        const statAt = midAt + C.VERDICT_HEADERS.length;
        const extraAt = statAt + C.STAT_HEADERS.length;
        let src = '';
        if (i < nRec) src = '引擎算 / 赛果录入';
        else if (h === '主队排名区间' || h === '客队排名区间') src = '引擎按分界自动判（可覆盖）';
        else if (h === '是否空场') src = '输入（TRUE / 留空）';
        else if (i === midAt) src = '引擎：中水二次判定';
        else if (i >= extraAt) src = '输入（可选）：' + (h === '手动指定上盘方' ? '手动指定机构让球方（留空 = 自动）' : '近 6 场实际场次');
        else if (i >= statAt) src = '引擎：按场景方向分组的投注盈利统计';
        else src = '输入';
        return {
          i: i + 1, h: U.esc(h), f: f ? '<code>' + f + '</code>' : '',
          src: '<span class="mini">' + src + '</span>'
        };
      })) }));
      c1.appendChild(det);
      host.appendChild(c1);

      // 预览
      const c2 = U.el('div', { class: 'card' });
      const prevH = headersOf(S.scope);
      c2.appendChild(U.el('h2', {}, [document.createTextNode('导出预览（前 5 行 · ' +
        (S.scope === 'summary' ? '精简表 ' : '完整明细 ') + prevH.length + ' 列）')]));
      const prev = outRows(rs.slice(0, 5), S.scope);
      const tw = U.el('div', { class: 'tw', style: { maxHeight: '420px' } });
      let html = '<table><thead><tr><th>#</th>';
      prevH.forEach(function (h) { html += '<th>' + U.esc(h) + '</th>'; });
      html += '</tr></thead><tbody>';
      prev.forEach(function (o, i) {
        html += '<tr><td>' + (i + 1) + '</td>';
        prevH.forEach(function (h) { html += '<td class="wrapcell" style="max-width:200px">' + U.esc(o[h]) + '</td>'; });
        html += '</tr>';
      });
      html += '</tbody></table>';
      tw.innerHTML = html;
      c2.appendChild(tw);
      if (!prev.length) c2.appendChild(U.note('还没有记录。去「批量计算 → ① 单场录入」建一场，或从上面导入一份备份。', 'warn'));
      host.appendChild(c2);
      bridgeCard(host);          /* 🔄 三端数据桥 */
    }
  });

  function kpi(l, v, s) {
    const b = U.el('div', { class: 'kpi' });
    b.appendChild(U.el('div', { class: 'v', text: v }));
    b.appendChild(U.el('div', { class: 'l', text: l }));
    if (s) b.appendChild(U.el('div', { class: 'sub', text: s }));
    return b;
  }

  window.Export = {
    exportCSV: exportCSV, exportXLSX: exportXLSX, exportHTML: exportHTML, exportJSON: exportJSON,
    buildXLSX: buildXLSX, buildSheets: buildSheets, fullRows: fullRows, outRows: outRows,
    statBlocks: statBlocks, allResults: allResults,
  };
})();
