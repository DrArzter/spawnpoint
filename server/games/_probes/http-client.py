#!/usr/bin/env python3
"""Minimal HTTP client for a game's probe and save calls (ADR-0076).

Standard library only. One request to a game's own HTTP API on this host,
with HTTP basic authentication, and the response body printed as it came:

    http-client.py GET  http://127.0.0.1:<port>/<path>
    http-client.py POST http://127.0.0.1:<port>/<path> [<json body>]

The user and the password come from HTTP_PROBE_USER and HTTP_PROBE_PASSWORD,
never from the command line, which every user of the host can read. The
password travels in clear text, so only a loopback address is accepted, and
a redirect is refused rather than followed with the credentials.

Exit codes: 0 printed, 2 usage, 3 no answer, 4 an answer this client does
not take (a status other than 2xx, a redirect, a body that is too large).
The probe treats every non-zero as "unavailable", which the watchdog counts
as not-empty: fail closed.
"""

import base64
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Looking the host up yields a fixed address, so no caller-supplied host
# reaches the request (SSRF guard).
LOOPBACK_HOSTS = {"127.0.0.1": "127.0.0.1", "::1": "[::1]", "localhost": "127.0.0.1"}
MAX_BODY_BYTES = 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 5


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def usage() -> int:
    print("usage: http-client.py GET|POST http://127.0.0.1:<port>/<path> [<json body>]", file=sys.stderr)
    return 2


def fail(code: int, message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return code


def read_settings():
    """Return (method, url, body, user, password, timeout), or an exit code."""
    if len(sys.argv) not in (3, 4):
        return usage()
    method, url = sys.argv[1], sys.argv[2]
    body = sys.argv[3] if len(sys.argv) == 4 else None
    if method not in ("GET", "POST") or (method == "GET" and body is not None):
        return usage()
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS or parsed.port is None:
        return fail(2, "only http on a loopback address and an explicit port is accepted")
    user = os.environ.get("HTTP_PROBE_USER", "")
    password = os.environ.get("HTTP_PROBE_PASSWORD", "")
    if not user or not password:
        return fail(2, "HTTP_PROBE_USER and HTTP_PROBE_PASSWORD must be set")
    try:
        timeout = float(os.environ.get("HTTP_PROBE_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    except ValueError:
        return usage()
    # Plain http is deliberate: the address is loopback, so nothing leaves the host.
    url = f"http://{LOOPBACK_HOSTS[parsed.hostname]}:{parsed.port}{parsed.path}"  # NOSONAR
    if parsed.query:
        url += f"?{parsed.query}"
    return method, url, body, user, password, timeout


def build_request(method: str, url: str, user: str, password: str):
    request = urllib.request.Request(url, method=method)
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    request.add_header("Authorization", f"Basic {token}")
    request.add_header("Accept", "application/json")
    if method == "POST":
        request.add_header("Content-Type", "application/json")
    return request


def main() -> int:
    settings = read_settings()
    if isinstance(settings, int):
        return settings
    method, url, body, user, password, timeout = settings
    request = build_request(method, url, user, password)
    data = (body or "").encode("utf-8") if method == "POST" else None

    # No proxy: an http_proxy in the environment would carry the password off the host.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    try:
        with opener.open(request, data=data, timeout=timeout) as response:
            content = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        return fail(4, f"http status {error.code}")
    except OSError as error:  # URLError, timeouts and connection errors
        return fail(3, f"http request failed: {error}")
    if len(content) > MAX_BODY_BYTES:
        return fail(4, "response body is too large")
    sys.stdout.write(content.decode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
