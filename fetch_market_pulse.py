#!/usr/bin/env python3
"""Fetch whole-market breadth and project the current session's turnover."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import json
import math
import statistics
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CHINA_TZ = timezone(timedelta(hours=8))
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}
INDEXES = [
    {"name": "上证", "code": "000001", "secid": "1.000001"},
    {"name": "深证", "code": "399001", "secid": "0.399001"},
    {"name": "北证", "code": "899050", "secid": "0.899050"},
]
STOCK_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"


def request_json(url, params, timeout=40, attempts=4):
    last_error = None
    for attempt in range(attempts):
        try:
            response = requests.get(
                url,
                params=params,
                headers=HEADERS,
                timeout=timeout,
                verify=False,
            )
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                import time

                time.sleep(0.7 * (attempt + 1))
    raise RuntimeError(f"Request failed: {last_error}")


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def nearest_percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    index = round((len(ordered) - 1) * fraction)
    return ordered[max(0, min(len(ordered) - 1, index))]


index_quote_payload = request_json(
    "https://push2.eastmoney.com/api/qt/ulist.np/get",
    {
        "fltt": 2,
        "invt": 2,
        "fields": "f2,f3,f6,f12,f14,f124",
        "secids": ",".join(item["secid"] for item in INDEXES),
    },
)
index_rows = (index_quote_payload.get("data") or {}).get("diff") or []
index_by_code = {
    str(row.get("f12") or ""): row
    for row in index_rows
    if row.get("f12")
}
quote_timestamps = [
    int(row.get("f124") or 0)
    for row in index_rows
    if int(row.get("f124") or 0) > 0
]
if not quote_timestamps:
    raise RuntimeError("No whole-market quote timestamp returned")
quote_dt = datetime.fromtimestamp(max(quote_timestamps), CHINA_TZ)
quote_date = quote_dt.date()
current_amount = sum(
    number(index_by_code.get(item["code"], {}).get("f6")) or 0
    for item in INDEXES
)

daily_amount_by_date = defaultdict(float)
for item in INDEXES:
    payload = request_json(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        {
            "secid": item["secid"],
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
            "klt": 101,
            "fqt": 1,
            "beg": (quote_date - timedelta(days=120)).strftime("%Y%m%d"),
            "end": "20500101",
        },
    )
    klines = (payload.get("data") or {}).get("klines") or []
    for row in klines:
        fields = row.split(",")
        if len(fields) >= 7:
            amount = number(fields[6])
            if amount is not None:
                daily_amount_by_date[fields[0]] += amount

completed_daily_dates = sorted(
    date_text
    for date_text in daily_amount_by_date
    if date_text < quote_date.isoformat()
    and daily_amount_by_date[date_text] > 0
)
previous_date = completed_daily_dates[-1] if completed_daily_dates else None
previous_amount = (
    daily_amount_by_date[previous_date] if previous_date is not None else None
)

intraday_amount_by_timestamp = defaultdict(float)
five_minute_beg = (quote_date - timedelta(days=50)).strftime("%Y%m%d")
for item in INDEXES:
    payload = request_json(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        {
            "secid": item["secid"],
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
            "klt": 5,
            "fqt": 1,
            "beg": five_minute_beg,
            "end": "20500101",
            "lmt": 2000,
        },
    )
    klines = (payload.get("data") or {}).get("klines") or []
    for row in klines:
        fields = row.split(",")
        if len(fields) >= 7:
            amount = number(fields[6])
            if amount is not None:
                intraday_amount_by_timestamp[fields[0]] += amount

day_intraday_amounts = defaultdict(list)
day_total_amounts = defaultdict(float)
for timestamp, amount in intraday_amount_by_timestamp.items():
    day_text, time_text = timestamp.split(" ", 1)
    day_intraday_amounts[day_text].append((time_text, amount))
    day_total_amounts[day_text] += amount

completed_intraday_dates = sorted(
    day_text
    for day_text in day_intraday_amounts
    if day_text < quote_date.isoformat() and day_total_amounts[day_text] > 0
)[-20:]

quote_minutes = quote_dt.hour * 60 + quote_dt.minute
if quote_minutes >= 15 * 60:
    cutoff_minutes = 15 * 60
elif quote_minutes >= 13 * 60:
    cutoff_minutes = quote_minutes
elif quote_minutes >= 11 * 60 + 30:
    cutoff_minutes = 11 * 60 + 30
elif quote_minutes >= 9 * 60 + 35:
    cutoff_minutes = quote_minutes - (quote_minutes % 5)
else:
    cutoff_minutes = 9 * 60 + 35
cutoff_text = f"{cutoff_minutes // 60:02d}:{cutoff_minutes % 60:02d}"

progress_values = []
for day_text in completed_intraday_dates:
    cumulative = sum(
        amount
        for time_text, amount in day_intraday_amounts[day_text]
        if time_text <= cutoff_text
    )
    total = day_total_amounts[day_text]
    if cumulative > 0 and total > 0:
        progress_values.append(min(1.0, cumulative / total))

historical_completion = (
    statistics.median(progress_values) if progress_values else None
)
is_final = cutoff_minutes >= 15 * 60
predicted_amount = current_amount
predicted_low = current_amount
predicted_high = current_amount
if (
    not is_final
    and current_amount > 0
    and historical_completion is not None
    and historical_completion >= 0.01
):
    predicted_amount = current_amount / historical_completion
    high_completion = nearest_percentile(progress_values, 0.75)
    low_completion = nearest_percentile(progress_values, 0.25)
    if high_completion and high_completion > 0:
        predicted_low = current_amount / high_completion
    if low_completion and low_completion > 0:
        predicted_high = current_amount / low_completion

elapsed_minutes = max(
    0,
    min(
        240,
        (
            quote_minutes - (9 * 60 + 30)
            if quote_minutes <= 11 * 60 + 30
            else 120
            if quote_minutes < 13 * 60
            else 120 + quote_minutes - 13 * 60
        ),
    ),
)

stock_endpoint = "https://push2.eastmoney.com/api/qt/clist/get"
stock_params = {
    "pz": 100,
    "po": 1,
    "np": 1,
    "fltt": 2,
    "invt": 2,
    "fid": "f3",
    "fs": STOCK_FS,
    "fields": "f2,f3,f12,f14,f18,f124",
}


def fetch_stock_page(page):
    return request_json(stock_endpoint, {**stock_params, "pn": page})


first_page = fetch_stock_page(1)
first_data = first_page.get("data") or {}
stock_total = int(first_data.get("total") or 0)
page_count = max(1, math.ceil(stock_total / 100))
stock_rows = list(first_data.get("diff") or [])
with ThreadPoolExecutor(max_workers=8) as executor:
    futures = [executor.submit(fetch_stock_page, page) for page in range(2, page_count + 1)]
    for future in as_completed(futures):
        payload = future.result()
        stock_rows.extend((payload.get("data") or {}).get("diff") or [])

unique_stocks = {}
for row in stock_rows:
    code = str(row.get("f12") or "")
    if code:
        unique_stocks.setdefault(code, row)


def limit_ratio(code):
    if code.startswith(("4", "8", "92")):
        return 0.30
    if code.startswith(("300", "301", "688", "689")):
        return 0.20
    return 0.10


def rounded_price(value):
    return math.floor(value * 100 + 0.5) / 100


bucket_keys = [
    "limitUp",
    "gt10",
    "7to10",
    "3to7",
    "0to3",
    "flat",
    "minus0to3",
    "minus3to7",
    "minus7to10",
    "ltMinus10",
    "limitDown",
]
bucket_counts = {key: 0 for key in bucket_keys}
valid_count = 0
st_excluded = 0
for row in unique_stocks.values():
    name = str(row.get("f14") or "")
    if "ST" in name.upper():
        st_excluded += 1
        continue
    price = number(row.get("f2"))
    previous_close = number(row.get("f18"))
    change_pct = number(row.get("f3"))
    if (
        price is None
        or price <= 0
        or previous_close is None
        or previous_close <= 0
        or change_pct is None
    ):
        continue
    code = str(row.get("f12") or "")
    limit = limit_ratio(code)
    up_limit_price = rounded_price(previous_close * (1 + limit))
    down_limit_price = rounded_price(previous_close * (1 - limit))
    is_limit_up = price >= up_limit_price - 0.011
    is_limit_down = price <= down_limit_price + 0.011
    valid_count += 1
    if is_limit_up:
        bucket_counts["limitUp"] += 1
    elif is_limit_down:
        bucket_counts["limitDown"] += 1
    elif change_pct > 10:
        bucket_counts["gt10"] += 1
    elif change_pct > 7:
        bucket_counts["7to10"] += 1
    elif change_pct > 3:
        bucket_counts["3to7"] += 1
    elif change_pct > 0.005:
        bucket_counts["0to3"] += 1
    elif change_pct >= -0.005:
        bucket_counts["flat"] += 1
    elif change_pct >= -3:
        bucket_counts["minus0to3"] += 1
    elif change_pct >= -7:
        bucket_counts["minus3to7"] += 1
    elif change_pct >= -10:
        bucket_counts["minus7to10"] += 1
    else:
        bucket_counts["ltMinus10"] += 1

bucket_labels = {
    "limitUp": "涨停",
    "gt10": ">10%",
    "7to10": "10~7%",
    "3to7": "7~3%",
    "0to3": "3~0%",
    "flat": "平",
    "minus0to3": "0~3%",
    "minus3to7": "3~7%",
    "minus7to10": "7~10%",
    "ltMinus10": "10%<",
    "limitDown": "跌停",
}
bucket_tones = {
    "limitUp": "up-strong",
    "gt10": "up",
    "7to10": "up",
    "3to7": "up",
    "0to3": "up-soft",
    "flat": "flat",
    "minus0to3": "down-soft",
    "minus3to7": "down",
    "minus7to10": "down",
    "ltMinus10": "down",
    "limitDown": "down-strong",
}
buckets = [
    {
        "key": key,
        "label": bucket_labels[key],
        "tone": bucket_tones[key],
        "count": bucket_counts[key],
    }
    for key in bucket_keys
]
up_count = bucket_counts["limitUp"] + sum(
    bucket_counts[key] for key in ["gt10", "7to10", "3to7", "0to3"]
)
flat_count = bucket_counts["flat"]
down_count = bucket_counts["limitDown"] + sum(
    bucket_counts[key]
    for key in ["ltMinus10", "minus7to10", "minus3to7", "minus0to3"]
)

change_amount = (
    predicted_amount - previous_amount
    if predicted_amount is not None and previous_amount is not None
    else None
)
change_pct = (
    predicted_amount / previous_amount - 1
    if predicted_amount is not None and previous_amount not in (None, 0)
    else None
)
now = datetime.now(CHINA_TZ)
print(
    json.dumps(
        {
            "source": "东方财富沪深京A股实时快照与指数分钟线",
            "sourceDate": quote_date.isoformat(),
            "quoteTime": quote_dt.isoformat(),
            "fetchedAt": now.isoformat(),
            "market": {
                "amount": current_amount,
                "previousAmount": previous_amount,
                "previousDate": previous_date,
                "predictedAmount": predicted_amount,
                "predictedLow": predicted_low,
                "predictedHigh": predicted_high,
                "changeAmount": change_amount,
                "changePct": change_pct,
                "historicalCompletion": historical_completion,
                "timeProgress": elapsed_minutes / 240,
                "historicalDays": len(progress_values),
                "isFinal": is_final,
            },
            "breadth": {
                "validCount": valid_count,
                "stExcluded": st_excluded,
                "upCount": up_count,
                "flatCount": flat_count,
                "downCount": down_count,
                "limitUpCount": bucket_counts["limitUp"],
                "limitDownCount": bucket_counts["limitDown"],
                "buckets": buckets,
            },
            "method": (
                "沪深京量能为上证指数、深证成指、北证50成交额合计；"
                "涨跌分布覆盖沪深京A股并剔除ST。"
            ),
            "forecastMethod": (
                "预测量能=当前成交额÷最近20个交易日同一时刻的历史累计成交完成度中位数；"
                "区间使用历史完成度的25%和75%分位。"
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
        result = run_script(REMOTE_SCRIPT, timeout=180)
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
        RuntimeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Market pulse fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output = root / "market_pulse_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        "Market pulse: "
        f"{payload['market']['amount'] / 100_000_000:.0f}亿元 actual, "
        f"{payload['market']['predictedAmount'] / 100_000_000:.0f}亿元 projected"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
