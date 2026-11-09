#!/usr/bin/env python3
"""Refresh the embedded Shenwan level-1 daily trend data.

The script can fetch directly from the deployment machine. Set
`SW_FETCH_HOST` to route requests through an optional SSH fetch proxy.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import popen_script


REMOTE_SCRIPT = r'''
import datetime
import json
import re
import sys
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    )
}
CURRENT_URL = "https://www.swsresearch.com/institute-sw/api/index_publish/current/"
TREND_URL = "https://www.swsresearch.com/institute-sw/api/index_publish/trend/"
BENCHMARK_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
BENCHMARK_CONFIG = [
    {"name": "上证指数", "code": "000001", "secid": "1.000001"},
    {"name": "沪深300", "code": "000300", "secid": "1.000300"},
    {"name": "中证1000", "code": "000852", "secid": "1.000852"},
    {"name": "中证2000", "code": "932000", "secid": "2.932000"},
]

session = requests.Session()
session.headers.update(HEADERS)
current_response = None
for attempt in range(6):
    current_response = session.get(
        CURRENT_URL,
        params={"page": "1", "page_size": "50", "indextype": "一级行业"},
        timeout=60,
        verify=False,
    )
    if current_response.status_code < 500:
        break
    time.sleep(2 * (attempt + 1))
current_response.raise_for_status()
industries = []
for row in current_response.json()["data"]["results"]:
    industries.append(
        {
            "code": row["swindexcode"],
            "name": row["swindexname"],
            "count": None,
            "pe": None,
            "peTtm": None,
            "pb": None,
            "dividendYield": None,
        }
    )

if len(industries) < 25:
    raise RuntimeError(f"Only parsed {len(industries)} Shenwan level-1 industries")

level_one_code_by_name = {item["name"]: item["code"] for item in industries}
sub_current_response = session.get(
    CURRENT_URL,
    params={"page": "1", "page_size": "200", "indextype": "二级行业"},
    timeout=60,
    verify=False,
)
sub_current_response.raise_for_status()
sub_rows = sub_current_response.json()["data"]["results"]

level_two_page = None
for attempt in range(4):
    level_two_page = session.get(
        "https://legulegu.com/stockdata/sw-industry-overview",
        timeout=40,
    )
    if level_two_page.status_code < 500:
        break
    time.sleep(2 * (attempt + 1))
level_two_page.raise_for_status()
level_two_html = level_two_page.text
level_two_start = level_two_html.find('id="level2Items"')
level_two_end = level_two_html.find('id="level3Items"')
level_two_scope = level_two_html[level_two_start:level_two_end]
parent_name_by_code = {}
for match in re.finditer(
    r'<div id="(\d{6})\.SI".*?'
    r'<div class="lg-industries-item-number">.*?'
    r'<span class="parent-industry-name">\[(.*?)\]</span>',
    level_two_scope,
    re.S,
):
    parent_name_by_code[match.group(1)] = match.group(2).strip()

sub_industries = []
for row in sub_rows:
    code = row["swindexcode"]
    parent_name = parent_name_by_code.get(code)
    parent_code = level_one_code_by_name.get(parent_name)
    if not parent_code:
        continue
    sub_industries.append(
        {
            "code": code,
            "name": row["swindexname"],
            "parentCode": parent_code,
            "parentName": parent_name,
        }
    )
if len(sub_industries) < 100:
    raise RuntimeError(f"Only parsed {len(sub_industries)} Shenwan level-2 industries")

def fetch_sector(item):
    code = item["code"]
    response = None
    for attempt in range(6):
        response = session.get(
            TREND_URL,
            params={"swindexcode": code, "period": "DAY"},
            timeout=90,
            verify=False,
        )
        if response.status_code < 500 and response.status_code != 429:
            break
        time.sleep(2.5 * (attempt + 1))
    response.raise_for_status()
    payload = response.json()
    if "data" not in payload:
        raise RuntimeError(f"{code}: {payload}")
    points = []
    for row in payload["data"]:
        close = row.get("closeindex")
        date = str(row.get("bargaindate", "")).split("T", 1)[0]
        if close is not None and date:
            points.append([date, round(float(close), 4)])
    return {**item, "points": points[-1400:]}


skip_codes = set()
for argument in sys.argv[1:]:
    if argument.startswith("--skip="):
        skip_codes = {code for code in argument.split("=", 1)[1].split(",") if code}

for item in industries:
    if item["code"] in skip_codes:
        continue
    try:
        enriched_item = fetch_sector(item)
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch {item['code']}: {exc}") from exc
    print("@@SECTOR " + json.dumps(enriched_item, ensure_ascii=False), flush=True)
    time.sleep(0.35)

benchmarks = []
for benchmark_config in BENCHMARK_CONFIG:
    benchmark_response = session.get(
        BENCHMARK_URL,
        params={
            "secid": benchmark_config["secid"],
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56",
            "klt": "101",
            "fqt": "1",
            "beg": "20210701",
            "end": "20500101",
        },
        timeout=40,
    )
    benchmark_response.raise_for_status()
    benchmark_rows = benchmark_response.json()["data"]["klines"]
    points = []
    for row in benchmark_rows:
        fields = row.split(",")
        points.append([fields[0], round(float(fields[2]), 4)])
    benchmarks.append({**benchmark_config, "points": points})

metadata = {
    "source": "申万宏源研究所申万一级行业指数；上证指数、沪深300、中证1000、中证2000来自东方财富",
    "updatedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "frequency": "daily",
    "benchmarks": benchmarks,
    "subIndustries": sub_industries,
}
print("@@META " + json.dumps(metadata, ensure_ascii=False), flush=True)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    cache_path = root / ".data-cache.json"
    try:
        cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        sector_cache = cache.get("industries", {})
        metadata = cache.get("metadata", {})
        skip = ",".join(sorted(sector_cache))
        process = popen_script(REMOTE_SCRIPT, (f"--skip={skip}",))
        assert process.stdin and process.stdout and process.stderr
        process.stdin.write(REMOTE_SCRIPT)
        process.stdin.close()
        for line in process.stdout:
            if line.startswith("@@SECTOR "):
                sector = json.loads(line.removeprefix("@@SECTOR "))
                sector_cache[sector["code"]] = sector
                cache_path.write_text(
                    json.dumps(
                        {"metadata": metadata, "industries": sector_cache},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
            elif line.startswith("@@META "):
                metadata = json.loads(line.removeprefix("@@META "))
                cache_path.write_text(
                    json.dumps(
                        {"metadata": metadata, "industries": sector_cache},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
        return_code = process.wait(timeout=420)
        stderr = process.stderr.read()
        if return_code and len(sector_cache) < 31:
            raise RuntimeError(stderr.strip() or f"SSH exited with status {return_code}")
        if len(sector_cache) < 25:
            raise RuntimeError(f"Only received {len(sector_cache)} industries")
        latest_dates = [
            item["points"][-1][0]
            for item in sector_cache.values()
            if item.get("points")
        ]
        source_date = max(latest_dates)
        sector_dates = sorted(
            {
                point[0]
                for item in sector_cache.values()
                for point in item["points"]
                if point[0] <= source_date
            }
        )
        aligned_benchmarks = []
        for benchmark in metadata["benchmarks"]:
            daily_benchmark = benchmark["points"]
            aligned_benchmark = []
            daily_index = 0
            latest_close = None
            for date in sector_dates:
                while (
                    daily_index < len(daily_benchmark)
                    and daily_benchmark[daily_index][0] <= date
                ):
                    latest_close = daily_benchmark[daily_index][1]
                    daily_index += 1
                if latest_close is not None:
                    aligned_benchmark.append([date, latest_close])
            aligned_benchmarks.append(
                {**benchmark, "points": aligned_benchmark[-1400:]}
            )
        primary_benchmark = next(
            item for item in aligned_benchmarks if item["code"] == "000300"
        )
        payload = {
            **metadata,
            "sourceDate": source_date,
            "benchmarks": aligned_benchmarks,
            "benchmark": primary_benchmark,
            "industries": sorted(
                sector_cache.values(),
                key=lambda item: item["code"],
            ),
        }
    except (OSError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"Data refresh failed: {exc}", file=sys.stderr)
        return 1

    output = root / "data.js"
    serialized = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    )
    content = "window.SW_TREND_DATA = " + serialized + ";\n"
    output.write_text(content, encoding="utf-8")
    (root / "data.json").write_text(serialized, encoding="utf-8")
    cache_path.unlink(missing_ok=True)
    print(
        f"Wrote {output} — {len(payload['industries'])} industries, "
        f"{len(payload['benchmarks'])} benchmarks, "
        f"through {payload['sourceDate']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
