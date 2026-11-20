/* =========================================================================
 * gate.js —— 一个「够挡住随手点开的人」的前端密码锁
 *
 * ★ 先说清楚它的强度（不要自欺欺人）：
 *   这是**纯前端**的门禁。密码只存哈希、不存明文，看不到源码里的人猜不出密码；
 *   但懂技术的人可以直接改 JS 绕过 —— 这也拦不住，因为没有服务端。
 *   它的真实作用：链接万一被转发出去，别人打开是一片「请输入密码」，看不到任何数据。
 *
 * 想换密码：把下面的 SALT/SHA/FNV 换成新密码算出来的值即可（README 里有算法）。
 * 解锁状态记 30 天，存在 localStorage['benxin.gate.v1']。
 * ========================================================================= */
(function (global) {
  'use strict';

  var SALT = 'benxin-jc-2026';
  var WANT_SHA = '8a10681c200d0d180524341c4630e3157c87825039045a327d0d3a16827a6e0b';
  var WANT_FNV = '63e55c2f88210a0d';
  var LS = 'benxin.gate.v1';
  var TTL = 30 * 24 * 3600 * 1000;      // 30 天免输

  var fails = 0;
  var coolUntil = 0;

  /* ---------------- 哈希：优先 SHA-256（需要安全上下文），否则 FNV-1a ---------------- */

  function fnv1a(str) {
    var b = new TextEncoder().encode(str);
    var h = 0xcbf29ce484222325n;
    var p = 0x100000001b3n;
    var mask = 0xFFFFFFFFFFFFFFFFn;
    for (var i = 0; i < b.length; i++) {
      h = (h ^ BigInt(b[i])) & mask;
      h = (h * p) & mask;
    }
    var hex = h.toString(16);
    while (hex.length < 16) hex = '0' + hex;
    return hex;
  }

  function sha256Hex(str) {
    if (!(global.crypto && crypto.subtle && crypto.subtle.digest)) return Promise.resolve(null);
    var buf = new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      var a = new Uint8Array(d), s = '';
      for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return s;
    }).catch(function () { return null; });
  }

  /* ---------------- 解锁状态的存取 ---------------- */

  function readToken() {
    try {
      var o = JSON.parse(localStorage.getItem(LS) || 'null');
      if (!o || !o.exp || o.exp < Date.now()) return false;
      // 简单签名：改 exp 也会让签名对不上
      if (o.sig !== fnv1a(SALT + '|' + o.exp)) return false;
      return true;
    } catch (e) { return false; }
  }

  function writeToken() {
    try {
      var exp = Date.now() + TTL;
      localStorage.setItem(LS, JSON.stringify({ exp: exp, sig: fnv1a(SALT + '|' + exp) }));
    } catch (e) { /* 存不了就每次都要输，不影响用 */ }
  }

  function clearToken() {
    try { localStorage.removeItem(LS); } catch (e) { }
  }

  /* ---------------- 界面 ---------------- */

  var $ = function (id) { return document.getElementById(id); };

  function unlock() {
    document.body.classList.remove('gate');
    var ov = $('gateOverlay');
    if (ov) ov.remove();
    var inp = $('gateInput');
    if (inp) { inp.value = ''; inp.blur(); }
    global.Gate.unlocked = true;
    document.dispatchEvent(new CustomEvent('gate:unlocked'));
  }

  function shake(msg) {
    var card = $('gateCard');
    var err = $('gateErr');
    if (err) { err.textContent = msg; err.style.opacity = '1'; }
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth;          // 强制重排，动画才能重放
      card.classList.add('shake');
    }
  }

  function check(pwd) {
    if (!pwd) return Promise.resolve(false);
    var msg = SALT + ':' + pwd;
    if (fnv1a(msg) === WANT_FNV) return Promise.resolve(true);
    return sha256Hex(msg).then(function (h) {
      return h === WANT_SHA;
    });
  }

  function submit() {
    var now = Date.now();
    if (now < coolUntil) {
      shake('试太多次了，' + Math.ceil((coolUntil - now) / 1000) + ' 秒后再试');
      return;
    }
    var inp = $('gateInput');
    if (!inp) return;
    var v = String(inp.value || '').trim();
    if (!v) { shake('请输入密码'); return; }

    var btn = $('gateBtn');
    if (btn) { btn.disabled = true; btn.textContent = '核对中…'; }

    check(v).then(function (ok) {
      if (btn) { btn.disabled = false; btn.textContent = '进 入'; }
      if (ok) {
        fails = 0;
        writeToken();
        unlock();
        return;
      }
      fails++;
      inp.value = '';
      inp.focus();
      if (fails >= 5) {
        coolUntil = Date.now() + 30000;
        shake('密码不对（已连续 ' + fails + ' 次）。等 30 秒再试。');
      } else {
        shake('密码不对，再试一次（第 ' + fails + ' 次）');
      }
    });
  }

  function bind() {
    var inp = $('gateInput');
    var btn = $('gateBtn');
    if (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      setTimeout(function () { try { inp.focus(); } catch (e) { } }, 120);
    }
    if (btn) btn.addEventListener('click', submit);

    var forgot = $('gateForgot');
    if (forgot) {
      forgot.addEventListener('click', function () {
        var box = $('gateHint');
        if (!box) return;
        box.classList.toggle('on');
      });
    }
  }

  /* ---------------- 启动 ---------------- */

  var Gate = {
    unlocked: false,
    SALT: SALT,
    lock: function () { clearToken(); location.reload(); },
    submit: submit
  };
  global.Gate = Gate;

  if (readToken()) {
    // 已解锁：立刻摘掉遮罩（在 App 渲染之前同步执行，不会闪一下）
    Gate.unlocked = true;
    document.documentElement.classList.add('unlocked');
    if (document.body) document.body.classList.remove('gate');
    var ov0 = $('gateOverlay');
    if (ov0) ov0.remove();
  } else {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else bind();
  }
})(window);
