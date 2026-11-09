#!/usr/bin/env python3
"""Fetch daily fund-flow history for the 31 Shenwan level-1 industries."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from datetime import datetime
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

industries = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
endpoint = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
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


def fetch(item):
    response = requests.get(
        endpoint,
        params={
            "lmt": 20,
            "klt": 101,
            "secid": f"90.{item['boardCode']}",
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
    flows = []
    for row in rows:
        values = str(row).split(",")
        if len(values) < 7:
            continue
        flows.append(
            {
                "date": values[0],
                "mainNetInflow": number(values[1]),
                "mainNetRatio": number(values[6]),
            }
        )
    return item["swCode"], {
        "name": item["name"],
        "boardCode": item["boardCode"],
        "flows": flows[-10:],
    }


result = {}
with ThreadPoolExecutor(max_workers=6) as executor:
    futures = [executor.submit(fetch, item) for item in industries]
    for future in as_completed(futures):
        try:
            code, payload = future.result()
            result[code] = payload
        except Exception:
            continue

latest_dates = [
    item["flows"][-1]["date"]
    for item in result.values()
    if item.get("flows")
]
source_date = max(latest_dates) if latest_dates else None
now = datetime.now(timezone(timedelta(hours=8)))
print(
    json.dumps(
        {
            "source": "东方财富申万一级行业板块资金流历史",
            "sourceDate": source_date,
            "fetchedAt": now.isoformat(),
            "industryCount": len(result),
            "industries": result,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
    snapshot_file = root / "industry_flow_cache.json"
    if not snapshot_file.exists():
        print("industry_flow_cache.json is missing", file=sys.stderr)
        return 1
    snapshot = json.loads(snapshot_file.read_text(encoding="utf-8"))
    industries = [
        {
            "swCode": item["swCode"],
            "name": item["name"],
            "boardCode": item["boardCode"],
        }
        for item in snapshot.get("industries", [])
        if item.get("swCode") and item.get("boardCode")
    ]
    encoded = base64.b64encode(
        json.dumps(industries, ensure_ascii=False).encode("utf-8")
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
            f"Industry fund history fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1
    output = root / "industry_fund_history_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {payload.get('industryCount')} industries "
        f"for {payload.get('sourceDate')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
