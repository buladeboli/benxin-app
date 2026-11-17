# -*- coding: utf-8 -*-
"""
server.py —— 竞彩数据服务（本心盘口 · 竞彩选票模块的后端）

只做三件事：
  1. 把「网页」目录（也就是本心盘口那个单页应用）当静态站服务出来
       → 浏览器打开 http://127.0.0.1:8765/ 就是完整的模型 + 竞彩选票模块
       → 好处：页面和接口**同源**，不会再有「Failed to fetch / 跨域」的问题
  2. 提供数据接口
       GET /api/health   连通性探测（前端用它判断后端在不在）
       GET /api/data     读缓存（页面一打开就用它，不发网络请求）
       GET /api/refresh  真抓一次（会写缓存）
       GET /api/sources  看看有哪些抓取源
  3. 零依赖：只用 Python 自带的 http.server，不用 Flask、不用 requests

启动：双击「启动.bat」，或  python server.py
自检：python server.py --doctor     （不启动服务，只打印环境体检）
"""

import json
import os
import socket
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ★ 控制台编码：Windows 默认 GBK 时，打印 ✔ / 中文符号会直接 UnicodeEncodeError 把服务打挂。
#   （这就是"黑窗口一闪就消失"最常见的原因）
#   ★ 现在优先跟随控制台本身的编码（中文 Windows 是 cp936/GBK）：
#     之前无条件改成 utf-8，导致黑窗口里的中文全变成乱码 —— 用户根本看不懂提示。
def _console_enc():
    for cand in ("cp936", "gbk", "mbcs"):
        try:
            "中文".encode(cand)
            return cand
        except Exception:                   # noqa: BLE001
            continue
    return "utf-8"


_ENC = _console_enc()
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding=_ENC, errors="replace")
    except Exception:                       # noqa: BLE001
        pass

import scraper
try:
    import titan_db
except Exception:                      # noqa: BLE001
    titan_db = None
try:
    import tm_db
except Exception:                      # noqa: BLE001
    tm_db = None
try:
    import tm_injury
except Exception:                      # noqa: BLE001
    tm_injury = None
try:
    import titan_injury
except Exception:                      # noqa: BLE001
    titan_injury = None

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_PORT = 8765
MIN_REFRESH_GAP = 8.0          # 两次手动刷新至少间隔 8 秒
MAX_PORT_TRIES = 20

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}

_state = {
    "last_fetch_at": 0.0,
    "last_payload": None,
    "lock": threading.Lock(),
}

# ---------------------------------------------------------------- 球队/球员库（titan007）
# ★ 这件事只能由后端做：zq.titan007.com 只支持 TLS 1.0，浏览器里 fetch 根本握不上手。
#   而且它限流很凶（连续请求会让 IP 被临时断连），所以做成「后台线程 + 状态轮询 + 断点续抓」。
_titan = {
    "running": False, "done": 0, "total": 0, "msg": "", "error": "",
    "started_at": 0.0, "finished_at": "", "leagues": [], "source": "tm", "season": "",
    "lock": threading.Lock(),
}


def _titan_state_dict():
    with _titan["lock"]:
        return {
            "ok": True,
            "available": titan_db is not None,
            "running": _titan["running"],
            "done": _titan["done"],
            "total": _titan["total"],
            "msg": _titan["msg"],
            "error": _titan["error"],
            "leagues": list(_titan["leagues"]),
            "source": _titan.get("source", "tm"),
            "season": _titan.get("season", ""),
            "elapsed": round(time.time() - _titan["started_at"], 1) if _titan["started_at"] else 0,
            "finished_at": _titan["finished_at"],
        }


def _titan_worker(leagues, force, source="tm", season=None):
    def prog(done, total, msg):
        with _titan["lock"]:
            _titan["done"] = done
            _titan["total"] = total
            _titan["msg"] = msg
        print("  [titan] " + msg, flush=True)

    try:
        if source == "titan":
            db = titan_db.build(leagues, want_players=True, progress=prog,
                                force=force, spacing=1.2)
            s = titan_db.summary(db)
        else:
            db = tm_db.build(leagues, season=season or None, want_players=True,
                             progress=prog, force=force, spacing=0.5)
            s = tm_db.summary(db)
        with _titan["lock"]:
            _titan["msg"] = "完成：%d 联赛 / %d 球队 / %d 球员" % (s["leagues"], s["teams"], s["players"])
            _titan["finished_at"] = s.get("updated_at", "")
    except Exception as e:                  # noqa: BLE001
        with _titan["lock"]:
            _titan["error"] = "%s: %s" % (type(e).__name__, e)
            _titan["msg"] = "出错：" + str(e)
        print("  [titan] 出错：" + str(e), flush=True)
    finally:
        with _titan["lock"]:
            _titan["running"] = False


# ---------------------------------------------------------------- 定位「网页」目录

def find_spa_dir():
    """找本心盘口那个单页应用所在的目录（里面有 index.html）。"""
    cands = []
    env_dir = os.environ.get("SPA_DIR")
    if env_dir:
        cands.append(env_dir)                          # 云端部署可以指到任意目录
    cands += [
        os.path.join(HERE, "web"),                     # ★ 云端部署（仓库里叫 web/）
        os.path.join(os.path.dirname(HERE), "网页"),   # 本地：和本文件夹同级
        os.path.join(HERE, "网页"),
        os.path.join(HERE, "public"),
    ]
    for c in cands:
        c = os.path.abspath(c)
        if os.path.isfile(os.path.join(c, "index.html")):
            return c
    return None


SPA_DIR = find_spa_dir()


# ---------------------------------------------------------------- 工具

def _json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def lan_ip():
    """本机在局域网里的 IP（手机用这个访问）；取不到就回 127.0.0.1"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("223.5.5.5", 80))
            return s.getsockname()[0]
    except Exception:                      # noqa: BLE001
        return "127.0.0.1"


def want_lan():
    """要不要对局域网开放：JC_LAN=1 或命令行带 --lan"""
    if "--lan" in sys.argv:
        return True
    return (os.environ.get("JC_LAN") or "").strip() in ("1", "true", "yes", "on")


BIND_HOST = "0.0.0.0"


def pick_port(start, tries=MAX_PORT_TRIES):
    if os.environ.get("PORT"):
        return int(os.environ["PORT"])              # 云端用平台给的端口，不探测
    host = BIND_HOST if want_lan() else "127.0.0.1"
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    return start


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "BenxinJC/1.1"
    # HTTP/1.1 + 每条响应都带 Content-Length：连接能复用，Node/PowerShell 的客户端也不会
    # 因为"服务器说完话就断线"而报底层解析错误。
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        if code != 204:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # 允许从 file:// 打开页面时也能取到数据（Origin 会是 null）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if code == 204:
            return
        try:
            self.wfile.write(body)
        except Exception:                       # noqa: BLE001
            pass

    def _auth_ok(self):
        """
        公网部署的访问令牌：环境变量 JC_TOKEN 设了才启用。
          · /api/health 永远放行（平台健康检查要用）
          · 其它 /api/* 必须带 ?k=令牌 或请求头 X-BX-Token
          · 静态文件（网页本身）也要求带 k，避免别人白拿你的后端页面
        本地不设 JC_TOKEN → 完全不拦（和以前一样）。
        """
        token = (os.environ.get("JC_TOKEN") or "").strip()
        if not token:
            return True
        path = urlparse(self.path).path
        if path == "/api/health":
            return True
        q = parse_qs(urlparse(self.path).query)
        got = (q.get("k") or [""])[0] or (self.headers.get("X-BX-Token") or "")
        return str(got).strip() == token

    def _deny(self):
        body = ("<!DOCTYPE html><meta charset=utf-8>"
                "<h3>需要访问令牌</h3>"
                "<p>这个地址是受保护的。请用带令牌的链接打开：<br>"
                "<code>本地址 + /?k=你的令牌</code></p>"
                "<p>令牌就是部署时设的 <code>JC_TOKEN</code> 环境变量的值。</p>").encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, _json_bytes(obj))

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/" in msg:
            sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
            sys.stdout.flush()

    # ------- 路由 -------
    def do_OPTIONS(self):
        self._send(204, b"")

    def do_POST(self):
        if not self._auth_ok():
            return self._deny()
        path = urlparse(self.path).path
        if path == "/api/titan/refresh":
            return self._api_titan_refresh()
        if path == "/api/tm/injuries":
            return self._api_tm_injuries()
        if path == "/api/titan/injury":
            return self._api_titan_injury()
        if path == "/api/store":
            return self._api_store()
        return self._json({"ok": False, "error": "不支持的 POST 接口"}, 404)

    def do_GET(self):
        if not self._auth_ok():
            return self._deny()
        path = urlparse(self.path).path

        if path == "/api/health":
            return self._json(scraper.health())
        if path == "/api/sources":
            return self._json({
                "ok": True,
                "jczq": scraper.SOURCES_JCZQ,
                "sfc": scraper.SOURCES_SFC,
            })
        if path == "/api/data":
            with _state["lock"]:
                if _state["last_payload"]:
                    return self._json(_state["last_payload"])
            return self._json(scraper.load_cache_only())
        if path == "/api/refresh":
            return self._api_refresh()
        if path == "/api/tm/injuries":
            return self._api_tm_injuries()
        if path == "/api/titan/injury":
            return self._api_titan_injury()
        if path == "/api/store":
            return self._api_store()
        if path == "/api/titan/db":
            return self._api_titan_db()
        if path == "/api/titan/status":
            return self._json(_titan_state_dict())

        return self._serve_static(path)

    # ------- 数据 -------
    def _api_refresh(self):
        if not _state["lock"].acquire(timeout=60):
            return self._json({"ok": False, "errors": ["上一次抓取还在进行中，稍等几秒"],
                               "jczq": [], "sfc": {"expect": "", "matches": [], "deadline": ""},
                               "sources": [], "ts": time.strftime("%Y-%m-%d %H:%M:%S")})
        try:
            gap = time.time() - _state["last_fetch_at"]
            if gap < MIN_REFRESH_GAP:
                payload = dict(_state["last_payload"] or scraper.load_cache_only())
                payload["errors"] = list(payload.get("errors") or []) + [
                    "点太快了（%.1f 秒内点了两次），先把上次的结果给你；赔率变了你再点一次就好。" % gap]
                payload["throttled"] = round(MIN_REFRESH_GAP - gap, 1)
                return self._json(payload)

            _state["last_fetch_at"] = time.time()
            payload = scraper.scrape()
            _state["last_payload"] = payload
            return self._json(payload)
        except Exception as e:                  # noqa: BLE001
            return self._json({
                "ok": False,
                "errors": ["后端异常：%s: %s" % (type(e).__name__, e)],
                "jczq": [], "sfc": {"expect": "", "matches": [], "deadline": ""},
                "sources": [], "ts": time.strftime("%Y-%m-%d %H:%M:%S"), "from_cache": False,
            })
        finally:
            _state["lock"].release()

    # ------- 球队/球员库 -------
    STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "store.json")

    def _api_store(self):
        """
        数据桥：不同入口（file:// / 127.0.0.1 / 手机局域网）是**不同的 localStorage**，
        这里用一个本机文件当"中转站"，把某个页面的数据整包上传/下载。

          POST /api/store   body = {rows, params, lib, players, settings, at}
          GET  /api/store   → 同一份；没有就返回 {ok:false, error:"还没有上传过"}
        """
        path = self.STORE_PATH
        if self.command == "GET":
            try:
                with open(path, encoding="utf-8") as f:
                    j = json.load(f)
                return self._json({"ok": True, "data": j, "size": os.path.getsize(path)})
            except Exception:              # noqa: BLE001
                return self._json({"ok": False, "error": "还没有上传过数据（先在某个页面点「⬆ 上传本页数据到本机」）"})
        # POST
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            j = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:             # noqa: BLE001
            return self._json({"ok": False, "error": "数据解析失败：%s" % e})
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(j, f, ensure_ascii=False)
            os.replace(tmp, path)
            return self._json({"ok": True, "size": os.path.getsize(path),
                               "at": j.get("at", ""),
                               "rows": len(j.get("rows") or [])})
        except Exception as e:             # noqa: BLE001
            return self._json({"ok": False, "error": "写入失败：%s" % e})

    def _api_titan_injury(self):
        """
        从球探抓一场比赛的【伤停号码 + 上一场首发/替补】

        GET  /api/titan/injury?match=<比赛ID或 analysis 链接>[&force=1]
        POST /api/titan/injury  body {match, force}
        返回：{ok, matchId, home:{name,out[],starters[],subs[]}, away:{...}, cached}
        """
        if titan_injury is None:
            return self._json({"ok": False, "error": "titan_injury.py 没加载"})
        try:
            if self.command == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
            else:
                q = parse_qs(urlparse(self.path).query)
                body = {k: (v[0] if v else "") for k, v in q.items()}
        except Exception as e:                 # noqa: BLE001
            return self._json({"ok": False, "error": "参数解析失败：%s" % e})

        match = str(body.get("match") or "").strip()
        if not match:
            return self._json({"ok": False, "error": "请传 match（比赛ID 或 analysis 链接）"})
        force = str(body.get("force") or "").strip() in ("1", "true", "yes")
        try:
            data = titan_injury.get(match, force=force)
        except Exception as e:                 # noqa: BLE001
            return self._json({"ok": False, "error": str(e)})
        out = {"ok": True}
        out.update(data)
        out["text"] = titan_injury._fmt(data["home"]) + "\n\n" + titan_injury._fmt(data["away"])
        return self._json(out)

    def _api_tm_injuries(self):
        """
        用 Transfermarkt 自动算「伤病修正 / 阵容深度 / 停赛修正」

        body / query: {league, home, away, homeTm, awayTm}
          league  你的联赛名（要和 TM 库里的一致，如 英超）
          home/away  中文队名（展示用）
          homeTm/awayTm  TM 英文原名（优先用它去库里找队）
        """
        if tm_injury is None:
            return self._json({"ok": False, "error": "tm_injury.py 没加载"})
        try:
            if self.command == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
            else:
                q = parse_qs(urlparse(self.path).query)
                body = {k: (v[0] if v else "") for k, v in q.items()}
        except Exception as e:                 # noqa: BLE001
            return self._json({"ok": False, "error": "参数解析失败：%s" % e})

        league = str(body.get("league") or "").strip()
        home = str(body.get("home") or "").strip()
        away = str(body.get("away") or "").strip()
        if not league or not home or not away:
            return self._json({"ok": False, "error": "请传 league / home / away"})

        try:
            res = tm_injury.compute(
                league, home, away,
                home_tm=str(body.get("homeTm") or "").strip() or None,
                away_tm=str(body.get("awayTm") or "").strip() or None,
                home_squad=body.get("homeSquad") or None,
                away_squad=body.get("awaySquad") or None,
            )
        except Exception as e:                 # noqa: BLE001
            return self._json({"ok": False, "error": "抓取出错：%s" % e})
        res["text"] = (
            tm_injury._fmt_one(res["home"]) + "\n\n" + tm_injury._fmt_one(res["away"])
            if res.get("ok") else ""
        )
        return self._json(res)

    def _api_titan_db(self):
        q = parse_qs(urlparse(self.path).query)
        source = (q.get("source") or ["tm"])[0]
        mod = tm_db if (source == "tm" and tm_db is not None) else titan_db
        if mod is None:
            return self._json({"ok": False, "error": "数据源模块没加载（文件被删了？）"})
        db = mod.load()
        s = mod.summary(db)
        s["source"] = source if source in ("tm", "titan") else "titan"
        rows = []
        for name, v in ((db or {}).get("leagues") or {}).items():
            teams = v.get("teams") or []
            rows.append({
                "name": name,
                "label": v.get("label") or name,
                "tm_id": v.get("tm_id", ""),
                "season": v.get("season", ""),
                "season_name": v.get("season_name", ""),
                "teams": len(teams),
                "players": sum(len(t.get("players") or []) for t in teams),
                "coach": sum(1 for t in teams if t.get("coach")),
                "changes": sum(1 for t in teams if (t.get("changes") or {}).get("added") or (t.get("changes") or {}).get("removed")),
                # ★ 2A：把"谁进谁出"的明细一起给前端（不然只有一个数字）
                "changeList": [
                    {
                        "team": t.get("name", ""),
                        "at": (t.get("changes") or {}).get("at", ""),
                        "added": (t.get("changes") or {}).get("added") or [],
                        "removed": (t.get("changes") or {}).get("removed") or [],
                    }
                    for t in teams
                    if ((t.get("changes") or {}).get("added") or (t.get("changes") or {}).get("removed"))
                ],
            })
        out = {
            "ok": True,
            "summary": s,
            "leagues": rows,
            "warn": (db or {}).get("warn") or [],
            "status": _titan_state_dict(),
        }
        # ?full=1 → 连完整阵容一起给（"导入到球员库"要用）
        if (q.get("full") or [""])[0] == "1":
            out["raw"] = db or {}
        return self._json(out)

    def _api_titan_refresh(self):
        if titan_db is None:
            return self._json({"ok": False, "error": "titan_db.py 没加载"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except Exception:                   # noqa: BLE001
            body = {}
        leagues = [str(x).strip() for x in (body.get("leagues") or []) if str(x).strip()]
        force = bool(body.get("force"))
        source = str(body.get("source") or "tm")
        season = str(body.get("season") or "").strip() or None
        if source == "tm" and tm_db is None:
            return self._json({"ok": False, "error": "tm_db.py 没加载"})
        if source == "titan" and titan_db is None:
            return self._json({"ok": False, "error": "titan_db.py 没加载"})
        if not leagues:
            return self._json({"ok": False, "error": "请传 leagues 数组，例如 [\"英超\",\"西甲\"]"})
        with _titan["lock"]:
            if _titan["running"]:
                return self._json({"ok": False, "error": "上一次更新还在跑，等它结束再点"})
            _titan.update({
                "running": True, "done": 0, "total": 0, "msg": "准备中…",
                "started_at": time.time(), "finished_at": "", "error": "",
                "leagues": leagues, "source": source, "season": season or "",
            })
        threading.Thread(target=_titan_worker,
                         args=(leagues, force, source, season), daemon=True).start()
        print("  [titan] 开始更新：" + ",".join(leagues), flush=True)
        return self._json({"ok": True, "started": True, "leagues": leagues, "force": force})

    # ------- 静态文件（本心盘口 SPA） -------
    def _serve_static(self, path):
        if SPA_DIR is None:
            return self._send(500, (
                "<meta charset=utf-8><h3>没找到「网页」目录</h3>"
                "<p>把 <code>竞彩计算器</code> 和 <code>网页</code> 放在同一个文件夹里，"
                "或者直接用浏览器打开 <code>网页/index.html</code>（那样需要允许跨域）。</p>"
                "<p>接口是好的：<a href='/api/health'>/api/health</a></p>"), "text/html; charset=utf-8")

        rel = path.lstrip("/")
        if rel == "":
            rel = "index.html"
        if rel == "favicon.ico":
            return self._send(204, b"")

        full = os.path.abspath(os.path.join(SPA_DIR, rel))
        if not full.startswith(SPA_DIR):
            return self._send(403, "forbidden", "text/plain; charset=utf-8")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._send(404, (
                "<meta charset=utf-8><h3>404 · 没有这个文件</h3><p><code>%s</code></p>"
                "<p><a href='/'>回首页</a></p>" % rel), "text/html; charset=utf-8")

        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        return self._send(200, data, MIME.get(ext, "application/octet-stream"))


# ---------------------------------------------------------------- 体检

def doctor():
    print("=" * 66)
    print("  竞彩数据服务 · 环境体检")
    print("=" * 66)
    print("  Python            : %d.%d.%d  (%s)" % (sys.version_info[:3] + (sys.executable,)))
    print("  工作目录           : %s" % HERE)
    print("  抓取源             :")
    for s in scraper.SOURCES_JCZQ + scraper.SOURCES_SFC:
        print("      - %-46s %s" % (s["name"], s["url"]))
    print("  缓存文件           : %s  (%s)"
          % (scraper.CACHE_FILE, "有" if os.path.isfile(scraper.CACHE_FILE) else "还没有"))

    if SPA_DIR:
        print("  「网页」目录        : [OK] %s" % SPA_DIR)
    else:
        print("  「网页」目录        : [X] 没找到！请把 竞彩计算器 和 网页 放在同一个文件夹")

    port = pick_port(DEFAULT_PORT, tries=1)
    if port == DEFAULT_PORT:
        print("  端口 %d           : [OK] 空闲" % DEFAULT_PORT)
    else:
        print("  端口 %d           : 被占用，启动时会自动往后找" % DEFAULT_PORT)

    # 能不能连上 500
    print("  连接 trade.500.com : ", end="")
    try:
        with socket.create_connection(("trade.500.com", 443), timeout=6) as s:
            s.close()
        print("[OK] 通")
    except Exception as e:                      # noqa: BLE001
        print("[X] 不通（%s）—— 检查网络/代理/防火墙" % e)

    print("=" * 66)
    print("  体检完成。直接运行 python server.py 就是正常启动。")
    print("=" * 66)


# ---------------------------------------------------------------- 启动

def main():
    if "--doctor" in sys.argv:
        return doctor()

    cloud = bool(os.environ.get("PORT"))            # ★ Render/Railway 会注入 PORT
    if cloud:
        port = int(os.environ["PORT"])
        lan = True                                  # 绑 0.0.0.0
    else:
        start = int(os.environ.get("JC_PORT") or DEFAULT_PORT)
        port = pick_port(start)
        lan = want_lan()
    url = "http://127.0.0.1:%d/" % port

    print("=" * 66)
    print("  竞彩数据服务（本心盘口 · 竞彩选票模块）")
    print("=" * 66)
    print("  页面地址 : %s" % url)
    if SPA_DIR:
        print("  静态目录 : %s" % SPA_DIR)
    else:
        print("  静态目录 : 未找到「网页」目录 —— 只能用 /api/* 接口")
    print("  数据源   : 500彩票网（点页面上的「刷新数据」才抓一次）")
    print("  关闭     : 关掉本窗口，或按 Ctrl+C")
    print("-" * 66)
    print("  提示：如果浏览器没自动打开，手动复制上面的地址到地址栏。")
    print("=" * 66)

    bind = BIND_HOST if lan else "127.0.0.1"
    srv = ThreadingHTTPServer((bind, port), Handler)
    srv.daemon_threads = True

    if not os.environ.get("JC_NO_BROWSER") and not cloud:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    print("  [OK] 服务已启动，正在监听 %d 端口（这个窗口别关）" % port)
    if lan:
        print("")
        print("  ★ 手机/平板（和电脑同一个 WiFi）用这个地址打开：")
        print("      http://%s:%d/" % (lan_ip(), port))
        print("    （手机走这个地址时，抓取/自动算伤病 全部可用 —— 和电脑是不是同一个页面）")
    else:
        print("  想用手机打开？关掉本窗口，双击「启动手机模式.bat」（或加 --lan 参数）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
