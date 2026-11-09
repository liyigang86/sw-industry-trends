#!/usr/bin/env python3
"""Search Eastmoney concepts and return the related A-share constituents."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import difflib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

query = base64.b64decode(sys.argv[1]).decode("utf-8").strip()
china_tz = timezone(timedelta(hours=8))
endpoint = "https://push2.eastmoney.com/api/qt/clist/get"
history_endpoint = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
limit_pool_endpoint = (
    "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool"
)
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


def normalize(value):
    text = str(value or "").strip().lower()
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"(?:概念|板块|题材)$", "", text)
    return text


def number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def board_count(label):
    text = str(label or "")
    if "首板" in text:
        return 1
    match = re.search(r"(\d+)板", text)
    if match:
        return int(match.group(1))
    match = re.search(r"(\d+)天(\d+)板", text)
    return int(match.group(2)) if match else 1


def rows_from_response(response):
    response.raise_for_status()
    data = response.json().get("data") or {}
    rows = data.get("diff") or []
    if isinstance(rows, dict):
        rows = list(rows.values())
    return data, rows


def percentile_rank(values, value):
    valid = [float(item) for item in values if item is not None]
    if value is None or not valid:
        return 0.0
    below = sum(1 for item in valid if item < value)
    equal = sum(1 for item in valid if item == value)
    return (below + equal * 0.5) / len(valid)


def fetch_stock_history(stock):
    market = 1 if stock["exchange"] == "SH" else 0
    response = session.get(
        history_endpoint,
        params={
            "secid": f"{market}.{stock['stockCode']}",
            "klt": 101,
            "fqt": 1,
            "lmt": 8,
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6,f7,f8",
            "fields2": "f51,f53",
        },
        timeout=25,
        verify=False,
    )
    response.raise_for_status()
    rows = (response.json().get("data") or {}).get("klines") or []
    bars = []
    for row in rows:
        values = str(row).split(",")
        if len(values) < 2:
            continue
        close = number(values[1])
        if close is not None:
            bars.append({"date": values[0], "close": close})
    return stock["code"], bars


def fetch_limit_pool(day):
    for offset in range(0, 8):
        target = day - timedelta(days=offset)
        if target.weekday() >= 5:
            continue
        response = session.get(
            limit_pool_endpoint,
            params={
                "page": 1,
                "limit": 200,
                "field": (
                    "199112,10,9001,330323,330324,330325,9002,"
                    "330329,133971,133970,1968584,3475914,9004"
                ),
                "filter": "HS,GEM2STAR",
                "order_field": "330324",
                "order_type": 0,
                "date": target.strftime("%Y%m%d"),
            },
            timeout=30,
            verify=False,
            headers={"Referer": "https://data.10jqka.com.cn/rank/ztpool/"},
        )
        response.raise_for_status()
        rows = ((response.json().get("data") or {}).get("info") or [])
        if rows:
            return target.isoformat(), rows
    return None, []


boards = []
for page in range(1, 8):
    data, batch = rows_from_response(
        session.get(
            endpoint,
            params={
                "pn": page,
                "pz": 100,
                "po": 1,
                "np": 1,
                "fltt": 2,
                "invt": 2,
                "fid": "f3",
                "fs": "m:90+t:3+f:!50",
                "fields": "f12,f14,f2,f3,f62,f184,f124",
            },
            timeout=35,
            verify=False,
        )
    )
    boards.extend(batch)
    total = int(data.get("total") or 0)
    if not batch or len(boards) >= total:
        break

aliases = {
    "物理ai": [
        "人形机器人",
        "机器人概念",
        "机器人执行器",
        "虚拟机器人",
        "具身智能",
    ],
    "物理人工智能": [
        "人形机器人",
        "机器人概念",
        "机器人执行器",
        "虚拟机器人",
        "具身智能",
    ],
    "具身智能": [
        "人形机器人",
        "机器人概念",
        "机器人执行器",
        "虚拟机器人",
    ],
    "ai短剧": [
        "短剧互动游戏",
        "AI视频",
        "影视概念",
        "AIGC概念",
    ],
    "传媒": [
        "影视概念",
        "短剧互动游戏",
        "AI视频",
        "AIGC概念",
    ],
}

normalized_query = normalize(query)
alias_terms = [normalize(item) for item in aliases.get(normalized_query, [])]
matches = []
known_names = []
for board in boards:
    name = str(board.get("f14") or "").strip()
    normalized_name = normalize(name)
    if not name:
        continue
    known_names.append(name)
    score = 0
    match_type = ""
    if normalized_name == normalized_query:
        score = 100
        match_type = "exact"
    elif normalized_query and (
        normalized_query in normalized_name or normalized_name in normalized_query
    ):
        score = 80
        match_type = "contains"
    elif normalized_name in alias_terms:
        score = 65 - alias_terms.index(normalized_name)
        match_type = "related"
    if not score:
        continue
    matches.append(
        {
            "code": board.get("f12"),
            "name": name,
            "score": score,
            "matchType": match_type,
            "changePct": number(board.get("f3")),
            "mainNetInflow": number(board.get("f62")),
            "mainNetRatio": number(board.get("f184")),
            "quoteTimestamp": int(board.get("f124") or 0),
        }
    )

matches.sort(
    key=lambda item: (
        item["score"],
        item.get("mainNetInflow") is not None,
        item.get("mainNetInflow") or -1e30,
    ),
    reverse=True,
)
matches = matches[:5]

suggestions = []
if not matches:
    suggestions = difflib.get_close_matches(
        normalized_query,
        known_names,
        n=6,
        cutoff=0.28,
    )
    if not suggestions:
        suggestions = [
            name
            for name in known_names
            if normalized_query and (
                normalized_query[:1] in name or normalized_query[-1:] in name
            )
        ][:6]

stocks = {}
quote_timestamps = []
for board in matches:
    board_code = board["code"]
    board_rows = []
    for page in range(1, 12):
        data, batch = rows_from_response(
            session.get(
                endpoint,
                params={
                    "pn": page,
                    "pz": 100,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f62",
                    "fs": f"b:{board_code}+f:!50",
                    "fields": (
                        "f2,f3,f6,f8,f10,f12,f13,f14,"
                        "f20,f21,f24,f62,f109,f124,f184,"
                        "f66,f72,f78,f84"
                    ),
                },
                timeout=35,
                verify=False,
            )
        )
        board_rows.extend(batch)
        total = int(data.get("total") or 0)
        if not batch or len(board_rows) >= total:
            break
    board["memberCount"] = len(board_rows)
    for row in board_rows:
        stock_code = str(row.get("f12") or "").strip()
        if not stock_code:
            continue
        market_id = int(row.get("f13") or 0)
        exchange = "SH" if market_id == 1 else "SZ"
        security_code = f"{stock_code}.{exchange}"
        quote_timestamp = int(row.get("f124") or 0)
        if quote_timestamp:
            quote_timestamps.append(quote_timestamp)
        existing = stocks.get(security_code)
        if existing is None:
            existing = {
                "code": security_code,
                "stockCode": stock_code,
                "exchange": exchange,
                "name": row.get("f14") or stock_code,
                "price": number(row.get("f2")),
                "changePct": number(row.get("f3")),
                "amount": number(row.get("f6")),
                "turnoverRate": number(row.get("f8")),
                "volumeRatio": number(row.get("f10")),
                "marketCap": number(row.get("f20")),
                "floatMarketCap": number(row.get("f21")),
                "return5d": number(row.get("f109")),
                "return60d": number(row.get("f24")),
                "mainNetInflow": number(row.get("f62")),
                "mainNetRatio": number(row.get("f184")),
                "superLargeNetInflow": number(row.get("f66")),
                "largeNetInflow": number(row.get("f72")),
                "mediumNetInflow": number(row.get("f78")),
                "smallNetInflow": number(row.get("f84")),
                "quoteTimestamp": quote_timestamp,
                "concepts": [],
            }
            stocks[security_code] = existing
        if board["name"] not in existing["concepts"]:
            existing["concepts"].append(board["name"])

stock_rows = list(stocks.values())
stock_rows.sort(
    key=lambda item: (
        item.get("mainNetInflow") is not None,
        item.get("mainNetInflow") or -1e30,
    ),
    reverse=True,
)

latest_timestamp = max(quote_timestamps) if quote_timestamps else 0
quote_time = datetime.fromtimestamp(latest_timestamp, china_tz)
now = datetime.now(china_tz)

def snapshot_lead_score(item):
    return (
        percentile_rank(
            [row.get("changePct") for row in stock_rows],
            item.get("changePct"),
        )
        * 0.35
        + percentile_rank(
            [row.get("return5d") for row in stock_rows],
            item.get("return5d"),
        )
        * 0.25
        + percentile_rank(
            [row.get("amount") for row in stock_rows],
            item.get("amount"),
        )
        * 0.2
        + percentile_rank(
            [row.get("mainNetRatio") for row in stock_rows],
            item.get("mainNetRatio"),
        )
        * 0.12
        + percentile_rank(
            [row.get("volumeRatio") for row in stock_rows],
            item.get("volumeRatio"),
        )
        * 0.08
    )


def snapshot_capacity_score(item):
    return (
        percentile_rank(
            [row.get("marketCap") for row in stock_rows],
            item.get("marketCap"),
        )
        * 0.5
        + percentile_rank(
            [row.get("amount") for row in stock_rows],
            item.get("amount"),
        )
        * 0.3
        + percentile_rank(
            [row.get("mainNetInflow") for row in stock_rows],
            item.get("mainNetInflow"),
        )
        * 0.2
    )


lead_candidates = sorted(
    stock_rows,
    key=snapshot_lead_score,
    reverse=True,
)[:24]
capacity_candidates = sorted(
    stock_rows,
    key=snapshot_capacity_score,
    reverse=True,
)[:24]
candidate_map = {
    item["code"]: item
    for item in lead_candidates + capacity_candidates
}
histories = {}
with ThreadPoolExecutor(max_workers=8) as executor:
    futures = {
        executor.submit(fetch_stock_history, item): code
        for code, item in candidate_map.items()
    }
    for future in as_completed(futures):
        code = futures[future]
        try:
            result_code, bars = future.result()
            histories[result_code] = bars
        except Exception:
            histories[code] = []

limit_date, limit_rows = fetch_limit_pool(quote_time.date())
limit_by_stock = {
    str(row.get("code") or "").strip(): row
    for row in limit_rows
    if row.get("code")
}
for stock in stock_rows:
    stock["history"] = histories.get(stock["code"], [])
    stock["historyEligible"] = stock["code"] in candidate_map
    limit_row = limit_by_stock.get(stock["stockCode"])
    stock["limitUp"] = (
        {
            "limitUpType": limit_row.get("limit_up_type"),
            "boardLabel": limit_row.get("high_days"),
            "boardCount": board_count(limit_row.get("high_days")),
            "firstLimitTime": number(limit_row.get("first_limit_up_time")),
            "lastLimitTime": number(limit_row.get("last_limit_up_time")),
            "openCount": number(limit_row.get("open_num")),
            "reasonText": limit_row.get("reason_type"),
        }
        if limit_row
        else None
    )

alias_note = None
if matches and all(item["matchType"] == "related" for item in matches):
    alias_note = (
        f"概念库没有完全同名的“{query}”板块，"
        "这里按常见关联词匹配："
        + "、".join(item["name"] for item in matches)
        + "。属于相近概念映射，不是官方同名概念。"
    )
print(
    json.dumps(
        {
            "query": query,
            "normalizedQuery": normalized_query,
            "source": "东方财富概念板块及成分股",
            "sourceDate": quote_time.strftime("%Y-%m-%d"),
            "quoteTime": quote_time.isoformat(),
            "fetchedAt": now.isoformat(),
            "isAliasMatch": bool(matches)
            and all(item["matchType"] == "related" for item in matches),
            "aliasNote": alias_note,
            "concepts": matches,
            "suggestions": suggestions,
            "stockCount": len(stock_rows),
            "strictRoleModel": (
                "角色使用板块差异化涨停阈值、首次封板时间、连板高度、"
                "炸板次数、近5日板块内领导稳定性和共振跟随，"
                "并结合涨幅、5日动量、市值、成交与资金计算。"
            ),
            "limitPoolDate": limit_date,
            "historicalCandidateCount": len(histories),
            "stocks": stock_rows,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
)
'''


def cache_name(query: str) -> str:
    normalized = re.sub(r"\s+", "", query).lower()
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:20]
    return f"{digest}.json"


def main() -> int:
    query = " ".join(sys.argv[1:]).strip()
    if not query:
        print("usage: fetch_concept_stocks.py <concept query>", file=sys.stderr)
        return 2

    root = Path(__file__).resolve().parent
    try:
        result = run_script(
            REMOTE_SCRIPT,
            (
                base64.b64encode(query.encode("utf-8")).decode("ascii"),
            ),
            timeout=180,
        )
        payload = json.loads(result.stdout)
    except (
        OSError,
        subprocess.SubprocessError,
        json.JSONDecodeError,
    ) as exc:
        details = getattr(exc, "stderr", None)
        print(
            f"Concept stock fetch failed: {exc}"
            + (f"\n{details.strip()}" if isinstance(details, str) and details else ""),
            file=sys.stderr,
        )
        return 1

    output_dir = root / "concept_stock_cache"
    output_dir.mkdir(exist_ok=True)
    output = output_dir / cache_name(query)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"Wrote {output} with {len(payload.get('concepts') or [])} concepts "
        f"and {payload.get('stockCount', 0)} stocks"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
