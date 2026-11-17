# -*- coding: utf-8 -*-
"""
tm_db.py —— 从 transfermarkt-api 抓「球队名单 + 阵容」

为什么用它而不是自己爬 Transfermarkt：
  · Transfermarkt 官方条款禁止自动抓取，且 Cloudflare 很凶（直连会 403 / 封 IP）。
  · 这里用的是社区维护的公开封装服务（transfermarkt-api），**是它去访问 TM**，
    你的 IP 不会被 TM 记上；而且它在服务端做了缓存（响应的 updatedAt 是抓取时间）。
  · 只读公开数据、个人使用、低频 —— 风险可控。商用请改用官方授权 API。

★★ 重要限制：该服务 **没有开 CORS**，浏览器 fetch 会被拦 → 只能由本机后端代抓。
   所以这个功能必须配合 启动.bat（http://127.0.0.1:8765）。

数据来源（transfermarkt-api 的公开端点）：
    GET /competitions/{tm_id}/seasons              赛季列表（id 形如 "2026"）
    GET /competitions/{tm_id}/clubs?season_id=     联赛球队名单
    GET /clubs/{club_id}/players?season_id=        该队阵容（号码/位置/年龄/身价/合同…）

用法：
    python tm_db.py --leagues 英超,西甲
    python tm_db.py --leagues 英超 --season 2026 --force
    python tm_db.py --probe 英超            # 只抓球队名单，不抓阵容（很快）
"""

import json
import os
import re
import sys
import time
import ssl
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA_DIR, "tm_db.json")

# 公共实例（按顺序试，前面挂了会自动换后面的）
BASES = [
    "https://transfermarkt-api.onrender.com",
    "https://transfermarkt-api.fly.dev",
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")

# 本心联赛名 → Transfermarkt 联赛 id（实测逐个试出来的）
TM_LEAGUE_ID = {
    "英超": "GB1", "西甲": "ES1", "德甲": "L1", "意甲": "IT1", "法甲": "FR1",
    "英冠": "GB2", "葡超": "PO1", "荷甲": "NL1",
    "沙特联": "SA1", "沙地联": "SA1",          # ← 同一个联赛的两种叫法
    "美职联": "MLS1", "美职业": "MLS1",
    "挪超": "NO1",
    "日职联": "JAP1", "日职": "JAP1",
    "韩K1联": "RSK1", "韩K联": "RSK1",
    "芬超": "FI1",
    "澳超": "AUS1",
    # 备选（将来加联赛时可直接用）
    "苏超": "SC1", "比甲": "BE1", "土超": "TR1", "俄超": "RU1",
    "巴甲": "BRA1", "阿甲": "AR1N", "墨超": "MEX1", "日职乙": "JAP2",
    "德乙": "L2", "意乙": "IT2", "西乙": "ES2", "法乙": "FR2", "英甲": "GB3",
}

# 常见别名 → 映射表里的标准名（用户库里的叫法可能不一样）
ALIAS = {
    "沙地联": "沙特联", "美职业": "美职联", "韩K联": "韩K1联",
    "日职": "日职联", "意大利甲级": "意甲", "西班牙甲级": "西甲",
}

# 位置中文化（TM 用英文，且很细）
def pos_cn(p):
    s = str(p or "")
    if not s:
        return "未知"
    low = s.lower()
    if "goalkeeper" in low or low == "keeper":
        return "门将"
    if "back" in low or "defend" in low:
        return "后卫"
    if "midfield" in low:
        return "中场"
    if "winger" in low or "forward" in low or "striker" in low or "attack" in low:
        return "前锋"
    return "未知"


# --------------------------------------------------------------------- 网络

_CTX = ssl.create_default_context()
_BASE = [0]          # 当前用第几个 base


def _url(path):
    return BASES[_BASE[0]] + path


def get(path, timeout=25, retries=3):
    """取 JSON；失败换 base / 退避重试"""
    last = None
    for i in range(retries + 1):
        try:
            req = Request(_url(path), headers={
                "User-Agent": UA,
                "Accept": "application/json",
            })
            with urlopen(req, timeout=timeout, context=_CTX) as r:
                raw = r.read()
            return json.loads(raw.decode("utf-8", "replace"))
        except (HTTPError, URLError, ssl.SSLError, OSError, ValueError) as e:
            last = e
            # 换个实例试试
            if len(BASES) > 1 and i == 0:
                _BASE[0] = (_BASE[0] + 1) % len(BASES)
            wait = 0.8 * (2 ** i)
            if i < retries:
                time.sleep(wait)
    raise RuntimeError("取不到 %s：%s" % (path, last))


# --------------------------------------------------------------------- 抓取

def seasons(tm_id):
    """[{id:'2026', name:'26/27'}, ...]"""
    j = get("/competitions/%s/seasons" % tm_id)
    return j.get("seasons") or j.get("results") or []


def clubs(tm_id, season_id=None):
    """[{id, name, ...}]"""
    p = "/competitions/%s/clubs" % tm_id
    if season_id:
        p += "?season_id=%s" % season_id
    j = get(p)
    arr = j.get("clubs") or j.get("results") or []
    out = []
    for c in arr:
        if not c.get("id"):
            continue
        out.append({
            "id": c.get("id"),
            "name": c.get("name") or c.get("clubName") or "",
            "logo": c.get("image") or c.get("logo") or "",
            "players": [],
        })
    return out


def squad(club_id, season_id=None):
    """该队阵容（字段比 titan007 丰富得多）"""
    p = "/clubs/%s/players" % club_id
    if season_id:
        p += "?season_id=%s" % season_id
    j = get(p)
    arr = j.get("players") or []
    out = []
    for p1 in arr:
        if not p1.get("id"):
            continue
        num = p1.get("shirtNumber")
        out.append({
            "id": str(p1.get("id")),
            "num": "" if num is None else str(num),
            "name": p1.get("name") or "",
            "pos": pos_cn(p1.get("position")),
            "pos_en": p1.get("position") or "",
            "age": p1.get("age"),
            "height": p1.get("height"),
            "foot": p1.get("foot") or "",
            "nat": "/".join(p1.get("nationalities") or p1.get("nationality") or []),
            "mv": p1.get("marketValue"),
            "contract": p1.get("contract") or "",
            "joined": p1.get("joinedOn") or "",
            "from": p1.get("signedFrom") or "",
            "captain": bool(p1.get("isCaptain")),
            "img": p1.get("imageUrl") or "",
        })
    return out


# --------------------------------------------------------------------- 组装

def save(db):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, DB_PATH)


def load():
    try:
        with open(DB_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _diff(old, new):
    """对比阵容变化（转会跟踪）：返回 {added:[名字...], removed:[名字...]}"""
    o = {str(x.get("id")): x.get("name", "") for x in (old or [])}
    n = {str(x.get("id")): x.get("name", "") for x in (new or [])}
    added = [n[k] for k in n if k not in o]
    removed = [o[k] for k in o if k not in n]
    return {"added": added, "removed": removed}


def build(leagues, season=None, want_players=True, force=False,
          progress=None, spacing=0.5):
    """
    抓指定联赛的球队名单 + 阵容，**合并**进已有数据库（抓失败不清空旧数据）。
    season: 指定赛季 id（如 "2026"）；None = 用该联赛当前赛季。
    force:  True = 已有阵容的球队也重抓（默认跳过，支持断点续抓）
    """
    old = load() or {}
    db = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "transfermarkt",
        "season": season or "",
        "warn": [],
        "leagues": dict(old.get("leagues") or {}),
    }

    for name in leagues:
        tm_id = TM_LEAGUE_ID.get(name) or TM_LEAGUE_ID.get(ALIAS.get(name, ""))
        if not tm_id:
            db["warn"].append("没有「%s」的 Transfermarkt id（已知：%s）" %
                              (name, "、".join(TM_LEAGUE_ID.keys())))
            continue
        # 赛季
        sid = season
        sname = ""
        if not sid:
            try:
                ss = seasons(tm_id)
                if ss:
                    sid = str(ss[0].get("id") or "")
                    sname = ss[0].get("name") or ""
            except RuntimeError as e:
                db["warn"].append("「%s」赛季列表失败：%s" % (name, e))

        if progress:
            progress(0, 0, "正在取「%s（%s）」的球队名单…" % (name, tm_id))
        try:
            teams = clubs(tm_id, sid)
        except RuntimeError as e:
            db["warn"].append("「%s」球队名单失败：%s" % (name, e))
            continue
        if not teams:
            db["warn"].append("「%s」球队名单是空的，保留旧数据" % name)
            continue

        # 继承旧阵容（失败不清空）
        old_teams = ((old.get("leagues") or {}).get(name) or {}).get("teams") or []
        old_by_id = {str(t.get("id")): t for t in old_teams}
        new_teams = []
        for t in teams:
            prev = old_by_id.get(str(t["id"])) or {}
            t["players"] = prev.get("players") or []
            t["changes"] = prev.get("changes") or {}
            new_teams.append(t)

        db["leagues"][name] = {
            "label": "%s（%s）" % (name, tm_id),   # ← 中文名 + id，方便一眼识别
            "tm_id": tm_id,
            "season": sid,
            "season_name": sname,
            "teams": new_teams,
        }
        if progress:
            progress(0, 0, "已取球队：%s（%d 队，赛季 %s）" % (name, len(teams), sname or sid))
        time.sleep(spacing)

    # 阵容
    todo = [(ln, t) for ln in leagues if ln in db["leagues"]
            for t in db["leagues"][ln]["teams"]]
    total = len(todo)
    done = 0
    fail_streak = 0
    if want_players:
        for lname, t in todo:
            if t.get("players") and not force:
                done += 1
                continue
            if fail_streak >= 5:
                if progress:
                    progress(done, total, "连续失败 %d 次，休息 10 秒…" % fail_streak)
                time.sleep(10)
                fail_streak = 0
            try:
                sid = (db["leagues"][lname] or {}).get("season") or None
                new_pl = squad(t["id"], sid)
                if not new_pl:
                    raise RuntimeError("返回空阵容")
                t["changes"] = dict(_diff(t.get("players") or [], new_pl))
                t["changes"]["at"] = time.strftime("%Y-%m-%d %H:%M")
                t["players"] = new_pl
                fail_streak = 0
                save(db)                      # ★ 每抓一队就落盘
            except RuntimeError as e:
                fail_streak += 1
                keep = len(t.get("players") or [])
                db["warn"].append("%s(%s) 阵容失败%s：%s" % (
                    t.get("name"), t.get("id"),
                    ("（保留旧的 %d 人）" % keep) if keep else "", str(e)[:90]))
            done += 1
            if progress and (done % 2 == 0 or done == total):
                progress(done, total, "已抓阵容 %d/%d（%s）" % (done, total, t.get("name") or ""))
            time.sleep(spacing)

    save(db)
    return db


def summary(db):
    if not db:
        return {"updated_at": "", "leagues": 0, "teams": 0, "players": 0, "source": "transfermarkt"}
    lg = db.get("leagues") or {}
    teams = sum(len(v.get("teams") or []) for v in lg.values())
    players = sum(len(t.get("players") or []) for v in lg.values() for t in (v.get("teams") or []))
    return {"updated_at": db.get("updated_at", ""), "leagues": len(lg),
            "teams": teams, "players": players, "source": db.get("source", "transfermarkt"),
            "season": db.get("season", "")}


# --------------------------------------------------------------------- CLI

if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = sys.argv[1:]
    names = []
    if "--leagues" in args:
        names = [s.strip() for s in args[args.index("--leagues") + 1].split(",") if s.strip()]
    elif "--probe" in args:
        names = [args[args.index("--probe") + 1]]
    if not names:
        print("用法：python tm_db.py --leagues 英超,西甲 [--season 2026] [--force] | --probe 英超")
        print("已知联赛 id：")
        for k, v in TM_LEAGUE_ID.items():
            print("   %-8s %s" % (k, v))
        sys.exit(1)
    season = args[args.index("--season") + 1] if "--season" in args else None
    want_players = "--probe" not in args
    t0 = time.time()
    db = build(names, season=season, want_players=want_players,
               force=("--force" in args),
               progress=lambda d, t, m: print("  ", m, flush=True))
    s = summary(db)
    print("\n完成：%s（来源 %s）" % (s["updated_at"], s["source"]))
    print("  联赛 %d / 球队 %d / 球员 %d，用时 %.1f 秒" %
          (s["leagues"], s["teams"], s["players"], time.time() - t0))
    if db["warn"]:
        print("  提醒：")
        for w in db["warn"][:10]:
            print("   -", w)
    print("  已写入：", DB_PATH)
