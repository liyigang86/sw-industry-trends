#!/usr/bin/env python3
"""Map current limit-up stocks to concept boards and score event catalysts."""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

stocks = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
session = requests.Session()
session.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
        ),
        "Referer": "https://emweb.securities.eastmoney.com/",
    }
)


def fetch_concepts(stock):
    code = stock["code"]
    stock_code, exchange = code.split(".", 1)
    response = session.get(
        "https://emweb.securities.eastmoney.com/PC_HSF10/"
        "CoreConception/PageAjax",
        params={"code": f"{exchange.upper()}{stock_code}"},
        timeout=30,
        verify=False,
    )
    response.raise_for_status()
    boards = response.json().get("ssbk") or []
    names = [
        str(item.get("BOARD_NAME") or "").strip()
        for item in boards
        if str(item.get("IS_PRECISE")) == "1"
        and str(item.get("BOARD_NAME") or "").strip()
    ]
    return code, names


result = {}
with ThreadPoolExecutor(max_workers=8) as executor:
    futures = {
        executor.submit(fetch_concepts, stock): stock["code"]
        for stock in stocks
    }
    for future in as_completed(futures):
        code = futures[future]
        try:
            _, names = future.result()
            result[code] = names
        except Exception:
            result[code] = []

print(
    json.dumps(
        result,
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def normalize(value: str) -> str:
    text = re.sub(r"\s+", "", str(value or "").strip().lower())
    return re.sub(r"(?:概念|板块|题材)$", "", text)


def main() -> int:
    root = Path(__file__).resolve().parent
    heat_file = root / "concept_heat_cache.json"
    event_file = root / "event_theme_cache.json"
    if not heat_file.exists() or not event_file.exists():
        print("Concept heat or event theme cache is missing", file=sys.stderr)
        return 1
    heat = json.loads(heat_file.read_text(encoding="utf-8"))
    events = json.loads(event_file.read_text(encoding="utf-8"))
    limit_stocks = events.get("limitUpStocks") or []
    if not limit_stocks:
        print("No limit-up stocks found in event theme cache", file=sys.stderr)
        return 1

    compact = [
        {"code": item.get("code"), "name": item.get("name")}
        for item in limit_stocks
        if item.get("code")
    ]
    encoded = base64.b64encode(
        json.dumps(compact, ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    try:
        result = run_script(REMOTE_SCRIPT, (encoded,), timeout=180)
        stock_concepts = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Concept hotspot mapping failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    concept_by_name = {
        normalize(item.get("name")): item
        for item in heat.get("concepts", [])
        if item.get("name")
    }
    aggregates: dict[str, dict] = {}
    mapped_codes = set()
    for stock in limit_stocks:
        code = stock.get("code")
        names = stock_concepts.get(code) or []
        for name in names:
            concept = concept_by_name.get(normalize(name))
            if not concept:
                continue
            mapped_codes.add(code)
            board_code = concept["code"]
            item = aggregates.setdefault(
                board_code,
                {
                    "code": board_code,
                    "name": concept["name"],
                    "limitUpStocks": {},
                },
            )
            item["limitUpStocks"][code] = {
                "code": code,
                "name": stock.get("name"),
                "boardLabel": stock.get("boardLabel"),
                "boardCount": stock.get("boardCount") or 1,
                "firstLimitTime": stock.get("firstLimitTime") or 0,
                "lastLimitTime": stock.get("lastLimitTime") or 0,
                "openCount": stock.get("openCount"),
                "orderAmount": stock.get("orderAmount"),
                "reasonText": stock.get("reasonText"),
                "matchedConcept": name,
            }

    concepts = []
    for item in aggregates.values():
        stocks = sorted(
            item["limitUpStocks"].values(),
            key=lambda stock: (
                stock.get("boardCount") or 1,
                -(stock.get("firstLimitTime") or 0),
                stock.get("orderAmount") or 0,
            ),
            reverse=True,
        )
        concepts.append(
            {
                "code": item["code"],
                "name": item["name"],
                "limitUpCount": len(stocks),
                "multiBoardCount": sum(
                    1 for stock in stocks if (stock.get("boardCount") or 1) >= 2
                ),
                "maxBoard": max(
                    (stock.get("boardCount") or 1 for stock in stocks),
                    default=0,
                ),
                "openedCount": sum(
                    1 for stock in stocks if (stock.get("openCount") or 0) > 0
                ),
                "stocks": stocks[:20],
            }
        )
    concepts.sort(
        key=lambda item: (
            item["limitUpCount"],
            item["multiBoardCount"],
            item["maxBoard"],
        ),
        reverse=True,
    )

    china_tz = timezone(timedelta(hours=8))
    payload = {
        "source": "东方财富概念映射 + 同花顺涨停池",
        "sourceDate": events.get("sourceDate"),
        "quoteTime": events.get("quoteTime"),
        "fetchedAt": datetime.now(china_tz).isoformat(),
        "limitUpStockCount": len(limit_stocks),
        "mappedStockCount": len(mapped_codes),
        "mappedConceptCount": len(concepts),
        "concepts": concepts,
    }
    output = root / "concept_hotspot_cache.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {len(concepts)} concepts, "
        f"{len(mapped_codes)}/{len(limit_stocks)} mapped limit-up stocks"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
