#!/usr/bin/env python3
"""Fetch basic profile information for one listed company."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from fetch_bridge import run_script


REMOTE_SCRIPT = r'''
import base64
import html as html_lib
import json
import re
import sys
from datetime import datetime, timedelta

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

security_code = sys.argv[1]
industry_board_map = json.loads(
    base64.b64decode(sys.argv[2]).decode("utf-8")
)
session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0"})

profile_response = session.get(
    "https://datacenter.eastmoney.com/securities/api/data/v1/get",
    params={
        "reportName": "RPT_F10_BASIC_ORGINFO",
        "columns": "ALL",
        "filter": f'(SECUCODE="{security_code}")',
    },
    timeout=40,
    verify=False,
)
profile_response.raise_for_status()
rows = ((profile_response.json().get("result") or {}).get("data") or [])
if not rows:
    raise SystemExit("Company profile not found")

row = rows[0]
stock_code, exchange = security_code.split(".", 1)
exchange = exchange.lower()

def clean(value):
    if value is None:
        return None
    return re.sub(r"\s+", " ", str(value)).strip()

def date_value(value):
    value = clean(value)
    return value[:10] if value else None

def safe_number(value):
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None

industry_path = []
concepts = []
highlights = []
try:
    concept_response = session.get(
        "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
        params={"code": f"{exchange.upper()}{stock_code}"},
        timeout=40,
        verify=False,
    )
    concept_response.raise_for_status()
    concept_payload = concept_response.json()
    boards = concept_payload.get("ssbk") or []
    theme_response = session.get(
        "https://datacenter.eastmoney.com/securities/api/data/v1/get",
        params={
            "reportName": "RPT_F10_CORETHEME_BOARDTYPE",
            "columns": "ALL",
            "filter": f'(SECUCODE="{security_code}")',
        },
        timeout=40,
        verify=False,
    )
    theme_response.raise_for_status()
    theme_rows = (
        ((theme_response.json().get("result") or {}).get("data") or [])
    )
    concept_reasons = {
        clean(item.get("BOARD_NAME")): clean(item.get("SELECTED_BOARD_REASON"))
        for item in theme_rows
        if clean(item.get("BOARD_NAME")) and clean(item.get("SELECTED_BOARD_REASON"))
    }
    industry_path = [
        {
            "code": item.get("BOARD_CODE"),
            "name": clean(item.get("BOARD_NAME")),
            "level": int(safe_number(item.get("BOARD_LEVEL"))),
        }
        for item in theme_rows
        if safe_number(item.get("BOARD_LEVEL")) is not None
    ]
    industry_path.sort(key=lambda item: item["level"])
    concepts = [
        {
            "code": item.get("NEW_BOARD_CODE"),
            "name": clean(item.get("BOARD_NAME")),
            "reason": concept_reasons.get(clean(item.get("BOARD_NAME"))),
        }
        for item in boards
        if str(item.get("IS_PRECISE")) == "1"
        and safe_number(item.get("BOARD_LEVEL")) is None
    ]
    concepts.sort(key=lambda item: item["name"])
    highlights = [
        {
            "category": clean(item.get("KEY_CLASSIF")),
            "title": clean(item.get("KEYWORD")),
            "content": clean(item.get("MAINPOINT_CONTENT")),
        }
        for item in (concept_payload.get("hxtc") or [])
        if clean(item.get("KEY_CLASSIF")) in {"主营业务", "行业背景", "核心竞争力"}
    ][:6]
except Exception:
    industry_path = []
    concepts = []
    highlights = []


def compact_text(value):
    value = clean(value) or ""
    return re.sub(r"[\s·•（）()【】\[\],，。:：;；/\\\-_]", "", value).lower()


def concept_aliases(name):
    base = re.sub(r"(?:概念|板块|题材)$", "", clean(name) or "").strip()
    aliases = {base}
    mappings = {
        "国产芯片": {"芯片", "集成电路", "半导体"},
        "半导体": {"半导体", "集成电路", "芯片"},
        "存储芯片": {"存储芯片", "存储器", "eeprom", "norflash"},
        "锂电池": {"锂电池", "锂离子电池", "电池"},
        "动力电池": {"动力电池", "电池"},
        "新能源车": {"新能源车", "新能源汽车", "动力电池"},
        "新能源": {"新能源", "动力电池", "储能"},
        "白酒": {"白酒", "茅台酒", "酒类"},
        "超级品牌": {"品牌"},
    }
    for key, values in mappings.items():
        if key in base or base in key:
            aliases.update(values)
    return sorted(
        {compact_text(alias) for alias in aliases if len(compact_text(alias)) >= 2},
        key=len,
        reverse=True,
    )


def concept_evidence_date(reason):
    match = re.search(
        r"(20\d{2})[年./-](\d{1,2})(?:[月./-](\d{1,2}))?",
        reason or "",
    )
    if not match:
        year = re.search(r"(20\d{2})", reason or "")
        return year.group(1) if year else None
    parts = [match.group(1), match.group(2).zfill(2)]
    if match.group(3):
        parts.append(match.group(3).zfill(2))
    return "-".join(parts)


core_business_text = clean(row.get("MAIN_BUSINESS")) or ""
profile_text = " ".join(
    clean(value) or ""
    for value in (
        row.get("ORG_PROFILE"),
        row.get("BUSINESS_SCOPE"),
        *[item.get("content") for item in highlights],
    )
)
industry_text = " ".join(item.get("name") or "" for item in industry_path)
core_business_compact = compact_text(
    f"{core_business_text} {industry_text}"
)
profile_compact = compact_text(profile_text)


def classify_concept(concept):
    name = clean(concept.get("name")) or ""
    reason = clean(concept.get("reason")) or ""
    reason_compact = compact_text(reason)
    aliases = concept_aliases(name)
    direct_business_match = any(
        alias in core_business_compact for alias in aliases
    )
    contextual_match = any(alias in profile_compact for alias in aliases)

    if re.search(
        r"实际控制人|控股股东|国资委|国有资产|注册地址|所在地|属地|"
        r"乡村振兴|社会公益|慈善|帮扶|捐赠|西部大开发|区域发展",
        reason,
    ):
        relevance = "weak"
        basis = "依据主要来自股东、地域或社会责任属性"
    elif re.search(
        r"参股|共同出资|间接持股|财务投资|股权基金|合伙企业",
        reason,
    ):
        relevance = "weak"
        basis = "依据主要是参股或历史投资关系"
    elif re.search(
        r"研究探索|探索阶段|正在研发|研发方向|研究方向|计划推出|"
        r"拟与|拟投资|拟收购|尚未",
        reason,
    ) and not re.search(
        r"主营|主导|核心产品|收入占比|出货占比|供应|客户|合作|协议|"
        r"应用于|用于|产品包括|产品布局",
        reason,
    ):
        relevance = "weak"
        basis = "依据仅为研发、规划或尚未落地的预期信息"
    elif direct_business_match:
        relevance = "core"
        basis = "概念与主营业务、主要产品或所属行业直接重合"
    elif name == "超级品牌" or re.search(
        r"主营业务|主要业务|主要产品|主导产品|公司专注于|"
        r"核心产品|核心业务|主要从事|收入占比|出货占比|市占率|"
        r"产品布局包括|超级品牌|高端白酒龙头",
        reason,
    ):
        relevance = "core"
        basis = "公告或年报明确指向主营产品或核心业务"
    elif re.search(
        r"全球领先|第一品牌|龙头企业|高端白酒龙头|行业龙头",
        reason,
    ) and any(alias in reason_compact for alias in aliases):
        relevance = "core"
        basis = "依据指向公司当前核心产品或行业领先地位"
    elif re.search(
        r"应用于|主要用于|应用于|用于|下游|客户包括|供货|供应商|"
        r"合作伙伴|战略合作|生态|产品线|业务涉及|子公司|产业链|"
        r"产品包括|产品布局|配套|渠道|平台|应用场景|业务聚焦于|"
        r"推出.{0,16}产品|新推出|均有应用|应用|研发|产品涵盖|产品涉及|"
        r"技术处于行业领先|小批量生产|供应|协议",
        reason,
    ) or contextual_match:
        relevance = "extension"
        basis = "属于下游应用、客户、产业链或新业务延伸"
    else:
        relevance = "weak"
        basis = "暂未找到直接主营证据，按弱题材关联处理"

    evidence_date = concept_evidence_date(reason)
    evidence_year = (
        int(evidence_date[:4])
        if evidence_date and evidence_date[:4].isdigit()
        else None
    )
    return {
        **concept,
        "relevance": relevance,
        "relevanceLabel": {
            "core": "核心业务相关",
            "extension": "业务延伸",
            "weak": "弱题材关联",
        }[relevance],
        "relevanceBasis": basis,
        "evidenceDate": evidence_date,
        "stale": bool(evidence_year and evidence_year < datetime.now().year - 2),
    }


concepts = [classify_concept(item) for item in concepts]
concept_order = {"core": 0, "extension": 1, "weak": 2}
concepts.sort(
    key=lambda item: (
        concept_order.get(item["relevance"], 3),
        item.get("name") or "",
    )
)

def return_percent(closes, days):
    if len(closes) <= days or not closes[-1 - days]:
        return None
    return round((closes[-1] / closes[-1 - days] - 1) * 100, 2)

company_financial_inputs = None
fundamental_checks = []
financials = None
try:
    finance_response = session.get(
        "https://datacenter.eastmoney.com/securities/api/data/v1/get",
        params={
            "reportName": "RPT_F10_FINANCE_MAINFINADATA",
            "columns": "ALL",
            "filter": f'(SECUCODE="{security_code}")',
            "sortColumns": "REPORT_DATE",
            "sortTypes": "-1",
            "pageSize": "16",
        },
        timeout=40,
        verify=False,
    )
    finance_response.raise_for_status()
    finance_rows = (
        ((finance_response.json().get("result") or {}).get("data") or [])
    )
    finance_row = finance_rows[0]
    primary_metrics = {
        "revenueGrowth": safe_number(finance_row.get("TOTALOPERATEREVETZ")),
        "profitGrowth": safe_number(finance_row.get("PARENTNETPROFITTZ")),
        "grossMargin": safe_number(finance_row.get("XSMLL")),
        "netMargin": safe_number(finance_row.get("XSJLL")),
        "roe": safe_number(finance_row.get("ROEJQ")),
        "debtRatio": safe_number(finance_row.get("ZCFZL")),
        "cashToProfit": (
            round(float(finance_row.get("NCO_NETPROFIT")) * 100, 4)
            if finance_row.get("NCO_NETPROFIT") is not None
            else None
        ),
    }

    ths_response = session.get(
        f"https://basic.10jqka.com.cn/{stock_code}/finance.html",
        timeout=40,
        verify=False,
    )
    ths_response.raise_for_status()
    ths_text = ths_response.content.decode("gb18030", "ignore")
    annual_rows = [
        item
        for item in finance_rows
        if (date_value(item.get("REPORT_DATE")) or "").endswith("-12-31")
        and safe_number(item.get("ROEJQ")) is not None
    ]
    company_financial_inputs = {
        "reportDate": date_value(finance_row.get("REPORT_DATE")),
        "annualRoes": [
            safe_number(item.get("ROEJQ"))
            for item in annual_rows[:3]
        ],
        "annualProfitGrowth": [
            safe_number(item.get("PARENTNETPROFITTZ"))
            for item in annual_rows[:3]
            if safe_number(item.get("PARENTNETPROFITTZ")) is not None
        ],
        "annualRevenueGrowth": [
            safe_number(item.get("TOTALOPERATEREVETZ"))
            for item in annual_rows[:3]
            if safe_number(item.get("TOTALOPERATEREVETZ")) is not None
        ],
        "latestBps": safe_number(finance_row.get("BPS")),
        "latestRoe": safe_number(finance_row.get("ROEJQ")),
        "latestProfitGrowth": safe_number(
            finance_row.get("PARENTNETPROFITTZ")
        ),
        "latestRevenueGrowth": safe_number(
            finance_row.get("TOTALOPERATEREVETZ")
        ),
    }
    labels = {
        "revenueGrowth": "营业收入增长率",
        "profitGrowth": "净利润增长率",
        "grossMargin": "毛利率",
        "netMargin": "净利率",
        "roe": "净资产收益率",
        "debtRatio": "资产负债率",
        "cashToProfit": "净利润现金含量",
    }
    secondary_metrics = {}
    industry_ranks = {}
    list_items = re.findall(r"<li[^>]*>(.*?)</li>", ths_text, re.S)
    for item in list_items:
        plain = html_lib.unescape(re.sub(r"<[^>]+>", " ", item))
        plain = re.sub(r"\s+", " ", plain)
        rank_match = re.search(r"行业排名\s*(\d+)\s*/\s*(\d+)", plain)
        for key, label in labels.items():
            if f"本期{label}" not in plain:
                continue
            value_match = re.search(
                rf"本期{re.escape(label)}\s*([-+]?\d+(?:\.\d+)?)%",
                plain,
            )
            if value_match:
                secondary_metrics[key] = round(float(value_match.group(1)), 4)
            if rank_match:
                industry_ranks[key] = {
                    "rank": int(rank_match.group(1)),
                    "total": int(rank_match.group(2)),
                }
            break

    scores = {}
    chart_match = re.search(
        r'id="chartData"\s+value=\'(.*?)\'',
        ths_text,
        re.S,
    )
    if chart_match:
        try:
            records = json.loads(html_lib.unescape(chart_match.group(1)))
            report_date = date_value(finance_row.get("REPORT_DATE"))
            period_record = records[0].get(report_date, {}) if records else {}
            scores = {
                key: period_record.get(key, {}).get("score")
                for key in ("profit", "grow", "pay", "operate", "cash")
                if isinstance(period_record.get(key), dict)
            }
        except (ValueError, TypeError, IndexError):
            scores = {}

    for key, label in labels.items():
        primary = primary_metrics.get(key)
        secondary = secondary_metrics.get(key)
        difference = (
            round(abs(primary - secondary), 4)
            if primary is not None and secondary is not None
            else None
        )
        relative_error = (
            round(difference / abs(primary) * 100, 2)
            if difference is not None and abs(primary) > 0.01
            else difference
        )
        if difference is None:
            status = "unavailable"
        elif difference <= 0.05 or (relative_error or 0) <= 1:
            status = "verified"
        elif (relative_error or 0) <= 5:
            status = "warning"
        else:
            status = "error"
        fundamental_checks.append(
            {
                "key": key,
                "label": label,
                "primary": primary,
                "secondary": secondary,
                "difference": difference,
                "relativeError": relative_error,
                "status": status,
                "rank": industry_ranks.get(key),
            }
        )

    financials = {
        "reportDate": date_value(finance_row.get("REPORT_DATE")),
        "reportName": clean(finance_row.get("REPORT_DATE_NAME")),
        "revenue": safe_number(finance_row.get("TOTALOPERATEREVE")),
        "netProfit": safe_number(finance_row.get("PARENTNETPROFIT")),
        "operatingCashFlow": safe_number(finance_row.get("NETCASH_OPERATE_PK")),
        **primary_metrics,
        "scores": scores,
        "checks": fundamental_checks,
        "sources": ["东方财富", "同花顺"],
    }
except Exception:
    financials = None

market_data = None
try:
    secid = f"{'1' if exchange == 'sh' else '0'}.{stock_code}"
    kline_response = session.get(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        params={
            "secid": secid,
            "klt": "101",
            "fqt": "1",
            "lmt": "120",
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        },
        timeout=40,
        verify=False,
    )
    kline_response.raise_for_status()
    kline_rows = ((kline_response.json().get("data") or {}).get("klines") or [])
    east_rows = []
    for raw in kline_rows:
        values = raw.split(",")
        east_rows.append(
            {
                "date": values[0],
                "close": float(values[2]),
                "high": float(values[3]),
                "low": float(values[4]),
                "volume": float(values[5]),
                "turnover": float(values[10]) if values[10] else None,
            }
        )

    tencent_response = session.get(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
        params={"param": f"{exchange}{stock_code},day,,,120,qfq"},
        timeout=40,
        verify=False,
    )
    tencent_response.raise_for_status()
    tencent_data = (tencent_response.json().get("data") or {}).get(
        f"{exchange}{stock_code}", {}
    )
    tencent_rows = tencent_data.get("qfqday") or tencent_data.get("day") or []
    tencent_closes = {
        values[0]: float(values[2])
        for values in tencent_rows
        if len(values) >= 3
    }
    common_dates = sorted(
        {item["date"] for item in east_rows}.intersection(tencent_closes)
    )
    east_by_date = {item["date"]: item for item in east_rows}
    common_east = [east_by_date[date] for date in common_dates]
    east_closes = [item["close"] for item in common_east]
    tencent_closes_aligned = [tencent_closes[date] for date in common_dates]

    def source_check(label, primary, secondary):
        difference = abs(primary - secondary)
        relative_error = (
            difference / abs(primary) * 100 if abs(primary) > 0.0001 else difference
        )
        return {
            "label": label,
            "primary": round(primary, 4),
            "secondary": round(secondary, 4),
            "difference": round(difference, 4),
            "relativeError": round(relative_error, 2),
            "status": (
                "verified"
                if difference <= 0.05 or relative_error <= 1
                else "warning"
                if relative_error <= 5
                else "error"
            ),
        }

    returns = {}
    market_checks = []
    for days in (1, 5, 20, 60):
        primary_return = return_percent(east_closes, days)
        secondary_return = return_percent(tencent_closes_aligned, days)
        returns[str(days)] = primary_return
        if primary_return is not None and secondary_return is not None:
            market_checks.append(
                source_check(
                    f"{days}日收益",
                    primary_return,
                    secondary_return,
                )
            )

    latest = east_rows[-1]
    ma20 = sum(item["close"] for item in common_east[-20:]) / 20
    prev_volumes = [item["volume"] for item in east_rows[-21:-1]]
    volume_ratio = (
        latest["volume"] / (sum(prev_volumes) / len(prev_volumes))
        if len(prev_volumes) == 20 and sum(prev_volumes) > 0
        else None
    )
    high20 = max(item["high"] for item in east_rows[-20:])
    market_data = {
        "asOf": latest["date"],
        "close": round(latest["close"], 2),
        "return1d": returns.get("1"),
        "return5d": returns.get("5"),
        "return20d": returns.get("20"),
        "return60d": returns.get("60"),
        "ma20Distance": round((latest["close"] / ma20 - 1) * 100, 2),
        "high20Distance": round((latest["close"] / high20 - 1) * 100, 2),
        "volumeRatio20": (
            round(volume_ratio, 2) if volume_ratio is not None else None
        ),
        "turnover": latest["turnover"],
        "history": [
            [item["date"], round(item["close"], 4)]
            for item in east_rows[-90:]
        ],
        "checks": market_checks,
        "sources": ["东方财富", "腾讯证券"],
    }
except Exception:
    market_data = None

bank_valuation = None
is_bank_industry = any(
    item.get("level") == 1 and item.get("name") == "银行"
    for item in industry_path
)
if is_bank_industry and market_data and company_financial_inputs:
    try:
        valuation_response = session.get(
            "https://datacenter.eastmoney.com/securities/api/data/v1/get",
            params={
                "reportName": "RPT_VALUEANALYSIS_DET",
                "columns": "SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ",
                "filter": f'(SECURITY_CODE="{stock_code}")',
                "sortColumns": "TRADE_DATE",
                "sortTypes": "-1",
                "pageSize": "1000",
                "pageNumber": "1",
            },
            timeout=40,
            verify=False,
        )
        valuation_response.raise_for_status()
        valuation_rows = (
            ((valuation_response.json().get("result") or {}).get("data") or [])
        )
        if not valuation_rows:
            raise RuntimeError("No valuation history")
        latest_valuation = valuation_rows[0]
        latest_valuation_date = datetime.strptime(
            latest_valuation["TRADE_DATE"][:10], "%Y-%m-%d"
        )
        cutoff_date = (latest_valuation_date - timedelta(days=1095)).strftime(
            "%Y-%m-%d"
        )
        own_pb_values = sorted(
            safe_number(item.get("PB_MRQ"))
            for item in valuation_rows
            if (item.get("TRADE_DATE") or "")[:10] >= cutoff_date
            and safe_number(item.get("PB_MRQ")) is not None
            and 0 < safe_number(item.get("PB_MRQ")) < 20
        )
        if len(own_pb_values) < 60:
            raise RuntimeError("Insufficient PB history")

        peer_response = session.get(
            "https://push2.eastmoney.com/api/qt/clist/get",
            params={
                "pn": 1,
                "pz": 100,
                "po": 1,
                "np": 1,
                "fltt": 2,
                "invt": 2,
                "fid": "f23",
                "fs": "b:BK1283",
                "fields": "f9,f12,f14,f23",
            },
            timeout=40,
            verify=False,
        )
        peer_response.raise_for_status()
        peer_rows = (
            ((peer_response.json().get("data") or {}).get("diff") or [])
        )
        industry_pb_values = sorted(
            safe_number(item.get("f23"))
            for item in peer_rows
            if safe_number(item.get("f23")) is not None
            and 0 < safe_number(item.get("f23")) < 20
        )
        if len(industry_pb_values) < 10:
            raise RuntimeError("Insufficient bank peers")

        bonus_response = session.get(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            params={
                "reportName": "RPT_SHAREBONUS_DET",
                "columns": "ALL",
                "filter": f'(SECUCODE="{security_code}")',
                "sortColumns": "REPORT_DATE",
                "sortTypes": "-1",
                "pageSize": "50",
            },
            timeout=40,
            verify=False,
        )
        bonus_response.raise_for_status()
        bonus_rows = (
            ((bonus_response.json().get("result") or {}).get("data") or [])
        )
        annual_bonus_rows = [
            item
            for item in bonus_rows
            if (date_value(item.get("REPORT_DATE")) or "").endswith("-12-31")
            and safe_number(item.get("BASIC_EPS")) is not None
            and safe_number(item.get("BASIC_EPS")) > 0
        ]
        payout_ratio = None
        latest_annual_eps = None
        latest_dividend_per_share = None
        if annual_bonus_rows:
            latest_annual = annual_bonus_rows[0]
            latest_annual_eps = safe_number(latest_annual.get("BASIC_EPS"))
            annual_year = (date_value(latest_annual.get("REPORT_DATE")) or "")[:4]
            dividend_rows = [
                item
                for item in bonus_rows
                if (date_value(item.get("REPORT_DATE")) or "").startswith(
                    annual_year
                )
                and "实施" in str(item.get("ASSIGN_PROGRESS") or "")
                and safe_number(item.get("PRETAX_BONUS_RMB")) is not None
            ]
            latest_dividend_per_share = round(
                sum(
                    safe_number(item.get("PRETAX_BONUS_RMB")) or 0
                    for item in dividend_rows
                )
                / 10,
                4,
            )
            if latest_annual_eps:
                payout_ratio = latest_dividend_per_share / latest_annual_eps
        payout_estimated = payout_ratio is None
        if payout_ratio is None:
            payout_ratio = 0.3
        payout_ratio = min(max(payout_ratio, 0.1), 0.8)

        def percentile(values, fraction):
            if not values:
                return None
            position = (len(values) - 1) * fraction
            lower = int(position)
            upper = min(lower + 1, len(values) - 1)
            weight = position - lower
            return values[lower] + (values[upper] - values[lower]) * weight

        own_pb = {
            "bear": percentile(own_pb_values, 0.25),
            "base": percentile(own_pb_values, 0.50),
            "bull": percentile(own_pb_values, 0.75),
        }
        industry_pb = {
            "bear": percentile(industry_pb_values, 0.25),
            "base": percentile(industry_pb_values, 0.50),
            "bull": percentile(industry_pb_values, 0.75),
        }
        current_price = safe_number(market_data.get("close"))
        valuation_pb = safe_number(latest_valuation.get("PB_MRQ"))
        latest_bps = safe_number(company_financial_inputs.get("latestBps"))
        if current_price and valuation_pb:
            current_bps = current_price / valuation_pb
        elif latest_bps:
            current_bps = latest_bps
            valuation_pb = current_price / current_bps if current_price else None
        else:
            raise RuntimeError("No book value per share")

        annual_roes = [
            value
            for value in company_financial_inputs.get("annualRoes", [])
            if value is not None and 0 < value < 50
        ]
        if not annual_roes:
            raise RuntimeError("No annual ROE")
        normalized_roe = sum(annual_roes) / len(annual_roes)
        roe_dispersion = (
            (
                sum((value - normalized_roe) ** 2 for value in annual_roes)
                / len(annual_roes)
            )
            ** 0.5
            if len(annual_roes) > 1
            else 1.0
        )
        roe_dispersion = max(roe_dispersion, 1.0)

        scenario_config = [
            ("bear", "悲观", -1),
            ("base", "基准", 0),
            ("bull", "乐观", 1),
        ]
        scenarios = []
        for key, label, direction in scenario_config:
            scenario_roe = normalized_roe + direction * roe_dispersion
            scenario_roe = min(max(scenario_roe, 3.0), 30.0)
            growth = scenario_roe / 100 * (1 - payout_ratio)
            growth = min(max(growth, 0), 0.12)
            future_bps = current_bps * (1 + growth)
            target_pb = (
                (own_pb[key] + industry_pb[key]) / 2
                if own_pb[key] is not None and industry_pb[key] is not None
                else own_pb[key] or industry_pb[key]
            )
            if target_pb is None:
                raise RuntimeError("No target PB")
            target_pb = min(max(target_pb, 0.2), 3.0)
            target_pb = min(
                max(target_pb, valuation_pb * 0.7),
                valuation_pb * 1.3,
            )
            target_price = future_bps * target_pb
            estimated_eps = current_bps * scenario_roe / 100
            estimated_dps = estimated_eps * payout_ratio
            scenarios.append(
                {
                    "key": key,
                    "label": label,
                    "roe": round(scenario_roe, 2),
                    "growth": round(growth * 100, 2),
                    "futureBps": round(future_bps, 2),
                    "targetPb": round(target_pb, 2),
                    "targetPrice": round(target_price, 2),
                    "upside": round(
                        (target_price / current_price - 1) * 100, 2
                    ),
                    "dividendYield": round(
                        estimated_dps / target_price * 100, 2
                    ),
                }
            )

        bank_valuation = {
            "method": "PB-ROE",
            "currentPrice": current_price,
            "currentPb": round(valuation_pb, 2),
            "currentBps": round(current_bps, 2),
            "normalizedRoe": round(normalized_roe, 2),
            "payoutRatio": round(payout_ratio * 100, 2),
            "payoutEstimated": payout_estimated,
            "currentDividendYield": round(
                (latest_dividend_per_share or 0) / current_price * 100, 2
            ),
            "latestDividendPerShare": latest_dividend_per_share,
            "latestAnnualEps": latest_annual_eps,
            "valuationDate": latest_valuation_date.strftime("%Y-%m-%d"),
            "valuationHistoryStart": cutoff_date,
            "ownPb": {
                key: round(value, 2)
                for key, value in own_pb.items()
                if value is not None
            },
            "industryPb": {
                key: round(value, 2)
                for key, value in industry_pb.items()
                if value is not None
            },
            "industryPeerCount": len(industry_pb_values),
            "annualRoeYears": len(annual_roes),
            "scenarios": scenarios,
            "assumption": (
                "未来一年每股净资产按可持续增长估算；目标PB取公司近三年"
                "PB分位与当前银行行业PB分位的均值，并限制在当前PB的"
                "0.7～1.3倍；盈利和资产质量未做专项预测。"
            ),
            "sources": ["东方财富估值历史", "东方财富银行板块", "东方财富分红记录"],
        }
    except Exception:
        bank_valuation = None

scenario_valuation = None
if (
    not is_bank_industry
    and market_data
    and company_financial_inputs
):
    try:
        level_one_name = next(
            (
                item.get("name")
                for item in industry_path
                if item.get("level") == 1 and item.get("name")
            ),
            None,
        )
        board_code = industry_board_map.get(level_one_name)
        if not level_one_name or not board_code:
            raise RuntimeError("Industry board not found")

        valuation_response = session.get(
            "https://datacenter.eastmoney.com/securities/api/data/v1/get",
            params={
                "reportName": "RPT_VALUEANALYSIS_DET",
                "columns": "SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ",
                "filter": f'(SECURITY_CODE="{stock_code}")',
                "sortColumns": "TRADE_DATE",
                "sortTypes": "-1",
                "pageSize": "1000",
                "pageNumber": "1",
            },
            timeout=40,
            verify=False,
        )
        valuation_response.raise_for_status()
        valuation_rows = (
            ((valuation_response.json().get("result") or {}).get("data") or [])
        )
        if not valuation_rows:
            raise RuntimeError("No valuation history")
        latest_valuation = valuation_rows[0]
        latest_valuation_date = datetime.strptime(
            latest_valuation["TRADE_DATE"][:10], "%Y-%m-%d"
        )
        cutoff_date = (latest_valuation_date - timedelta(days=1095)).strftime(
            "%Y-%m-%d"
        )
        recent_valuations = [
            item
            for item in valuation_rows
            if (item.get("TRADE_DATE") or "")[:10] >= cutoff_date
        ]
        own_pe_values = sorted(
            safe_number(item.get("PE_TTM"))
            for item in recent_valuations
            if safe_number(item.get("PE_TTM")) is not None
            and 0 < safe_number(item.get("PE_TTM")) < 500
        )
        own_pb_values = sorted(
            safe_number(item.get("PB_MRQ"))
            for item in recent_valuations
            if safe_number(item.get("PB_MRQ")) is not None
            and 0 < safe_number(item.get("PB_MRQ")) < 20
        )

        peer_rows = []
        total_peers = None
        for page in range(1, 11):
            peer_response = session.get(
                "https://push2.eastmoney.com/api/qt/clist/get",
                params={
                    "pn": page,
                    "pz": 100,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f20",
                    "fs": f"b:{board_code}",
                    "fields": "f9,f12,f14,f20,f23",
                },
                timeout=35,
                verify=False,
            )
            peer_response.raise_for_status()
            peer_data = peer_response.json().get("data") or {}
            total_peers = peer_data.get("total")
            batch = peer_data.get("diff") or []
            peer_rows.extend(batch)
            if not batch or (
                total_peers is not None and len(peer_rows) >= total_peers
            ):
                break
        industry_pe_values = sorted(
            safe_number(item.get("f9"))
            for item in peer_rows
            if safe_number(item.get("f9")) is not None
            and 0 < safe_number(item.get("f9")) < 500
        )
        industry_pb_values = sorted(
            safe_number(item.get("f23"))
            for item in peer_rows
            if safe_number(item.get("f23")) is not None
            and 0 < safe_number(item.get("f23")) < 20
        )

        def percentile(values, fraction):
            if not values:
                return None
            position = (len(values) - 1) * fraction
            lower = int(position)
            upper = min(lower + 1, len(values) - 1)
            weight = position - lower
            return values[lower] + (values[upper] - values[lower]) * weight

        def clipped(value, minimum, maximum):
            return min(max(value, minimum), maximum)

        prefer_pb = level_one_name in {
            "非银金融",
            "房地产",
            "钢铁",
            "煤炭",
            "有色金属",
            "基础化工",
            "建筑材料",
            "石油石化",
        }
        pe_available = (
            len(own_pe_values) >= 60 and len(industry_pe_values) >= 10
        )
        pb_available = (
            len(own_pb_values) >= 60 and len(industry_pb_values) >= 10
        )
        use_pb = pb_available and (prefer_pb or not pe_available)
        if not use_pb and not pe_available:
            raise RuntimeError("No usable industry valuation metric")

        current_price = safe_number(market_data.get("close"))
        current_pe = safe_number(latest_valuation.get("PE_TTM"))
        current_pb = safe_number(latest_valuation.get("PB_MRQ"))
        if use_pb:
            method = "PB"
            method_label = "行业PB分位 + 成长情景"
            current_multiple = current_pb
            own_values = own_pb_values
            industry_values = industry_pb_values
        else:
            method = "PE"
            method_label = "行业PE分位 + 成长情景"
            current_multiple = current_pe
            own_values = own_pe_values
            industry_values = industry_pe_values
        if current_price is None or current_multiple is None or current_multiple <= 0:
            raise RuntimeError("Invalid current valuation")

        own_percentiles = {
            "bear": percentile(own_values, 0.25),
            "base": percentile(own_values, 0.50),
            "bull": percentile(own_values, 0.75),
        }
        industry_percentiles = {
            "bear": percentile(industry_values, 0.25),
            "base": percentile(industry_values, 0.50),
            "bull": percentile(industry_values, 0.75),
        }

        profit_growth = [
            clipped(float(value), -100, 200)
            for value in company_financial_inputs.get(
                "annualProfitGrowth", []
            )
            if value is not None
        ]
        revenue_growth = [
            clipped(float(value), -100, 200)
            for value in company_financial_inputs.get(
                "annualRevenueGrowth", []
            )
            if value is not None
        ]

        def median(values):
            if not values:
                return None
            ordered = sorted(values)
            middle = len(ordered) // 2
            if len(ordered) % 2:
                return ordered[middle]
            return (ordered[middle - 1] + ordered[middle]) / 2

        profit_base = median(profit_growth)
        revenue_base = median(revenue_growth)
        latest_profit = safe_number(
            company_financial_inputs.get("latestProfitGrowth")
        )
        latest_revenue = safe_number(
            company_financial_inputs.get("latestRevenueGrowth")
        )
        if profit_base is None:
            profit_base = latest_profit
        if revenue_base is None:
            revenue_base = latest_revenue
        if profit_base is None and revenue_base is None:
            base_growth = 0.0
        elif profit_base is None:
            base_growth = revenue_base
        elif revenue_base is None:
            base_growth = profit_base
        else:
            base_growth = profit_base * 0.6 + revenue_base * 0.4
        base_growth = clipped(base_growth, -20, 25)
        growth_samples = profit_growth + revenue_growth
        if len(growth_samples) >= 2:
            mean_growth = sum(growth_samples) / len(growth_samples)
            growth_dispersion = (
                sum((value - mean_growth) ** 2 for value in growth_samples)
                / len(growth_samples)
            ) ** 0.5
        else:
            growth_dispersion = 8.0
        growth_dispersion = clipped(growth_dispersion, 5, 20)

        current_per_share = current_price / current_multiple
        scenarios = []
        for key, label, direction in [
            ("bear", "悲观", -1),
            ("base", "基准", 0),
            ("bull", "乐观", 1),
        ]:
            scenario_growth = clipped(
                base_growth + direction * growth_dispersion,
                -35,
                40,
            )
            target_multiple = (
                own_percentiles[key] + industry_percentiles[key]
            ) / 2
            target_multiple = min(
                max(target_multiple, current_multiple * 0.7),
                current_multiple * 1.3,
            )
            if direction < 0:
                target_multiple = min(target_multiple, current_multiple)
            elif direction == 0:
                target_multiple = min(
                    target_multiple,
                    current_multiple * 1.15,
                )
            else:
                target_multiple = max(target_multiple, current_multiple)
            if use_pb:
                target_multiple = clipped(target_multiple, 0.2, 5)
                future_per_share = current_per_share * (
                    1 + scenario_growth / 100
                )
            else:
                target_multiple = clipped(target_multiple, 3, 150)
                future_per_share = current_per_share * (
                    1 + scenario_growth / 100
                )
            target_price = future_per_share * target_multiple
            scenarios.append(
                {
                    "key": key,
                    "label": label,
                    "targetPrice": round(target_price, 2),
                    "upside": round(
                        (target_price / current_price - 1) * 100, 2
                    ),
                    "multiple": round(target_multiple, 2),
                    "growth": round(scenario_growth, 2),
                    "perShare": round(future_per_share, 4),
                }
            )

        scenario_valuation = {
            "method": method,
            "methodLabel": method_label,
            "industryName": level_one_name,
            "currentPrice": current_price,
            "currentMultiple": round(current_multiple, 2),
            "baseGrowth": round(base_growth, 2),
            "industryPeerCount": len(industry_values),
            "valuationDate": latest_valuation_date.strftime("%Y-%m-%d"),
            "ownPercentiles": {
                key: round(value, 2)
                for key, value in own_percentiles.items()
                if value is not None
            },
            "industryPercentiles": {
                key: round(value, 2)
                for key, value in industry_percentiles.items()
                if value is not None
            },
            "scenarios": scenarios,
            "assumption": (
                "基准增速取近三年年度营收与利润增速的加权中位数，"
                "悲观和乐观按历史增速波动展开；目标估值取公司自身近三年"
                f"分位与{level_one_name}行业分位的均值，并限制在当前"
                "估值倍数的0.7～1.3倍。"
            ),
            "sources": ["东方财富估值历史", "东方财富行业成分与估值"],
        }
    except Exception:
        scenario_valuation = None

payload = {
    "code": clean(row.get("SECUCODE")),
    "name": clean(row.get("SECURITY_NAME_ABBR")),
    "fullName": clean(row.get("ORG_NAME")),
    "englishName": clean(row.get("ORG_NAME_EN")),
    "formerName": clean(row.get("FORMERNAME")),
    "exchange": clean(row.get("TRADE_MARKET")),
    "securityType": clean(row.get("SECURITY_TYPE")),
    "industry": clean(row.get("BOARD_NAME_LEVEL") or row.get("EM2016")),
    "csrcIndustry": clean(row.get("INDUSTRYCSRC1")),
    "actualController": clean(row.get("ACTUAL_HOLDER")),
    "chairman": clean(row.get("CHAIRMAN")),
    "president": clean(row.get("PRESIDENT")),
    "legalPerson": clean(row.get("LEGAL_PERSON")),
    "secretary": clean(row.get("SECRETARY")),
    "foundedDate": date_value(row.get("FOUND_DATE")),
    "listingDate": date_value(row.get("LISTING_DATE")),
    "registeredCapital": row.get("REG_CAPITAL"),
    "employees": row.get("EMP_NUM"),
    "website": clean(row.get("ORG_WEB")),
    "phone": clean(row.get("ORG_TEL")),
    "email": clean(row.get("ORG_EMAIL")),
    "registeredAddress": clean(row.get("REG_ADDRESS")),
    "officeAddress": clean(row.get("ADDRESS")),
    "mainBusiness": clean(row.get("MAIN_BUSINESS")),
    "businessScope": clean(row.get("BUSINESS_SCOPE")),
    "profile": clean(row.get("ORG_PROFILE")),
    "industryPath": industry_path,
    "concepts": concepts,
    "conceptRelevanceVersion": 4,
    "highlights": highlights,
    "bankValuation": bank_valuation,
    "scenarioValuation": scenario_valuation,
    "valuationVersion": 4,
    "market": market_data,
    "financials": financials,
    "sourceDate": datetime.now().strftime("%Y-%m-%d"),
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
'''


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fetch_company_info.py <security-code>", file=sys.stderr)
        return 2

    security_code = sys.argv[1].upper()
    parts = security_code.split(".")
    if (
        len(parts) != 2
        or len(parts[0]) != 6
        or not parts[0].isdigit()
        or parts[1] not in {"SH", "SZ", "BJ"}
    ):
        print("invalid security code", file=sys.stderr)
        return 2

    root = Path(__file__).resolve().parent
    try:
        industry_board_map = {}
        try:
            flow_payload = json.loads(
                (root / "industry_flow_cache.json").read_text(encoding="utf-8")
            )
            industry_board_map = {
                item["name"]: item["boardCode"]
                for item in flow_payload.get("industries", [])
                if item.get("name") and item.get("boardCode")
            }
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            industry_board_map = {}
        board_argument = base64.b64encode(
            json.dumps(
                industry_board_map,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).decode("ascii")
        result = run_script(
            REMOTE_SCRIPT,
            (security_code, board_argument),
            timeout=120,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"Company profile fetch failed: {exc}", file=sys.stderr)
        return 1

    cache_dir = root / "company_info_cache"
    cache_dir.mkdir(exist_ok=True)
    output = cache_dir / f"{parts[0]}.{parts[1].lower()}.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {output} for {payload.get('name') or security_code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
