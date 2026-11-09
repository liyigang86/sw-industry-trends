#!/usr/bin/env python3
"""Fetch Shenwan level-2 history for the children of one level-1 industry."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import json
import sys
import time

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

codes = [code for code in sys.argv[1].split(",") if code]
url = "https://www.swsresearch.com/institute-sw/api/index_publish/trend/"
session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0"})
result = {}

for code in codes:
    response = None
    for attempt in range(5):
        response = session.get(
            url,
            params={"swindexcode": code, "period": "DAY"},
            timeout=90,
            verify=False,
        )
        if response.status_code < 500 and response.status_code != 429:
            break
        time.sleep(2 * (attempt + 1))
    response.raise_for_status()
    points = []
    for row in response.json()["data"]:
        close = row.get("closeindex")
        date = str(row.get("bargaindate", "")).split("T", 1)[0]
        if close is not None and date:
            points.append([date, round(float(close), 4)])
    result[code] = points[-1400:]
    time.sleep(0.25)

print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
'''


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: fetch_level2_parent.py <parent-code>", file=sys.stderr)
        return 2

    parent_code = sys.argv[1]
    root = Path(__file__).resolve().parent
    data_file = root / "data.json"
    if not data_file.exists():
        print("data.json is missing; refresh level-1 data first", file=sys.stderr)
        return 1

    metadata = json.loads(data_file.read_text(encoding="utf-8"))
    children = [
        item
        for item in metadata.get("subIndustries", [])
        if item.get("parentCode") == parent_code
    ]
    if not children:
        print(f"No level-2 industries found for {parent_code}", file=sys.stderr)
        return 1

    codes = ",".join(item["code"] for item in children)
    try:
        result = run_script(REMOTE_SCRIPT, (codes,), timeout=240)
        histories = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"Level-2 fetch failed: {exc}", file=sys.stderr)
        return 1

    industries = []
    for item in children:
        points = histories.get(item["code"])
        if points:
            industries.append({**item, "points": points})
    if len(industries) != len(children):
        print("Some level-2 history series were not returned", file=sys.stderr)
        return 1

    cache_dir = root / "level2_cache"
    cache_dir.mkdir(exist_ok=True)
    payload = {
        "parentCode": parent_code,
        "sourceDate": max(item["points"][-1][0] for item in industries),
        "industries": industries,
    }
    output = cache_dir / f"{parent_code}.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {output} with {len(industries)} level-2 industries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
