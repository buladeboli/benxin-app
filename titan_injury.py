# -*- coding: utf-8 -*-
"""
titan_injury.py —— 从球探(titan007) 抓一场比赛的【伤停 + 上一场首发/替补】

为什么用它（而不是 Transfermarkt）：
  · 球探这一页直接给**球衣号码 + 位置 + 缺阵原因**，正是「伤停量化」要的三组号码；
  · TM 只给球员 ID/姓名，而且伤停滞后 1~2 天、小球队收录弱。

数据来源（一个请求搞定）：
    https://zq.titan007.com/analysis/<比赛ID>cn.htm      （约 24 万字节）
  页面里有两块：
    ① 「阵容情况」→ 两队各自的【缺阵名单】= 号码 (位置) 姓名 + 缺阵原因
    ② 同一区块里的「上一场阵容」→ 两队各自的【首发】/【后备】号码
       ★ 注意：这块在 HTML 里被 <!-- --> 注释掉了，但数据是完整的，
         把注释符去掉就能解析（不要被"注释"骗了）。

防封（上次被封过，这次必须守规矩）：
  · 一次只发一个请求（串行），相邻请求至少间隔 PACING 秒
  · 同一场比赛 PACING_HOURS 小时内走缓存，不重复抓
  · 连续失败 2 次 → 直接停 BLOCK_MIN 分钟，不再硬重试
  · 带 User-Agent + Referer（模拟正常浏览）
"""

import json
import os
import re
import ssl
import time
import threading
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
CACHE_PATH = os.path.join(DATA_DIR, "titan_injury_cache.json")

PACING = 2.0            # 相邻请求最小间隔（秒）
PACING_HOURS = 6        # 同一场缓存多久
BLOCK_MIN = 10          # 连续失败后停多久（分钟）
MAX_FAIL = 2            # 连续失败几次就停

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")
REFERER = "https://zq.titan007.com/"

_lock = threading.Lock()
_state = {"last_req": 0.0, "fail": 0, "blocked_until": 0.0}


# ---------------------------------------------------------------- 缓存
def _load_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            j = json.load(f)
            return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def _save_cache(c):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass


# ---------------------------------------------------------------- 网络（TLS 1.0）
_CTX = None


def _ctx():
    global _CTX
    if _CTX is None:
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        try:
            c.minimum_version = ssl.TLSVersion.TLSv1      # ★ 球探只支持老 TLS
        except Exception:
            pass
        try:
            c.set_ciphers("DEFAULT@SECLEVEL=0")
        except Exception:
            pass
        _CTX = c
    return _CTX


def parse_match_id(s):
    """从链接或纯数字里取比赛 ID"""
    s = str(s or "").strip()
    m = re.search(r"/analysis/[a-z]*/?(\d{4,9})", s, re.I)
    if m:
        return m.group(1)
    m = re.search(r"(\d{4,9})", s)
    return m.group(1) if m else ""


def _get(url):
    """串行 + 间隔 + 熔断的一次 GET"""
    now = time.time()
    with _lock:
        if now < _state["blocked_until"]:
            left = int((_state["blocked_until"] - now) / 60) + 1
            raise RuntimeError("球探那边刚才连着失败，已自动停手（还要等 %d 分钟）。"
                               "这通常是被限流了，等一会再点。" % left)
        wait = PACING - (now - _state["last_req"])
        if wait > 0:
            time.sleep(wait)
        _state["last_req"] = time.time()

    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER,
                                              "Accept-Language": "zh-CN,zh;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=35, context=_ctx()) as r:
            body = r.read()
        with _lock:
            _state["fail"] = 0
        try:
            return body.decode("utf-8")
        except Exception:
            return body.decode("gbk", "replace")
    except Exception as e:
        with _lock:
            _state["fail"] += 1
            if _state["fail"] >= MAX_FAIL:
                _state["blocked_until"] = time.time() + BLOCK_MIN * 60
                _state["fail"] = 0
        raise RuntimeError("抓不到（%s）" % str(e)[:80])


# ---------------------------------------------------------------- 解析
def _clean(s):
    s = str(s or "")
    s = s.replace("&nbsp;", " ").replace("\u00a0", " ")
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _num_pos_name(cell_html):
    """把 '39 (中前卫) 布鲁诺·吉马良斯' 拆成 (39, '中前卫', '布鲁诺·吉马良斯')"""
    t = _clean(cell_html)
    m = re.match(r"^\s*(\d{1,3})\s*\(\s*([^)]*?)\s*\)\s*(.+?)\s*$", t)
    if m:
        return int(m.group(1)), m.group(2), m.group(3)
    m = re.match(r"^\s*(\d{1,3})\s+(.+?)\s*$", t)
    if m:
        return int(m.group(1)), "", m.group(2)
    return None, "", t


def _rows(block):
    """把一块 HTML 拆成 [ [cell1, cell2], ... ]（只看 <tr>，每行取前两个 <td>）"""
    out = []
    for tr in re.findall(r"<tr\b[\s\S]*?</tr>", block, re.I):
        cells = re.findall(r"<td\b[\s\S]*?</td>", tr, re.I)
        if len(cells) >= 2:
            out.append(cells)
        elif len(cells) == 1:
            out.append([cells[0], ""])
    return out


def parse(html):
    """解析 analysis 页 → 两队 {name, out[], starters[], subs[]}"""
    # ① 去掉 HTML 注释符号（「上一场阵容」就在注释里，数据是好的）
    h = str(html or "")
    h = h.replace("<!--", "").replace("-->", "")

    # ② 定位「阵容情况」区块
    i = h.find("阵容情况")
    if i < 0:
        raise RuntimeError("这页里没找到「阵容情况」（可能不是足球比赛，或页面改版了）")
    seg = h[i:]
    j = seg.find("<h2", 10)
    if j > 0:
        seg = seg[:j]

    # ③ 按 50% 宽的两栏切成主/客队
    parts = re.split(r'<td[^>]*width\s*=\s*["\']?50%', seg, flags=re.I)
    blocks = [p for p in parts[1:] if "缺阵原因" in p or "上一场阵容" in p]
    if len(blocks) < 2:
        # 退路：按「缺阵原因」出现切成两块
        idxs = [m.start() for m in re.finditer("缺阵原因", seg)]
        blocks = []
        for k, st in enumerate(idxs):
            en = idxs[k + 1] if k + 1 < len(idxs) else len(seg)
            blocks.append(seg[max(0, st - 2500):en])
    if len(blocks) < 2:
        raise RuntimeError("解析不出两支队的阵容区块（页面结构可能变了）")

    teams = []
    for b in blocks[:2]:
        # 队名：第一个 <b>...</b>
        nm = re.search(r"<b>\s*([^<]+?)\s*</b>", b)
        name = _clean(nm.group(1)) if nm else ""
        if not name:
            nm = re.search(r'title=["\']([^"\']+)["\']', b)
            name = _clean(nm.group(1)) if nm else "?"

        rows = _rows(b)
        outs, starters, subs = [], [], []
        in_lineup = False
        for cells in rows:
            joined = " ".join(cells)
            if "上一场阵容" in joined:
                in_lineup = True
                continue
            if "缺阵原因" in joined or ("球员" in joined and "原因" in joined):
                continue
            if in_lineup:
                n1, _, _ = _num_pos_name(cells[0])
                n2, _, _ = _num_pos_name(cells[1]) if len(cells) > 1 else (None, "", "")
                if n1:
                    starters.append(n1)
                if n2:
                    subs.append(n2)
            else:
                num, pos, pname = _num_pos_name(cells[0])
                reason = _clean(cells[1]) if len(cells) > 1 else ""
                if num is None:
                    continue
                outs.append({"num": num, "pos": pos, "name": pname, "reason": reason,
                             "suspend": bool(re.search(r"停赛|红牌|禁赛", reason))})
        teams.append({"name": name, "out": outs, "starters": starters, "subs": subs})

    return {"home": teams[0], "away": teams[1]}


# ---------------------------------------------------------------- 对外
def get(match, force=False):
    """match 可以是比赛 ID 或 analysis 链接；返回解析结果（带缓存）"""
    mid = parse_match_id(match)
    if not mid:
        raise RuntimeError("没看出比赛 ID —— 请贴 zq.titan007.com/analysis/xxxxxcn.htm 这种链接")

    cache = _load_cache()
    hit = cache.get(mid)
    if hit and not force and (time.time() - float(hit.get("at", 0))) < PACING_HOURS * 3600:
        out = dict(hit.get("data") or {})
        out["cached"] = True
        out["matchId"] = mid
        return out

    url = "https://zq.titan007.com/analysis/%scn.htm" % mid
    html = _get(url)
    data = parse(html)
    data["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        c = _load_cache()
        c[mid] = {"at": time.time(), "data": data}
        # 只留最近 200 场
        if len(c) > 200:
            for k in sorted(c.keys(), key=lambda x: c[x].get("at", 0))[:len(c) - 200]:
                c.pop(k, None)
        _save_cache(c)
    out = dict(data)
    out["cached"] = False
    out["matchId"] = mid
    out["url"] = url
    return out


def _fmt(side):
    name = side.get("name", "?")
    lines = ["【%s】" % name]
    outs = side.get("out") or []
    if outs:
        lines.append("  缺阵 %d 人：" % len(outs))
        for o in outs:
            lines.append("    %-3s (%s) %s —— %s" % (o.get("num"), o.get("pos") or "?", o.get("name"),
                                                    o.get("reason") or "未写原因"))
    else:
        lines.append("  缺阵：无")
    lines.append("  上一场首发 %d 人：%s" % (len(side.get("starters") or []),
                                        ",".join(str(x) for x in (side.get("starters") or []))))
    lines.append("  上一场后备 %d 人：%s" % (len(side.get("subs") or []),
                                        ",".join(str(x) for x in (side.get("subs") or []))))
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--selftest":
        # 对着本地样本跑解析（不发请求）
        p = os.path.join(DATA_DIR, "_sample_analysis.htm")
        html = open(p, encoding="utf-8", errors="replace").read()
        d = parse(html)
        print(_fmt(d["home"]))
        print("")
        print(_fmt(d["away"]))
        sys.exit(0)
    if not arg:
        print("用法：python titan_injury.py <比赛ID或链接>    |    python titan_injury.py --selftest")
        sys.exit(1)
    t0 = time.time()
    r = get(arg)
    print("比赛 %s（%s，%.1f 秒）" % (r["matchId"], "来自缓存" if r.get("cached") else "刚抓的", time.time() - t0))
    print(_fmt(r["home"]))
    print("")
    print(_fmt(r["away"]))
