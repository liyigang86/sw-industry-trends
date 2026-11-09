"""Small zero-dependency subset of requests used by the data fetchers.

The dashboard's fetch scripts run in a separate Python process and only need
GET requests, JSON/text responses and a Session object.  Keeping this local
module in the release means the service can start without pip or network
access to PyPI.  A real ``requests`` package is still preferred when the
fetcher is launched on a configured SSH helper host.
"""

from __future__ import annotations

import gzip
import json as json_module
import ssl
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse, urlunparse
from urllib.request import Request, build_opener, HTTPSHandler


class Response:
    def __init__(self, raw, url: str):
        self._raw = raw
        self.url = url
        self.status_code = int(getattr(raw, "status", 200))
        self.headers = raw.headers
        data = raw.read()
        if (self.headers.get("Content-Encoding") or "").lower() == "gzip":
            data = gzip.decompress(data)
        self.content = data
        charset = self.headers.get_content_charset() or "utf-8"
        try:
            self.text = data.decode(charset, "replace")
        except LookupError:
            self.text = data.decode("utf-8", "replace")

    def json(self):
        return json_module.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise HTTPError(
                self.url,
                self.status_code,
                f"HTTP {self.status_code}",
                self.headers,
                None,
            )


def _build_url(url: str, params) -> str:
    if not params:
        return url
    parsed = urlparse(url)
    query = urlencode(params, doseq=True)
    existing = parsed.query
    final_query = f"{existing}&{query}" if existing else query
    return urlunparse(parsed._replace(query=final_query))


def _request(
    method: str,
    url: str,
    *,
    params=None,
    headers=None,
    timeout=30,
    verify=True,
    **_kwargs,
) -> Response:
    final_url = _build_url(url, params)
    request = Request(final_url, headers=headers or {}, method=method)
    context = None
    if verify is False:
        context = ssl._create_unverified_context()
    opener = build_opener(HTTPSHandler(context=context)) if context else build_opener()
    try:
        raw = opener.open(request, timeout=timeout)
    except HTTPError as exc:
        raw = exc
    return Response(raw, final_url)


class Session:
    def __init__(self):
        self.headers = {}

    def get(self, url: str, **kwargs) -> Response:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", None) or {})
        return _request("GET", url, headers=headers, **kwargs)

    def post(self, url: str, **kwargs) -> Response:
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", None) or {})
        data = kwargs.pop("data", None)
        if data is not None and not isinstance(data, bytes):
            if isinstance(data, (dict, list)):
                data = json_module.dumps(data).encode("utf-8")
            else:
                data = str(data).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
        final_url = _build_url(url, kwargs.pop("params", None))
        request = Request(final_url, data=data, headers=headers, method="POST")
        context = None
        if kwargs.get("verify") is False:
            context = ssl._create_unverified_context()
        opener = build_opener(HTTPSHandler(context=context)) if context else build_opener()
        try:
            raw = opener.open(request, timeout=kwargs.get("timeout", 30))
        except HTTPError as exc:
            raw = exc
        return Response(raw, final_url)


def get(url: str, **kwargs) -> Response:
    return _request("GET", url, **kwargs)


def post(url: str, **kwargs) -> Response:
    return Session().post(url, **kwargs)
