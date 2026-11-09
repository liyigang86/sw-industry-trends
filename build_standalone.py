#!/usr/bin/env python3
"""Build a single-file offline dashboard from the local data caches."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def script_json(value) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).replace("</", "<\\/")


def collect_cache(directory: Path) -> dict:
    return {
        path.stem: read_json(path)
        for path in sorted(directory.glob("*.json"))
    }


def normalize_concept(value: str) -> str:
    return re.sub(r"\s+", "", str(value or "").strip()).lower()


def main() -> None:
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    styles = (ROOT / "styles.css").read_text(encoding="utf-8")
    app = (ROOT / "app.js").read_text(encoding="utf-8")
    data = read_json(ROOT / "data.json")
    company_directory = read_json(ROOT / "company_directory.json").get(
        "companies", []
    )

    company_info = {
        code.upper(): payload
        for code, payload in collect_cache(ROOT / "company_info_cache").items()
    }
    concept_stocks = {
        normalize_concept(payload.get("query")): payload
        for payload in collect_cache(ROOT / "concept_stock_cache").values()
        if payload.get("query")
    }
    standalone = {
        "companyDirectory": company_directory,
        "level2": collect_cache(ROOT / "level2_cache"),
        "level2Flow": collect_cache(ROOT / "level2_flow_cache"),
        "conceptStocks": concept_stocks,
        "conceptHeat": read_json(ROOT / "concept_heat_cache.json"),
        "conceptHotspot": read_json(ROOT / "concept_hotspot_cache.json"),
        "conceptIntradayFlow": read_json(
            ROOT / "concept_intraday_flow_cache.json"
        ),
        "eventThemes": read_json(ROOT / "event_theme_cache.json"),
        "conceptRotation": read_json(ROOT / "concept_rotation_cache.json"),
        "marketPulse": read_json(ROOT / "market_pulse_cache.json"),
        "companies": collect_cache(ROOT / "companies_cache"),
        "companyInfo": company_info,
        "industryFlow": read_json(ROOT / "industry_flow_cache.json"),
        "industryFundHistory": read_json(
            ROOT / "industry_fund_history_cache.json"
        ),
    }

    index = index.replace(
        '    <link rel="stylesheet" href="styles.css?v=20261109-marketpulse2">',
        f"    <style>\n{styles}\n    </style>",
    )
    index = index.replace(
        "  <script src=\"data.js\"></script>\n"
        "  <script src=\"bootstrap.js?v=20261109-marketpulse2\"></script>",
        "  <script>\n"
        f"    window.SW_TREND_DATA = {script_json(data)};\n"
        f"    window.SW_STANDALONE = {script_json(standalone)};\n"
        "    document.getElementById(\"refresh-status\").textContent = "
        "\"离线单文件版\";\n"
        f"{app}\n"
        "  </script>",
    )
    index = index.replace(
        "<title>申万一级行业趋势</title>",
        "<title>申万一级行业趋势 · 离线版</title>",
    )

    output = ROOT / "industry-dashboard.html"
    output.write_text(index, encoding="utf-8")
    print(
        f"Wrote {output} "
        f"({output.stat().st_size / 1024 / 1024:.2f} MB, "
        f"{len(standalone['level2'])} level-2 groups, "
        f"{len(standalone['level2Flow'])} level-2 flow snapshots, "
        f"{len(concept_stocks)} concept snapshots, "
        f"{len(company_info)} company details)"
    )


if __name__ == "__main__":
    main()
