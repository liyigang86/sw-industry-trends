#!/usr/bin/env python3
"""Build a 12-week and 20-day rotation heatmap for active concept boards."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

LIST_ENDPOINT = "https://push2.eastmoney.com/api/qt/clist/get"
HISTORY_ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
FLOW_ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
HEADERS = {
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


def history(code):
    response = requests.get(
        HISTORY_ENDPOINT,
        params={
            "secid": f"90.{code}",
            "klt": 101,
            "fqt": 1,
            "lmt": 70,
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8",
            "fields2": "f51,f53,f56,f57,f61",
        },
        timeout=30,
        verify=False,
        headers=HEADERS,
    )
    response.raise_for_status()
    rows = (response.json().get("data") or {}).get("klines") or []
    bars = []
    for item in rows:
        values = str(item).split(",")
        if len(values) < 2:
            continue
        close = number(values[1])
        if close is not None:
            bars.append(
                {
                    "date": values[0],
                    "close": close,
                    "volume": number(values[2]) if len(values) > 2 else None,
                    "amount": number(values[3]) if len(values) > 3 else None,
                    "turnover": number(values[4]) if len(values) > 4 else None,
                }
            )
    return bars


def flow_history(code):
    response = requests.get(
        FLOW_ENDPOINT,
        params={
            "lmt": 20,
            "klt": 101,
            "secid": f"90.{code}",
            "fields1": "f1,f2,f3,f7",
            "fields2": (
                "f51,f52,f53,f54,f55,f56,f57,"
                "f58,f59,f60,f61,f62,f63,f64,f65"
            ),
        },
        timeout=30,
        verify=False,
        headers=HEADERS,
    )
    response.raise_for_status()
    rows = (response.json().get("data") or {}).get("klines") or []
    flows = []
    for item in rows:
        values = str(item).split(",")
        if len(values) < 7:
            continue
        flows.append(
            {
                "date": values[0],
                "mainNetInflow": number(values[1]),
                "mainNetRatio": number(values[6]),
            }
        )
    return flows


def average(values):
    valid = [float(value) for value in values if value is not None]
    return sum(valid) / len(valid) if valid else 0.0


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def persistence_score(item, bars, flows):
    closes = [bar["close"] for bar in bars if bar.get("close") is not None]
    volumes = [bar.get("volume") or 0 for bar in bars]
    if len(closes) < 22:
        return None
    close = closes[-1]
    ma5 = average(closes[-5:])
    ma10 = average(closes[-10:])
    ma20 = average(closes[-20:])
    ma5_prior = average(closes[-10:-5])
    alignment = sum([close >= ma5, ma5 >= ma10, ma10 >= ma20]) / 3
    ma20_distance = close / ma20 - 1 if ma20 else 0
    ma5_slope = ma5 / ma5_prior - 1 if ma5_prior else 0
    trend_score = clamp(
        alignment * 0.55
        + clamp((ma20_distance + 0.01) / 0.05) * 0.25
        + clamp((ma5_slope + 0.005) / 0.03) * 0.20
    )

    recent_flows = flows[-5:]
    flow_values = [
        row["mainNetInflow"]
        for row in recent_flows
        if row.get("mainNetInflow") is not None
    ]
    positive_days = sum(1 for value in flow_values if value > 0)
    positive_rate = positive_days / len(flow_values) if flow_values else 0.0
    flow_sum3 = sum(flow_values[-3:])
    flow_sum5 = sum(flow_values)
    current_flow_positive = (item.get("mainNetRatio") or 0) > 0
    flow_score = clamp(
        positive_rate * 0.40
        + (1 if flow_sum3 > 0 else 0) * 0.25
        + (1 if flow_sum5 > 0 else 0) * 0.20
        + (1 if current_flow_positive else 0) * 0.15
    )

    breadth_score = clamp((item.get("upRatio") or 0) / 100)
    return5 = close / closes[-6] - 1 if len(closes) >= 6 else 0
    return20 = close / closes[-21] - 1 if len(closes) >= 21 else 0
    momentum_score = clamp(
        clamp((return5 + 0.03) / 0.12) * 0.55
        + clamp((return20 + 0.05) / 0.18) * 0.45
    )
    volume_trend = (
        average(volumes[-5:]) / average(volumes[-25:-5])
        if len(volumes) >= 25
        else 1
    )
    volume_score = clamp(
        clamp(((item.get("volumeRatio") or 0) - 0.75) / 0.9) * 0.45
        + clamp((volume_trend - 0.65) / 0.9) * 0.55
    )
    overheat = clamp(
        clamp((ma20_distance - 0.08) / 0.12) * 0.55
        + clamp((return5 - 0.08) / 0.12) * 0.45
    )
    stability_score = 1 - overheat * 0.65
    score = round(
        (
            trend_score * 28
            + flow_score * 30
            + breadth_score * 17
            + momentum_score * 13
            + volume_score * 7
            + stability_score * 5
        ),
        1,
    )

    if score >= 72 and flow_score >= 0.55 and (item.get("upRatio") or 0) >= 50:
        label = "强持续"
    elif score >= 60:
        label = "偏持续"
    elif (item.get("changePct") or 0) >= 2 and (item.get("upRatio") or 0) < 40:
        label = "一日脉冲"
    elif score < 38:
        label = "退潮"
    else:
        label = "观察"

    reasons = []
    if alignment >= 0.99:
        reasons.append("均线多头")
    if positive_days >= 4:
        reasons.append("资金连续流入")
    if (item.get("upRatio") or 0) >= 60:
        reasons.append("上涨广度强")
    if return5 >= 0.03:
        reasons.append("5日动量强")
    if volume_score >= 0.55:
        reasons.append("量能配合")
    if (item.get("changePct") or 0) >= 2 and (item.get("upRatio") or 0) < 40:
        reasons.append("少数龙头拉升")
    if ma20_distance >= 0.08:
        reasons.append("短期偏热")
    if score < 38:
        reasons.append("趋势与资金偏弱")

    return {
        "score": score,
        "label": label,
        "trendScore": round(trend_score * 100, 1),
        "flowScore": round(flow_score * 100, 1),
        "breadthScore": round(breadth_score * 100, 1),
        "momentumScore": round(momentum_score * 100, 1),
        "volumeScore": round(volume_score * 100, 1),
        "stabilityScore": round(stability_score * 100, 1),
        "reasons": reasons,
        "metrics": {
            "ma5": round(ma5, 2),
            "ma10": round(ma10, 2),
            "ma20": round(ma20, 2),
            "ma20Distance": round(ma20_distance * 100, 2),
            "return5": round(return5 * 100, 2),
            "return20": round(return20 * 100, 2),
            "flowPositiveDays5": positive_days,
            "flowSum3": round(flow_sum3, 2),
            "flowSum5": round(flow_sum5, 2),
            "volumeTrend": round(volume_trend, 2),
        },
    }


rows = []
for page in range(1, 8):
    response = requests.get(
        LIST_ENDPOINT,
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
                "f3,f6,f10,f12,f14,f24,f25,f62,f104,f105,f106,f109,f124,f184"
            ),
        },
        timeout=35,
        verify=False,
        headers=HEADERS,
    )
    response.raise_for_status()
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
    "证券",
    "指数",
    "成份",
    "样本",
    "权重",
    "成长",
    "市值",
    "热股",
    "题材股",
    "近期新高",
    "历史新高",
    "最近",
    "涨停",
    "跌停",
    "打板",
    "次新股",
    "新股",
    "低价股",
    "高价股",
    "增发",
    "配股",
    "解禁",
    "分红",
    "送转",
    "摘帽",
    "破发",
    "重仓",
    "机构",
    "证金持股",
    "汇金持股",
    "基金重仓",
    "保险重仓",
    "QFII",
    "社保重仓",
    "预盈预增",
    "预亏预减",
    "股权转让",
    "并购重组",
    "壳资源",
    "举牌",
    "长期破净",
    "IPO受益",
    "标准普尔",
    "HS300",
    "沪股通",
    "深股通",
    "小盘股",
    "中盘股",
    "小盘",
    "中盘",
    "大盘",
    "风格",
    "龙头",
    "深成500",
    "中报预增",
    "年报预增",
    "预增",
    "预减",
    "中证",
    "国证",
    "百元股",
    "茅指数",
    "价值股",
    "红利股",
    "中特估",
    "GDR",
    "上证",
    "深证",
    "创业板",
    "科创板",
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
    if member_count < 5:
        continue
    quote_timestamp = int(row.get("f124") or 0)
    if quote_timestamp:
        quote_timestamps.append(quote_timestamp)
    concepts.append(
        {
            "code": row.get("f12"),
            "name": name,
            "changePct": number(row.get("f3")),
            "return5d": number(row.get("f109")),
            "return60d": number(row.get("f24")),
            "returnYtd": number(row.get("f25")),
            "amount": number(row.get("f6")),
            "volumeRatio": number(row.get("f10")),
            "mainNetInflow": number(row.get("f62")),
            "mainNetRatio": number(row.get("f184")),
            "upRatio": round(up_count / member_count * 100, 4),
            "memberCount": member_count,
        }
    )

change_values = [item["changePct"] for item in concepts if item["changePct"] is not None]
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
flow_values = [item["mainNetRatio"] for item in concepts if item["mainNetRatio"] is not None]
breadth_values = [item["upRatio"] for item in concepts if item["upRatio"] is not None]
volume_values = [item["volumeRatio"] for item in concepts if item["volumeRatio"] is not None]
amount_values = [item["amount"] for item in concepts if item["amount"] is not None]
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
    item["shortTermScore"] = round(
        (
            return5_rank * 0.40
            + change_rank * 0.20
            + flow_rank * 0.15
            + breadth_rank * 0.10
            + volume_rank * 0.10
            + amount_rank * 0.05
        )
        * 100,
        2,
    )
    item["heatScore"] = round(
        (
            return5_rank * 0.20
            + return60_rank * 0.15
            + change_rank * 0.15
            + flow_rank * 0.20
            + breadth_rank * 0.15
            + volume_rank * 0.10
            + amount_rank * 0.05
        )
        * 100,
        2,
    )

hot_ranked = sorted(concepts, key=lambda item: item["heatScore"], reverse=True)
amount_ranked = sorted(
    concepts,
    key=lambda item: item["amount"] or 0,
    reverse=True,
)
return60_ranked = sorted(
    concepts,
    key=lambda item: item["return60d"] or -1e30,
    reverse=True,
)
short_term_ranked = sorted(
    concepts,
    key=lambda item: item["shortTermScore"] or -1e30,
    reverse=True,
)
selected = {}
for source in (
    hot_ranked[:12],
    amount_ranked[:10],
    return60_ranked[:12],
    short_term_ranked[:12],
):
    for item in source:
        selected[item["code"]] = item
selected_concepts = list(selected.values())

data_by_code = {}
with ThreadPoolExecutor(max_workers=6) as executor:
    futures = {
        executor.submit(
            lambda code: (history(code), flow_history(code)),
            item["code"],
        ): item["code"]
        for item in selected_concepts
    }
    for future in as_completed(futures):
        code = futures[future]
        try:
            data_by_code[code] = future.result()
        except Exception:
            data_by_code[code] = ([], [])

def weekly_bars(bars):
    weeks = {}
    for bar in bars:
        date = datetime.strptime(bar["date"], "%Y-%m-%d").date()
        monday = date - timedelta(days=date.weekday())
        weeks[monday.isoformat()] = bar
    return list(weeks.values())

output = []
for item in selected_concepts:
    bars, flows = data_by_code.get(item["code"]) or ([], [])
    if len(bars) < 22:
        continue
    item["daily"] = bars[-21:]
    item["weekly"] = weekly_bars(bars)[-13:]
    if len(item["weekly"]) < 3:
        continue
    item["flows"] = flows[-10:]
    item["persistence"] = persistence_score(item, bars, flows)
    output.append(item)

latest_timestamp = max(quote_timestamps) if quote_timestamps else 0
quote_time = datetime.fromtimestamp(
    latest_timestamp,
    timezone(timedelta(hours=8)),
)
now = datetime.now(timezone(timedelta(hours=8)))
print(
    json.dumps(
        {
            "source": "东方财富概念板块日线与当前热度",
            "sourceDate": quote_time.strftime("%Y-%m-%d"),
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "selectionRule": (
                "从题材概念中选取近期综合热度前12名、成交额前10名、"
                "60日趋势前12名和短线热度前12名，合并去重后展示"
                "近12周与近20日轮动。"
            ),
            "selectedCount": len(output),
            "concepts": output,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    try:
        result = run_script(REMOTE_SCRIPT, (), timeout=240)
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Concept rotation fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output = root / "concept_rotation_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('selectedCount')} concepts "
        f"at {payload.get('quoteTime')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
