#!/usr/bin/env python3
"""Serve the dashboard and refresh its upstream data when the page opens."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")

ROOT = Path(__file__).resolve().parent
DATA_JSON = ROOT / "data.json"
FETCH_SCRIPT = ROOT / "fetch_sw_trends.py"
FETCH_LEVEL2_SCRIPT = ROOT / "fetch_level2_parent.py"
FETCH_COMPANIES_SCRIPT = ROOT / "fetch_industry_companies.py"
FETCH_COMPANY_INFO_SCRIPT = ROOT / "fetch_company_info.py"
FETCH_COMPANY_DIRECTORY_SCRIPT = ROOT / "fetch_company_directory.py"
FETCH_INDUSTRY_FLOW_SCRIPT = ROOT / "fetch_industry_flow.py"
FETCH_MARKET_PULSE_SCRIPT = ROOT / "fetch_market_pulse.py"
FETCH_INDUSTRY_FUND_HISTORY_SCRIPT = ROOT / "fetch_industry_fund_history.py"
FETCH_LEVEL2_FLOW_SCRIPT = ROOT / "fetch_level2_stock_flow.py"
FETCH_CONCEPT_STOCKS_SCRIPT = ROOT / "fetch_concept_stocks.py"
FETCH_CONCEPT_HEAT_SCRIPT = ROOT / "fetch_concept_heat.py"
FETCH_CONCEPT_HOTSPOT_SCRIPT = ROOT / "fetch_concept_hotspot.py"
FETCH_CONCEPT_INTRADAY_FLOW_SCRIPT = ROOT / "fetch_concept_intraday_flow.py"
FETCH_CONCEPT_ROTATION_SCRIPT = ROOT / "fetch_concept_rotation.py"
FETCH_EVENT_THEMES_SCRIPT = ROOT / "fetch_event_themes.py"
LEVEL2_CACHE_DIR = ROOT / "level2_cache"
COMPANIES_CACHE_DIR = ROOT / "companies_cache"
COMPANY_INFO_CACHE_DIR = ROOT / "company_info_cache"
COMPANY_DIRECTORY_FILE = ROOT / "company_directory.json"
INDUSTRY_FLOW_CACHE_FILE = ROOT / "industry_flow_cache.json"
MARKET_PULSE_CACHE_FILE = ROOT / "market_pulse_cache.json"
INDUSTRY_FUND_HISTORY_CACHE_FILE = ROOT / "industry_fund_history_cache.json"
LEVEL2_FLOW_CACHE_DIR = ROOT / "level2_flow_cache"
CONCEPT_STOCK_CACHE_DIR = ROOT / "concept_stock_cache"
CONCEPT_HEAT_CACHE_FILE = ROOT / "concept_heat_cache.json"
CONCEPT_HOTSPOT_CACHE_FILE = ROOT / "concept_hotspot_cache.json"
CONCEPT_INTRADAY_FLOW_CACHE_FILE = ROOT / "concept_intraday_flow_cache.json"
CONCEPT_ROTATION_CACHE_FILE = ROOT / "concept_rotation_cache.json"
EVENT_THEME_CACHE_FILE = ROOT / "event_theme_cache.json"
try:
    from zoneinfo import ZoneInfo

    SHANGHAI = ZoneInfo("Asia/Shanghai")
except Exception:
    from datetime import timezone

    SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")
REFRESH_COOLDOWN_SECONDS = 300
INDUSTRY_FLOW_COOLDOWN_SECONDS = 30
MARKET_PULSE_COOLDOWN_SECONDS = 60
CONCEPT_ROTATION_COOLDOWN_SECONDS = 300
COMPANY_LIST_COOLDOWN_SECONDS = 120

refresh_lock = threading.Lock()
last_attempt_at = 0.0
last_error: str | None = None
industry_flow_lock = threading.Lock()
last_industry_flow_attempt = 0.0
last_industry_flow_error: str | None = None
market_pulse_lock = threading.Lock()
last_market_pulse_attempt = 0.0
last_market_pulse_error: str | None = None
industry_fund_history_lock = threading.Lock()
last_industry_fund_history_attempt = 0.0
last_industry_fund_history_error: str | None = None
level2_flow_attempts: dict[str, float] = {}
level2_flow_errors: dict[str, str | None] = {}
level2_flow_locks: dict[str, threading.Lock] = {}
level2_flow_lock_guard = threading.Lock()
concept_stock_attempts: dict[str, float] = {}
concept_stock_errors: dict[str, str | None] = {}
concept_stock_locks: dict[str, threading.Lock] = {}
concept_stock_lock_guard = threading.Lock()
concept_heat_lock = threading.Lock()
last_concept_heat_attempt = 0.0
last_concept_heat_error: str | None = None
concept_hotspot_lock = threading.Lock()
last_concept_hotspot_attempt = 0.0
last_concept_hotspot_error: str | None = None
concept_intraday_flow_lock = threading.Lock()
last_concept_intraday_flow_attempt = 0.0
last_concept_intraday_flow_error: str | None = None
concept_rotation_lock = threading.Lock()
last_concept_rotation_attempt = 0.0
last_concept_rotation_error: str | None = None
event_theme_lock = threading.Lock()
last_event_theme_attempt = 0.0
last_event_theme_error: str | None = None
level2_attempts: dict[str, float] = {}
level2_errors: dict[str, str | None] = {}
level2_locks: dict[str, threading.Lock] = {}
level2_lock_guard = threading.Lock()
company_attempts: dict[str, float] = {}
company_errors: dict[str, str | None] = {}
company_locks: dict[str, threading.Lock] = {}
company_lock_guard = threading.Lock()
company_info_locks: dict[str, threading.Lock] = {}
company_info_lock_guard = threading.Lock()
company_directory_lock = threading.Lock()


def target_market_date(now: datetime) -> date:
    """Approximate the latest completed mainland trading date."""
    target = now.date()
    while target.weekday() >= 5:
        target -= timedelta(days=1)
    if target == now.date() and now.hour < 16:
        target -= timedelta(days=1)
        while target.weekday() >= 5:
            target -= timedelta(days=1)
    return target


def latest_quote_date(now: datetime) -> date:
    """Return the trading date whose intraday quote should be displayed."""
    target = now.date()
    while target.weekday() >= 5:
        target -= timedelta(days=1)
    if target == now.date() and (
        now.hour < 9 or (now.hour == 9 and now.minute < 15)
    ):
        target -= timedelta(days=1)
        while target.weekday() >= 5:
            target -= timedelta(days=1)
    return target


def is_market_hours(now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return (555 <= minutes <= 695) or (775 <= minutes <= 915)


def read_data() -> dict | None:
    try:
        return json.loads(DATA_JSON.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_data(force: bool = False) -> tuple[dict | None, bool, str | None]:
    global last_attempt_at, last_error
    with refresh_lock:
        now = datetime.now(SHANGHAI)
        target = target_market_date(now)
        cached = read_data()
        cached_source_date = cached.get("sourceDate") if cached else None
        recently_attempted = time.monotonic() - last_attempt_at < REFRESH_COOLDOWN_SECONDS
        needs_refresh = (
            force
            or cached is None
            or (
                not recently_attempted
                and (cached_source_date is None or cached_source_date < target.isoformat())
            )
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_attempt_at = time.monotonic()
            try:
                result = subprocess.run(
                    [sys.executable, str(FETCH_SCRIPT)],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=300,
                    check=False,
                )
                if result.returncode != 0:
                    last_error = (result.stderr or result.stdout or "data refresh failed").strip()
                else:
                    last_error = None
            except (OSError, subprocess.TimeoutExpired) as exc:
                last_error = str(exc)
        return read_data(), attempted, last_error


def read_industry_flow() -> dict | None:
    try:
        return json.loads(INDUSTRY_FLOW_CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_industry_flow() -> tuple[dict | None, bool, str | None]:
    global last_industry_flow_attempt, last_industry_flow_error
    with industry_flow_lock:
        cached = read_industry_flow()
        recently_attempted = (
            time.monotonic() - last_industry_flow_attempt
            < INDUSTRY_FLOW_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if INDUSTRY_FLOW_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - INDUSTRY_FLOW_CACHE_FILE.stat().st_mtime
                < INDUSTRY_FLOW_COOLDOWN_SECONDS
            )
        needs_refresh = cached is None or (
            not recently_attempted and not cache_is_fresh
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_industry_flow_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_INDUSTRY_FLOW_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=150,
                check=False,
            )
            if result.returncode != 0:
                last_industry_flow_error = (
                    result.stderr or result.stdout or "industry flow refresh failed"
                ).strip()
            else:
                last_industry_flow_error = None
        return (
            read_industry_flow(),
            attempted,
            last_industry_flow_error,
        )


def read_market_pulse() -> dict | None:
    try:
        return json.loads(MARKET_PULSE_CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_market_pulse(
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    global last_market_pulse_attempt, last_market_pulse_error
    with market_pulse_lock:
        cached = read_market_pulse()
        recently_attempted = (
            time.monotonic() - last_market_pulse_attempt
            < MARKET_PULSE_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if MARKET_PULSE_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - MARKET_PULSE_CACHE_FILE.stat().st_mtime
                < MARKET_PULSE_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_market_pulse_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_MARKET_PULSE_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=210,
                check=False,
            )
            if result.returncode != 0:
                last_market_pulse_error = (
                    result.stderr
                    or result.stdout
                    or "market pulse refresh failed"
                ).strip()
            else:
                last_market_pulse_error = None
        return (
            read_market_pulse(),
            attempted,
            last_market_pulse_error,
        )


def read_industry_fund_history() -> dict | None:
    try:
        return json.loads(
            INDUSTRY_FUND_HISTORY_CACHE_FILE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_industry_fund_history() -> tuple[dict | None, bool, str | None]:
    global last_industry_fund_history_attempt, last_industry_fund_history_error
    with industry_fund_history_lock:
        cached = read_industry_fund_history()
        recently_attempted = (
            time.monotonic() - last_industry_fund_history_attempt
            < CONCEPT_ROTATION_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if INDUSTRY_FUND_HISTORY_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - INDUSTRY_FUND_HISTORY_CACHE_FILE.stat().st_mtime
                < CONCEPT_ROTATION_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_industry_fund_history_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_INDUSTRY_FUND_HISTORY_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                last_industry_fund_history_error = (
                    result.stderr
                    or result.stdout
                    or "industry fund history refresh failed"
                ).strip()
            else:
                last_industry_fund_history_error = None
        return (
            read_industry_fund_history(),
            attempted,
            last_industry_fund_history_error,
        )


def read_level2_flow(industry_code: str) -> dict | None:
    try:
        return json.loads(
            (LEVEL2_FLOW_CACHE_DIR / f"{industry_code}.json").read_text(
                encoding="utf-8"
            )
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_level2_flow(
    industry_code: str,
    *,
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    with level2_flow_lock_guard:
        flow_lock = level2_flow_locks.setdefault(industry_code, threading.Lock())
    with flow_lock:
        cached = read_level2_flow(industry_code)
        recently_attempted = (
            time.monotonic() - level2_flow_attempts.get(industry_code, 0.0)
            < INDUSTRY_FLOW_COOLDOWN_SECONDS
        )
        cache_file = LEVEL2_FLOW_CACHE_DIR / f"{industry_code}.json"
        cache_is_fresh = False
        if cache_file.exists():
            cache_is_fresh = (
                time.time() - cache_file.stat().st_mtime
                < INDUSTRY_FLOW_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        error = level2_flow_errors.get(industry_code)
        if needs_refresh:
            attempted = True
            level2_flow_attempts[industry_code] = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_LEVEL2_FLOW_SCRIPT), industry_code],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                error = (
                    result.stderr
                    or result.stdout
                    or "level-2 stock flow refresh failed"
                ).strip()
            else:
                error = None
            level2_flow_errors[industry_code] = error
        return read_level2_flow(industry_code), attempted, error


def concept_cache_path(query: str) -> Path:
    normalized = re.sub(r"\s+", "", query).lower()
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:20]
    return CONCEPT_STOCK_CACHE_DIR / f"{digest}.json"


def read_concept_stocks(query: str) -> dict | None:
    try:
        return json.loads(concept_cache_path(query).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_concept_stocks(
    query: str,
    *,
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    key = re.sub(r"\s+", "", query).lower()
    with concept_stock_lock_guard:
        query_lock = concept_stock_locks.setdefault(key, threading.Lock())
    with query_lock:
        cached = read_concept_stocks(query)
        recently_attempted = (
            time.monotonic() - concept_stock_attempts.get(key, 0.0)
            < INDUSTRY_FLOW_COOLDOWN_SECONDS
        )
        cache_file = concept_cache_path(query)
        cache_is_fresh = False
        if cache_file.exists():
            cache_is_fresh = (
                time.time() - cache_file.stat().st_mtime
                < INDUSTRY_FLOW_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        error = concept_stock_errors.get(key)
        if needs_refresh:
            attempted = True
            concept_stock_attempts[key] = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_CONCEPT_STOCKS_SCRIPT), query],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                error = (
                    result.stderr
                    or result.stdout
                    or "concept stock refresh failed"
                ).strip()
            else:
                error = None
            concept_stock_errors[key] = error
        return read_concept_stocks(query), attempted, error


def read_concept_heat() -> dict | None:
    try:
        return json.loads(CONCEPT_HEAT_CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_concept_heat(force: bool = False) -> tuple[dict | None, bool, str | None]:
    global last_concept_heat_attempt, last_concept_heat_error
    with concept_heat_lock:
        cached = read_concept_heat()
        recently_attempted = (
            time.monotonic() - last_concept_heat_attempt
            < INDUSTRY_FLOW_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if CONCEPT_HEAT_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - CONCEPT_HEAT_CACHE_FILE.stat().st_mtime
                < INDUSTRY_FLOW_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_concept_heat_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_CONCEPT_HEAT_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                last_concept_heat_error = (
                    result.stderr
                    or result.stdout
                    or "concept heat refresh failed"
                ).strip()
            else:
                last_concept_heat_error = None
        return read_concept_heat(), attempted, last_concept_heat_error


def read_concept_hotspot() -> dict | None:
    try:
        return json.loads(
            CONCEPT_HOTSPOT_CACHE_FILE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_concept_hotspot(
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    global last_concept_hotspot_attempt, last_concept_hotspot_error
    with concept_hotspot_lock:
        cached = read_concept_hotspot()
        recently_attempted = (
            time.monotonic() - last_concept_hotspot_attempt
            < CONCEPT_ROTATION_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if CONCEPT_HOTSPOT_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - CONCEPT_HOTSPOT_CACHE_FILE.stat().st_mtime
                < CONCEPT_ROTATION_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_concept_hotspot_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_CONCEPT_HOTSPOT_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                last_concept_hotspot_error = (
                    result.stderr
                    or result.stdout
                    or "concept hotspot refresh failed"
                ).strip()
            else:
                last_concept_hotspot_error = None
        return (
            read_concept_hotspot(),
            attempted,
            last_concept_hotspot_error,
        )


def read_concept_intraday_flow() -> dict | None:
    try:
        return json.loads(
            CONCEPT_INTRADAY_FLOW_CACHE_FILE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_concept_intraday_flow(
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    global last_concept_intraday_flow_attempt, last_concept_intraday_flow_error
    with concept_intraday_flow_lock:
        cached = read_concept_intraday_flow()
        recently_attempted = (
            time.monotonic() - last_concept_intraday_flow_attempt
            < INDUSTRY_FLOW_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if CONCEPT_INTRADAY_FLOW_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - CONCEPT_INTRADAY_FLOW_CACHE_FILE.stat().st_mtime
                < INDUSTRY_FLOW_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_concept_intraday_flow_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_CONCEPT_INTRADAY_FLOW_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=240,
                check=False,
            )
            if result.returncode != 0:
                last_concept_intraday_flow_error = (
                    result.stderr
                    or result.stdout
                    or "concept intraday flow refresh failed"
                ).strip()
            else:
                last_concept_intraday_flow_error = None
        return (
            read_concept_intraday_flow(),
            attempted,
            last_concept_intraday_flow_error,
        )


def read_concept_rotation() -> dict | None:
    try:
        return json.loads(
            CONCEPT_ROTATION_CACHE_FILE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_concept_rotation(
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    global last_concept_rotation_attempt, last_concept_rotation_error
    with concept_rotation_lock:
        cached = read_concept_rotation()
        recently_attempted = (
            time.monotonic() - last_concept_rotation_attempt
            < CONCEPT_ROTATION_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if CONCEPT_ROTATION_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - CONCEPT_ROTATION_CACHE_FILE.stat().st_mtime
                < CONCEPT_ROTATION_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_concept_rotation_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_CONCEPT_ROTATION_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=300,
                check=False,
            )
            if result.returncode != 0:
                last_concept_rotation_error = (
                    result.stderr
                    or result.stdout
                    or "concept rotation refresh failed"
                ).strip()
            else:
                last_concept_rotation_error = None
        return (
            read_concept_rotation(),
            attempted,
            last_concept_rotation_error,
        )


def read_event_themes() -> dict | None:
    try:
        return json.loads(
            EVENT_THEME_CACHE_FILE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_event_themes(
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    global last_event_theme_attempt, last_event_theme_error
    with event_theme_lock:
        cached = read_event_themes()
        recently_attempted = (
            time.monotonic() - last_event_theme_attempt
            < CONCEPT_ROTATION_COOLDOWN_SECONDS
        )
        cache_is_fresh = False
        if EVENT_THEME_CACHE_FILE.exists():
            cache_is_fresh = (
                time.time() - EVENT_THEME_CACHE_FILE.stat().st_mtime
                < CONCEPT_ROTATION_COOLDOWN_SECONDS
            )
        needs_refresh = (
            cached is None
            or force
            or (not recently_attempted and not cache_is_fresh)
        )
        attempted = False
        if needs_refresh:
            attempted = True
            last_event_theme_attempt = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_EVENT_THEMES_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=300,
                check=False,
            )
            if result.returncode != 0:
                last_event_theme_error = (
                    result.stderr
                    or result.stdout
                    or "event theme refresh failed"
                ).strip()
            else:
                last_event_theme_error = None
        return (
            read_event_themes(),
            attempted,
            last_event_theme_error,
        )


def read_level2(parent_code: str) -> dict | None:
    try:
        return json.loads(
            (LEVEL2_CACHE_DIR / f"{parent_code}.json").read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_level2(parent_code: str) -> tuple[dict | None, bool, str | None]:
    with level2_lock_guard:
        parent_lock = level2_locks.setdefault(parent_code, threading.Lock())
    with parent_lock:
        now = datetime.now(SHANGHAI)
        target = target_market_date(now)
        cached = read_level2(parent_code)
        recently_attempted = (
            time.monotonic() - level2_attempts.get(parent_code, 0.0)
            < REFRESH_COOLDOWN_SECONDS
        )
        needs_refresh = (
            cached is None
            or (
                not recently_attempted
                and cached.get("sourceDate", "") < target.isoformat()
            )
        )
        attempted = False
        error = level2_errors.get(parent_code)
        if needs_refresh:
            attempted = True
            level2_attempts[parent_code] = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_LEVEL2_SCRIPT), parent_code],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=300,
                check=False,
            )
            if result.returncode != 0:
                error = (result.stderr or result.stdout or "level-2 refresh failed").strip()
            else:
                error = None
            level2_errors[parent_code] = error
        return read_level2(parent_code), attempted, error


def read_companies(industry_code: str) -> dict | None:
    try:
        return json.loads(
            (COMPANIES_CACHE_DIR / f"{industry_code}.json").read_text(
                encoding="utf-8"
            )
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_companies(
    industry_code: str,
    *,
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    with company_lock_guard:
        industry_lock = company_locks.setdefault(industry_code, threading.Lock())
    with industry_lock:
        now = datetime.now(SHANGHAI)
        target = latest_quote_date(now)
        cached = read_companies(industry_code)
        recently_attempted = (
            time.monotonic() - company_attempts.get(industry_code, 0.0)
            < COMPANY_LIST_COOLDOWN_SECONDS
        )
        cache_file = COMPANIES_CACHE_DIR / f"{industry_code}.json"
        cache_age = (
            time.time() - cache_file.stat().st_mtime
            if cache_file.exists()
            else None
        )
        needs_refresh = (
            cached is None
            or force
            or (
                not recently_attempted
                and (
                    str(cached.get("sourceDate") or "") < target.isoformat()
                    or (
                        is_market_hours(now)
                        and (cache_age is None or cache_age > 120)
                    )
                )
            )
        )
        attempted = False
        error = company_errors.get(industry_code)
        if needs_refresh:
            attempted = True
            company_attempts[industry_code] = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(FETCH_COMPANIES_SCRIPT), industry_code],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=180,
                check=False,
            )
            if result.returncode != 0:
                error = (result.stderr or result.stdout or "company refresh failed").strip()
            else:
                error = None
            company_errors[industry_code] = error
        return read_companies(industry_code), attempted, error


def read_company_info(security_code: str) -> dict | None:
    code, market = security_code.upper().split(".", 1)
    try:
        return json.loads(
            (COMPANY_INFO_CACHE_DIR / f"{code}.{market.lower()}.json").read_text(
                encoding="utf-8"
            )
        )
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def refresh_company_info(
    security_code: str,
    *,
    force: bool = False,
) -> tuple[dict | None, bool, str | None]:
    normalized = security_code.upper()
    with company_info_lock_guard:
        info_lock = company_info_locks.setdefault(normalized, threading.Lock())
    with info_lock:
        cached = read_company_info(normalized)
        now = datetime.now(SHANGHAI)
        target = latest_quote_date(now)
        cache_file = (
            COMPANY_INFO_CACHE_DIR
            / f"{normalized.split('.', 1)[0]}.{normalized.split('.', 1)[1].lower()}.json"
        )
        cache_age = (
            time.time() - cache_file.stat().st_mtime
            if cache_file.exists()
            else None
        )
        cached_market_date = (
            str((cached or {}).get("market", {}).get("asOf") or "")[:10]
        )
        cache_has_required_fields = (
            cached is not None
            and "market" in cached
            and "financials" in cached
            and "industryPath" in cached
            and "concepts" in cached
            and cached.get("conceptRelevanceVersion") == 4
            and cached.get("valuationVersion") == 4
        )
        stale_intraday = (
            cache_has_required_fields
            and is_market_hours(now)
            and (cache_age is None or cache_age > 120)
        )
        if (
            cache_has_required_fields
            and not force
            and cached_market_date >= target.isoformat()
            and not stale_intraday
        ):
            return cached, False, None
        result = subprocess.run(
            [sys.executable, str(FETCH_COMPANY_INFO_SCRIPT), normalized],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
            check=False,
        )
        error = None
        if result.returncode != 0:
            error = (result.stderr or result.stdout or "company profile failed").strip()
        return read_company_info(normalized), True, error


def read_company_directory() -> list[dict]:
    try:
        payload = json.loads(COMPANY_DIRECTORY_FILE.read_text(encoding="utf-8"))
        companies = payload.get("companies")
        return companies if isinstance(companies, list) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def search_companies(query: str) -> list[dict]:
    with company_directory_lock:
        companies = read_company_directory()
        needs_refresh = (
            not companies
            or COMPANY_DIRECTORY_FILE.stat().st_mtime
            < time.time() - 24 * 60 * 60
        )
        if needs_refresh:
            result = subprocess.run(
                [sys.executable, str(FETCH_COMPANY_DIRECTORY_SCRIPT)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=180,
                check=False,
            )
            if result.returncode == 0:
                companies = read_company_directory()

    normalized = query.strip().lower().replace(".", "")
    if not normalized:
        return []

    matches = []
    for item in companies:
        name = str(item.get("name") or "")
        code = str(item.get("stockCode") or "")
        full_code = str(item.get("code") or "")
        name_lower = name.lower()
        code_lower = code.lower()
        full_code_lower = full_code.lower().replace(".", "")
        if (
            normalized not in name_lower
            and normalized not in code_lower
            and normalized not in full_code_lower
        ):
            continue
        score = (
            0
            if code_lower == normalized or full_code_lower == normalized
            else 1
            if name_lower.startswith(normalized)
            else 2
            if code_lower.startswith(normalized) or full_code_lower.startswith(normalized)
            else 3
        )
        matches.append((score, item))
    matches.sort(key=lambda pair: (pair[0], pair[1].get("stockCode", "")))
    return [item for _, item in matches[:16]]


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/data":
            query = parse_qs(parsed.query)
            force = query.get("force", ["0"])[0] == "1"
            data, attempted, error = refresh_data(force=force)
            if data is None:
                self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, error or "No cached data")
                return
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Source-Date", str(data.get("sourceDate") or ""))
            self.send_header(
                "X-Target-Date",
                target_market_date(datetime.now(SHANGHAI)).isoformat(),
            )
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/status":
            body = json.dumps(
                {
                    "cachedDate": (read_data() or {}).get("sourceDate"),
                    "lastError": last_error,
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/industry-flow":
            data, attempted, error = refresh_industry_flow()
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No industry flow data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/market-pulse":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_market_pulse(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No market pulse data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/industry-fund-history":
            data, attempted, error = refresh_industry_fund_history()
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No industry fund history data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/concept-heat":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_concept_heat(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No concept heat data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/concept-hotspot":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_concept_hotspot(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No concept hotspot data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/concept-intraday-flow":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_concept_intraday_flow(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No concept intraday flow data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/concept-rotation":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_concept_rotation(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No concept rotation data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/event-themes":
            query = parse_qs(parsed.query)
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            data, attempted, error = refresh_event_themes(force=force)
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No event theme data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/concept-stocks":
            query = parse_qs(parsed.query)
            concept_query = " ".join(query.get("q", [""])).strip()
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            if not concept_query or len(concept_query) > 40:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid concept query")
                return
            data, attempted, error = refresh_concept_stocks(
                concept_query,
                force=force,
            )
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No concept stock data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/level2-stock-flow":
            query = parse_qs(parsed.query)
            industry_code = query.get("industry", [""])[0]
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            if not industry_code.isdigit() or len(industry_code) != 6:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid industry code")
                return
            known_level2 = {
                item.get("code")
                for item in (read_data() or {}).get("subIndustries", [])
            }
            if industry_code not in known_level2:
                self.send_error(HTTPStatus.BAD_REQUEST, "Unknown level-2 industry")
                return
            data, attempted, error = refresh_level2_flow(
                industry_code,
                force=force,
            )
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No level-2 stock flow data",
                )
                return
            body = json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Quote-Time", str(data.get("quoteTime") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/level2":
            query = parse_qs(parsed.query)
            parent_code = query.get("parent", [""])[0]
            if not parent_code.isdigit() or len(parent_code) != 6:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid parent code")
                return
            data, attempted, error = refresh_level2(parent_code)
            if data is None:
                self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, error or "No level-2 data")
                return
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Source-Date", str(data.get("sourceDate") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/companies":
            query = parse_qs(parsed.query)
            industry_code = query.get("industry", [""])[0]
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            if not industry_code.isdigit() or len(industry_code) != 6:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid industry code")
                return
            data, attempted, error = refresh_companies(
                industry_code,
                force=force,
            )
            if data is None:
                self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, error or "No company data")
                return
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header("X-Source-Date", str(data.get("sourceDate") or ""))
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/company-info":
            query = parse_qs(parsed.query)
            security_code = query.get("code", [""])[0].upper()
            force = query.get("refresh", [""])[0].lower() in {
                "1",
                "true",
                "yes",
            }
            code, _, market = security_code.partition(".")
            if (
                len(code) != 6
                or not code.isdigit()
                or market not in {"SH", "SZ", "BJ"}
            ):
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid security code")
                return
            data, attempted, error = refresh_company_info(
                security_code,
                force=force,
            )
            if data is None:
                self.send_error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    error or "No company profile",
                )
                return
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Refresh-Attempted", str(attempted).lower())
            self.send_header(
                "X-Quote-Date",
                str((data.get("market") or {}).get("asOf") or ""),
            )
            if error:
                self.send_header("X-Refresh-Error", "1")
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/company-search":
            query = parse_qs(parsed.query)
            term = query.get("q", [""])[0].strip()
            if not term:
                self.send_error(HTTPStatus.BAD_REQUEST, "Missing query")
                return
            companies = search_companies(term)
            body = json.dumps(
                {"query": term, "companies": companies},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main() -> None:
    port = int(os.environ.get("SW_TREND_PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), DashboardHandler)
    print(f"Serving http://127.0.0.1:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
