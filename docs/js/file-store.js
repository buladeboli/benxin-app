/* =========================================================================
 * file-store.js —— 把记录写进「手机本地的文件夹」
 *
 * 现实（不要自欺欺人）：
 *   · showDirectoryPicker()（选一个用户看得见的真实文件夹）只有**桌面版** Chromium 有；
 *     安卓 Chrome / 苹果 Safari 都不支持 —— 这是浏览器安全策略，不是能绕过去的。
 *   · OPFS（navigator.storage.getDirectory）全平台都有：它是浏览器自己的私有文件系统，
 *     算「手机本地的一个文件夹」，关掉再开数据还在，但用户在系统文件管理器里看不到。
 *   · navigator.share：手机上有，可以把导出的文件分享到「文件」App / 微信 / 随便哪。
 *
 * 于是分三档：
 *   mode = 'dir'   桌面浏览器选了文件夹  → 真·写进你能看到的文件夹
 *   mode = 'opfs'  手机/其它            → 写进 OPFS（私有文件夹）
 *   mode = 'none'  都不支持             → 只留 localStorage，并提示「导出成文件」
 *
 * 对外接口（window.FileStore）：
 *   detect()        同步探测能力
 *   init()          异步准备（OS 里恢复已授权的文件夹 handle）
 *   ready()         Promise，等 init 完成
 *   pickFolder()    让用户挑一个文件夹（仅桌面）
 *   sync()          立即写一次
 *   autoSync()      防抖写（给每次保存用）
 *   list()          列出 OPFS 里的文件
 *   payload()       生成给电脑端导入的 JSON 文本
 *   download()      导出成文件（下载 / 分享）
 *   status()        当前状态（界面显示用）
 * ========================================================================= */
(function (global) {
  'use strict';

  var FOLDER = '本心盘口';
  var FILE_MAIN = '本心手机端记录.json';
  var FILE_NOTE = '最近一次保存.txt';

  var st = {
    dirPicker: false,
    opfs: false,
    secure: false,
    share: false,
    mode: 'none',        // dir | opfs | none
    inited: false,       // init() 是否已完成（界面据此决定要不要"再刷新一次"）
    dirName: '',
    lastAt: '',
    lastName: '',
    lastCount: 0,
    lastError: '',
    writing: false
  };

  var _opfsRoot = null;      // FileSystemDirectoryHandle（OPFS 根）
  var _dirHandle = null;     // 用户挑的文件夹
  var _ready = null;
  var _timer = null;

  /* ---------------------------------------------------------- 能力探测 */

  function detect() {
    st.secure = !!global.isSecureContext;
    st.opfs = !!(navigator.storage && navigator.storage.getDirectory);
    st.dirPicker = (typeof global.showDirectoryPicker === 'function');
    st.share = (typeof navigator.share === 'function');
    return st;
  }

  /* ---------------------------------------------------------- IndexedDB（存目录 handle） */

  function idb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('没有 IndexedDB'));
      var req = indexedDB.open('benxin_fs', 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readonly');
        var r = tx.objectStore('kv').get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function idbSet(key, val) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  /* ---------------------------------------------------------- OPFS */

  function opfsRoot() {
    if (_opfsRoot) return Promise.resolve(_opfsRoot);
    if (!st.opfs) return Promise.resolve(null);
    return navigator.storage.getDirectory().then(function (root) {
      _opfsRoot = root;
      return root;
    }, function () { return null; });
  }

  function opfsDir() {
    return opfsRoot().then(function (root) {
      if (!root) return null;
      return root.getDirectoryHandle(FOLDER, { create: true });
    }).catch(function () { return null; });
  }

  /* ---------------------------------------------------------- 写文件（统一入口） */

  function writeTo(dirHandle, name, text) {
    return dirHandle.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) {
        return w.write(new Blob([text], { type: 'application/json;charset=utf-8' }))
          .then(function () { return w.close(); });
      })
      .then(function () { return name; });
  }

  /* ---------------------------------------------------------- 初始化 */

  function init() {
    if (_ready) return _ready;
    detect();
    if (!st.opfs && !st.dirPicker) {
      st.mode = 'none';
      st.inited = true;
      _ready = Promise.resolve(st);
      return _ready;
    }
    _ready = opfsRoot().then(function () {
      // 手机/默认走 OPFS
      if (st.opfs) { st.mode = 'opfs'; }
      else st.mode = 'none';

      // 桌面浏览器：如果以前挑过文件夹，恢复它（权限可能需要在交互里再确认）
      if (!st.dirPicker) return null;
      return idbGet('dirHandle').then(function (h) {
        if (!h) return null;
        return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
          if (p === 'granted') {
            _dirHandle = h;
            st.dirName = h.name || '（已选文件夹）';
            st.mode = 'dir';
          }
          return null;
        }, function () { return null; });
      });
    }).catch(function (e) {
      st.lastError = e && e.message || String(e);
      st.mode = 'none';
      return null;
    }).then(function () { st.inited = true; return st; });
    return _ready;
  }

  /** 让用户挑一个文件夹（仅桌面浏览器）。返回 Promise<boolean> */
  function pickFolder() {
    detect();
    if (!st.dirPicker) {
      return Promise.reject(new Error(
        '这个浏览器不支持「选择文件夹」。手机上的浏览器（安卓 Chrome / 苹果 Safari）都不支持 —— ' +
        '这是浏览器的安全限制。用「导出文件」把它存到手机的下载/文件里，再传电脑即可。'));
    }
    return global.showDirectoryPicker({ id: 'benxin', mode: 'readwrite', startIn: 'documents' })
      .then(function (h) {
        _dirHandle = h;
        st.dirName = h.name || '（已选文件夹）';
        st.mode = 'dir';
        return idbSet('dirHandle', h).then(function () { return true; });
      });
  }

  /* ---------------------------------------------------------- 数据 → 文本 */

  /**
   * 生成给【电脑端】导入的 JSON。
   * 格式 = **输入对象数组**（每项就是 Core 的 81 个字段 + note）。
   * 电脑端 mod-io.js 的 rowsToInputs() 原生认这个形状（会提示「识别为 JSON 数组」），
   * 所以电脑端一行代码都不用改，选文件 → 确认导入即可。
   */
  function payload() {
    var C = global.Core;
    if (!C || !C.store) return '[]';
    var rows = (C.store.rows || []).map(function (r) {
      var o = {};
      for (var k in r.inp) {
        if (r.inp[k] !== '' && r.inp[k] !== undefined && r.inp[k] !== null) o[k] = r.inp[k];
      }
      o.note = r.note || r.inp.note || '';
      return o;
    });
    return JSON.stringify(rows);
  }

  function stampText(reason) {
    var C = global.Core;
    var n = (C && C.store && C.store.rows) ? C.store.rows.length : 0;
    return [
      '本心盘口 · 手机端本地保存记录',
      '时间：' + new Date().toLocaleString('zh-CN'),
      '条数：' + n + ' 条',
      '触发：' + (reason || '保存'),
      '',
      '说明：同目录下的「' + FILE_MAIN + '」是给电脑端导入用的数据文件；',
      '本文件只是「刚才确实写进去了」的凭证。'
    ].join('\n');
  }

  /* ---------------------------------------------------------- 同步写入 */

  function sync(reason) {
    detect();
    var C = global.Core;
    if (!C || !C.store) return Promise.resolve(false);

    var json = payload();
    var note = stampText(reason);
    var dir = (st.mode === 'dir' && _dirHandle) ? Promise.resolve(_dirHandle) : null;

    if (!dir && st.mode !== 'opfs') {
      // 什么都没有：至少让状态有个说法
      return Promise.resolve(false);
    }

    st.writing = true;
    var target = dir || opfsDir();
    return target.then(function (dh) {
      if (!dh) throw new Error('拿不到文件夹句柄');
      return writeTo(dh, FILE_MAIN, json).then(function () {
        return writeTo(dh, FILE_NOTE, note);
      });
    }).then(function () {
      st.lastAt = new Date().toLocaleString('zh-CN');
      st.lastName = FILE_MAIN;
      st.lastCount = (C.store.rows || []).length;
      st.lastError = '';
      st.writing = false;
      return true;
    }).catch(function (e) {
      st.writing = false;
      st.lastError = (e && e.message) || String(e);
      // 目录句柄失效（比如用户删了文件夹）→ 退回 OPFS，别把数据丢了
      if (st.mode === 'dir') {
        _dirHandle = null;
        st.mode = st.opfs ? 'opfs' : 'none';
        st.dirName = '';
        if (st.mode === 'opfs') return sync(reason);
      }
      return false;
    });
  }

  /** 防抖：每次保存都会调它，0.5 秒内多次保存只写一次 */
  function autoSync(reason) {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () {
      _timer = null;
      sync(reason || '自动保存');
    }, 500);
    return true;
  }

  /* ---------------------------------------------------------- 列文件 / 导出 */

  function list() {
    if (st.mode === 'dir' && _dirHandle) {
      return listOf(_dirHandle);
    }
    if (st.mode === 'opfs') {
      return opfsDir().then(function (d) { return d ? listOf(d) : []; });
    }
    return Promise.resolve([]);
  }

  function listOf(dirHandle) {
    var out = [];
    if (!dirHandle.entries) return Promise.resolve(out);
    var it = dirHandle.entries();
    function step() {
      return it.next().then(function (r) {
        if (r.done) {
          out.sort(function (a, b) { return b.mtime - a.mtime; });
          return out;
        }
        var name = r.value[0], handle = r.value[1];
        if (handle.kind !== 'file') return step();
        return handle.getFile().then(function (f) {
          out.push({ name: name, size: f.size, mtime: f.lastModified });
          return step();
        }, step);
      });
    }
    return step().catch(function () { return out; });
  }

  function fileName() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return '本心手机端记录_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.json';
  }

  /** 导出成文件：优先用系统分享（手机），否则下载 */
  function download() {
    var json = payload();
    var C = global.Core;
    var n = (C && C.store && C.store.rows) ? C.store.rows.length : 0;
    if (!n) return Promise.resolve('empty');

    var name = fileName();
    if (st.share && navigator.canShare) {
      try {
        var file = new File([json], name, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: name, text: '本心盘口 · 手机端记录 ' + n + ' 条' })
            .then(function () { return 'shared'; })
            .catch(function () { return fallbackDownload(json, name); });
        }
      } catch (e) { /* 走下载 */ }
    }
    return Promise.resolve(fallbackDownload(json, name));
  }

  function fallbackDownload(json, name) {
    if (global.UI && UI.download) {
      UI.download(name, json, 'application/json;charset=utf-8');
      return 'downloaded';
    }
    return 'failed';
  }

  function status() {
    return {
      mode: st.mode, inited: st.inited, dirName: st.dirName, lastAt: st.lastAt, lastName: st.lastName,
      lastCount: st.lastCount, lastError: st.lastError, writing: st.writing,
      dirPicker: st.dirPicker, opfs: st.opfs, share: st.share, secure: st.secure,
      folder: FOLDER, mainFile: FILE_MAIN
    };
  }

  global.FileStore = {
    FOLDER: FOLDER,
    FILE_MAIN: FILE_MAIN,
    state: st,
    detect: detect,
    init: init,
    ready: function () { return _ready || init(); },
    pickFolder: pickFolder,
    sync: sync,
    autoSync: autoSync,
    list: list,
    payload: payload,
    download: download,
    status: status
  };
})(window);
