"""Run data-source scripts locally or through an optional SSH host."""

from __future__ import annotations

import os
import subprocess
import sys


def _child_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _command(args: tuple[str, ...]) -> list[str]:
    host = os.environ.get("SW_FETCH_HOST", "").strip()
    if host:
        return ["ssh", host, "python3", "-", *args]
    return [sys.executable, "-", *args]


def run_script(
    script: str,
    args: tuple[str, ...] = (),
    *,
    timeout: int,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _command(args),
        input=script,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=timeout,
        check=True,
        env=_child_env(),
    )


def popen_script(
    script: str,
    args: tuple[str, ...] = (),
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        _command(args),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=_child_env(),
    )
