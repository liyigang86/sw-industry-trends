#!/usr/bin/env python3
"""Fetch listed companies in one Shenwan level-2 industry."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import html
import json
import re
import sys
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

industry_code = sys.argv[1]
index_code = f"{industry_code}.SI"
url = "https://www.legulegu.com/stockdata/index-composition"
headers = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/140.0.0.0 Safari/537.36"
    ),
    "Referer": (
        "https://www.legulegu.com/stockdata/sw-industry-2021"
        f"?industryCode={index_code}"
    ),
}
response = requests.get(
    url,
    params={"industryCode": index_code},
    headers=headers,
    timeout=45,
    verify=False,
)
response.raise_for_status()
text = response.text

industry_name_match = re.search(
    r'content="\d{4}-\d{2}-\d{2}，([^<(]+)\(\d{6}\.SI\)',
    text,
    re.S,
)
source_date_match = re.search(
    r"(\d{4}-\d{2}-\d{2})，.*?最新申万行业成分股",
    text,
    re.S,
)
expected_match = re.search(r"查看成分股\((\d+)\)", text)

def text_value(value):
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()

def number_value(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None

companies = []
row_pattern = re.compile(
    r'<tr class="index-basic-composition-item"(.*?)</tr>',
    re.S,
)
for row_index, row_match in enumerate(row_pattern.finditer(text), start=1):
    row = row_match.group(1)
    attributes = dict(
        re.findall(r'data-([a-z0-9-]+)="([^"]*)"', row, re.I)
    )
    code = attributes.get("stock-code", "").strip()
    name_match = re.search(
        r'<td[^>]*text-align:\s*center[^>]*>\s*'
        r'<a href="/s/[^"]+">([^<]+)</a>\s*</td>',
        row,
        re.S,
    )
    name = text_value(name_match.group(1)) if name_match else ""
    if not code or not name:
        continue
    companies.append(
        {
            "rank": row_index,
            "code": code,
            "name": name,
            "close": number_value(attributes.get("close")),
            "change1d": number_value(attributes.get("day1-chg")),
            "change5d": number_value(attributes.get("day5-chg")),
            "change1y": number_value(attributes.get("day-year-chg")),
            "marketCap": number_value(attributes.get("market-cap")),
            "peTtm": number_value(attributes.get("pe-ttm")),
            "pb": number_value(attributes.get("pb")),
        }
    )

if not companies:
    raise SystemExit("No company rows found")

quote_map = {}
quote_timestamps = []
for start in range(0, len(companies), 80):
    batch = companies[start : start + 80]
    secids = []
    for company in batch:
        stock_code, exchange = company["code"].split(".", 1)
        market = {"SH": "1", "SZ": "0", "BJ": "0"}.get(exchange.upper(), "0")
        secids.append(f"{market}.{stock_code}")
    response = requests.get(
        "https://push2.eastmoney.com/api/qt/ulist.np/get",
        params={
            "secids": ",".join(secids),
            "fields": "f2,f3,f12,f14,f20,f23,f109,f124",
            "fltt": 2,
            "invt": 2,
        },
        headers={**headers, "Referer": "https://quote.eastmoney.com/"},
        timeout=45,
        verify=False,
    )
    response.raise_for_status()
    rows = (response.json().get("data") or {}).get("diff") or []
    for row in rows:
        stock_code = str(row.get("f12") or "")
        if stock_code:
            quote_map[stock_code] = row
            timestamp = int(row.get("f124") or 0)
            if timestamp:
                quote_timestamps.append(timestamp)

for company in companies:
    stock_code = company["code"].split(".", 1)[0]
    quote = quote_map.get(stock_code)
    if not quote:
        continue
    close = number_value(quote.get("f2"))
    change1d = number_value(quote.get("f3"))
    change5d = number_value(quote.get("f109"))
    market_cap = number_value(quote.get("f20"))
    pe_ttm = number_value(quote.get("f23"))
    if close is not None:
        company["close"] = close
    if change1d is not None:
        company["change1d"] = change1d
    if change5d is not None:
        company["change5d"] = change5d
    if market_cap is not None:
        company["marketCap"] = round(market_cap / 100_000_000, 2)
    if pe_ttm is not None:
        company["peTtm"] = pe_ttm

quote_date = (
    datetime.fromtimestamp(
        max(quote_timestamps),
        timezone(timedelta(hours=8)),
    ).strftime("%Y-%m-%d")
    if quote_timestamps
    else None
)
print(
    json.dumps(
        {
            "industryCode": industry_code,
            "industryName": (
                text_value(industry_name_match.group(1))
                if industry_name_match
                else industry_code
            ),
            "sourceDate": (
                quote_date
                or (source_date_match.group(1) if source_date_match else None)
            ),
            "membershipDate": (
                source_date_match.group(1) if source_date_match else None
            ),
            "quoteTime": (
                datetime.fromtimestamp(
                    max(quote_timestamps),
                    timezone(timedelta(hours=8)),
                ).isoformat()
                if quote_timestamps
                else None
            ),
            "expectedCount": (
                int(expected_match.group(1)) if expected_match else None
            ),
            "companies": companies,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or len(sys.argv[1]) != 6:
        print("usage: fetch_industry_companies.py <industry-code>", file=sys.stderr)
        return 2

    industry_code = sys.argv[1]
    try:
        result = run_script(REMOTE_SCRIPT, (industry_code,), timeout=120)
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"Company fetch failed: {exc}", file=sys.stderr)
        return 1

    companies = payload.get("companies") or []
    if not companies:
        print("Company source returned an empty list", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parent
    cache_dir = root / "companies_cache"
    cache_dir.mkdir(exist_ok=True)
    output = cache_dir / f"{industry_code}.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    expected = payload.get("expectedCount")
    count_note = f" (source expected {expected})" if expected else ""
    print(f"Wrote {output} with {len(companies)} companies{count_note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
