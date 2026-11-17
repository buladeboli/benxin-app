# -*- coding: utf-8 -*-
"""
tm_injury.py —— 用 Transfermarkt 自动算「伤病修正 / 阵容深度 / 停赛修正」

思路（不猜，全部可解释）：
  1. 从 tm_db.json 拿这支队的阵容（有 TM 球员 id + 身价）
  2. 按身价从高到低排：前 3 名 = 绝对核心，前 11 名 = 主力，其余 = 轮换
  3. 逐个查该球员的伤病 / 缺阵（停赛）记录：
       GET /players/{id}/injuries    → [{season, injury, fromDate, untilDate, days, gamesMissed}]
       GET /players/{id}/absences    → 同上结构（停赛/国家队征召等）
     判定「现在能不能上」：untilDate 为空（还在伤）或在今天之后（还没好）
  4. 数「核心/主力缺阵几位」→ 映射成模型加减分库里的原文标签

输出严格用 LIB 里的标签（拼错 = 引擎查不到 = 等于没填）：
  injury : 阵容齐整或无影响缺阵 / 单名普通主力缺阵 / 单名绝对核心缺阵 /
           双核或攻防双主力缺阵 / 三核缺阵或半套主力 / 大面积伤病潮
  suspend: 无停赛 / 首发主力红牌停赛 / 轮换球员红牌停赛
  depth  : 深度雄厚 / 深度一般 / 深度薄弱

成本：每名球员 2 个请求；默认只查前 14 名（= 首发 + 关键替补）→ 每队 28 个请求。
     全部结果按「球员 + 日期」缓存，同一天再算同一支队几乎不花钱；
     并带每日请求预算，超了就停（不会把公共封装服务刷爆）。
"""

import json
import os
import threading
import time
import datetime
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
DB_PATH = os.path.join(DATA_DIR, "tm_db.json")
CACHE_PATH = os.path.join(DATA_DIR, "tm_injuries.json")

TOP_N = 11                 # 每队查前 N 名（按身价，= 首发 XI）
DAILY_BUDGET = 1200        # 每日最多打 TM 多少次（200 队次 × 11 人 × 2 接口）
CACHE_HOURS = 20           # 球员伤病记录的缓存小时数
WORKERS = 8
PACING = 0.12


# ---------------------------------------------------------------- 小工具
def _today():
    return datetime.date.today().isoformat()


def _now_ts():
    return time.time()


_lock = threading.Lock()


def _load_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            j = json.load(f)
            if not isinstance(j, dict):
                return {"players": {}, "budget": {}}
            j.setdefault("players", {})
            j.setdefault("budget", {})
            return j
    except Exception:
        return {"players": {}, "budget": {}}


def _save_cache(c):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass


def _budget_left(cache):
    day = _today()
    b = cache["budget"].get(day, 0)
    return max(0, DAILY_BUDGET - b)


def _budget_spend(cache, n=1):
    day = _today()
    cache["budget"][day] = cache["budget"].get(day, 0) + n
    # 只留最近 3 天
    for k in sorted(cache["budget"].keys())[:-3]:
        cache["budget"].pop(k, None)


# ---------------------------------------------------------------- 拉取
def _fetch(pid):
    """取一名球员的伤病 + 停赛（含缓存）。返回 {'inj': [...], 'abs': [...]}"""
    import tm_db           # 复用它的 get()（带 UA / 重试 / 换实例）

    cache = _load_cache()
    hit = cache["players"].get(str(pid))
    if hit and (_now_ts() - float(hit.get("at", 0))) < CACHE_HOURS * 3600:
        return {"inj": hit.get("inj") or [], "abs": hit.get("abs") or []}

    if _budget_left(cache) < 2:
        return {"inj": [], "abs": [], "skipped": "今日 TM 查询额度用完"}

    out = {"inj": [], "abs": []}
    for key, path in (("inj", "/players/%s/injuries"), ("abs", "/players/%s/absences")):
        try:
            j = tm_db.get(path % pid, timeout=20, retries=2)
            arr = j.get("injuries") if key == "inj" else j.get("absences")
            out[key] = arr or []
        except Exception:
            out[key] = []
        with _lock:
            c2 = _load_cache()
            _budget_spend(c2, 1)
            _save_cache(c2)
        time.sleep(PACING)

    with _lock:
        c3 = _load_cache()
        c3["players"][str(pid)] = {"at": _now_ts(), "inj": out["inj"], "abs": out["abs"]}
        _save_cache(c3)
    return out


def _fetch_mv(pid):
    """单独取一名球员的当前身价（TM 有些球队的名单接口不返回 marketValue）。

    接口：/players/{id}/market_value → {marketValue: 9000000, ...}
    结果缓存在 tm_injuries.json 的 mv 字段里。
    """
    import tm_db
    cache = _load_cache()
    cache.setdefault("mv", {})
    hit = cache["mv"].get(str(pid))
    if hit is not None and (_now_ts() - float(hit.get("at", 0))) < 24 * 3600:
        return hit.get("v")

    if _budget_left(cache) < 1:
        return None
    try:
        j = tm_db.get("/players/%s/market_value" % pid, timeout=20, retries=2)
        v = j.get("marketValue")
    except Exception:                      # noqa: BLE001
        v = None
    with _lock:
        c2 = _load_cache()
        c2.setdefault("mv", {})
        c2["mv"][str(pid)] = {"at": _now_ts(), "v": v}
        _budget_spend(c2, 1)
        _save_cache(c2)
    time.sleep(PACING)
    return v


def _backfill_mv(players):
    """整队几乎都没身价时，逐个补。返回 {pid: mv}"""
    out = {}

    def one(p):
        try:
            v = _fetch_mv(p["id"])
            if v:
                out[str(p["id"])] = float(v)
        except Exception:                  # noqa: BLE001
            pass

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(one, players))
    return out


def _is_active(rec, today=None):
    """这条伤病/缺阵记录现在还算不算（还在伤 / 还没好）"""
    today = today or _today()
    until = (rec.get("untilDate") or "").strip()
    if not until:
        return True                      # untilDate 为空 = 还在伤
    return until >= today                # 结束日期在今天之后 = 还没好


def _is_suspend(rec):
    s = (str(rec.get("injury") or "") + " " + str(rec.get("reason") or "")).lower()
    return ("suspend" in s) or ("red card" in s) or ("ban" in s) or ("停赛" in s)


# ---------------------------------------------------------------- 判级
def _injury_label(core_out, starter_out, total_out):
    """映射到加减分库 LIB.injury 的原文"""
    if total_out >= 8:
        return "大面积伤病潮"
    if core_out >= 3 or starter_out >= 5:
        return "三核缺阵或半套主力"
    # 2 名核心、或 1 核心 + 1 主力、或 3 名以上主力 → 双核/双主力
    if core_out >= 2 or (core_out >= 1 and starter_out >= 1) or starter_out >= 3:
        return "双核或攻防双主力缺阵"
    if core_out == 1:
        return "单名绝对核心缺阵"
    if starter_out >= 1:
        return "单名普通主力缺阵"
    return "阵容齐整或无影响缺阵"


def _depth_by_shape(squad):
    """没有身价时的兜底：看阵容人数和位置结构"""
    n = len(squad)
    cnt = {}
    for p in squad:
        cnt[p.get("pos") or "中场"] = cnt.get(p.get("pos") or "中场", 0) + 1
    gk = cnt.get("门将", 0)
    thin = []
    if gk < 2:
        thin.append("门将只有 %d 人" % gk)
    if n < 20:
        thin.append("总人数只有 %d" % n)
    if len(thin) >= 2:
        return "深度薄弱", "按人数结构：%s（TM 无身价）" % "、".join(thin)
    if n >= 26 and gk >= 3:
        return "深度雄厚", "按人数结构：%d 人 / 门将 %d 人（TM 无身价）" % (n, gk)
    return "深度一般", "按人数结构：%d 人（TM 无身价）" % n


def _depth_label(total_value, league_values, squad=None):
    """按同联赛身价分位 → 深度雄厚/一般/薄弱；本队没身价就用人数结构兜底"""
    if not total_value:
        if squad:
            return _depth_by_shape(squad)
        return "深度一般", "身价数据不足"
    if not league_values or len(league_values) < 4:
        if squad:
            return _depth_by_shape(squad)
        return "深度一般", "身价数据不足"
    vals = sorted(league_values)
    n = len(vals)
    # 本队排第几（1 = 最贵）
    rank = 1 + sum(1 for v in vals if v > total_value)
    pct = (rank - 1) / max(1, n - 1)      # 0 = 最贵, 1 = 最穷
    if pct <= 0.33:
        return "深度雄厚", "总身价全联赛第 %d/%d（最富的三分之一）" % (rank, n)
    if pct >= 0.67:
        return "深度薄弱", "总身价全联赛第 %d/%d（最穷的三分之一）" % (rank, n)
    return "深度一般", "总身价全联赛第 %d/%d（中游）" % (rank, n)


# ---------------------------------------------------------------- 主流程
def _norm(s):
    """队名归一：去重音符号 / 常见前后缀 / 数字 / 标点，转小写（用来跨中英文名对齐）

    ★ 必须去重音：TM 里叫 Málaga CF、Atlético de Madrid，用户库里是 Malaga / Atletico，
      不去掉 á/é 就永远匹配不上（马拉加就是这么找不到的）。
    """
    import re
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")   # 去掉组合重音
    s = s.lower()
    s = re.sub(r"[.\'’`\-/]", " ", s)
    drop = {"fc", "cf", "ac", "as", "sc", "sl", "rc", "cd", "ud", "sv", "vfb", "vfl", "tsg",
            "bk", "fk", "if", "sk", "al", "sad", "ssc", "ss", "us", "club", "de", "do", "da", "the"}
    toks = [t for t in re.findall(r"[a-z0-9]+", s) if t not in drop and not re.fullmatch(r"\d{2,4}", t)]
    return " ".join(toks)


def _find_team(db, league, names):
    """names: 候选队名列表（先英文 TM 原名，再中文），逐个试"""
    if isinstance(names, str):
        names = [names]
    names = [n for n in names if n and str(n).strip()]
    lg = (db.get("leagues") or {}).get(league)
    if not lg:
        return None, "库里的联赛名对不上（现有：%s）" % "、".join((db.get("leagues") or {}).keys())
    teams = lg.get("teams") or []
    if not teams:
        return None, "库里「%s」还没有球队（先去球员库更新这个联赛）" % league

    # ① 完全相等
    for n in names:
        for t in teams:
            if (t.get("name") or "").strip() == str(n).strip():
                return t, None
    # ② 归一后相等 / 互相包含
    for n in names:
        nn = _norm(n)
        if not nn:
            continue
        for t in teams:
            if _norm(t.get("name")) == nn:
                return t, None
        hits = [t for t in teams if nn in _norm(t.get("name")) or _norm(t.get("name")) in nn]
        if len(hits) == 1:
            return hits[0], None
        if len(hits) > 1:
            return None, "「%s」匹配到多支队：%s" % (n, "、".join(x.get("name") for x in hits))
    return None, "库里没有「%s」（试过：%s）" % (names[0], "、".join(str(x) for x in names))


def _club_by_name(name):
    """在 TM 里按名字搜一个俱乐部，返回 {id, name} 或 None

    接口：/clubs/search/{名字} → {results:[{id, name, country, ...}]}
    中文名搜不到（TM 只有英文），所以要用 meta.full 里的英文原名。
    """
    import tm_db
    import urllib.parse
    q = str(name or "").strip()
    if not q:
        return None
    try:
        j = tm_db.get("/clubs/search/" + urllib.parse.quote(q), timeout=25, retries=2)
    except Exception:                      # noqa: BLE001
        return None
    arr = j.get("results") or j.get("clubs") or []
    if not arr:
        return None
    nq = _norm(q)
    # 先找名字归一后完全相等的，再找包含的，否则就取第一个
    for c in arr:
        if _norm(c.get("name")) == nq:
            return c
    for c in arr:
        cn = _norm(c.get("name"))
        if nq and (nq in cn or cn in nq):
            return c
    return arr[0]


def _team_from_tm(name, cache_key):
    """TM 名单里没有这支队时，直接按名字把它拉出来（含阵容）

    返回和 tm_db 一样的结构：{id, name, players:[...]}
    """
    import tm_db
    c = _club_by_name(name)
    if not c or not c.get("id"):
        return None
    cid = str(c["id"])
    try:
        j = tm_db.get("/clubs/%s/players" % cid, timeout=30, retries=3)
    except Exception:                      # noqa: BLE001
        return None
    arr = j.get("players") or []
    if not arr:
        return None
    need_mv = sum(1 for p in arr if not p.get("marketValue"))
    players = []
    for p1 in arr:
        if not p1.get("id"):
            continue
        players.append({
            "id": str(p1.get("id")),
            "num": "" if p1.get("shirtNumber") is None else str(p1.get("shirtNumber")),
            "name": p1.get("name") or "",
            "pos": _POS_CN(p1.get("position")),
            "pos_en": p1.get("position") or "",
            "age": p1.get("age"),
            "mv": p1.get("marketValue"),
        })
    return {"id": cid, "name": c.get("name") or name, "players": players,
            "fromSearch": True, "needMv": need_mv > 0}


def _POS_CN(p):
    """和 tm_db.py 里同一套位置映射（保持标签一致）"""
    s = str(p or "").lower()
    if "goalkeeper" in s:
        return "门将"
    if "back" in s or "defend" in s:
        return "后卫"
    if "midfield" in s:
        return "中场"
    if "winger" in s or "forward" in s or "striker" in s:
        return "前锋"
    return "中场"


def _league_values(db, league):
    """本联赛各队总身价（DB 里有身价的 + 之前补出来的）"""
    lg = (db.get("leagues") or {}).get(league) or {}
    cache = _load_cache()
    totals = cache.get("teamTotals") or {}
    out = []
    for t in lg.get("teams") or []:
        s = sum(float(p.get("mv") or 0) for p in (t.get("players") or []))
        if s <= 0:
            s = float(totals.get(league + "|" + (t.get("name") or ""), 0) or 0)
        if s > 0:
            out.append(s)
    return out


def _squad_from_client(squad, name):
    """浏览器传来的名单：[{id, num, name, pos, val}]，val 单位是万欧 → 换成欧"""
    players = []
    for p in (squad or []):
        if not p.get("id"):
            continue
        try:
            v = float(p.get("val") or 0) * 10000.0
        except Exception:                  # noqa: BLE001
            v = 0.0
        players.append({
            "id": str(p["id"]),
            "num": "" if p.get("num") is None else str(p.get("num")),
            "name": p.get("name") or "",
            "pos": p.get("pos") or "中场",
            "mv": v,
        })
    if not players:
        return None
    return {"id": "", "name": name, "players": players, "fromClient": True}


def scan_team(db, league, team, team_tm=None, progress=None, squad=None):
    """算一支队的伤病/停赛/深度；team_tm 是 TM 英文原名（优先用）

    squad：浏览器传来的名单（带 TM 球员 ID）。有它就直接用，不再去 TM 找队。
    """
    t, err = None, None
    if squad:
        t = _squad_from_client(squad, team)
        if t:
            err = None
    if t is None:
        t, err = _find_team(db, league, [team_tm, team])
    from_search = False
    if err:
        # 库里这个联赛没有它（例如升班马/杯赛对手）→ 直接去 TM 搜这支队的英文名
        for cand in (team_tm, team):
            tt = _team_from_tm(cand, team)
            if tt and tt.get("players"):
                t, err, from_search = tt, None, True
                break
        if err:
            return {"ok": False, "error": err + "；去 TM 按名字搜也没找到（要有英文名，去「球员库」看这队的 full 字段）"}

    players = [p for p in (t.get("players") or []) if p.get("id")]
    if not players:
        return {"ok": False, "error": "「%s」在 TM 库里没有球员数据（先去球员库更新这个联赛）" % team}

    # ★ TM 有少数球队（里昂、斯特拉斯堡…）名单接口不返回 marketValue，
    #   表现为"整队身价 0"。这时逐个补 /players/{id}/market_value，
    #   否则按身价排出来的"核心/主力"全是乱的，深度也判不了。
    no_mv = sum(1 for p in players if not p.get("mv"))
    backfilled = 0
    if no_mv >= max(3, int(len(players) * 0.8)):
        if progress:
            progress(0, 0, "「%s」TM 没给身价，正在逐个补（%d 人）…" % (team, len(players)))
        got = _backfill_mv(players)
        for p in players:
            if not p.get("mv") and got.get(str(p["id"])):
                p["mv"] = got[str(p["id"])]
                backfilled += 1

    players.sort(key=lambda p: float(p.get("mv") or 0), reverse=True)
    checked = players[:TOP_N]
    total_value = sum(float(p.get("mv") or 0) for p in players)

    # 并发拉
    results = {}
    done = [0]

    def one(p):
        try:
            results[str(p["id"])] = _fetch(p["id"])
        except Exception:
            results[str(p["id"])] = {"inj": [], "abs": []}
        with _lock:
            done[0] += 1
            if progress and done[0] % 4 == 0:
                progress(done[0], len(checked), "已查 %d/%d 名球员…" % (done[0], len(checked)))

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(one, checked))

    # ★ 只要有球员没查成（额度用完/网络失败），就不能给结论 —— 否则会把"没查"算成"没伤"
    skipped = [str(p.get("name") or p.get("id")) for p in checked
               if (results.get(str(p["id"])) or {}).get("skipped")]
    if skipped:
        return {"ok": False,
                "error": "有 %d 名球员没查成（%s）—— 不给结论，免得把没查当成没伤。可以去「⑥」手动填，或明天再点。"
                         % (len(skipped), "、".join(skipped[:3]) + ("…" if len(skipped) > 3 else ""))}

    core_out, starter_out, rotation_out = [], [], []
    susp_main, susp_rot = [], []
    for idx, p in enumerate(checked):
        r = results.get(str(p["id"])) or {}
        name = p.get("name") or ("#" + str(p.get("num") or "?"))
        mv = float(p.get("mv") or 0)
        tier = "core" if idx < 3 else ("starter" if idx < 11 else "rotation")

        inj_hit = [x for x in (r.get("inj") or []) if _is_active(x) and not _is_suspend(x)]
        abs_hit = [x for x in (r.get("abs") or []) if _is_active(x)]

        if inj_hit:
            rec = max(inj_hit, key=lambda x: int(x.get("gamesMissed") or 0))
            item = {"name": name, "num": p.get("num"), "mv": mv,
                    "why": rec.get("injury") or "伤病",
                    "from": rec.get("fromDate"), "until": rec.get("untilDate"),
                    "missed": rec.get("gamesMissed")}
            (core_out if tier == "core" else starter_out if tier == "starter" else rotation_out).append(item)

        sus = [x for x in abs_hit if _is_suspend(x)]
        if sus:
            rec = sus[0]
            item = {"name": name, "num": p.get("num"), "mv": mv,
                    "why": rec.get("reason") or rec.get("injury") or "停赛",
                    "from": rec.get("fromDate"), "until": rec.get("untilDate")}
            (susp_main if tier in ("core", "starter") else susp_rot).append(item)

    total_out = len(core_out) + len(starter_out) + len(rotation_out)
    inj_label = _injury_label(len(core_out), len(starter_out), total_out)

    if susp_main:
        sus_label = "首发主力红牌停赛"
    elif susp_rot:
        sus_label = "轮换球员红牌停赛"
    else:
        sus_label = "无停赛"

    # 把"补出来的总身价"记进缓存，这样**下一支队**算分位时也能看到它（14/15 就能对齐）
    if total_value:
        with _lock:
            c4 = _load_cache()
            c4.setdefault("teamTotals", {})[league + "|" + (t.get("name") or "")] = total_value
            _save_cache(c4)
    if from_search:
        # 这支队不在本联赛的库里（跨级别/杯赛对手），拿它跟别队比身价没有意义 → 按人数结构估
        dep_label, dep_why = _depth_by_shape(players)
        dep_why += "（这支队不在 TM 的本联赛名单里，深度按人数结构估）"
    else:
        if total_value:
            with _lock:
                c4 = _load_cache()
                c4.setdefault("teamTotals", {})[league + "|" + (t.get("name") or "")] = total_value
                _save_cache(c4)
        lvals = _league_values(db, league)
        if total_value and all(abs(total_value - v) > 1 for v in lvals):
            lvals = lvals + [total_value]
        dep_label, dep_why = _depth_label(total_value, lvals, players)

    return {
        "ok": True,
        "team": t.get("name"),
        "checked": len(checked),
        "squad": len(players),
        "injury": inj_label,
        "suspend": sus_label,
        "depth": dep_label,
        "core": core_out, "starter": starter_out, "rotation": rotation_out,
        "susp": susp_main + susp_rot,
        "depthWhy": dep_why,
        "totalValue": total_value,
        "backfilled": backfilled,
        "fromSearch": from_search,
        "noMv": sum(1 for p in players if not p.get("mv")),
    }


def compute(league, home, away, home_tm=None, away_tm=None, progress=None,
            home_squad=None, away_squad=None):
    """给一场比赛两队都算好，返回可直接写进 ⑥ 加减分项的结果"""
    db = None
    try:
        with open(DB_PATH, encoding="utf-8") as f:
            db = json.load(f)
    except Exception:
        return {"ok": False, "error": "读不到 TM 球队库（先到球员库点「更新球队/球员库」）"}
    if not db or not db.get("leagues"):
        return {"ok": False, "error": "TM 球队库是空的（先去球员库更新）"}

    h = scan_team(db, league, home, home_tm, progress, squad=home_squad)
    a = scan_team(db, league, away, away_tm, progress, squad=away_squad)
    cache = _load_cache()
    return {
        "ok": True,
        "home": h, "away": a,
        "budgetLeft": _budget_left(cache),
        "budgetMax": DAILY_BUDGET,
    }


def _fmt_one(r):
    if not r.get("ok"):
        return "✘ " + (r.get("error") or "失败")
    lines = ["%s：伤病「%s」 深度「%s」 停赛「%s」" % (r.get("team"), r["injury"], r["depth"], r["suspend"])]
    if r.get("backfilled"):
        lines.append("  （TM 名单没给身价，已逐个补了 %d 人）" % r["backfilled"])
    if r.get("noMv"):
        lines.append("  ⚠ 仍有 %d 人身价缺失（TM 没数据），排名判断可能偏" % r["noMv"])
    lines += [
             "  查了 %d/%d 人（按身价前 %d），总身价 %s 万欧；%s" % (
                 r.get("checked"), r.get("squad"), TOP_N, int(r.get("totalValue") or 0), r.get("depthWhy") or "")]
    for tag, arr in (("核心缺阵", r.get("core")), ("主力缺阵", r.get("starter")), ("轮换缺阵", r.get("rotation")), ("停赛", r.get("susp"))):
        for x in (arr or []):
            lines.append("  · %s #%s %s（%s%s）" % (
                tag, x.get("num") or "?", x.get("name"), x.get("why"),
                ("，" + str(x.get("until")) + " 复出") if x.get("until") else ""))
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    import tm_db                      # noqa: F401  (只为复用 get)
    args = sys.argv[1:]
    if len(args) < 3:
        print("用法：python tm_injury.py <联赛> <主队> <客队>")
        print("例如：python tm_injury.py 英超 阿森纳 切尔西")
        sys.exit(1)
    t0 = time.time()
    res = compute(args[0], args[1], args[2],
                  progress=lambda d, t, m: print("  ", m, flush=True))
    print("")
    if not res.get("ok"):
        print("✘", res.get("error"))
        sys.exit(1)
    print(_fmt_one(res["home"]))
    print("")
    print(_fmt_one(res["away"]))
    print("\nTM 请求余额：%d/%d　用时 %.1f 秒" % (res["budgetLeft"], res["budgetMax"], time.time() - t0))
