#!/usr/bin/env python3
"""
LDS Hymn Cross-Reference Scraper
=================================
Scrapes the four language hymnal pages on churchofjesuschrist.org and produces
a single JSON file containing:

  hymns    — per-language dict of {num: {title, url}}
  crossRef — dict keyed by English URL slug → {eng, esp, por, fra} numbers

Requirements:
    pip install playwright
    playwright install chromium

Usage:
    # Fully automatic (headless) — works well for English:
    python scrape_hymns.py

    # Headed + interactive — browser stays visible; press Enter in the terminal
    # once the hymn list is fully loaded for each language:
    python scrape_hymns.py --headed

    # Save debug screenshots and HTML for each language:
    python scrape_hymns.py --headed --debug

    # Custom output path:
    python scrape_hymns.py --output my_hymns.json
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright, Page
except ImportError:
    print("Playwright not found.  Install it with:")
    print("    pip install playwright")
    print("    playwright install chromium")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

LANGUAGES = [
    # key  = label used in output JSON (native-language abbreviation)
    # lang = query-string value used on the website
    {"key": "ENG", "lang": "eng"},
    {"key": "ESP", "lang": "spa"},   # español — site uses 'spa' in URLs
    {"key": "POR", "lang": "por"},
    {"key": "FRA", "lang": "fra"},   # français — key and URL lang both 'fra'
]

BASE_URL = "https://www.churchofjesuschrist.org"

# Two parallel collections to scrape and merge.
#   - "hymns": the traditional hymnal (numbers vary by language)
#   - "hymns-for-home-and-church": the new common-numbered collection
#     (guaranteed to use the same hymn numbers across all languages)
COLLECTIONS = [
    {"key": "hymns",      "url": f"{BASE_URL}/media/music/collections/hymns"},
    {"key": "hfhc",       "url": f"{BASE_URL}/media/music/collections/hymns-for-home-and-church"},
]

SONG_RE        = re.compile(r"/media/music/songs/([^/?#]+)")
HYMN_NUM_RE    = re.compile(r"^\d+[a-z]?$", re.IGNORECASE)

# "{num}. {title}" as confirmed from live DOM
# e.g. "30. Saint, Saint, notre Sauveur"  or  "127a. Douce nuit! (Version suisse)"
ENTRY_RE = re.compile(r"^(\d+[a-z]?)\.\s+(.+)$", re.IGNORECASE | re.DOTALL)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def song_url(slug: str, lang: str) -> str:
    return f"{BASE_URL}/media/music/songs/{slug}?lang={lang}"


async def wait_for_user(prompt: str) -> None:
    """Async-friendly input() — suspends the event loop while waiting."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: input(prompt))


async def scroll_until_stable(page: Page, lang_key: str) -> None:
    """
    Scroll to the bottom repeatedly until the number of song links stops
    increasing.  Used in headless (automatic) mode.
    """
    prev_count = 0
    for cycle in range(80):
        links = await page.query_selector_all("a[href*='/media/music/songs/']")
        count = len(links)

        if cycle > 0 and count == prev_count:
            break
        prev_count = count

        # Try a "Load more" / "Show more" button first
        load_more = await page.query_selector(
            "button:has-text('more'), button:has-text('More'), "
            "button:has-text('Show'), button[class*='load']"
        )
        if load_more:
            try:
                await load_more.scroll_into_view_if_needed()
                await load_more.click()
                await page.wait_for_load_state("networkidle", timeout=20_000)
                continue
            except Exception:
                pass

        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(2.0)

    final = await page.query_selector_all("a[href*='/media/music/songs/']")
    print(f"  → {len(final)} song links found")


async def load_language(page: Page, lang: dict, collection_url: str, headed: bool) -> None:
    """
    Navigate to the given collection page for *lang* and wait until all
    hymns are visible.

    headed=False  — automatic: scroll/click until stable
    headed=True   — interactive: browser stays open; user presses Enter when ready
    """
    url = f"{collection_url}?lang={lang['lang']}"
    print(f"\n[{lang['key']}] Loading {url}")

    if headed:
        # Navigate and let the user watch the page load naturally
        await page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        print(f"  Browser is open.  Scroll / wait until all hymns are visible.")
        await wait_for_user("  Press Enter when the hymn list is fully loaded… ")
    else:
        # Headless: navigate, wait for network idle, then scroll to load all
        await page.goto(url, wait_until="networkidle", timeout=90_000)
        try:
            await page.wait_for_selector(
                "a[href*='/media/music/songs/']", timeout=30_000
            )
        except Exception:
            print(f"  [WARN] No song links appeared after 30s for {lang['key']}.")
            return
        await scroll_until_stable(page, lang["key"])


async def extract_hymns(page: Page, lang: dict, collection_key: str, debug: bool) -> list[dict]:
    """
    Parse all hymn links on the currently loaded page.
    DOM structure (confirmed from live page):
        <a href="/media/music/songs/{slug}?…&lang={code}">
          <h4><div>{num}. {title}</div></h4>
        </a>
    Returns a list of {num, title, slug, url, collection} dicts sorted by
    hymn number. The "hymns-for-home-and-church" collection numbers from
    1001+, so numbers never collide with the original "hymns" collection.
    """
    if debug:
        shot = f"debug_{collection_key}_{lang['key']}.png"
        html = f"debug_{collection_key}_{lang['key']}.html"
        await page.screenshot(path=shot, full_page=True)
        Path(html).write_text(await page.content(), encoding="utf-8")
        print(f"  [debug] saved {shot} and {html}")

    links = await page.query_selector_all("a[href*='/media/music/songs/']")
    print(f"  → parsing {len(links)} links…")

    seen_nums: set[str] = set()
    hymns: list[dict] = []

    for link in links:
        href = await link.get_attribute("href")
        if not href:
            continue
        m = SONG_RE.search(href)
        if not m:
            continue
        slug = m.group(1)

        # Primary selector: h4 > div contains "{num}. {title}"
        heading = await link.query_selector("h4 div")
        if heading:
            raw = (await heading.inner_text()).strip()
        else:
            raw = (await link.inner_text()).strip()

        raw = re.sub(r"\s+", " ", raw)

        num   = None
        title = None

        m2 = ENTRY_RE.match(raw)
        if m2:
            num   = m2.group(1)
            title = m2.group(2).strip()
        else:
            # Fallback: "127a Title" without a period
            parts = raw.split(" ", 1)
            if len(parts) == 2 and HYMN_NUM_RE.match(parts[0].rstrip(".")):
                num   = parts[0].rstrip(".")
                title = parts[1].strip()

        if not num or not title:
            continue
        if num in seen_nums:
            continue
        seen_nums.add(num)

        hymns.append({
            "num":        num,
            "title":      title,
            "slug":       slug,
            "url":        song_url(slug, lang["lang"]),
            "collection": collection_key,
        })

    # Sort: numeric part first, then optional letter suffix
    def sort_key(h):
        m = re.match(r"(\d+)([a-z]?)", h["num"], re.IGNORECASE)
        return (int(m.group(1)), m.group(2).lower()) if m else (0, "")

    hymns.sort(key=sort_key)
    print(f"  → extracted {len(hymns)} hymns")
    return hymns


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def scrape(output_path: Path, headed: bool, debug: bool) -> None:
    # all_hymns[collection_key][lang_key] = list of hymn dicts
    all_hymns: dict[str, dict[str, list[dict]]] = {}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=not headed)
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        page = await ctx.new_page()

        if headed:
            # Open to a sensible size so the user can see the page clearly
            await page.set_viewport_size({"width": 1280, "height": 900})

        for collection in COLLECTIONS:
            ck = collection["key"]
            all_hymns[ck] = {}
            for lang in LANGUAGES:
                try:
                    await load_language(page, lang, collection["url"], headed)
                    hymns = await extract_hymns(page, lang, ck, debug)
                    all_hymns[ck][lang["key"]] = hymns
                except Exception as exc:
                    print(f"  [ERROR] {ck}/{lang['key']}: {exc}")
                    all_hymns[ck][lang["key"]] = []

        await browser.close()

    # -----------------------------------------------------------------------
    # Build output JSON
    # -----------------------------------------------------------------------

    # 1. Per-language hymn dicts {num: {title, url}}, merged across collections.
    #    Numbers don't collide: "hymns" uses 1-3xx, "hfhc" uses 1001+.
    hymns_out: dict[str, dict] = {}
    for lang in LANGUAGES:
        k = lang["key"]
        merged: dict[str, dict] = {}
        for collection in COLLECTIONS:
            for h in all_hymns[collection["key"]].get(k, []):
                merged[h["num"]] = {"title": h["title"], "url": h["url"]}
        hymns_out[k] = merged

    # 2. slug -> num maps per language, merged across collections
    slug_maps: dict[str, dict[str, str]] = {lang["key"]: {} for lang in LANGUAGES}
    for collection in COLLECTIONS:
        for lang in LANGUAGES:
            for h in all_hymns[collection["key"]].get(lang["key"], []):
                slug_maps[lang["key"]][h["slug"]] = h["num"]

    # 3. Cross-reference keyed by English slug
    #    '*' = hymn not present in that language's collection
    all_slugs: set[str] = set()
    for lang in LANGUAGES:
        all_slugs.update(slug_maps[lang["key"]].keys())

    cross_ref: dict[str, dict] = {}
    for slug in sorted(all_slugs):
        cross_ref[slug] = {
            lang["key"].lower(): slug_maps[lang["key"]].get(slug, "*")
            for lang in LANGUAGES
        }

    output = {
        "hymns":    hymns_out,
        "crossRef": cross_ref,
    }

    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # -----------------------------------------------------------------------
    # Summary
    # -----------------------------------------------------------------------
    print(f"\n{'='*52}")
    print(f"Output: {output_path.resolve()}")
    print(f"{'='*52}")
    for collection in COLLECTIONS:
        ck = collection["key"]
        print(f"  [{ck}]")
        for lang in LANGUAGES:
            n = len(all_hymns[ck].get(lang["key"], []))
            print(f"    {lang['key']}: {n} hymns")
    print(f"  --- merged totals ---")
    for lang in LANGUAGES:
        k = lang["key"]
        print(f"  {k}: {len(hymns_out.get(k, {}))} hymns")

    all_four = sum(
        1 for e in cross_ref.values() if all(v != "*" for v in e.values())
    )
    print(f"  Cross-reference slugs total : {len(cross_ref)}")
    print(f"  Present in all four languages: {all_four}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape LDS hymn cross-references from churchofjesuschrist.org"
    )
    parser.add_argument(
        "--output", "-o",
        default="hymns-data.json",
        help="Output JSON file path (default: hymns-data.json)",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help=(
            "Run with a visible browser.  After navigating to each language page "
            "the script pauses — scroll until all hymns are visible, then press "
            "Enter in this terminal to trigger extraction."
        ),
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Save a full-page screenshot and raw HTML for each language.",
    )
    args = parser.parse_args()

    asyncio.run(scrape(Path(args.output), args.headed, args.debug))


if __name__ == "__main__":
    main()