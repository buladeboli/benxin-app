/* =========================================================================
 * ui.js — 通用 UI 工具（无依赖）
 * ========================================================================= */
(function (global) {
  'use strict';
  const U = {};

  U.$ = (s, r) => (r || document).querySelector(s);
  U.$$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  U.el = function (tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  };
  U.esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  U.fmt = function (v, n) {
    if (v === '' || v === null || v === undefined) return '';
    const f = Number(v);
    if (!isFinite(f)) return String(v);
    if (n === undefined) n = (Math.abs(f) < 1 && f !== 0) ? 4 : 3;
    const s = f.toFixed(n);
    return s.replace(/\.?0+$/, '') || '0';
  };
  U.pct = function (v, n) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v * 100).toFixed(n === undefined ? 1 : n) + '%';
  };
  U.toast = function (msg, kind, ms) {
    const box = document.getElementById('toast');
    if (!box) return;
    const d = U.el('div', { class: kind || '', text: msg });
    box.appendChild(d);
    setTimeout(function () { d.style.opacity = '0'; d.style.transition = 'opacity .25s'; }, (ms || 2600));
    setTimeout(function () { d.remove(); }, (ms || 2600) + 300);
  };
  U.download = function (filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = U.el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };
  U.pickFile = function (accept, cb) {
    const i = U.el('input', { type: 'file', accept: accept || '' , style: { display: 'none' } });
    i.addEventListener('change', function () { if (i.files && i.files[0]) cb(i.files[0]); i.remove(); });
    document.body.appendChild(i); i.click();
  };
  /** 多选文件（球员库要一次传好几个联赛的表） */
  U.pickFiles = function (accept, cb) {
    const i = U.el('input', { type: 'file', accept: accept || '', multiple: 'multiple', style: { display: 'none' } });
    i.addEventListener('change', function () {
      const fs = [];
      for (let k = 0; k < (i.files ? i.files.length : 0); k++) fs.push(i.files[k]);
      if (fs.length) cb(fs);
      i.remove();
    });
    document.body.appendChild(i); i.click();
  };
  U.copy = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { U.toast('已复制到剪贴板', 'ok'); },
        function () { U.fallbackCopy(text); });
    } else U.fallbackCopy(text);
  };
  U.fallbackCopy = function (text) {
    const t = U.el('textarea', { style: { position: 'fixed', left: '-9999px' } });
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); U.toast('已复制到剪贴板', 'ok'); }
    catch (e) { U.toast('复制失败，请手动选择', 'bad'); }
    t.remove();
  };
  U.pill = function (text, kind) { return '<span class="pill ' + (kind || 'mute') + '">' + U.esc(text) + '</span>'; };
  U.confirmBox = function (msg, cb) {
    if (window.confirm(msg)) cb();
  };

  /** 判断单元格值是不是「已经是 HTML 片段」（按钮 / 小标签 / 进度条等）。
   *  规则：含白名单标签 → 当 HTML 直接输出；含 script / iframe / on*= / javascript: 等
   *  危险内容 → 一律当纯文本转义（防注入）。这样纯文本永远不会漏转义，HTML 也不会被显示成源码。 */
  U.HTML_TAGS = 'span|b|i|em|strong|code|button|input|div|br|a|img|svg|small|section|article|ul|ol|li|p|pre|hr|table|thead|tbody|tr|td|th';
  U.DANGER_HTML = /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|form|base|applet|frame|frameset|template|math)\b|\son[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html/i;
  U.looksHtml = function (v) {
    if (typeof v !== 'string' || v.indexOf('<') < 0) return false;
    if (U.DANGER_HTML.test(v)) return false;
    return new RegExp('<\\s*/?\\s*(' + U.HTML_TAGS + ')\\b', 'i').test(v);
  };

  /** 表格：cols = [{k,n,w,cls,fmt,raw}]  rows = [{...}] */
  U.table = function (cols, rows, opts) {
    opts = opts || {};
    const h = ['<div class="tw"', opts.maxH ? ' style="max-height:' + opts.maxH + '"' : '', '><table><thead><tr>'];
    cols.forEach(function (c) {
      h.push('<th', c.w ? ' style="min-width:' + c.w + '"' : '', '>', U.esc(c.n), '</th>');
    });
    h.push('</tr></thead><tbody>');
    rows.forEach(function (r, i) {
      h.push('<tr>');
      cols.forEach(function (c) {
        let v = typeof c.k === 'function' ? c.k(r, i) : r[c.k];
        let cls = 'td';
        if (c.cls) cls += ' ' + c.cls;
        if (typeof v === 'object' && v !== null) { h.push('<td class="' + (v.cls || '') + '">' + v.html + '</td>'); return; }
        if (c.num) cls += ' num';
        if (c.wrap) cls += ' wrapcell';
        const raw = c.raw || U.looksHtml(v);
        h.push('<td class="' + cls + '">', raw ? v : U.esc(v), '</td>');
      });
      h.push('</tr>');
    });
    if (!rows.length) h.push('<tr><td colspan="' + cols.length + '" style="color:var(--txt-3);padding:14px">暂无数据</td></tr>');
    h.push('</tbody></table></div>');
    return h.join('');
  };

  /** 可编辑行网格：每格可以是 DOM 元素（输入框/下拉/按钮）或字符串。
   *  U.table 只能放字符串或 {html}，凡是要在格子里放控件的都用这个。
   *  cols: [{n, w}]  rows: [[cell, cell, ...], ...] */
  U.grid = function (cols, rows, opts) {
    opts = opts || {};
    const box = U.el('div', { class: 'pl-grid', style: opts.maxH ? { maxHeight: opts.maxH } : null });
    const head = U.el('div', { class: 'pl-head' });
    cols.forEach(function (c) {
      const s = U.el('span', { text: c.n, style: c.w ? { width: c.w, flex: '0 0 ' + c.w } : { flex: '1 1 0' } });
      if (c.num) s.style.textAlign = 'right';
      head.appendChild(s);
    });
    box.appendChild(head);
    rows.forEach(function (r) {
      const row = U.el('div', { class: 'pl-row' });
      cols.forEach(function (c, i) {
        const v = r[i];
        if (v && typeof v === 'object' && v.appendChild) {
          if (c.w && !v.style.width) { v.style.flex = '0 0 ' + c.w; v.style.width = c.w; }
          else if (!c.w) v.style.flex = '1 1 0';
          row.appendChild(v);
        } else {
          const isObj = (typeof v === 'object' && v !== null);
          const html = isObj && v.html !== undefined ? v.html : String(v === undefined || v === null ? '' : v);
          const asHtml = (isObj && v.html !== undefined) || U.looksHtml(v);
          row.appendChild(U.el('span', {
            html: asHtml ? html : U.esc(html),
            style: c.w ? { width: c.w, flex: '0 0 ' + c.w } : { flex: '1 1 0' },
          }));
        }
      });
      box.appendChild(row);
    });
    if (!rows.length) box.appendChild(U.el('div', { class: 'mini', style: { padding: '10px' }, text: '暂无数据' }));
    return box;
  };

  U.chips = function (items, active, onPick, multi) {    const box = U.el('div', { class: 'chips' });
    items.forEach(function (it) {
      const val = typeof it === 'object' ? it.v : it;
      const lab = typeof it === 'object' ? it.n : it;
      const on = multi ? (active || []).indexOf(val) >= 0 : active === val;
      const c = U.el('span', { class: 'chip' + (on ? ' on' : ''), text: lab });
      c.addEventListener('click', function () { onPick(val, c, box); });
      box.appendChild(c);
    });
    return box;
  };

  U.field = function (label, inputEl, hint) {
    const l = U.el('label', { class: 'f' });
    l.appendChild(U.el('span', { class: 'k', html: U.esc(label) + (hint ? ' <span class="mini">' + U.esc(hint) + '</span>' : '') }));
    l.appendChild(inputEl);
    return l;
  };
  U.input = function (val, onInput, attrs) {
    const i = U.el('input', Object.assign({ type: 'text', value: val === null || val === undefined ? '' : String(val) }, attrs || {}));
    if (onInput) i.addEventListener('input', function () { onInput(i.value, i); });
    return i;
  };
  U.number = function (val, onInput, attrs) {
    const i = U.el('input', Object.assign({ type: 'number', value: val === null || val === undefined ? '' : String(val) }, attrs || {}));
    if (onInput) i.addEventListener('input', function () { onInput(i.value === '' ? '' : Number(i.value), i); });
    return i;
  };
  U.select = function (opts, val, onChange, attrs) {
    const s = U.el('select', attrs || {});
    (opts || []).forEach(function (o) {
      const v = typeof o === 'object' ? o.v : o, n = typeof o === 'object' ? o.n : o;
      const op = U.el('option', { value: v }, [String(n)]);
      if (String(v) === String(val)) op.selected = true;
      s.appendChild(op);
    });
    if (onChange) s.addEventListener('change', function () { onChange(s.value, s); });
    return s;
  };
  U.textarea = function (val, onInput, attrs) {
    const t = U.el('textarea', Object.assign({ rows: 8, spellcheck: 'false' }, attrs || {}));
    t.value = val === undefined || val === null ? '' : val;
    if (onInput) t.addEventListener('input', function () { onInput(t.value, t); });
    return t;
  };
  U.btn = function (text, onClick, cls, title) {
    return U.el('button', { class: cls || '', onclick: onClick, title: title || '' }, [text]);
  };
  U.card = function (title, bodyEls, desc, hint) {
    const c = U.el('div', { class: 'card' });
    if (title) {
      const h = U.el('h2');
      h.appendChild(document.createTextNode(title));
      if (hint) h.appendChild(U.el('span', { class: 'hint', text: hint }));
      c.appendChild(h);
    }
    if (desc) c.appendChild(U.el('p', { class: 'desc', text: desc }));
    (bodyEls || []).forEach(function (e) { if (e) c.appendChild(e); });
    return c;
  };
  U.note = function (text, kind) { return U.el('div', { class: 'note ' + (kind || ''), html: text }); };
  U.bar = function (ratio, kind) {
    const p = Math.max(0, Math.min(1, ratio || 0)) * 100;
    return '<div class="bar"><i class="' + (kind || '') + '" style="width:' + p.toFixed(1) + '%"></i></div>';
  };

  /** CSV 解析（支持引号、换行；delim 可显式指定，否则自动识别 , / 制表符 / 全角，） */
  U.parseCSV = function (text, delim) {
    text = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!delim) {
      const cn = (text.match(/，/g) || []).length, en = (text.match(/,/g) || []).length, tb = (text.match(/\t/g) || []).length;
      delim = (tb > en && tb > cn) ? '\t' : (cn > en ? '，' : ',');
    }
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === delim) { row.push(cur); cur = ''; }
        else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += ch;
      }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.length && !(r.length === 1 && r[0].trim() === ''); });
  };

  /** 检测文本用的分隔符（供需要“先切再修”的场景使用） */
  U.detectDelim = function (text) {
    const t = String(text || '');
    const cn = (t.match(/，/g) || []).length, en = (t.match(/,/g) || []).length, tb = (t.match(/\t/g) || []).length;
    if (tb > en && tb > cn) return '\t';
    return cn > en ? '，' : ',';
  };
  U.toCSV = function (headers, rows, quoteAll) {
    const q = function (v) {
      let s = v === null || v === undefined ? '' : String(v);
      if (quoteAll || /[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const out = [headers.map(q).join(',')];
    rows.forEach(function (r) { out.push(headers.map(function (h) { return q(r[h]); }).join(',')); });
    return '\ufeff' + out.join('\r\n');
  };

  /**
   * 手机端适配：给表格的每个单元格补上「表头文字」，并决定这张表在手机上怎么展示。
   *
   *   <td data-th="联赛">西甲</td>   →  手机端渲染成「联赛｜西甲」的两列卡片行
   *   列数 ≥ 5 → table.as-cards  （整表变成一张张卡片，竖着滑）
   *   列数 < 5 → table.as-scroll （保留表格形态，外面横向滚动，不压缩）
   *
   * 因为本项目的表格有三个来源（U.table 生成的、U.grid 生成的 div 表、各模块自己
   * 拼 innerHTML 的表），逐个改太容易漏，所以统一在这里「事后补标」。
   * 幂等：重复调用不会重复写属性。
   */
  U.autoLabelTables = function (root) {
    try {
      var host = root || document;
      var tables = U.$$('table', host);
      tables.forEach(function (t) {
        var ths = U.$$('thead th', t);
        if (!ths.length) return;
        var heads = ths.map(function (th) { return String(th.textContent || '').trim(); });

        U.$$('tbody tr', t).forEach(function (tr) {
          var col = 0;
          for (var k = 0; k < tr.children.length; k++) {
            var td = tr.children[k];
            if (!td || td.tagName !== 'TD') continue;
            if (td.hasAttribute('colspan')) { td.setAttribute('data-nolabel', '1'); continue; }
            if (!td.hasAttribute('data-th')) td.setAttribute('data-th', heads[col] || '');
            col++;
          }
        });

        var wide = heads.length >= 5;
        if (wide) {
          t.classList.add('as-cards');
          t.classList.remove('as-scroll');
        } else {
          t.classList.add('as-scroll');
          t.classList.remove('as-cards');
        }
      });
      return true;
    } catch (e) {
      return false;      // 手机适配出错绝不能影响页面本身
    }
  };

  global.UI = U;
})(window);
