#!/usr/bin/env python3
"""Build an intraday concept-board cumulative fund-flow chart."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

concepts = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
endpoint = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}


def fetch(item):
    response = requests.get(
        endpoint,
        params={
            "lmt": 0,
            "klt": 1,
            "secid": f"90.{item['code']}",
            "fields1": "f1,f2,f3,f7",
            "fields2": (
                "f51,f52,f53,f54,f55,f56,f57,"
                "f58,f59,f60,f61,f62,f63,f64,f65"
            ),
        },
        timeout=35,
        verify=False,
        headers=headers,
    )
    response.raise_for_status()
    rows = (response.json().get("data") or {}).get("klines") or []
    points = []
    for row in rows:
        values = str(row).split(",")
        if len(values) < 2:
            continue
        try:
            main_flow = round(float(values[1]) / 100_000_000, 4)
        except (TypeError, ValueError):
            continue
        points.append([values[0], main_flow])
    return item["code"], {
        **item,
        "points": points,
        "latest": points[-1][1] if points else item.get("latest"),
    }


result = []
with ThreadPoolExecutor(max_workers=6) as executor:
    futures = [executor.submit(fetch, item) for item in concepts]
    for future in as_completed(futures):
        try:
            _, item = future.result()
            if item.get("points"):
                result.append(item)
        except Exception:
            continue

result.sort(key=lambda item: item.get("latest") or 0, reverse=True)
all_times = [
    point[0]
    for item in result
    for point in item.get("points", [])
]
latest_time = max(all_times) if all_times else ""
source_date = latest_time[:10] if latest_time else ""
china_tz = timezone(timedelta(hours=8))
print(
    json.dumps(
        {
            "source": "东方财富概念板块1分钟资金流",
            "sourceDate": source_date,
            "quoteTime": latest_time,
            "fetchedAt": datetime.now(china_tz).isoformat(),
            "unit": "亿元",
            "conceptCount": len(result),
            "chartCount": sum(
                1 for item in result if item.get("showInChart")
            ),
            "selectionRule": (
                "热点排序候选合并综合热度、短线热度、累计资金和涨停事件"
                "靠前的概念；资金图只展示流入、流出与热度代表概念。"
            ),
            "concepts": result,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    heat_file = root / "concept_heat_cache.json"
    hotspot_file = root / "concept_hotspot_cache.json"
    if not heat_file.exists():
        print("concept_heat_cache.json is missing", file=sys.stderr)
        return 1
    heat = json.loads(heat_file.read_text(encoding="utf-8"))
    hotspot = (
        json.loads(hotspot_file.read_text(encoding="utf-8"))
        if hotspot_file.exists()
        else {}
    )
    items = [
        item
        for item in heat.get("concepts", [])
        if item.get("code")
        and item.get("mainNetInflow") is not None
        and item.get("category") == "theme"
    ]
    heat_ranked = sorted(
        items,
        key=lambda item: item.get("heatScore") or 0,
        reverse=True,
    )
    short_ranked = sorted(
        items,
        key=lambda item: item.get("shortTermScore") or 0,
        reverse=True,
    )
    positive = sorted(
        items,
        key=lambda item: item.get("mainNetInflow") or 0,
        reverse=True,
    )
    negative = sorted(
        [item for item in items if (item.get("mainNetInflow") or 0) < 0],
        key=lambda item: item.get("mainNetInflow") or 0,
    )[:10]
    event_items = sorted(
        hotspot.get("concepts", []),
        key=lambda item: (
            item.get("limitUpCount") or 0,
            item.get("multiBoardCount") or 0,
            item.get("maxBoard") or 0,
        ),
        reverse=True,
    )[:25]
    by_code = {item["code"]: item for item in items}
    selected = {}
    for item in (
        heat_ranked[:30]
        + short_ranked[:20]
        + positive[:20]
        + negative
    ):
        selected[item["code"]] = {
            "code": item["code"],
            "name": item.get("name"),
            "category": item.get("category"),
            "changePct": item.get("changePct"),
            "heatScore": item.get("heatScore"),
            "latest": round(
                (item.get("mainNetInflow") or 0) / 100_000_000,
                4,
            ),
        }
    for event in event_items:
        item = by_code.get(event.get("code"))
        if item:
            selected[item["code"]] = {
                "code": item["code"],
                "name": item.get("name"),
                "category": item.get("category"),
                "changePct": item.get("changePct"),
                "heatScore": item.get("heatScore"),
                "latest": round(
                    (item.get("mainNetInflow") or 0) / 100_000_000,
                    4,
                ),
            }
    chart_codes = {
        item["code"]
        for item in (positive[:14] + negative[:7] + heat_ranked[:4])
    }
    for code, item in selected.items():
        item["showInChart"] = code in chart_codes
    encoded = base64.b64encode(
        json.dumps(list(selected.values()), ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    try:
        result = run_script(REMOTE_SCRIPT, (encoded,), timeout=180)
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Concept intraday flow fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1
    output = root / "concept_intraday_flow_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('conceptCount')} concepts "
        f"for {payload.get('quoteTime')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
