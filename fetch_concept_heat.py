#!/usr/bin/env python3
"""Fetch current concept-board heat and rank market themes."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import json
import time
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

endpoint = "https://push2.eastmoney.com/api/qt/clist/get"
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}


def number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def percentile_rank(values, value):
    if value is None or not values:
        return 0.0
    below = sum(1 for item in values if item < value)
    equal = sum(1 for item in values if item == value)
    return (below + equal * 0.5) / len(values)


rows = []
for page in range(1, 8):
    response = None
    last_error = None
    for attempt in range(6):
        try:
            response = requests.get(
                endpoint,
                params={
                    "pn": page,
                    "pz": 100,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f3",
                    "fs": "m:90+t:3+f:!50",
                    "fields": (
                        "f2,f3,f6,f8,f10,f12,f14,f24,f25,f62,f104,f105,f106,"
                        "f109,f124,f128,f136,f184"
                    ),
                },
                timeout=35,
                verify=False,
                headers=headers,
            )
            response.raise_for_status()
            break
        except Exception as exc:
            last_error = exc
            if attempt == 5:
                raise RuntimeError(
                    f"Concept heat page {page} failed after retries: {last_error}"
                ) from exc
            time.sleep(min(8, 1.2 * (attempt + 1)))
    data = response.json().get("data") or {}
    batch = data.get("diff") or []
    if isinstance(batch, dict):
        batch = list(batch.values())
    rows.extend(batch)
    total = int(data.get("total") or 0)
    if not batch or len(rows) >= total:
        break

excluded_parts = (
    "昨日",
    "连板",
    "ST股",
    "融资融券",
    "转债标的",
    "破净股",
    "高送转",
    "AH股",
    "B股",
    "标普",
    "富时罗素",
    "MSCI",
    "证金持股",
    "汇金持股",
    "基金重仓",
    "QFII",
    "社保重仓",
    "预盈预增",
    "预亏预减",
    "预增",
    "预减",
    "股权转让",
    "并购重组",
    "壳资源",
    "举牌",
    "最近",
    "多板",
    "IPO受益",
    "长期破净",
    "破增发价股",
)

style_parts = (
    "指数",
    "成份",
    "样本",
    "权重",
    "成长",
    "市值",
    "热股",
    "题材股",
    "重仓",
    "减仓",
    "机构",
    "持股",
    "小盘",
    "中盘",
    "大盘",
    "风格",
    "龙头",
    "价值股",
    "红利股",
    "中特估",
    "GDR",
    "沪股通",
    "深股通",
    "标准普尔",
    "上证",
    "深证",
    "创业板",
    "科创板",
    "中证",
    "国证",
    "百元股",
    "茅指数",
    "宁组合",
    "市盈率",
    "市净率",
    "HS300",
    "深成",
    "次新股",
    "低价股",
    "高价股",
    "破发",
)

concepts = []
quote_timestamps = []
for row in rows:
    name = str(row.get("f14") or "").strip()
    if not name or any(part in name for part in excluded_parts):
        continue
    up_count = int(row.get("f104") or 0)
    down_count = int(row.get("f105") or 0)
    flat_count = int(row.get("f106") or 0)
    member_count = up_count + down_count + flat_count
    if member_count < 3:
        continue
    quote_timestamp = int(row.get("f124") or 0)
    if quote_timestamp:
        quote_timestamps.append(quote_timestamp)
    concepts.append(
        {
            "code": row.get("f12"),
            "name": name,
            "category": "style"
            if any(part in name for part in style_parts)
            else "theme",
            "changePct": number(row.get("f3")),
            "return5d": number(row.get("f109")),
            "return60d": number(row.get("f24")),
            "returnYtd": number(row.get("f25")),
            "amount": number(row.get("f6")),
            "turnoverRate": number(row.get("f8")),
            "volumeRatio": number(row.get("f10")),
            "mainNetInflow": number(row.get("f62")),
            "mainNetRatio": number(row.get("f184")),
            "upCount": up_count,
            "downCount": down_count,
            "flatCount": flat_count,
            "memberCount": member_count,
            "upRatio": round(up_count / member_count * 100, 4)
            if member_count
            else None,
            "leaderName": row.get("f128"),
            "leaderChangePct": number(row.get("f136")),
            "quoteTimestamp": quote_timestamp,
        }
    )

change_values = [
    item["changePct"] for item in concepts if item["changePct"] is not None
]
return5_values = [
    item["return5d"]
    for item in concepts
    if item["return5d"] is not None
]
return60_values = [
    item["return60d"]
    for item in concepts
    if item["return60d"] is not None
]
flow_values = [
    item["mainNetRatio"]
    for item in concepts
    if item["mainNetRatio"] is not None
]
breadth_values = [
    item["upRatio"] for item in concepts if item["upRatio"] is not None
]
volume_values = [
    item["volumeRatio"]
    for item in concepts
    if item["volumeRatio"] is not None
]
amount_values = [
    item["amount"] for item in concepts if item["amount"] is not None
]

for item in concepts:
    return5_rank = percentile_rank(return5_values, item["return5d"])
    change_rank = percentile_rank(change_values, item["changePct"])
    flow_rank = percentile_rank(flow_values, item["mainNetRatio"])
    breadth_rank = percentile_rank(breadth_values, item["upRatio"])
    volume_rank = percentile_rank(volume_values, item["volumeRatio"])
    amount_rank = percentile_rank(amount_values, item["amount"])
    return60_rank = percentile_rank(
        return60_values,
        item["return60d"],
    )
    short_score = (
        return5_rank * 0.40
        + change_rank * 0.20
        + flow_rank * 0.15
        + breadth_rank * 0.10
        + volume_rank * 0.10
        + amount_rank * 0.05
    )
    score = (
        return5_rank * 0.20
        + return60_rank * 0.15
        + change_rank * 0.15
        + flow_rank * 0.20
        + breadth_rank * 0.15
        + volume_rank * 0.10
        + amount_rank * 0.05
    )
    item["shortTermScore"] = round(short_score * 100, 2)
    item["shortTermRank"] = round(short_score, 4)
    item["heatScore"] = round(score * 100, 2)
    reasons = []
    if (item["changePct"] or 0) >= 2:
        reasons.append("板块领涨")
    if (item["return60d"] or 0) >= 10:
        reasons.append("中期趋势强")
    if (item["return5d"] or 0) >= 8:
        reasons.append("5日强势")
    if (item["mainNetRatio"] or 0) >= 3:
        reasons.append("主力流入")
    if (item["upRatio"] or 0) >= 70:
        reasons.append("上涨家数占优")
    if (item["volumeRatio"] or 0) >= 1.3:
        reasons.append("成交放量")
    item["hotReasons"] = reasons
    if (item["return5d"] or 0) >= 10 or (
        short_score >= 0.88
        and (
            (item["return5d"] or 0) >= 5
            or (item["changePct"] or 0) >= 3
        )
    ):
        item["hotStage"] = "短线爆发"
    elif short_score >= 0.70:
        item["hotStage"] = "短线活跃"
    elif (item["return60d"] or 0) >= 10 and item["heatScore"] >= 70:
        item["hotStage"] = "趋势延续"
    elif (item["mainNetRatio"] or 0) >= 3:
        item["hotStage"] = "资金驱动"
    else:
        item["hotStage"] = "热度观察"

concepts.sort(key=lambda item: item["heatScore"], reverse=True)
latest_timestamp = max(quote_timestamps) if quote_timestamps else 0
quote_time = datetime.fromtimestamp(
    latest_timestamp,
    timezone(timedelta(hours=8)),
)
now = datetime.now(timezone(timedelta(hours=8)))
print(
    json.dumps(
        {
            "source": "东方财富概念板块实时快照",
            "sourceDate": quote_time.strftime("%Y-%m-%d"),
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "scannedCount": len(rows),
            "conceptCount": len(concepts),
            "concepts": concepts,
            "method": (
                "综合热度按5日涨幅20%、60日趋势15%、当日涨幅15%、"
                "主力净流入占比20%、上涨家数占比15%、量比10%、成交额5%计算；"
                "短线热度按5日涨幅40%、当日涨幅20%、主力占比15%、"
                "上涨广度10%、量比10%、成交额5%单独计算。"
            ),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    try:
        result = run_script(REMOTE_SCRIPT, (), timeout=150)
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Concept heat fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output = root / "concept_heat_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('conceptCount')} concepts "
        f"at {payload.get('quoteTime')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
