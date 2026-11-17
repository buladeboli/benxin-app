/* =========================================================================
 * xlsread.js — 纯前端表格读取器（不联网、不依赖任何库）
 *   · .xls  老式 Excel 二进制（OLE2/CFB + BIFF8）—— 逐记录手写解析
 *   · .xlsx 新式 Excel（ZIP + OOXML）
 *   · .csv / .txt / 粘贴的制表符文本
 * 对外：window.XlsRead.readFile(file) -> Promise<{kind, sheets:[{name, grid}]}>
 *       window.XlsRead.parseXls(u8) / parseXlsx(u8) / parseText(text)
 * ========================================================================= */
(function () {
  'use strict';
  const TD = typeof TextDecoder !== 'undefined' ? TextDecoder : null;
  function dec(buf, enc) { return new TD(enc || 'utf-8').decode(buf); }

  /* ---------------- 通用小工具 ---------------- */
  function u8at(b, o) { return b[o]; }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function i16(b, o) { const v = u16(b, o); return v >= 0x8000 ? v - 0x10000 : v; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function ascii1(b, o) {
    // 单字节 → 字符（latin-1）
    let s = '';
    for (let i = o; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  /* =====================================================================
   * 1. OLE2 / CFB —— 从 .xls 里取出 Workbook 流
   * =================================================================== */
  function oleStreams(buf) {
    const d = new Uint8Array(buf);
    if (!(d[0] === 0xD0 && d[1] === 0xCF && d[2] === 0x11 && d[3] === 0xE0)) {
      throw new Error('不是 .xls（OLE2）文件 —— 文件头不对');
    }
    const ssz = 1 << u16(d, 30);
    const mssz = 1 << u16(d, 32);
    const nfat = u32(d, 44);
    const dirstart = u32(d, 48);
    const cutoff = u32(d, 56);
    const minifatstart = u32(d, 60);
    const ndifat = u32(d, 72);
    const difatstart = u32(d, 68);

    function sec(n) { const off = 512 + n * ssz; return d.subarray(off, off + ssz); }

    // DIFAT → FAT
    const difat = [];
    for (let i = 0; i < 109; i++) difat.push(u32(d, 76 + i * 4));
    let nxt = difatstart;
    for (let k = 0; k < ndifat; k++) {
      if (nxt >= 0xFFFFFFFA) break;
      const s = sec(nxt);
      const cnt = ssz / 4;
      for (let i = 0; i < cnt - 1; i++) difat.push(u32(s, i * 4));
      nxt = u32(s, (cnt - 1) * 4);
    }
    const fat = [];
    for (let i = 0; i < nfat && i < difat.length; i++) {
      const fs = difat[i];
      if (fs >= 0xFFFFFFFA) continue;
      const s = sec(fs);
      for (let j = 0; j < ssz / 4; j++) fat.push(u32(s, j * 4));
    }
    function chain(start, f) {
      const out = []; let cur = start, guard = 0;
      while (cur < 0xFFFFFFFA && guard++ < 5e6) { out.push(cur); cur = cur < f.length ? f[cur] : 0xFFFFFFFE; }
      return out;
    }
    // 目录
    const dirRaw = [];
    chain(dirstart, fat).forEach(function (s) { dirRaw.push(sec(s)); });
    const entries = [];
    dirRaw.forEach(function (blk) {
      for (let i = 0; i + 128 <= blk.length; i += 128) {
        const e = blk.subarray(i, i + 128);
        const nlen = u16(e, 64);
        let name = '';
        if (nlen >= 2) {
          for (let k = 0; k + 1 < nlen - 1; k += 2) name += String.fromCharCode(u16(e, k));
        }
        entries.push({ name: name, type: e[66], start: u32(e, 116), size: u32(e, 120) });
      }
    });
    // miniFAT
    const mini = [];
    chain(minifatstart, fat).forEach(function (s) {
      const b = sec(s);
      for (let i = 0; i < ssz / 4; i++) mini.push(u32(b, i * 4));
    });
    const root = entries[0] || { start: 0, size: 0 };
    let ministream = new Uint8Array(0);
    if (root && root.start < 0xFFFFFFFA) {
      const parts = chain(root.start, fat).map(sec);
      let total = 0; parts.forEach(function (p) { total += p.length; });
      ministream = new Uint8Array(total);
      let o = 0; parts.forEach(function (p) { ministream.set(p, o); o += p.length; });
    }
    function read(name) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.type !== 2 || e.name !== name) continue;
        if (e.size < cutoff) {
          const parts = chain(e.start, mini).map(function (s) { return ministream.subarray(s * mssz, (s + 1) * mssz); });
          let total = 0; parts.forEach(function (p) { total += p.length; });
          const out = new Uint8Array(total);
          let o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; });
          return out.subarray(0, e.size);
        }
        const parts = chain(e.start, fat).map(sec);
        let total = 0; parts.forEach(function (p) { total += p.length; });
        const out = new Uint8Array(total);
        let o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; });
        return out.subarray(0, e.size);
      }
      return null;
    }
    return { read: read, names: entries.filter(function (e) { return e.type === 2; }).map(function (e) { return e.name; }) };
  }

  /* =====================================================================
   * 2. BIFF8 —— 解析 Workbook 流
   * =================================================================== */
  function biffRecords(b) {
    const out = []; let i = 0;
    while (i + 4 <= b.length) {
      const t = u16(b, i), ln = u16(b, i + 2);
      out.push({ t: t, d: b.subarray(i + 4, i + 4 + ln), off: i });
      i += 4 + ln;
    }
    return out;
  }
  function rkVal(rk) {
    let v;
    if (rk & 0x02) {
      v = (rk | 0) >> 2;              // 有符号 30 位整数
    } else {
      const hi = (rk & 0xFFFFFFFC) >>> 0;
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint32(0, 0, true); dv.setUint32(4, hi, true);
      v = dv.getFloat64(0, true);
    }
    return (rk & 0x01) ? v / 100 : v;
  }
  /** 解析 SST（含 CONTINUE 拼接） */
  function parseSST(blocks) {
    let total = 0; blocks.forEach(function (b) { total += b.length; });
    const buf = new Uint8Array(total);
    let o = 0;
    const bounds = [];
    blocks.forEach(function (b) { buf.set(b, o); bounds.push([o, o + b.length]); o += b.length; });
    function which(pos) {
      for (let k = 0; k < bounds.length; k++) if (pos >= bounds[k][0] && pos < bounds[k][1]) return bounds[k][1];
      return buf.length;
    }
    const n = u32(buf, 4);
    const out = [];
    let pos = 8;
    for (let idx = 0; idx < n; idx++) {
      if (pos + 3 > buf.length) break;
      let cch = u16(buf, pos); const flags = buf[pos + 2]; pos += 3;
      const rich = !!(flags & 0x08), ext = !!(flags & 0x04);
      let nrun = 0, cbext = 0;
      if (rich) { nrun = u16(buf, pos); pos += 2; }
      if (ext) { cbext = u32(buf, pos) | 0; pos += 4; }
      let hi = !!(flags & 0x01);
      let s = '', got = 0;
      while (got < cch) {
        const end = which(pos);
        const width = hi ? 2 : 1;
        const avail = Math.floor((end - pos) / width);
        const take = Math.min(avail, cch - got);
        if (take > 0) {
          if (hi) { for (let k = 0; k < take; k++) s += String.fromCharCode(u16(buf, pos + k * 2)); }
          else { for (let k = 0; k < take; k++) s += String.fromCharCode(buf[pos + k]); }
          pos += take * width; got += take;
        }
        if (got < cch) {
          pos = end;
          if (pos >= buf.length) break;
          hi = !!(buf[pos] & 0x01); pos += 1;
        }
      }
      pos += nrun * 4 + cbext;
      out.push(s);
    }
    return out;
  }
  function xlUniStr(d, o) {
    const cch = u16(d, o); const flags = d[o + 2];
    let p = o + 3, rich = 0, ext = 0;
    if (flags & 0x08) { rich = u16(d, p); p += 2; }
    if (flags & 0x04) { ext = u32(d, p); p += 4; }
    let s = '';
    if (flags & 0x01) { for (let k = 0; k < cch; k++) s += String.fromCharCode(u16(d, p + k * 2)); }
    else { for (let k = 0; k < cch; k++) s += String.fromCharCode(d[p + k]); }
    return { s: s, len: p - o + cch * ((flags & 0x01) ? 2 : 1) + rich * 4 + ext };
  }
  /** BOUNDSHEET 用的是「短字符串」：cch 只占 1 字节（不是 XLUnicodeString 的 2 字节） */
  function xlShortStr(d, o) {
    const cch = d[o];
    const flags = d[o + 1];
    let s = '';
    if (flags & 0x01) { for (let k = 0; k < cch; k++) s += String.fromCharCode(u16(d, o + 2 + k * 2)); }
    else { for (let k = 0; k < cch; k++) s += String.fromCharCode(d[o + 2 + k]); }
    return s;
  }

  function parseXls(buf) {
    const ole = oleStreams(buf);
    let wb = ole.read('Workbook');
    if (!wb) wb = ole.read('Book');
    if (!wb) throw new Error('.xls 里找不到 Workbook 流（可能是 .xlsb 或加密文件）');
    const recs = biffRecords(wb);

    // 先扫 SST 与 BOUNDSHEET
    let sst = [];
    const sheets = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.t === 0x00FC) {
        const blocks = [r.d];
        let j = i + 1;
        while (j < recs.length && recs[j].t === 0x003C) { blocks.push(recs[j].d); j++; }
        sst = parseSST(blocks);
        i = j - 1;
      } else if (r.t === 0x0085) {
        const pos = u32(r.d, 0);
        sheets.push({ pos: pos, name: xlShortStr(r.d, 6) });
      }
    }

    function readSheet(pos) {
      let idx = -1;
      for (let i = 0; i < recs.length; i++) if (recs[i].off === pos) { idx = i; break; }
      if (idx < 0) {
        for (let i = 0; i < recs.length; i++) {
          if (recs[i].t === 0x0809 && recs[i].d.length >= 4 && u16(recs[i].d, 2) === 0x0010) { idx = i; break; }
        }
      }
      if (idx < 0) return [];
      const cells = {};
      let maxR = -1, maxC = -1;
      let pendingStrCell = null;
      for (let i = idx + 1; i < recs.length; i++) {
        const t = recs[i].t, d = recs[i].d;
        if (t === 0x000A || t === 0x0809) break;
        let r, c;
        if (t === 0x00FD && d.length >= 10) {
          r = u16(d, 0); c = u16(d, 2); const isst = u32(d, 6);
          cells[r + ',' + c] = isst < sst.length ? sst[isst] : '';
        } else if (t === 0x0204) {
          r = u16(d, 0); c = u16(d, 2);
          cells[r + ',' + c] = xlUniStr(d, 6).s;
        } else if (t === 0x027E && d.length >= 10) {
          r = u16(d, 0); c = u16(d, 2);
          cells[r + ',' + c] = rkVal(u32(d, 6));
        } else if (t === 0x00BD) {
          r = u16(d, 0); const c1 = u16(d, 2);
          const cnt = Math.floor((d.length - 6) / 6);
          for (let k = 0; k < cnt; k++) {
            cells[r + ',' + (c1 + k)] = rkVal(u32(d, 4 + k * 6 + 2));
          }
        } else if (t === 0x0203 && d.length >= 14) {
          r = u16(d, 0); c = u16(d, 2);
          const dv = new DataView(d.buffer, d.byteOffset + 6, 8);
          cells[r + ',' + c] = dv.getFloat64(0, true);
        } else if (t === 0x0006 && d.length >= 20) {
          r = u16(d, 0); c = u16(d, 2);
          const b6 = d[12], b7 = d[13];
          if (b6 === 0xFF && b7 === 0xFF) {
            const kind = d[6];
            if (kind === 0) cells[r + ',' + c] = d[8] ? true : false;
            else if (kind === 1) cells[r + ',' + c] = '';
            else if (kind === 2) { cells[r + ',' + c] = ''; pendingStrCell = r + ',' + c; }
            else cells[r + ',' + c] = '';
          } else {
            const dv = new DataView(d.buffer, d.byteOffset + 6, 8);
            cells[r + ',' + c] = dv.getFloat64(0, true);
          }
        } else if (t === 0x0207 && pendingStrCell) {
          cells[pendingStrCell] = xlUniStr(d, 0).s;
          pendingStrCell = null;
        } else if (t === 0x0201 && d.length >= 10) {   // BLANK
          r = u16(d, 0); c = u16(d, 2);
        }
        if (typeof r === 'number') {
          if (r > maxR) maxR = r;
          if (c > maxC) maxC = c;
        }
      }
      const grid = [];
      for (let r = 0; r <= maxR; r++) {
        const line = [];
        for (let c = 0; c <= maxC; c++) {
          const v = cells[r + ',' + c];
          line.push(v === undefined ? '' : v);
        }
        grid.push(line);
      }
      return grid;
    }
    return sheets.map(function (s) { return { name: s.name, grid: readSheet(s.pos) }; });
  }

  /* =====================================================================
   * 3. XLSX —— ZIP + OOXML
   * =================================================================== */
  function zipList(u8) {
    let eocd = -1;
    const from = Math.max(0, u8.length - 66000);
    for (let i = u8.length - 22; i >= from; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是合法的 ZIP/XLSX（找不到目录结尾）');
    const count = u16(u8, eocd + 10);
    let p = u32(u8, eocd + 16);
    const out = {};
    for (let i = 0; i < count; i++) {
      if (u32(u8, p) !== 0x02014b50) break;
      const method = u16(u8, p + 10);
      const compSize = u32(u8, p + 20);
      const nameLen = u16(u8, p + 28);
      const extraLen = u16(u8, p + 30);
      const cmtLen = u16(u8, p + 32);
      const localOff = u32(u8, p + 42);
      const name = dec(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = u16(u8, localOff + 26);
      const lExtraLen = u16(u8, localOff + 28);
      out[name] = { method: method, at: localOff + 30 + lNameLen + lExtraLen, compSize: compSize };
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压（DecompressionStream 不可用），请改用 CSV。');
    const ds = new DecompressionStream('deflate-raw');
    const st = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  async function zipGet(u8, list, name) {
    const e = list[name];
    if (!e) return null;
    const raw = u8.subarray(e.at, e.at + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return await inflateRaw(raw);
    throw new Error('ZIP 用了不支持的压缩方式 ' + e.method);
  }
  function xmlUnesc(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 16)); })
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
  async function parseXlsx(buf) {
    const u8 = new Uint8Array(buf);
    const list = zipList(u8);
    const shared = [];
    const ssXml = await zipGet(u8, list, 'xl/sharedStrings.xml');
    if (ssXml) {
      const sd = dec(ssXml);
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = re.exec(sd)) !== null) {
        let s = '';
        const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tre.exec(m[1])) !== null) s += xmlUnesc(tm[1]);
        shared.push(s);
      }
    }
    const wbXml = await zipGet(u8, list, 'xl/workbook.xml');
    const relXml = await zipGet(u8, list, 'xl/_rels/workbook.xml.rels');
    const sheets = [];
    if (wbXml && relXml) {
      const wb = dec(wbXml), rels = {};
      let m;
      const rre = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
      while ((m = rre.exec(dec(relXml))) !== null) rels[m[1]] = m[2];
      const sre = /<sheet[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g;
      while ((m = sre.exec(wb)) !== null) sheets.push({ name: xmlUnesc(m[1]), id: m[2] });
      if (!sheets.length) {
        const sre2 = /<sheet[^>]*?r:id="([^"]+)"[^>]*?name="([^"]+)"/g;
        while ((m = sre2.exec(wb)) !== null) sheets.push({ name: xmlUnesc(m[2]), id: m[1] });
      }
    }
    if (!sheets.length) sheets.push({ name: 'Sheet1', id: 'rId1' });
    const out = [];
    for (let si = 0; si < sheets.length; si++) {
      const sh = sheets[si];
      let path = null;
      if (sh.id && relXml) {
        const rels = {};
        let m;
        const rre = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
        while ((m = rre.exec(dec(relXml))) !== null) rels[m[1]] = m[2];
        if (rels[sh.id]) path = 'xl/' + rels[sh.id].replace(/^\/?xl\//, '').replace(/^\//, '');
      }
      let sxml = path ? await zipGet(u8, list, path) : null;
      if (!sxml) sxml = await zipGet(u8, list, 'xl/worksheets/sheet' + (si + 1) + '.xml');
      if (!sxml) { out.push({ name: sh.name, grid: [] }); continue; }
      const xml = dec(sxml);
      const grid = [];
      let rm;
      const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
      let anyRow = false;
      while ((rm = rowRe.exec(xml)) !== null) {
        anyRow = true;
        const rIdx = parseInt(rm[1], 10) - 1;
        const line = grid[rIdx] = grid[rIdx] || [];
        const cre = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
        let cm;
        while ((cm = cre.exec(rm[2])) !== null) {
          const attrs = cm[1] || cm[2] || '';
          const body = cm[3] || '';
          const refM = /r="([A-Z]+)\d+"/.exec(attrs);
          if (!refM) continue;
          const ci = colIdx(refM[1]);
          const tyM = /t="([^"]+)"/.exec(attrs);
          const ty = tyM ? tyM[1] : 'n';
          let val = '';
          if (ty === 'inlineStr') {
            const tre = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
            while ((tm = tre.exec(body)) !== null) val += xmlUnesc(tm[1]);
          } else {
            const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
            const raw = vm ? xmlUnesc(vm[1]) : '';
            if (ty === 's') val = shared[+raw] !== undefined ? shared[+raw] : '';
            else if (ty === 'b') val = raw === '1';
            else if (ty === 'str') val = raw;
            else val = raw === '' ? '' : (isFinite(+raw) ? +raw : raw);
          }
          line[ci] = val;
        }
      }
      if (!anyRow) {
        // 有些文件不写 <row r>，退化成逐 <c>
        const cre = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
        let cm;
        while ((cm = cre.exec(xml)) !== null) {
          const refM = /r="([A-Z]+)(\d+)"/.exec(cm[1]);
          if (!refM) continue;
          const ci = colIdx(refM[1]), ri = parseInt(refM[2], 10) - 1;
          const tyM = /t="([^"]+)"/.exec(cm[1]);
          const ty = tyM ? tyM[1] : 'n';
          const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cm[2]);
          let val = '';
          if (ty === 'inlineStr') { const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[2]); val = tm ? xmlUnesc(tm[1]) : ''; }
          else if (ty === 's') val = shared[+vm[1]] !== undefined ? shared[+vm[1]] : '';
          else if (vm) val = isFinite(+vm[1]) ? +vm[1] : xmlUnesc(vm[1]);
          grid[ri] = grid[ri] || [];
          grid[ri][ci] = val;
        }
      }
      for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
      out.push({ name: sh.name, grid: grid });
    }
    return out;
  }

  /* =====================================================================
   * 4. 文本（CSV / TSV / 粘贴）
   * =================================================================== */
  function splitDelim(line, d) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function parseText(text) {
    let t = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = t.split('\n').filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    const head = lines[0];
    const counts = [[',', (head.match(/,/g) || []).length], ['\t', (head.match(/\t/g) || []).length],
    [';', (head.match(/;/g) || []).length], ['|', (head.match(/\|/g) || []).length]];
    counts.sort(function (a, b) { return b[1] - a[1]; });
    const d = counts[0][1] > 0 ? counts[0][0] : ',';
    return lines.map(function (l) {
      return splitDelim(l, d).map(function (s) { return s.trim(); });
    });
  }

  /* =====================================================================
   * 5. 对外
   * =================================================================== */
  async function readArrayBuffer(file) {
    if (typeof file.arrayBuffer === 'function') return await file.arrayBuffer();
    return await new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }
  async function readTextFile(file) {
    if (typeof file.text === 'function') return await file.text();
    return await new Promise(function (res, rej) {
      const fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('读取失败')); };
      fr.readAsText(file, 'utf-8');
    });
  }
  async function readFile(file) {
    const name = (file && file.name) || '';
    const low = name.toLowerCase();
    if (/\.xlsx$/.test(low) || /\.xlsm$/.test(low)) {
      const buf = await readArrayBuffer(file);
      return { kind: 'xlsx', sheets: await parseXlsx(buf) };
    }
    if (/\.xls$/.test(low)) {
      const buf = await readArrayBuffer(file);
      return { kind: 'xls', sheets: parseXls(buf) };
    }
    if (/\.(csv|txt|tsv)$/.test(low)) {
      const t = await readTextFile(file);
      return { kind: 'csv', sheets: [{ name: name.replace(/\.[^.]+$/, ''), grid: parseText(t) }] };
    }
    // 未知后缀：先按 ZIP/OLE2 magic 猜，再退回文本
    const buf = await readArrayBuffer(file);
    const b = new Uint8Array(buf);
    if (b[0] === 0x50 && b[1] === 0x4b) return { kind: 'xlsx', sheets: await parseXlsx(buf) };
    if (b[0] === 0xD0 && b[1] === 0xCF) return { kind: 'xls', sheets: parseXls(buf) };
    return { kind: 'csv', sheets: [{ name: '文本', grid: parseText(dec(b, 'utf-8')) }] };
  }

  window.XlsRead = {
    readFile: readFile,
    parseXls: function (buf) { return parseXls(buf); },
    parseXlsx: parseXlsx,
    parseText: parseText,
    oleNames: function (buf) { return oleStreams(buf).names; },
  };
})();
