#!/usr/bin/env python3
"""Fetch near-real-time capital flow and volume ratio for level-1 industries."""

from __future__ import annotations

import json
import base64
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import json
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

industry_names = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
cached_volume = {}
if len(sys.argv) > 2 and sys.argv[2]:
    cached_volume = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
china_tz = timezone(timedelta(hours=8))
session = requests.Session()
session.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
        )
    }
)

endpoint = "https://push2.eastmoney.com/api/qt/clist/get"
fields = (
    "f5,f6,f8,f10,f12,f14,f2,f3,f62,f184,"
    "f66,f69,f72,f75,f78,f81,f84,f87,f124"
)
rows = []
total = None
for page in range(1, 8):
    response = session.get(
        endpoint,
        params={
            "pn": page,
            "pz": 100,
            "po": 1,
            "np": 1,
            "fltt": 2,
            "invt": 2,
            "fid": "f62",
            "fs": "m:90+t:2+f:!50",
            "fields": fields,
        },
        timeout=35,
        verify=False,
    )
    response.raise_for_status()
    data = response.json().get("data") or {}
    total = data.get("total")
    batch = data.get("diff") or []
    rows.extend(batch)
    if not batch or (total is not None and len(rows) >= total):
        break

rows_by_name = {}
for row in rows:
    rows_by_name.setdefault(row.get("f14"), row)

def number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None

industries = []
quote_timestamps = []
for order, name in enumerate(industry_names, start=1):
    row = rows_by_name.get(name)
    if not row:
        continue
    quote_timestamp = int(row.get("f124") or 0)
    if quote_timestamp:
        quote_timestamps.append(quote_timestamp)
    industries.append(
        {
            "order": order,
            "name": name,
            "boardCode": row.get("f12"),
            "price": number(row.get("f2")),
            "changePct": number(row.get("f3")),
            "volume": number(row.get("f5")),
            "amount": number(row.get("f6")),
            "turnoverRate": number(row.get("f8")),
            "volumeRatio": number(row.get("f10")),
            "mainNetInflow": number(row.get("f62")),
            "mainNetRatio": number(row.get("f184")),
            "superLargeNetInflow": number(row.get("f66")),
            "superLargeNetRatio": number(row.get("f69")),
            "largeNetInflow": number(row.get("f72")),
            "largeNetRatio": number(row.get("f75")),
            "mediumNetInflow": number(row.get("f78")),
            "mediumNetRatio": number(row.get("f81")),
            "smallNetInflow": number(row.get("f84")),
            "smallNetRatio": number(row.get("f87")),
            "quoteTimestamp": quote_timestamp,
        }
    )

if len(industries) != len(industry_names):
    missing = sorted(set(industry_names) - {item["name"] for item in industries})
    raise SystemExit(
        f"Matched {len(industries)}/{len(industry_names)} industries; missing={missing}"
    )

latest_timestamp = max(quote_timestamps)
quote_time = datetime.fromtimestamp(latest_timestamp, china_tz)
quote_date = quote_time.date()
now = datetime.now(china_tz)

history_endpoint = "https://push2his.eastmoney.com/api/qt/stock/kline/get"


def fetch_json(url, params, timeout=45):
    last_error = None
    for attempt in range(4):
        try:
            response = session.get(
                url,
                params=params,
                timeout=timeout,
                verify=False,
            )
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                import time

                time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"History request failed: {last_error}")


def fetch_volume_profile(item):
    board_code = item["boardCode"]
    daily_payload = fetch_json(
        history_endpoint,
        {
            "secid": f"90.{board_code}",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
            "klt": 101,
            "fqt": 1,
            "beg": (quote_date - timedelta(days=120)).strftime("%Y%m%d"),
            "end": "20500101",
        },
    )
    daily_amounts = {}
    for row in (daily_payload.get("data") or {}).get("klines") or []:
        fields = row.split(",")
        if len(fields) >= 7:
            try:
                daily_amounts[fields[0]] = float(fields[6])
            except ValueError:
                continue
    completed_dates = sorted(
        day
        for day, amount in daily_amounts.items()
        if day < quote_date.isoformat() and amount > 0
    )
    previous_date = completed_dates[-1] if completed_dates else None
    previous_amount = (
        daily_amounts[previous_date] if previous_date is not None else None
    )

    intraday_payload = fetch_json(
        history_endpoint,
        {
            "secid": f"90.{board_code}",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57",
            "klt": 5,
            "fqt": 1,
            "beg": (quote_date - timedelta(days=50)).strftime("%Y%m%d"),
            "end": "20500101",
            "lmt": 2000,
        },
    )
    rows_by_day = {}
    for row in (intraday_payload.get("data") or {}).get("klines") or []:
        fields = row.split(",")
        if len(fields) < 7:
            continue
        try:
            amount = float(fields[6])
        except ValueError:
            continue
        day_text, time_text = fields[0].split(" ", 1)
        rows_by_day.setdefault(day_text, []).append((time_text, amount))
    profile_days = sorted(
        day
        for day, rows in rows_by_day.items()
        if day < quote_date.isoformat() and rows
    )[-20:]
    total_by_day = {
        day: sum(amount for _, amount in rows_by_day[day])
        for day in profile_days
    }
    completion_times = []
    minute = 9 * 60 + 35
    while minute <= 11 * 60 + 30:
        completion_times.append(minute)
        minute += 5
    minute = 13 * 60 + 5
    while minute <= 15 * 60:
        completion_times.append(minute)
        minute += 5
    completions = {}
    ranges = {}
    for minute in completion_times:
        time_text = f"{minute // 60:02d}:{minute % 60:02d}"
        values = []
        for day in profile_days:
            cumulative = sum(
                amount
                for row_time, amount in rows_by_day[day]
                if row_time <= time_text
            )
            total = total_by_day[day]
            if cumulative > 0 and total > 0:
                values.append(min(1.0, cumulative / total))
        if values:
            ordered = sorted(values)
            lower = ordered[round((len(ordered) - 1) * 0.25)]
            upper = ordered[round((len(ordered) - 1) * 0.75)]
            completions[time_text] = round(statistics.median(values), 6)
            ranges[time_text] = [round(lower, 6), round(upper, 6)]
    return board_code, {
        "previousAmount": previous_amount,
        "previousDate": previous_date,
        "completions": completions,
        "ranges": ranges,
        "historicalDays": len(profile_days),
    }


cached_profiles = (
    cached_volume.get("profiles", {})
    if cached_volume.get("sourceDate") == quote_date.isoformat()
    else {}
)
board_codes = {item["boardCode"] for item in industries}
if not board_codes.issubset(cached_profiles):
    profile_results = {}
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [
            executor.submit(fetch_volume_profile, item)
            for item in industries
        ]
        for future in as_completed(futures):
            board_code, profile = future.result()
            profile_results[board_code] = profile
    cached_profiles = profile_results

quote_minutes = quote_time.hour * 60 + quote_time.minute
if quote_minutes >= 15 * 60:
    cutoff_minutes = 15 * 60
elif quote_minutes >= 13 * 60:
    cutoff_minutes = quote_minutes - (quote_minutes % 5)
elif quote_minutes >= 11 * 60 + 30:
    cutoff_minutes = 11 * 60 + 30
elif quote_minutes >= 9 * 60 + 35:
    cutoff_minutes = quote_minutes - (quote_minutes % 5)
else:
    cutoff_minutes = 9 * 60 + 35
cutoff_text = f"{cutoff_minutes // 60:02d}:{cutoff_minutes % 60:02d}"

for item in industries:
    profile = cached_profiles.get(item["boardCode"], {})
    previous_amount = profile.get("previousAmount")
    completion = (
        1.0
        if cutoff_minutes >= 15 * 60
        else profile.get("completions", {}).get(cutoff_text)
    )
    low_completion, high_completion = profile.get("ranges", {}).get(
        cutoff_text,
        [None, None],
    )
    predicted_amount = item.get("amount")
    predicted_low = item.get("amount")
    predicted_high = item.get("amount")
    if (
        cutoff_minutes < 15 * 60
        and predicted_amount
        and completion
        and completion >= 0.01
    ):
        predicted_amount = predicted_amount / completion
        if high_completion and high_completion > 0:
            predicted_low = item["amount"] / high_completion
        if low_completion and low_completion > 0:
            predicted_high = item["amount"] / low_completion
    item["previousAmount"] = previous_amount
    item["previousDate"] = profile.get("previousDate")
    item["predictedAmount"] = predicted_amount
    item["predictedLow"] = predicted_low
    item["predictedHigh"] = predicted_high
    item["historicalCompletion"] = completion
    item["volumeForecastDays"] = profile.get("historicalDays")
    item["volumeForecastFinal"] = cutoff_minutes >= 15 * 60
    item["volumeChangeAmount"] = (
        predicted_amount - previous_amount
        if predicted_amount is not None and previous_amount is not None
        else None
    )
    item["volumeChangePct"] = (
        predicted_amount / previous_amount - 1
        if predicted_amount is not None and previous_amount not in (None, 0)
        else None
    )

print(
    json.dumps(
        {
            "source": "东方财富行业资金流",
            "sourceDate": quote_time.strftime("%Y-%m-%d"),
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "delaySeconds": max(0, int(now.timestamp() - latest_timestamp)),
            "boardsScanned": len(rows),
            "matchedCount": len(industries),
            "volumeProfileDate": quote_date.isoformat(),
            "volumeProfiles": cached_profiles,
            "industries": industries,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    output = root / "industry_flow_cache.json"
    cached_volume = {}
    try:
        cached_payload = json.loads(output.read_text(encoding="utf-8"))
        cached_volume = {
            "sourceDate": cached_payload.get("volumeProfileDate"),
            "profiles": cached_payload.get("volumeProfiles") or {},
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    try:
        data = json.loads((root / "data.json").read_text(encoding="utf-8"))
        names = [item["name"] for item in data["industries"]]
        code_by_name = {
            item["name"]: item["code"] for item in data["industries"]
        }
        result = run_script(
            REMOTE_SCRIPT,
            (
                base64.b64encode(
                    json.dumps(names, ensure_ascii=False).encode("utf-8")
                ).decode("ascii"),
                base64.b64encode(
                    json.dumps(cached_volume, ensure_ascii=False).encode("utf-8")
                ).decode("ascii"),
            ),
            timeout=240,
        )
        payload = json.loads(result.stdout)
        for item in payload.get("industries", []):
            item["swCode"] = code_by_name.get(item["name"])
    except (
        OSError,
        KeyError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Industry flow fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('matchedCount')} industries "
        f"at {payload.get('quoteTime')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
