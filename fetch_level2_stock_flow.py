#!/usr/bin/env python3
"""Fetch stock-level capital flow and aggregate it to one level-2 industry."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import json
import sys
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

stocks = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
china_tz = timezone(timedelta(hours=8))
session = requests.Session()
session.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
        ),
        "Referer": "https://quote.eastmoney.com/",
    }
)

endpoint = "https://push2.eastmoney.com/api/qt/ulist.np/get"
fields = (
    "f2,f3,f5,f6,f8,f10,f12,f14,f62,f184,"
    "f66,f69,f72,f75,f78,f81,f84,f87,f124"
)


def market_id(code):
    _, _, exchange = code.partition(".")
    return "1" if exchange.upper() == "SH" else "0"


def number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def chunked(values, size):
    for index in range(0, len(values), size):
        yield values[index:index + size]


rows_by_code = {}
for batch in chunked(stocks, 60):
    secids = ",".join(
        f"{market_id(item['code'])}.{item['code'].split('.')[0]}"
        for item in batch
    )
    response = session.get(
        endpoint,
        params={
            "fltt": 2,
            "invt": 2,
            "secids": secids,
            "fields": fields,
        },
        timeout=35,
        verify=False,
    )
    response.raise_for_status()
    data = response.json().get("data") or {}
    rows = data.get("diff") or []
    if isinstance(rows, dict):
        rows = list(rows.values())
    for row in rows:
        code = str(row.get("f12") or "").strip()
        if code:
            rows_by_code[code] = row

if not rows_by_code:
    raise SystemExit("No stock flow rows returned")

quote_timestamps = []
records = []
for stock in stocks:
    stock_code, _, exchange = stock["code"].partition(".")
    row = rows_by_code.get(stock_code)
    if not row:
        continue
    quote_timestamp = int(row.get("f124") or 0)
    if quote_timestamp:
        quote_timestamps.append(quote_timestamp)
    records.append(
        {
            "code": stock["code"],
            "stockCode": stock_code,
            "exchange": exchange,
            "name": stock.get("name") or row.get("f14") or stock_code,
            "industryCode": stock["industryCode"],
            "industryName": stock["industryName"],
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

if not records:
    raise SystemExit("No requested stock codes matched the flow response")

matched_codes = {item["stockCode"] for item in records}
missing = sorted(
    item["code"]
    for item in stocks
    if item["code"].split(".")[0] not in matched_codes
)
records.sort(
    key=lambda item: (
        item.get("mainNetInflow") is not None,
        item.get("mainNetInflow") or -1e30,
    ),
    reverse=True,
)

latest_timestamp = max(quote_timestamps) if quote_timestamps else 0
quote_time = datetime.fromtimestamp(latest_timestamp, china_tz)
now = datetime.now(china_tz)
print(
    json.dumps(
        {
            "source": "东方财富个股资金流，按申万二级行业成分股汇总",
            "sourceDate": quote_time.strftime("%Y-%m-%d"),
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "delaySeconds": max(0, int(now.timestamp() - latest_timestamp)),
            "matchedCount": len(records),
            "missingCount": len(missing),
            "missingCodes": missing,
            "stocks": records,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def weighted_average(records: list[dict], key: str) -> float | None:
    total_weight = 0.0
    weighted_sum = 0.0
    for item in records:
        value = item.get(key)
        weight = item.get("amount")
        if (
            isinstance(value, (int, float))
            and isinstance(weight, (int, float))
            and weight > 0
        ):
            total_weight += weight
            weighted_sum += value * weight
    return round(weighted_sum / total_weight, 4) if total_weight else None


def sum_values(records: list[dict], key: str) -> float:
    return round(
        sum(
            item[key]
            for item in records
            if isinstance(item.get(key), (int, float))
        ),
        4,
    )


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or len(sys.argv[1]) != 6:
        print(
            "usage: fetch_level2_stock_flow.py <level2-industry-code>",
            file=sys.stderr,
        )
        return 2

    industry_code = sys.argv[1]
    root = Path(__file__).resolve().parent
    company_file = root / "companies_cache" / f"{industry_code}.json"
    if not company_file.exists():
        result = subprocess.run(
            [sys.executable, str(root / "fetch_industry_companies.py"), industry_code],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=180,
            check=False,
        )
        if result.returncode != 0 or not company_file.exists():
            print(
                (result.stderr or result.stdout or "level-2 companies unavailable").strip(),
                file=sys.stderr,
            )
            return 1

    company_payload = read_json(company_file)
    industry_name = company_payload.get("industryName") or industry_code
    stocks = []
    for company in company_payload.get("companies") or []:
        if not company.get("code"):
            continue
        stocks.append(
            {
                "code": company["code"],
                "name": company.get("name") or company["code"],
                "industryCode": industry_code,
                "industryName": industry_name,
            }
        )
    if not stocks:
        print("No constituent stocks found", file=sys.stderr)
        return 1

    try:
        result = run_script(
            REMOTE_SCRIPT,
            (
                base64.b64encode(
                    json.dumps(stocks, ensure_ascii=False).encode("utf-8")
                ).decode("ascii"),
            ),
            timeout=150,
        )
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Level-2 stock flow fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    records = payload.get("stocks") or []
    main_net = sum_values(records, "mainNetInflow")
    amount = sum_values(records, "amount")
    payload["industry"] = {
        "code": industry_code,
        "name": industry_name,
        "stockCount": len(stocks),
        "matchedCount": len(records),
        "inflowCount": sum(
            1
            for item in records
            if isinstance(item.get("mainNetInflow"), (int, float))
            and item["mainNetInflow"] > 0
        ),
        "outflowCount": sum(
            1
            for item in records
            if isinstance(item.get("mainNetInflow"), (int, float))
            and item["mainNetInflow"] < 0
        ),
        "mainNetInflow": main_net,
        "mainNetRatio": round(main_net / amount * 100, 4) if amount else None,
        "amount": amount,
        "changePct": weighted_average(records, "changePct"),
        "volumeRatio": weighted_average(records, "volumeRatio"),
        "turnoverRate": weighted_average(records, "turnoverRate"),
    }

    output_dir = root / "level2_flow_cache"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / f"{industry_code}.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {len(records)}/{len(stocks)} stocks "
        f"at {payload.get('quoteTime')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
