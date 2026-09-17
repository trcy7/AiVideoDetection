"""Prove the frontend<->backend wiring WITHOUT uploading a clip.

    python verify_deploy.py --backend https://<domain>.ngrok-free.dev \
                            --frontend https://<app>.vercel.app

Reproduces exactly what a browser does before it will let an upload through, so
a clean run means the real thing will work. Stdlib only -- runs anywhere.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request

SKIP = {"ngrok-skip-browser-warning": "true"}
results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "", hint: str = "") -> bool:
    """detail is informational (always shown); hint explains a failure only."""
    results.append((ok, label))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if detail:
        print(f"         {detail}")
    if hint and not ok:
        print(f"         -> {hint}")
    return ok


def _open(url: str, headers: dict, method: str = "GET"):
    req = urllib.request.Request(url, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=30)


def check_backend(backend: str) -> None:
    print("\n1. Backend reachable and model loaded")
    try:
        with _open(f"{backend}/health", SKIP) as r:
            body = r.read().decode()
    except urllib.error.HTTPError as e:
        # ngrok answers for the domain even with no agent behind it, so a bare
        # status code misleads -- its own error code says what is actually wrong.
        code = e.headers.get("Ngrok-Error-Code", "")
        hints = {
            "ERR_NGROK_3200": "tunnel is OFFLINE -- no agent connected. "
                              "Rerun the Kaggle notebook (Run All).",
            "ERR_NGROK_6024": "ngrok interstitial -- skip header not honoured.",
            "ERR_NGROK_108": "another agent already holds this domain; "
                             "stop the old session.",
        }
        check(False, "GET /health", f"HTTP {e.code} {code}".strip(),
              hint=hints.get(code, "backend did not answer"))
        return
    except Exception as e:
        check(False, "GET /health", f"{type(e).__name__}: {e}",
              hint="DNS/network failure -- is the domain spelled correctly?")
        return
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        # The classic free-tier failure: HTML interstitial instead of the API.
        check(False, "GET /health returned JSON",
              "Got HTML -- ngrok interstitial. The skip header is missing or ignored.")
        return
    check(True, "GET /health returned JSON")
    check(payload.get("bands") is not None, "model is loaded (bands present)",
          f"bands={payload.get('bands')}")
    check(payload.get("storage") is True, "audit trail enabled",
          hint="storage is off -- /feedback will return 503")


def check_cors(backend: str, origin: str) -> None:
    """The preflight a browser sends before POST /analyze. This is the check
    that catches a wrong ALLOWED_ORIGINS -- the one failure that leaves the
    backend looking perfectly healthy while every upload dies."""
    print(f"\n2. CORS preflight from {origin}")
    headers = {**SKIP, "Origin": origin,
               "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "ngrok-skip-browser-warning"}
    try:
        with _open(f"{backend}/analyze", headers, method="OPTIONS") as r:
            allow = r.headers.get("access-control-allow-origin")
    except urllib.error.HTTPError as e:
        allow = e.headers.get("access-control-allow-origin")
    except Exception as e:
        check(False, "preflight completed", f"{type(e).__name__}: {e}")
        return
    check(allow == origin, "origin is allowed",
          f"access-control-allow-origin={allow!r}",
          hint="set ALLOWED_ORIGINS to this exact origin, then RESTART THE KERNEL")

    print("\n3. CORS rejects an unknown origin (not wide open)")
    bad = {**SKIP, "Origin": "https://evil.invalid",
           "Access-Control-Request-Method": "POST"}
    try:
        with _open(f"{backend}/analyze", bad, method="OPTIONS") as r:
            leaked = r.headers.get("access-control-allow-origin")
    except urllib.error.HTTPError as e:
        leaked = e.headers.get("access-control-allow-origin")
    except Exception:
        leaked = None
    check(leaked in (None, ""), "unknown origin refused", f"got {leaked!r}")


def check_frontend(frontend: str, backend: str) -> None:
    """VITE_* values are COMPILED IN at build time, so the deployed bundle is
    the only honest record of whether Vercel actually picked them up."""
    print(f"\n4. Deployed bundle points at the backend")
    try:
        with _open(frontend, {}) as r:
            html = r.read().decode("utf-8", "replace")
    except Exception as e:
        check(False, "frontend reachable", f"{type(e).__name__}: {e}")
        return
    check(True, "frontend reachable")

    # Guard against grading the WRONG site: a typo'd domain, a parked project,
    # or Vercel's login wall all return a cheerful 200 with unrelated HTML.
    title = re.search(r"<title>([^<]*)</title>", html, re.I)
    title_text = (title.group(1).strip() if title else "")
    if "login" in title_text.lower() and "vercel" in title_text.lower():
        check(False, "page is the app, not a login wall", f"title={title_text!r}",
              hint="Deployment Protection is on -- disable it, or this URL is not public")
        return
    if not check("ecnet" in html.lower() or "ecnet" in title_text.lower(),
                 "page identifies as ECNet", f"title={title_text!r}",
                 hint="this domain serves a DIFFERENT app -- check the URL"):
        return

    srcs = re.findall(r'<script[^>]+src="([^"]+\.js)"', html)
    if not srcs:
        check(False, "found a JS bundle to inspect")
        return
    # Vite code-splits: the entry bundle only *references* the route chunks, so
    # inspecting <script src> alone misses the code that calls the backend.
    # Follow /assets/*.js references one level deep to see the whole app.
    seen: set[str] = set()
    js = ""

    def fetch(path: str) -> str:
        url = path if path.startswith("http") else frontend.rstrip("/") + "/" + path.lstrip("/")
        if url in seen:
            return ""
        try:
            with _open(url, {}) as r:
                text = r.read().decode("utf-8", "replace")
        except Exception:
            return ""
        seen.add(url)   # only count what we actually read
        return text

    for s in srcs:
        js += fetch(s)
    for chunk in set(re.findall(r"assets/[A-Za-z0-9._-]+\.js", js)):
        js += fetch(chunk)
    print(f"         inspected {len(seen)} JS file(s)")

    host = backend.split("://")[-1].rstrip("/")
    check(host in js, "bundle contains the backend URL",
          hint="Vercel built without VITE_BACKEND_URL -- set it and REDEPLOY")
    check("localhost:8000" not in js, "bundle has no localhost fallback baked in",
          hint="the build fell back to the default; the env var was not applied")
    check("ngrok-skip-browser-warning" in js, "bundle sends the ngrok skip header",
          hint="the realBackend.ts change is not in this deploy")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backend", required=True)
    ap.add_argument("--frontend", help="deployed origin; also used for the CORS check")
    ap.add_argument("--origin", help="override the origin tested against CORS")
    a = ap.parse_args()

    backend = a.backend.rstrip("/")
    origin = (a.origin or a.frontend or "").rstrip("/")

    check_backend(backend)
    if origin:
        check_cors(backend, origin)
    if a.frontend:
        check_frontend(a.frontend.rstrip("/"), backend)

    failed = [l for ok, l in results if not ok]
    print("\n" + "=" * 62)
    print(f"  {len(results) - len(failed)}/{len(results)} passed")
    for l in failed:
        print(f"  FAILED: {l}")
    print("=" * 62)
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
