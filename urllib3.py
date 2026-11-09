"""Minimal urllib3 compatibility used by the bundled data fetchers."""

from __future__ import annotations

from types import SimpleNamespace


class InsecureRequestWarning(Warning):
    """Compatibility type for urllib3's TLS warning."""


def disable_warnings(*_args, **_kwargs) -> None:
    """The bundled fetchers explicitly request unverified TLS."""


exceptions = SimpleNamespace(InsecureRequestWarning=InsecureRequestWarning)
