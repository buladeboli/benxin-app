/* =========================================================================
 * pwa.js —— 注册 Service Worker / 提示「可以装到主屏幕」
 *
 * 只在安全上下文（https 或 localhost）里注册。
 * 手机用局域网 IP（http://192.168.x.x）访问时注册不了 —— 这是浏览器规定，
 * 部署到 https 之后自动就好了。
 * ========================================================================= */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!window.isSecureContext && !isLocal) return;      // 不安全上下文注册必然失败，别白试

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
      // 有新版本在等待 → 提示一下（不强制刷新，免得打断正在录的场次）
      reg.addEventListener('updatefound', function () { });
      if (reg.waiting && window.UI && UI.toast) {
        UI.toast('有新版本，下拉刷新即可更新', 'warn', 4000);
      }
    }).catch(function (e) {
      if (window.console) console.warn('[PWA] Service Worker 注册失败：', e && e.message);
    });
  });

  /* ---------- 「添加到主屏幕」提示 ---------- */
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    // 只在手机端弹一次，桌面端不打扰
    var small = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;
    if (!small || !window.UI || localStorage.getItem('benxin.a2hs') === 'never') return;
    setTimeout(function () { showHint(); }, 2500);
  });

  function showHint() {
    if (!deferred) return;
    var box = document.createElement('div');
    box.id = 'a2hs';
    box.innerHTML = '<span>可以装到手机主屏幕，像 App 一样全屏用</span>';
    /* 底部留出空间：Netlify 会在右下角注入「Powered by Netlify」角标，别让它盖住「安装」按钮 */
    /* 放在顶部：底部会挡住正在填写的输入框（真机反馈过），而且会跟 Netlify 角标打架 */
    box.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(58px + env(safe-area-inset-top));' +
      'z-index:150;display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:12px;' +
      'background:#1e2630;border:1px solid #324150;box-shadow:0 10px 30px rgba(0,0,0,.5);font-size:12.5px;color:#e6edf3';
    var b1 = document.createElement('button');
    b1.textContent = '安装';
    b1.style.cssText = 'flex:0 0 auto;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid #4d9cf6;' +
      'background:#2f7fd6;color:#fff;font:inherit;font-weight:600';
    var b2 = document.createElement('button');
    b2.textContent = '以后再说';
    b2.style.cssText = 'flex:0 0 auto;min-height:36px;padding:0 12px;border-radius:8px;border:1px solid #324150;' +
      'background:transparent;color:#a8b6c4;font:inherit';
    box.appendChild(b1); box.appendChild(b2);
    document.body.appendChild(box);

    b1.addEventListener('click', function () {
      kill();
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; });
    });
    /* 9 秒后自动收起，避免长期占用屏幕顶部 */
    var autoHide = setTimeout(function () { if (box.parentNode) box.remove(); }, 9000);
    function kill() { clearTimeout(autoHide); if (box.parentNode) box.remove(); }

    b2.addEventListener('click', function () {
      kill();
      try { localStorage.setItem('benxin.a2hs', 'never'); } catch (e) { }
    });
  }

  window.addEventListener('appinstalled', function () {
    try { localStorage.setItem('benxin.a2hs', 'never'); } catch (e) { }
    var b = document.getElementById('a2hs');
    if (b) b.remove();
  });
})();
