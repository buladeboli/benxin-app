# -*- coding: utf-8 -*-
"""
scrape_one.py —— 给 GitHub Actions 用的一次抓取脚本

输入（环境变量）：
    MATCH      球探比赛 ID（必填），例如 3003849
    KIND       titan（默认）—— 目前只支持球探伤停

输出：
    docs/data/titan-<MATCH>.json     前端要轮询的文件
    docs/data/titan-latest.json      最近一次（方便人工看）

本地也能直接跑：
    MATCH=3003849 python scrape_one.py
"""

import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "docs", "data")

sys.path.insert(0, HERE)


def main():
    match = (os.environ.get("MATCH") or "").strip()
    if not match:
        print("!! 没有 MATCH 环境变量")
        return 2

    import titan_injury

    mid = titan_injury.parse_match_id(match)
    if not mid:
        print("!! 看不出比赛 ID：%r" % match)
        return 2

    print("抓取比赛 %s …" % mid)
    t0 = time.time()
    try:
        data = titan_injury.get(mid, force=True)
    except Exception as e:                      # noqa: BLE001
        payload = {
            "ok": False,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "match": mid,
            "error": str(e)[:300],
        }
        _write(mid, payload)
        print("!! 抓取失败：%s" % e)
        return 1

    payload = {
        "ok": True,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "match": mid,
        "home": data.get("home"),
        "away": data.get("away"),
        "url": data.get("url", ""),
        "cost_sec": round(time.time() - t0, 1),
        "text": titan_injury._fmt(data["home"]) + "\n\n" + titan_injury._fmt(data["away"]),
    }
    _write(mid, payload)
    print("✔ 完成，用时 %.1f 秒" % (time.time() - t0))
    print(payload["text"])
    return 0


def _write(mid, payload):
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in ("titan-%s.json" % mid, "titan-latest.json"):
        p = os.path.join(OUT_DIR, name)
        with io.open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        print("   写入 %s" % p)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
