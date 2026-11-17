# -*- coding: utf-8 -*-
"""
titan_db.py —— 从 titan007（球探/新球体育）抓「球队 + 球员」库

用途：给本心盘口模型提供「阵容深度 / 伤病 / 停赛 / 战意」这些人工项的参考底表，
      并且**球员转会、下赛季升降级后，一键更新**。

★★ 一个必须知道的坑：zq.titan007.com 只支持 **TLS 1.0**。
   现代客户端（Python 默认 / Node / curl / 浏览器以外的库）握手会被它直接断开
   （报 RemoteDisconnected / curl 000）。所以这里必须：
        minimum_version = TLSv1
        set_ciphers("DEFAULT@SECLEVEL=0")
   牺牲一点安全性换取可用性 —— 抓的是公开只读数据，风险可控。
   ★ 也正因为如此，这件事只能由本地 Python 后端做，浏览器里做不了。

数据来源（全部 jsData 文件，纯文本数组，好解析）：
    1) /jsData/leftData/leftData.js                  联赛目录 [id,简,繁,英,类型]
    2) /jsData/LeagueSeason/sea<联赛id>.js            赛季列表 arrSeason[0] = 当前赛季
    3) /jsData/matchResult/<赛季>/s<联赛id>.js        arrTeam = [[球队id,简,繁,英,,logo,0],...]
    4) /jsData/teamInfo/teamDetail/tdl<球队id>.js     teamDetail + goalkeeper/rearguard/midfielder/vanguard

用法（命令行）：
    python titan_db.py --leagues 英超,西甲,葡超        # 抓指定联赛
    python titan_db.py --list                          # 只列出全部联赛名和 id
    python titan_db.py --probe 英超                     # 只抓联赛+球队，不抓球员（快）
"""

import json
import os
import re
import ssl
import sys
import time
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = "https://zq.titan007.com"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA_DIR, "titan_db.json")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")

POS_MAP = [("goalkeeper", "门将"), ("rearguard", "后卫"),
           ("midfielder", "中场"), ("vanguard", "前锋")]

# 本心模型里的联赛名 → titan007 的叫法（实测差异）
ALIAS = {
    "沙地联": "沙特联",     # 292
    "美职联": "美职业",     # 21
    "韩K1联": "韩K联",      # 15
}


# --------------------------------------------------------------------- 网络

def _ctx():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1
    except Exception:
        pass
    try:
        ctx.set_ciphers("DEFAULT@SECLEVEL=0")
    except Exception:
        pass
    return ctx


_CTX = None


def get(path, referer=None, timeout=18, retries=3):
    """
    取一个 jsData / 页面，返回 utf-8 文本（自动去 BOM）。
    ★ titan007 在请求过快时会直接掐断连接（Remote end closed connection），
      这不是错误而是"限流信号" → 指数退避，并且在掐断时额外多睡一会。
    """
    global _CTX
    if _CTX is None:
        _CTX = _ctx()
    url = path if path.startswith("http") else BASE + path
    last = None
    for i in range(retries + 1):
        try:
            req = Request(url, headers={
                "User-Agent": UA,
                "Referer": referer or (BASE + "/info/index_cn.htm"),
                "Accept": "*/*",
                "Connection": "close",
            })
            with urlopen(req, timeout=timeout, context=_CTX) as r:
                raw = r.read()
            return raw.decode("utf-8", "replace").lstrip("\ufeff")
        except (HTTPError, URLError, ssl.SSLError, OSError) as e:
            last = e
            msg = str(e)
            blocked = ("Remote end closed" in msg) or ("reset" in msg.lower()) or ("aborted" in msg.lower())
            wait = (3.0 if blocked else 0.8) * (2 ** i)
            if i < retries:
                time.sleep(min(wait, 20))
    raise RuntimeError("取不到 %s：%s" % (url, last))


# --------------------------------------------------------------------- 解析

_RE_LEAGUE = re.compile(r"\[(\d{1,5}),'([^']{1,40})','([^']{1,40})','([^']{0,60})',\d+\]")


CAT_PATH = os.path.join(DATA_DIR, "league_catalog.json")


def league_catalog(use_cache=True):
    """
    {联赛简体名: 联赛id}，来自 leftData.js。
    ★ 缓存 7 天：这个目录基本不变，没必要每次都去问（也少一个被限流的点）。
    """
    if use_cache and os.path.exists(CAT_PATH):
        try:
            with open(CAT_PATH, encoding="utf-8") as f:
                j = json.load(f)
            if time.time() - j.get("at", 0) < 7 * 86400 and j.get("map"):
                return j["map"]
        except Exception:
            pass
    txt = get("/jsData/leftData/leftData.js")
    out = {}
    for m in _RE_LEAGUE.finditer(txt):
        lid, cn, tw, en = m.group(1), m.group(2), m.group(3), m.group(4)
        if cn and cn not in out:
            out[cn] = int(lid)
        if tw and tw not in out:
            out[tw] = int(lid)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(CAT_PATH, "w", encoding="utf-8") as f:
            json.dump({"at": time.time(), "map": out}, f, ensure_ascii=False)
    except Exception:
        pass
    return out


def seasons(league_id):
    """该联赛的赛季列表（[0] = 当前赛季）"""
    try:
        txt = get("/jsData/LeagueSeason/sea%d.js" % league_id)
        m = re.search(r"arrSeason\s*=\s*\[([^\]]*)\]", txt)
        if not m:
            return []
        return re.findall(r"'([^']+)'", m.group(1))
    except RuntimeError:
        return []


def _league_page(league_id):
    """联赛页有两种：/cn/League/<id>.html 和 /cn/SubLeague/<id>.html，挨个试"""
    for tpl in ("/cn/League/%d.html", "/cn/SubLeague/%d.html"):
        p = tpl % league_id
        try:
            html = get(p, timeout=12, retries=1)   # ★ 快速失败：别在这儿磨 80 秒
            if "jsData" in html:
                return p, html
        except RuntimeError:
            continue
    return None, None


_RE_TEAM = re.compile(
    r"\[(\d+),'([^']*)','([^']*)','([^']*)','[^']*','([^']*)',\d+\]")


def fetch_teams(league_id, season=None):
    """
    返回 (season, [{id, name, name_tw, en, logo}])
    ★ 文件名带动态后缀（英超 s36.js、韩K联 s15_781.js、澳超 s273_462.js），
      所以必须先从联赛页 HTML 里把真正的 jsData 地址抠出来，不能硬拼。
    """
    page, html = _league_page(league_id)
    if not html:
        raise RuntimeError("联赛页打不开（League / SubLeague 都试过）")
    m = re.search(r"/jsData/matchResult/([^/]+)/(s%d[^\"?']*)" % league_id, html)
    if not m:
        raise RuntimeError("联赛页里找不到赛果数据文件")
    season_found, fname = m.group(1), m.group(2)

    txt = get("/jsData/matchResult/%s/%s" % (season_found, fname), referer=BASE + page)
    i = txt.find("arrTeam")
    if i < 0:
        raise RuntimeError("没有 arrTeam（%s）" % fname)
    seg = txt[i:i + 60000]
    end = seg.find("];")
    if end > 0:
        seg = seg[:end]
    out = []
    for mm in _RE_TEAM.finditer(seg):
        out.append({
            "id": int(mm.group(1)),
            "name": mm.group(2),
            "name_tw": mm.group(3),
            "en": mm.group(4),
            "logo": mm.group(5),
        })
    return season_found, out


_RE_PLAYER = re.compile(r"\['(\d{4,9})','(\d{0,3})','([^']*)','([^']*)','([^']*)',\d+\]")


def fetch_squad(team_id):
    """返回 {team:{id,name,en,stadium,coach}, players:[{id,num,name,name_tw,en,pos}]}"""
    txt = get("/jsData/teamInfo/teamDetail/tdl%d.js" % team_id,
              referer=BASE + "/team/%d.htm" % team_id)
    out = {"team": {"id": team_id}, "players": []}

    m = re.search(r"teamDetail\s*=\s*\[(\d+),'([^']*)','([^']*)','([^']*)'", txt)
    if m:
        out["team"].update({"id": int(m.group(1)), "name": m.group(2),
                            "name_tw": m.group(3), "en": m.group(4)})
    # 主场名（第 9 个字段附近），宽松取一下
    mh = re.search(r"teamDetail\s*=\s*\[[^\]]*?,'([^']*球场[^']*)'", txt)
    if mh:
        out["team"]["stadium"] = mh.group(1)

    mc = re.search(r"coach\s*=\s*\[(?:\[)?'?(\d*)'?,'?(\d*)'?,'?([^',\]]*)'?", txt)
    if mc and mc.group(3):
        out["team"]["coach"] = mc.group(3)

    for var, pos in POS_MAP:
        mi = txt.find("var " + var)
        if mi < 0:
            continue
        seg = txt[mi:mi + 40000]
        end = seg.find("];")
        if end > 0:
            seg = seg[:end]
        for pm in _RE_PLAYER.finditer(seg):
            out["players"].append({
                "id": pm.group(1), "num": pm.group(2),
                "name": pm.group(3), "name_tw": pm.group(4),
                "en": pm.group(5), "pos": pos,
            })
    return out


# --------------------------------------------------------------------- 组装

def build(league_names, want_players=True, progress=None, spacing=1.2, force=False):
    """
    抓指定联赛的球队/球员，**合并**进已有数据库并落盘。
    ★ 只覆盖这次真的抓成功的联赛；抓失败的不动旧数据，避免"点一下全清空"。
    """
    cat = league_catalog()
    old = load() or {}
    db = {
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "titan007",
        "warn": [],
        "leagues": dict(old.get("leagues") or {}),   # ← 先继承旧的
    }

    net_fail = 0
    for name in league_names:
        alias = ALIAS.get(name, name)
        lid = cat.get(alias) or cat.get(name)
        if not lid:
            db["warn"].append("titan007 里找不到联赛「%s」（试过别名「%s」）" % (name, alias))
            continue
        if progress:
            progress(0, 0, "正在取「%s」的球队列表…" % name)
        try:
            season, teams = fetch_teams(lid)
        except RuntimeError as e:
            msg = str(e)
            if ("Remote end closed" in msg) or ("取不到" in msg):
                net_fail += 1
                if net_fail >= 1:
                    raise RuntimeError(
                        "球探暂时拒绝连接（多半是抓太快被限流了）。过 10~30 分钟再点一次即可，"
                        "或者先少选几个联赛。详情：%s" % msg)
            db["warn"].append("「%s」球队列表失败：%s" % (name, msg[:120]))
            continue
        if not teams:
            db["warn"].append("「%s」球队列表是空的，保留旧数据" % name)
            continue
        # ★ 继承旧阵容：新抓失败时不要把人清空（球员库最金贵）
        old_teams = ((old.get("leagues") or {}).get(name) or {}).get("teams") or []
        old_players = {t["id"]: (t.get("players") or []) for t in old_teams}
        db["leagues"][name] = {"titan_id": lid, "season": season, "teams": [
            {"id": t["id"], "name": t["name"], "en": t["en"], "logo": t["logo"],
             "players": old_players.get(t["id"]) or []} for t in teams]}
        if progress:
            progress(0, 0, "已取球队：%s（%d 队，赛季 %s）" % (name, len(teams), season))
        time.sleep(spacing)

    # 逐个球队抓阵容（只抓这次请求的联赛）
    todo = [(ln, t) for ln in league_names if ln in db["leagues"]
            for t in db["leagues"][ln]["teams"]]
    total = len(todo)
    done = 0
    if want_players:
        fail_streak = 0
        for lname, t in todo:
            if fail_streak >= 4:
                # 连续失败 → 十有八九被限流了，歇一会再继续
                if progress:
                    progress(done, total, "连续失败 %d 次，休息 8 秒后继续…" % fail_streak)
                time.sleep(8)
                fail_streak = 0
            if t.get("players") and not force:
                done += 1
                if progress and done % 5 == 0:
                    progress(done, total, "已抓阵容 %d/%d（%s 已有，跳过）" % (done, total, t["name"]))
                continue
            try:
                sq = fetch_squad(t["id"])
                fail_streak = 0
                t["players"] = sq["players"]
                if sq["team"].get("coach"):
                    t["coach"] = sq["team"]["coach"]
                if sq["team"].get("stadium"):
                    t["stadium"] = sq["team"]["stadium"]
                save(db)          # ★ 每抓一队就落盘：被限流中断也不丢已抓到的
            except RuntimeError as e:
                fail_streak += 1
                keep = len(t.get("players") or [])
                db["warn"].append("球队 %s(%d) 阵容失败%s：%s" % (
                    t["name"], t["id"], ("（保留旧的 %d 人）" % keep) if keep else "", e))
            done += 1
            if progress and (done % 3 == 0 or done == total):
                progress(done, total, "已抓阵容 %d/%d（%s）" % (done, total, t["name"]))
            time.sleep(spacing)

    save(db)
    return db


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


def summary(db):
    if not db:
        return {"updated_at": "", "leagues": 0, "teams": 0, "players": 0}
    lg = db.get("leagues") or {}
    teams = sum(len(v.get("teams") or []) for v in lg.values())
    players = sum(len(t.get("players") or []) for v in lg.values() for t in (v.get("teams") or []))
    return {"updated_at": db.get("updated_at", ""), "leagues": len(lg),
            "teams": teams, "players": players}


# --------------------------------------------------------------------- CLI

if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if "--list" in args:
        cat = league_catalog()
        keys = sorted(cat.items(), key=lambda kv: kv[1])
        print("共 %d 条联赛名（含繁体别名）：" % len(keys))
        for k, v in keys:
            print("  %-14s %d" % (k, v))
        sys.exit(0)

    names = []
    if "--leagues" in args:
        names = [s.strip() for s in args[args.index("--leagues") + 1].split(",") if s.strip()]
    elif "--probe" in args:
        names = [args[args.index("--probe") + 1]]
    if not names:
        print("用法：python titan_db.py --leagues 英超,西甲,葡超   |  --list  |  --probe 英超")
        sys.exit(1)

    players = "--probe" not in args
    t0 = time.time()
    db = build(names, want_players=players,
               progress=lambda d, t, m: print("  ", m, flush=True))
    s = summary(db)
    print("\n完成：%s" % s["updated_at"])
    print("  联赛 %d / 球队 %d / 球员 %d，用时 %.1f 秒" %
          (s["leagues"], s["teams"], s["players"], time.time() - t0))
    if db["warn"]:
        print("  提醒：")
        for w in db["warn"]:
            print("   -", w)
    print("  已写入：", DB_PATH)
