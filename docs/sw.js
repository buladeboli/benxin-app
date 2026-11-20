/* =========================================================================
 * sw.js —— Service Worker（让网页能离线打开、能装到手机主屏幕）
 *
 * 策略：
 *   · 静态资源（js/png/manifest/首页）   → 预缓存 + 「缓存优先」，秒开
 *   · 页面导航（index.html）             → 「网络优先」，失败退回缓存的首页
 *   · 非 GET、非本站请求（比如 127.0.0.1 的抓取接口）→ 一律放行，不拦不缓存
 *
 * 改了任何 js/css/html 之后，把下面的 VERSION 改一下，用户下次打开就会更新缓存。
 * ========================================================================= */
const VERSION = 'benxin-v15.12.0';
const CACHE = VERSION;

/** 首次安装就预缓存的资源（相对路径，跟着部署目录走） */
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
  './js/gate.js',
  './js/core.js',
  './js/ui.js',
  './js/xlsread.js',
  './js/seed.js',
  './js/seed-players.js',
  './js/app.js',
  './js/file-store.js',
  './js/vz-api.js',
  './js/mod-players.js',
  './js/mod-io.js',
  './js/mod-dash.js',
  './js/mod-entry.js',
  './js/mod-batch.js',
  './js/mod-stats.js',
  './js/mod-bet.js',
  './js/mod-params.js',
  './js/mod-export.js',
  './js/mod-ai.js',
  './js/jc-calc.js',
  './js/mod-jc.js',
  './js/mod-help.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => null)              // 个别文件 404 也不要让安装整体失败
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // 只处理自家域名的 GET
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // 抓取接口（127.0.0.1:8765）直接放行

  // 页面导航：网络优先，断网时用缓存
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => { });
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 其它静态资源：缓存优先（并且后台顺手更新一份）
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => { });
        }
        return res;
      }).catch(() => hit);
    })
  );
});
