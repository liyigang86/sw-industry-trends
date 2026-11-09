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
import sys
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

industry_names = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
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
now = datetime.now(china_tz)
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
            "industries": industries,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def main() -> int:
    root = Path(__file__).resolve().parent
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
            ),
            timeout=120,
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

    output = root / "industry_flow_cache.json"
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
