#!/usr/bin/env python3
"""Refresh the A-share company search directory."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import json
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0"})
rows = []
page = 1
while True:
    response = session.get(
        "https://push2.eastmoney.com/api/qt/clist/get",
        params={
            "pn": page,
            "pz": 100,
            "po": 1,
            "np": 1,
            "fltt": 2,
            "invt": 2,
            "fid": "f3",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
            "fields": "f12,f13,f14",
        },
        timeout=45,
        verify=False,
    )
    response.raise_for_status()
    page_data = response.json().get("data") or {}
    page_rows = page_data.get("diff") or []
    rows.extend(page_rows)
    total = int(page_data.get("total") or 0)
    if not page_rows or len(rows) >= total:
        break
    page += 1
    time.sleep(0.08)

def exchange_for(code):
    if code.startswith(("4", "8", "9")):
        return "BJ"
    if code.startswith("6"):
        return "SH"
    return "SZ"

companies = []
seen = set()
for item in rows:
    code = str(item.get("f12") or "")
    name = str(item.get("f14") or "").strip()
    if len(code) != 6 or not name or code in seen:
        continue
    seen.add(code)
    exchange = exchange_for(code)
    companies.append(
        {
            "code": f"{code}.{exchange}",
            "stockCode": code,
            "name": name,
            "exchange": exchange,
        }
    )

companies.sort(key=lambda item: item["stockCode"])
print(
    json.dumps(
        {"companies": companies},
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    try:
        result = run_script(REMOTE_SCRIPT, timeout=90)
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"Company directory fetch failed: {exc}", file=sys.stderr)
        return 1

    companies = payload.get("companies") or []
    if not companies:
        print("Company directory is empty", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parent
    output = root / "company_directory.json"
    output.write_text(
        json.dumps(
            {"companies": companies},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Wrote {output} with {len(companies)} companies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
