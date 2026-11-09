#!/usr/bin/env python3
"""Cluster recent limit-up reasons into a dynamic event-theme layer."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import html as html_lib
import json
import math
import re
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ENDPOINT = "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
    ),
    "Referer": "https://data.10jqka.com.cn/rank/ztpool/",
}
FIELDS = (
    "199112,10,9001,330323,330324,330325,9002,330329,"
    "133971,133970,1968584,3475914,9004"
)


def number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def clean(value):
    if value is None:
        return None
    return re.sub(r"\s+", " ", html_lib.unescape(str(value))).strip()


def theme_display_name(value):
    text = clean(value) or ""
    text = re.sub(r"[\"'“”‘’]", "", text)
    return text.strip()


def theme_key(value):
    text = theme_display_name(value).lower()
    text = re.sub(r"(?:概念|板块|题材)$", "", text).strip()
    return text


def board_counts(label):
    text = clean(label) or ""
    if "首板" in text:
        return 1, 1
    match = re.search(r"(\d+)天(\d+)板", text)
    if match:
        return int(match.group(1)), int(match.group(2))
    match = re.search(r"(\d+)板", text)
    if match:
        return int(match.group(1)), int(match.group(1))
    return 1, 1


def market_suffix(stock_code, market_id):
    if str(market_id) == "17" or str(stock_code).startswith(("6", "5")):
        return "SH"
    if str(stock_code).startswith(("4", "8", "92")):
        return "BJ"
    return "SZ"


def split_reasons(value):
    text = clean(value) or ""
    parts = re.split(r"[+＋、；;|]", text)
    output = []
    seen = set()
    for part in parts:
        name = theme_display_name(part)
        key = theme_key(name)
        if not key or len(key) > 30 or key in seen:
            continue
        seen.add(key)
        output.append(name)
    return output


def candidate_dates(now):
    current = now.date()
    if current.weekday() >= 5:
        current -= timedelta(days=1)
    while current.weekday() >= 5:
        current -= timedelta(days=1)
    return current


session = requests.Session()
session.headers.update(HEADERS)
china_tz = timezone(timedelta(hours=8))
now = datetime.now(china_tz)
candidate = candidate_dates(now)
daily_rows = []
last_payload_summary = "no response"

for offset in range(0, 16):
    day = candidate - timedelta(days=offset)
    if day.weekday() >= 5:
        continue
    response = session.get(
        ENDPOINT,
        params={
            "page": 1,
            "limit": 200,
            "field": FIELDS,
            "filter": "HS,GEM2STAR",
            "order_field": "330324",
            "order_type": 0,
            "date": day.strftime("%Y%m%d"),
        },
        timeout=35,
        verify=False,
    )
    response.raise_for_status()
    payload = response.json()
    rows = ((payload.get("data") or {}).get("info") or [])
    last_payload_summary = {
        "date": day.isoformat(),
        "statusCode": payload.get("status_code"),
        "message": payload.get("status_msg") or payload.get("message"),
        "rowCount": len(rows),
    }
    if rows:
        daily_rows.append((day.isoformat(), rows))
    if len(daily_rows) >= 5:
        break

if not daily_rows:
    raise RuntimeError(
        f"No limit-up reason rows returned: {last_payload_summary}"
    )

daily_rows.reverse()
session_dates = [item[0] for item in daily_rows]
latest_date, latest_rows = daily_rows[-1]
theme_by_day = {}
stock_records_by_day = {}
quote_timestamps = []

for trade_date, rows in daily_rows:
    themes = {}
    stock_records = []
    for row in rows:
        reasons = split_reasons(row.get("reason_type"))
        if not reasons:
            continue
        stock_code = str(row.get("code") or "").strip()
        stock_name = clean(row.get("name")) or stock_code
        if not stock_code or not stock_name:
            continue
        market = market_suffix(stock_code, row.get("market_id"))
        days_count, board_count = board_counts(row.get("high_days"))
        last_limit_time = number(row.get("last_limit_up_time"))
        first_limit_time = number(row.get("first_limit_up_time"))
        if last_limit_time:
            quote_timestamps.append(int(last_limit_time))
        stock = {
            "code": f"{stock_code}.{market}",
            "name": stock_name,
            "boardLabel": clean(row.get("high_days")) or "首板",
            "boardCount": board_count,
            "daysCount": days_count,
            "changePct": number(row.get("change_rate")),
            "turnoverRate": number(row.get("turnover_rate")),
            "orderAmount": number(row.get("order_amount")),
            "openCount": number(row.get("open_num")),
            "limitUpType": clean(row.get("limit_up_type")),
            "firstLimitTime": int(first_limit_time) if first_limit_time else 0,
            "lastLimitTime": int(last_limit_time) if last_limit_time else 0,
            "reasonText": clean(row.get("reason_type")),
        }
        stock_records.append(stock)
        for reason in reasons:
            key = theme_key(reason)
            item = themes.setdefault(
                key,
                {
                    "key": key,
                    "name": reason,
                    "stocks": {},
                },
            )
            item["stocks"][stock_code] = stock

    normalized = {}
    for key, item in themes.items():
        stocks = sorted(
            item["stocks"].values(),
            key=lambda stock: (
                stock["boardCount"],
                stock["orderAmount"] or 0,
                -stock["turnoverRate"]
                if stock["turnoverRate"] is not None
                else 0,
            ),
            reverse=True,
        )
        normalized[key] = {
            "name": item["name"],
            "count": len(stocks),
            "stocks": stocks,
        }
    theme_by_day[trade_date] = normalized
    stock_records_by_day[trade_date] = stock_records

latest_themes = theme_by_day[latest_date]
themes = []
for key, item in latest_themes.items():
    history = []
    prior_counts = []
    for trade_date in session_dates:
        count = (theme_by_day.get(trade_date, {}).get(key) or {}).get("count", 0)
        history.append({"date": trade_date, "count": count})
        if trade_date != latest_date:
            prior_counts.append(count)

    appearances = sum(1 for point in history if point["count"] > 0)
    prior_count = history[-2]["count"] if len(history) >= 2 else 0
    max_board = max(stock["boardCount"] for stock in item["stocks"])
    avg_turnover = sum(
        stock["turnoverRate"] or 0 for stock in item["stocks"]
    ) / max(1, len(item["stocks"]))
    sum_order_amount = sum(
        stock["orderAmount"] or 0 for stock in item["stocks"]
    )
    themes.append(
        {
            "key": key,
            "name": item["name"],
            "count": item["count"],
            "maxBoard": max_board,
            "avgTurnover": round(avg_turnover, 2),
            "orderAmount": round(sum_order_amount, 2),
            "priorCount": prior_count,
            "appearances": appearances,
            "history": history,
            "stocks": item["stocks"],
        }
    )

max_count = max(theme["count"] for theme in themes) or 1
max_board = max(theme["maxBoard"] for theme in themes) or 1
max_seal = max(
    math.log1p(max(0, theme["orderAmount"])) for theme in themes
) or 1

for theme in themes:
    count_score = min(1.0, theme["count"] / max_count)
    recurrence_score = min(1.0, theme["appearances"] / max(1, len(session_dates)))
    board_score = min(1.0, (theme["maxBoard"] - 1) / max(1, max_board - 1))
    seal_score = min(
        1.0,
        math.log1p(max(0, theme["orderAmount"])) / max_seal,
    )
    turnover_score = min(1.0, theme["avgTurnover"] / 25)
    theme["score"] = round(
        (
            count_score * 35
            + recurrence_score * 25
            + board_score * 17
            + seal_score * 13
            + turnover_score * 10
        ),
        1,
    )
    if theme["appearances"] == 1 and theme["count"] > 1:
        theme["lifecycle"] = "新事件"
    elif theme["count"] > theme["priorCount"] and theme["appearances"] >= 2:
        theme["lifecycle"] = "扩散"
    elif theme["appearances"] >= 3 and theme["count"] >= max(1, theme["priorCount"]):
        theme["lifecycle"] = "延续"
    elif theme["count"] < theme["priorCount"]:
        theme["lifecycle"] = "降温"
    elif theme["count"] == 1 and theme["appearances"] == 1:
        theme["lifecycle"] = "个股事件"
    else:
        theme["lifecycle"] = "观察"

themes.sort(
    key=lambda theme: (
        theme["score"],
        theme["count"],
        theme["maxBoard"],
        theme["orderAmount"],
    ),
    reverse=True,
)

latest_timestamp = max(quote_timestamps) if quote_timestamps else 0
quote_time = (
    datetime.fromtimestamp(latest_timestamp, china_tz)
    if latest_timestamp
    else now
)
print(
    json.dumps(
        {
            "source": "同花顺涨停池及涨停原因",
            "sourceDate": latest_date,
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "sessionDates": session_dates,
            "scannedCount": len(latest_rows),
            "eventThemeCount": len(themes),
            "selectionRule": (
                "取最近5个有数据的交易日涨停池，将每只股票的涨停原因拆成"
                "动态标签，再按当日标签成分股数、连板高度、封单金额、"
                "换手率和近5日复现次数自动聚合成事件主题。"
            ),
            "themes": themes[:60],
            "limitUpStocks": stock_records_by_day.get(latest_date, []),
            "method": (
                "事件强度=涨停股覆盖35%+近5日复现25%+连板高度17%+"
                "封单金额13%+换手10%。涨停原因来自第三方行情数据，"
                "只用于识别当日事件驱动，不代表主题具有持续性。"
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
        result = run_script(REMOTE_SCRIPT, (), timeout=240)
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Event theme fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output = root / "event_theme_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('eventThemeCount')} event themes "
        f"for {payload.get('sourceDate')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
