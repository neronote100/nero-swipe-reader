#!/usr/bin/env python3
"""Optional real Chromium smoke test; all note HTTP responses are synthetic.

Run after `npm run build:chrome` with Python Playwright installed:
  python tests/chrome-browser-smoke.py
Use --probe to check only whether this host can launch Chromium. Exit code 2
means browser verification was not executed, and must not be reported as a pass.
This script opens a mocked note tab first and attaches a synthetic HttpOnly
Cookie. Every API request must originate in that note tab, rather than in the
extension page. It never signs in to or contacts a real note account.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.parse import parse_qs, urlparse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--extension", default="dist/chrome-members")
    parser.add_argument("--chromium", default=shutil.which("chromium"))
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("NOT RUN: optional Python Playwright dependency is unavailable", file=sys.stderr)
        return 2
    if not args.chromium:
        print("NOT RUN: Chromium executable is unavailable", file=sys.stderr)
        return 2

    extension = Path(args.extension).resolve()
    if not args.probe and not (extension / "manifest.json").is_file():
        print("NOT RUN: build the Chrome extension first", file=sys.stderr)
        return 2
    flags = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crashpad-for-testing"]
    if not args.probe:
        flags += [f"--disable-extensions-except={extension}", f"--load-extension={extension}"]
    posts, unexpected, liked, api_realms = [], [], {"n0", "n1", "n2"}, []

    def note_response(route):
        request = route.request
        url = urlparse(request.url)
        if url.scheme in ("chrome-extension", "data"):
            route.continue_()
            return
        if url.hostname != "note.com":
            route.abort()
            return
        if not url.path.startswith("/api/"):
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><meta charset=utf-8><title>note fixture</title><h1>Signed-in note fixture</h1>")
            return
        frame_url = request.frame.url
        headers = request.all_headers()
        has_cookie = "nero_fixture_session=synthetic" in headers.get("cookie", "")
        api_realms.append((frame_url, has_cookie))
        if urlparse(frame_url).hostname != "note.com" or not has_cookie:
            unexpected.append(("wrong request realm or missing session", frame_url))
            route.fulfill(status=401, content_type="application/json", body='{"error":"same-origin session required"}')
            return
        payload = None
        if url.path == "/api/v2/current_user":
            payload = {"data": {"key": "alice-key", "urlname": "alice"}}
        elif url.path == "/api/v2/creators/writer_a/contents":
            page = int(parse_qs(url.query)["page"][0])
            rows = [{"key": f"n{i}", "name": f"Source {i}",
                     "publishAt": f"2026-10-{31-i:02d}T00:00:00Z",
                     "user": {"urlname": "writer_a", "nickname": "Writer A"},
                     "noteUrl": f"https://note.com/writer_a/n/n{i}"}
                    for i in range(6)] if page == 1 else []
            payload = {"data": {"contents": rows}}
        elif re.fullmatch(r"/api/v3/notes/n[\w-]+", url.path):
            key = url.path.rsplit("/", 1)[1]
            linked = key == "nlinked"
            payload = {"data": {"key": key, "name": "Linked fixture" if linked else f"Source {key[1:]}",
                       "user": {"urlname": "writer_b" if linked else "writer_a", "nickname": "Fixture author"},
                       "body": "<p>Linked body</p>" if linked else '<p>Fixture body</p><figure data-src="https://note.com/embed/notes/nlinked"></figure><a href="https://external.invalid/">External fixture</a>',
                       "description": "Synthetic note card", "is_liked": key in liked}}
        elif request.method == "POST":
            posts.append((url.path, request.post_data))
            if url.path.endswith("/likes"):
                liked.add(url.path.split("/")[-2])
                payload = {"data": {}}
            elif url.path == "/api/v3/notes/nlinked/note_comments":
                payload = {"data": {"key": "fixture-comment"}}
        if payload is None:
            unexpected.append((request.method, url.path))
            route.fulfill(status=500, content_type="application/json", body='{"error":"unhandled fixture"}')
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

    with tempfile.TemporaryDirectory(prefix="nero-chrome-smoke-") as profile:
        with sync_playwright() as playwright:
            try:
                context = playwright.chromium.launch_persistent_context(
                    profile, executable_path=args.chromium, headless=not args.headed,
                    ignore_default_args=["--disable-extensions"], args=flags, timeout=15000)
            except Exception as error:
                print("NOT RUN: Chromium could not start on this host", file=sys.stderr)
                print(str(error)[:5000], file=sys.stderr)
                return 2
            try:
                if args.probe:
                    page = context.new_page()
                    page.goto("data:text/html,<h1>browser-ready</h1>")
                    assert page.locator("h1").inner_text() == "browser-ready"
                    print("chromium-probe-ok: browser started; extension tests were not requested")
                    return 0
                context.route("**/*", note_response)
                context.add_cookies([{"name": "nero_fixture_session", "value": "synthetic", "url": "https://note.com", "httpOnly": True, "secure": True, "sameSite": "Lax"}])
                note_page = context.new_page()
                note_page.goto("https://note.com/fixture")
                manifest = json.loads((extension / "manifest.json").read_text())
                digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
                extension_id = "".join(chr(ord("a") + int(char, 16)) for char in digest)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"chrome-extension://{extension_id}/reader/index.html")
                page.wait_for_function("document.querySelector('#account').textContent === '接続中 @alice'")
                page.locator("#watchInput").fill("writer_a")
                page.locator("#watchForm button").click()
                page.locator("#refreshFeed").click()
                page.wait_for_function("document.querySelector('#position').textContent === '1 / 3'")
                card = page.locator("#body .article-link-card").first
                card.wait_for()
                page.wait_for_function("document.querySelector('.article-link-card-title').textContent === 'Linked fixture'")
                source_title = page.locator("#title").inner_text()
                card.click()
                page.wait_for_function("document.querySelector('#title').textContent === 'Linked fixture'")
                page.locator("#like").click()
                page.wait_for_function("document.querySelector('#like').textContent === '♥ スキ済み'")
                assert any(path == "/api/v3/notes/nlinked/likes" for path, _ in posts)
                page.locator("#articleComment").click()
                page.locator("#draft").fill("Synthetic Chromium comment")
                page.locator("#send").click()
                page.wait_for_function("document.querySelector('#sendStatus').textContent.includes('送信しました')")
                assert any(path == "/api/v3/notes/nlinked/note_comments" for path, _ in posts)
                page.locator("#articleBack").click()
                page.wait_for_function("expected => document.querySelector('#title').textContent === expected", arg=source_title)
                assert page.locator("#position").inner_text() == "1 / 3"
                assert not errors, errors
                assert not unexpected, unexpected
                assert api_realms and all(urlparse(origin).hostname == "note.com" and cookie for origin, cookie in api_realms), api_realms
                print("chrome-browser-smoke-ok: note-tab same-origin fetch with synthetic HttpOnly session, actual extension startup/CSP, unliked backfill, card preview, internal navigation/back, guarded article like and comment (all HTTP mocked)")
                return 0
            finally:
                context.close()


if __name__ == "__main__":
    sys.exit(main())
