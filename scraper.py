# -*- coding: utf-8 -*-
"""
scraper.py —— 竞彩 / 胜负彩 数据抓取与解析（只依赖 Python 标准库）

【数据源策略】
  任何一个网站都可能改版、限流、临时挂掉，所以这里做成「多入口 + 逐级降级」：

    竞彩（要 编号/联赛/主客/时间/让球/胜平负/让球/比分/总进球/半全场）
      ① 500彩票网 · 竞彩 主入口  trade.500.com/jczq/index.php?playid=312&g=2
      ② 500彩票网 · 竞彩 备用入口  trade.500.com/jczq/?playid=312&g=2
      ③ 500彩票网 · 竞彩 基础页    trade.500.com/jczq/      （只有胜平负+让球）
    胜负彩 14 场
      ④ 500彩票网 · 胜负彩        trade.500.com/sfc/
      ⑤ 500彩票网 · 胜负彩(备用)  trade.500.com/sfc/index.php
    兜底
      ⑥ 上一次抓成功的磁盘缓存（会标注「缓存」，并说明本次为什么失败）

  每个源的耗时 / 条数 / 错误都会回传到前端，在页面「数据源明细」里能看到。

  说明：为什么没有别家网站？
    · 体彩官方接口 webapi.sporttery.cn 在本机被 WAF 硬拦（403 / 567，换 UA 无效）
    · 澳客 / 新浪的竞彩页是 JS 渲染的，HTML 里没有赔率数据，抓不到
    · 500 是目前唯一「一次请求就能拿到全部玩法赔率」的源
  所以不硬凑第三个站，而是把 500 的两个入口 + 缓存 + 手动导入做成三层兜底。

【解析设计】（2026-10 实测的页面结构）
  竞彩：每场是 <tr class="bet-tb-tr" data-matchnum="周一001" data-homesxname="..." ...>
        赔率 <p class="betbtn" data-type="nspf" data-value="3" data-sp="1.80">
        附加玩法在同一场的 <tr class="bet-more-wrap"> 里（data-type=bf/jqs/bqc）
        ⚠ 附加玩法那块有嵌套 <tr>，所以按「主行起点切段」，不能按 </tr> 切。
  胜负彩：<tr class="bet-tb-tr" data-cid="1"> + td-no / td-evt / td-endtime / team-l / team-r
"""

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- 源清单

SOURCES_JCZQ = [
    {
        "id": "500-jczq-a", "name": "500彩票网 · 竞彩（主入口）", "kind": "jczq",
        "url": "https://trade.500.com/jczq/index.php?playid=312&g=2",
        "referer": "https://trade.500.com/jczq/",
    },
    {
        "id": "500-jczq-b", "name": "500彩票网 · 竞彩（备用入口）", "kind": "jczq",
        "url": "https://trade.500.com/jczq/?playid=312&g=2",
        "referer": "https://trade.500.com/jczq/",
    },
    {
        "id": "500-jczq-c", "name": "500彩票网 · 竞彩（基础页，只有胜平负+让球）", "kind": "jczq",
        "url": "https://trade.500.com/jczq/",
        "referer": "https://www.500.com/",
    },
]

SOURCES_SFC = [
    {
        "id": "500-sfc-a", "name": "500彩票网 · 胜负彩", "kind": "sfc",
        "url": "https://trade.500.com/sfc/",
        "referer": "https://trade.500.com/",
    },
    {
        "id": "500-sfc-b", "name": "500彩票网 · 胜负彩（备用）", "kind": "sfc",
        "url": "https://trade.500.com/sfc/index.php",
        "referer": "https://trade.500.com/",
    },
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Connection": "close",
}

TIMEOUT = 20
RETRY = 2

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, "data")
CACHE_FILE = os.path.join(CACHE_DIR, "cache.json")

MARKETS = [("nspf", "胜平负"), ("spf", "让球胜平负"), ("bf", "比分"), ("jqs", "总进球"), ("bqc", "半全场")]
SPF_KEYS = ["3", "1", "0"]      # 500 的约定：3=胜 1=平 0=负


# ---------------------------------------------------------------- HTTP

def _fetch(url, referer="https://www.500.com/", timeout=TIMEOUT, retry=RETRY):
    headers = dict(HEADERS)
    headers["Referer"] = referer
    last = None
    for attempt in range(retry + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                if resp.status != 200:
                    raise RuntimeError("HTTP %s" % resp.status)
                return resp.read()
        except Exception as e:                       # noqa: BLE001
            last = e
            if attempt < retry:
                time.sleep(1.0 * (attempt + 1))
    raise RuntimeError("%s" % last)


def _decode(raw):
    for enc in ("gb18030", "gbk", "utf-8"):
        try:
            return raw.decode(enc)
        except Exception:                            # noqa: BLE001
            continue
    return raw.decode("gb18030", "ignore")


# ---------------------------------------------------------------- 小工具

def _attr(html, name, default=""):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % re.escape(name), html)
    return m.group(1).strip() if m else default


def _num(s, default=None):
    try:
        return float(str(s).strip())
    except Exception:                                # noqa: BLE001
        return default


def _clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def rq_text(rq):
    """让球数 → 人话。500 约定：负=主队让球，正=主队受让。"""
    if rq is None or rq == "":
        return "—"
    v = _num(rq, None)
    if v is None:
        return "—"
    if v == 0:
        return "0"
    return ("主让%d" % abs(int(v))) if v < 0 else ("主受让%d" % abs(int(v)))


def _odds_map(block, type_name):
    """抓某个玩法的所有选项：data-type=... data-value=... data-sp=..."""
    out = {}
    pat = re.compile(
        r'data-type\s*=\s*"%s"\s+data-value\s*=\s*"([^"]*)"\s+data-sp\s*=\s*"([^"]*)"'
        % re.escape(type_name))
    for m in pat.finditer(block):
        sp = _num(m.group(2))
        if sp and sp > 0:
            out[m.group(1).strip()] = sp
    if not out:   # 属性顺序可能变
        pat2 = re.compile(
            r'data-type\s*=\s*"%s"\s+data-sp\s*=\s*"([^"]*)"\s+data-value\s*=\s*"([^"]*)"'
            % re.escape(type_name))
        for m in pat2.finditer(block):
            sp = _num(m.group(1))
            if sp and sp > 0:
                out[m.group(2).strip()] = sp
    return out


def _split_matches(html):
    """按「主行起点」把页面切成一场一场（附加玩法嵌套 tr 也不会切坏）。"""
    starts = [m.start() for m in re.finditer(r'<tr\b[^>]*class="bet-tb-tr', html)]
    if not starts:
        return []
    return [html[a:b] for a, b in zip(starts, starts[1:] + [len(html)])]


# ---------------------------------------------------------------- 解析：竞彩

def parse_jczq(html):
    matches = []
    for block in _split_matches(html):
        open_tag = block[:block.find(">") + 1]
        num = _attr(open_tag, "data-matchnum")
        home = _attr(open_tag, "data-homesxname")
        away = _attr(open_tag, "data-awaysxname")
        if not num or not home:
            continue

        rq_raw = _attr(open_tag, "data-rangqiu")
        isend = _attr(open_tag, "data-isend")
        sub = _attr(open_tag, "data-subactive")
        sub_on = sorted({it.split(":", 1)[0].strip() for it in sub.split(",")
                         if ":" in it and it.split(":", 1)[1].strip() == "1"})

        markets = {}
        for key, _label in MARKETS:
            o = _odds_map(block, key)
            if o:
                markets[key] = o

        matches.append({
            "id": num,
            "num": num,
            "home": home,
            "away": away,
            "league": _attr(open_tag, "data-simpleleague") or "—",
            "kickoff": ("%s %s" % (_attr(open_tag, "data-matchdate"),
                                  _attr(open_tag, "data-matchtime"))).strip(),
            "buyend": _attr(open_tag, "data-buyendtime"),
            "rangqiu": _num(rq_raw, None) if rq_raw != "" else None,
            "rangqiu_text": rq_text(rq_raw),
            "on_sale": isend == "0",
            "nspf": [markets.get("nspf", {}).get(k) for k in SPF_KEYS],
            "spf": [markets.get("spf", {}).get(k) for k in SPF_KEYS],
            "odds": markets,
            "sub_on": sub_on,
        })
    return matches


# ---------------------------------------------------------------- 解析：胜负彩

def parse_sfc(html):
    expect = ""
    for pat in (r'name="expect"[^>]*value="([0-9]+)"',
                r'id="expect"[^>]*value="([0-9]+)"',
                r'curexp[^>]*value="([0-9]+)"'):
        m = re.search(pat, html)
        if m:
            expect = m.group(1)
            break

    out = []
    for block in _split_matches(html):
        open_tag = block[:block.find(">") + 1]
        if "data-cid" not in open_tag and "td-no" not in block:
            continue

        no = _attr(open_tag, "data-cid")
        if not no:
            m = re.search(r'<td class="td td-no">\s*([0-9]{1,2})\s*</td>', block)
            no = m.group(1) if m else ""
        if not no:
            continue

        lg = ""
        m = re.search(r'<td class="td td-evt">[\s\S]{0,240}?<a[^>]*>([^<]{2,12})</a>', block)
        if m:
            lg = _clean(m.group(1))

        end = ""
        m = re.search(r'<td class="td td-endtime"[^>]*>([^<]{3,20})</td>', block)
        if m:
            end = _clean(m.group(1))

        sides = re.findall(r'class="team-[lr]"[^>]*>([^<]{1,20})</a>', block)
        home = _clean(sides[0]) if len(sides) >= 1 else ""
        away = _clean(sides[1]) if len(sides) >= 2 else ""
        if not (home or away):
            vs = _attr(open_tag, "data-vs")
            if "vs" in vs:
                home, _, away = vs.partition("vs")
                home, away = _clean(home), _clean(away)
        if not home and not away:
            continue

        out.append({
            "no": int(no) if str(no).isdigit() else no,
            "league": lg or "—",
            "home": home,
            "away": away,
            "kickoff": end,
            "odds": None,
            "odds_from": None,
        })
        if len(out) >= 14:
            break

    deadline = ""
    m = re.search(r'截止[^<]{0,10}([\d]{1,2}-[\d]{1,2}[\s]*[\d:]{0,5})', html)
    if m:
        deadline = _clean(m.group(1))

    return {"expect": expect, "matches": out, "deadline": deadline}


def resolve_sfc_odds(sfc, jczq):
    """给 14 场补「参考胜平负赔率」= 同场竞彩赔率（胜负彩本身没有固定赔率）。"""
    index = {(m["home"], m["away"]): m for m in jczq}
    hit = 0
    for it in sfc.get("matches", []):
        m = index.get((it["home"], it["away"]))
        if m and any(m.get("nspf") or []):
            it["odds"] = m["nspf"]
            it["odds_from"] = "竞彩同场：" + m["num"]
            hit += 1
    return hit


# ---------------------------------------------------------------- 缓存

def _cache_read():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:                                # noqa: BLE001
        return None


def _cache_write(payload):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, CACHE_FILE)
    except Exception:                                # noqa: BLE001
        pass


# ---------------------------------------------------------------- 逐源尝试

def _try_sources(sources, parser, want, label):
    """
    依次尝试 sources，返回 (结果, 该块的状态列表)。
    want(x) 判断结果是否"够用"（条数 > 0，或 ≥14 场）。
    """
    status = []
    for src in sources:
        t0 = time.time()
        try:
            html = _decode(_fetch(src["url"], referer=src.get("referer", "")))
            got = parser(html)
            count = len(got) if isinstance(got, list) else len(got.get("matches", []))
            ms = int((time.time() - t0) * 1000)
            if want(got):
                status.append({"id": src["id"], "name": src["name"], "ok": True,
                               "count": count, "ms": ms})
                return got, status
            status.append({"id": src["id"], "name": src["name"], "ok": False,
                           "count": count, "ms": ms,
                           "error": "%s：页面抓到了但没解析出%s（可能改版了）" % (label, label)})
        except Exception as e:                       # noqa: BLE001
            status.append({"id": src["id"], "name": src["name"], "ok": False,
                           "count": 0, "ms": int((time.time() - t0) * 1000),
                           "error": "%s" % e})
    return None, status


def scrape():
    """
    抓一次（竞彩 + 胜负彩）。**永不抛异常**。
    """
    t_all = time.time()
    errors = []
    sources = []

    # ---- 竞彩
    jczq, st = _try_sources(SOURCES_JCZQ, parse_jczq, lambda x: len(x) > 0, "竞彩")
    sources.extend(st)
    if jczq is None:
        jczq = []
        errors.append("竞彩：所有入口都失败了（详见下面的数据源明细）")

    # ---- 胜负彩
    sfc, st2 = _try_sources(SOURCES_SFC, parse_sfc,
                            lambda x: len(x.get("matches", [])) >= 14, "胜负彩")
    sources.extend(st2)
    if sfc is None:
        sfc = {"expect": "", "matches": [], "deadline": ""}
        errors.append("胜负彩：所有入口都失败了")
    else:
        hit = resolve_sfc_odds(sfc, jczq)
        if hit == 0:
            errors.append("胜负彩：14 场拿到了，但同场竞彩赔率一个都没对上（参考赔率显示 —，不影响计算）")

    ok = bool(jczq) or bool(sfc.get("matches"))
    payload = {
        "ok": ok,
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "jczq": jczq,
        "sfc": sfc,
        "errors": errors,
        "sources": sources,
        "from_cache": False,
        "cost_ms": int((time.time() - t_all) * 1000),
        "source": "500彩票网",
    }

    if ok:
        _cache_write(payload)
        return payload

    cached = _cache_read()
    if cached:
        cached = dict(cached)
        cached["from_cache"] = True
        cached["sources"] = sources
        cached["errors"] = errors + [
            "本次全部抓取失败，下面是**上一次成功**拿到的数据（时间 %s）。" % cached.get("ts", "?")]
        return cached
    return payload


def load_cache_only():
    cached = _cache_read()
    if cached:
        cached = dict(cached)
        cached["from_cache"] = True
        return cached
    return {"ok": False, "ts": "", "jczq": [], "sfc": {"expect": "", "matches": [], "deadline": ""},
            "errors": ["还没有数据 —— 点右上角「刷新数据」抓一次"], "sources": [],
            "from_cache": True, "source": "500彩票网"}


def health():
    """给前端做连通性探测用。"""
    cached = _cache_read()
    return {
        "ok": True,
        "service": "竞彩数据服务",
        "version": "1.1",
        "python": "%d.%d.%d" % (__import__("sys").version_info[:3]),
        "cache": bool(cached),
        "cache_ts": (cached or {}).get("ts", ""),
        "sources": [s["name"] for s in (SOURCES_JCZQ + SOURCES_SFC)],
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


# ---------------------------------------------------------------- 命令行

if __name__ == "__main__":
    d = scrape()
    print("ok=%s  ts=%s  from_cache=%s  耗时 %sms" % (d["ok"], d["ts"], d["from_cache"], d.get("cost_ms", "?")))
    print("竞彩 %d 场（在售 %d）" % (len(d["jczq"]), sum(1 for x in d["jczq"] if x["on_sale"])))
    for x in d["jczq"][:8]:
        print("   %-8s %-6s %s vs %s  %s  让球[%s]  胜平负%s  让球%s  玩法%s"
              % (x["num"], x["league"], x["home"], x["away"], x["kickoff"],
                 x["rangqiu_text"], x["nspf"], x["spf"], ",".join(sorted(x["odds"].keys()))))
    print("胜负彩 期号=%s  %d 场" % (d["sfc"]["expect"], len(d["sfc"]["matches"])))
    print("数据源：")
    for s in d.get("sources", []):
        print("   %s %-46s %s" % ("OK " if s["ok"] else "FAIL", s["name"],
                                  ("%d 条 / %dms" % (s.get("count", 0), s.get("ms", 0))) if s["ok"] else s.get("error", "")))
    if d["errors"]:
        print("提示：")
        for e in d["errors"]:
            print("   -", e)
