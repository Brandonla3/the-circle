#!/usr/bin/env python3
"""
NCAA Division I Softball Stats Scraper
Scrapes all Individual and Team statistics from ncaa.com.
Designed to run nightly via cron / GitHub Actions and overwrite the
canonical data file at data/ncaa/stats.json. The Next.js /api/player-stats
route reads from that file as its primary data source.

Requirements:
    pip install requests beautifulsoup4 lxml
"""

import csv
import json
import logging
import os
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

# ── Configuration ─────────────────────────────────────────────────────────────
# Stable, repo-relative output path so the nightly commit overwrites a single
# file instead of accumulating one per run. Override with NCAA_OUT_DIR if you
# want to dump elsewhere when running locally.
OUTPUT_DIR = os.environ.get("NCAA_OUT_DIR", "data/ncaa")
OUTPUT_JSON = os.environ.get("NCAA_OUT_JSON", "stats.json")
WRITE_CSV = os.environ.get("NCAA_WRITE_CSV", "").lower() in ("1", "true", "yes")

DELAY_BETWEEN_REQUESTS = 0.5
MAX_RETRIES = 3
LOG_FILE = os.environ.get("NCAA_LOG_FILE", "ncaa_scraper.log")

BASE_URL = "https://www.ncaa.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

# ── All stat categories (discovered from ncaa.com dropdowns) ─────────────────
INDIVIDUAL_STATS = [
    ("Assists",                        "/stats/softball/d1/current/individual/1301"),
    ("Assists Per Game",               "/stats/softball/d1/current/individual/1302"),
    ("Batting Average",                "/stats/softball/d1/current/individual/271"),
    ("Caught Stealing By",             "/stats/softball/d1/current/individual/1270"),
    ("Complete Games",                 "/stats/softball/d1/current/individual/1231"),
    ("Doubles",                        "/stats/softball/d1/current/individual/1086"),
    ("Doubles Per Game",               "/stats/softball/d1/current/individual/274"),
    ("Earned Run Average",             "/stats/softball/d1/current/individual/276"),
    ("Games Started",                  "/stats/softball/d1/current/individual/1232"),
    ("Hit Batters",                    "/stats/softball/d1/current/individual/594"),
    ("Hit By Pitch",                   "/stats/softball/d1/current/individual/1235"),
    ("Hit by Pitch per Game",          "/stats/softball/d1/current/individual/414"),
    ("Hits",                           "/stats/softball/d1/current/individual/592"),
    ("Hits Allowed Per Seven Innings", "/stats/softball/d1/current/individual/413"),
    ("Home Runs",                      "/stats/softball/d1/current/individual/514"),
    ("Home Runs Per Game",             "/stats/softball/d1/current/individual/278"),
    ("Innings Pitched",                "/stats/softball/d1/current/individual/1233"),
    ("On Base Percentage",             "/stats/softball/d1/current/individual/280"),
    ("Pitching Appearances",           "/stats/softball/d1/current/individual/1236"),
    ("RBIs",                           "/stats/softball/d1/current/individual/593"),
    ("Runs",                           "/stats/softball/d1/current/individual/591"),
    ("Runs Batted In Per Game",        "/stats/softball/d1/current/individual/284"),
    ("Runs per Game",                  "/stats/softball/d1/current/individual/285"),
    ("Sacrifice Bunts per game",       "/stats/softball/d1/current/individual/286"),
    ("Sacrifice Flies",                "/stats/softball/d1/current/individual/1238"),
    ("Saves",                          "/stats/softball/d1/current/individual/1234"),
    ("Shutouts",                       "/stats/softball/d1/current/individual/1245"),
    ("Slugging Percentage",            "/stats/softball/d1/current/individual/288"),
    ("Stolen Base Percentage",         "/stats/softball/d1/current/individual/1269"),
    ("Stolen Bases",                   "/stats/softball/d1/current/individual/590"),
    ("Stolen Bases Per Game",          "/stats/softball/d1/current/individual/291"),
    ("Strikeout-to-Walk Ratio",        "/stats/softball/d1/current/individual/412"),
    ("Strikeouts",                     "/stats/softball/d1/current/individual/596"),
    ("Strikeouts Per Seven Innings",   "/stats/softball/d1/current/individual/411"),
    ("Total Bases",                    "/stats/softball/d1/current/individual/595"),
    ("Toughest to Strike Out",         "/stats/softball/d1/current/individual/293"),
    ("Triples",                        "/stats/softball/d1/current/individual/1087"),
    ("Triples Per Game",               "/stats/softball/d1/current/individual/295"),
    ("Victories",                      "/stats/softball/d1/current/individual/1246"),
    ("WHIP",                           "/stats/softball/d1/current/individual/1237"),
    ("Walks Allowed Per Seven Innings","/stats/softball/d1/current/individual/409"),
    ("Walks Per Game",                 "/stats/softball/d1/current/individual/297"),
]

TEAM_STATS = [
    ("Batting Average",                 "/stats/softball/d1/current/team/281"),
    ("Double Plays",                    "/stats/softball/d1/current/team/1225"),
    ("Double Plays per Game",           "/stats/softball/d1/current/team/350"),
    ("Doubles",                         "/stats/softball/d1/current/team/1224"),
    ("Doubles per Game",                "/stats/softball/d1/current/team/346"),
    ("Earned Run Average",              "/stats/softball/d1/current/team/282"),
    ("Fielding Percentage",             "/stats/softball/d1/current/team/283"),
    ("Hit Batters",                     "/stats/softball/d1/current/team/595"),
    ("Hit By Pitch",                    "/stats/softball/d1/current/team/1234"),
    ("Hits",                            "/stats/softball/d1/current/team/1229"),
    ("Hits Allowed Per Seven Innings",  "/stats/softball/d1/current/team/1230"),
    ("Home Runs",                       "/stats/softball/d1/current/team/1228"),
    ("Home Runs per game",              "/stats/softball/d1/current/team/345"),
    ("On Base Percentage",              "/stats/softball/d1/current/team/354"),
    ("RBIs Per Game",                   "/stats/softball/d1/current/team/1300"),
    ("Runs Batted In",                  "/stats/softball/d1/current/team/1226"),
    ("Scoring",                         "/stats/softball/d1/current/team/357"),
    ("Shutouts",                        "/stats/softball/d1/current/team/1227"),
    ("Slugging Percentage",             "/stats/softball/d1/current/team/358"),
    ("Stolen Bases per Game",           "/stats/softball/d1/current/team/361"),
    ("Strikeout-to-Walk Ratio",         "/stats/softball/d1/current/team/1188"),
    ("Team Strikeouts Per Seven Innings","/stats/softball/d1/current/team/363"),
    ("Total Runs",                      "/stats/softball/d1/current/team/1221"),
    ("Total Sacrifice Bunts",           "/stats/softball/d1/current/team/1222"),
    ("Total Sacrifice Flies",           "/stats/softball/d1/current/team/1223"),
    ("Total Stolen Bases",              "/stats/softball/d1/current/team/1220"),
    ("Triple Plays",                    "/stats/softball/d1/current/team/1246"),
    ("Triples",                         "/stats/softball/d1/current/team/1219"),
    ("Triples per Game",                "/stats/softball/d1/current/team/366"),
    ("WHIP",                            "/stats/softball/d1/current/team/367"),
    ("WL Percentage",                   "/stats/softball/d1/current/team/368"),
    ("Walks",                           "/stats/softball/d1/current/team/1223"),
]

# ── Logging setup ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


# ── Core scraping functions ───────────────────────────────────────────────────
def fetch_page(url: str):
    """Fetch a URL and return a BeautifulSoup object, with retries."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "lxml")
        except requests.RequestException as e:
            log.warning(f"Attempt {attempt}/{MAX_RETRIES} failed for {url}: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)
    log.error(f"All retries exhausted for {url}")
    return None


def get_max_page(soup) -> int:
    """Find the highest page number in the pagination links."""
    max_page = 1
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/p" in href:
            parts = href.rsplit("/p", 1)
            if len(parts) == 2 and parts[1].isdigit():
                max_page = max(max_page, int(parts[1]))
    return max_page


def parse_table(soup):
    """Extract headers and rows from the stats table."""
    table = soup.find("table")
    if not table:
        return [], []

    thead = table.find("thead")
    headers = [th.get_text(strip=True) for th in thead.find_all("th")] if thead else []

    rows = []
    tbody = table.find("tbody")
    if tbody:
        for tr in tbody.find_all("tr"):
            cells = [td.get_text(strip=True) for td in tr.find_all("td")]
            if cells:
                rows.append(cells)

    return headers, rows


def scrape_stat_category(name: str, path: str) -> dict:
    """Scrape all pages for a single stat category."""
    url = BASE_URL + path
    log.info(f"  Scraping: {name} ({url})")

    soup = fetch_page(url)
    if not soup:
        return {"category": name, "status": "fetch_error", "headers": [], "rows": []}

    headers, rows = parse_table(soup)
    if not headers:
        log.info(f"    → No data available for '{name}'")
        return {"category": name, "status": "no_data", "headers": [], "rows": []}

    max_page = get_max_page(soup)
    log.info(f"    → {len(rows)} rows on page 1 of {max_page}")

    for page in range(2, max_page + 1):
        time.sleep(DELAY_BETWEEN_REQUESTS)
        page_soup = fetch_page(f"{url}/p{page}")
        if page_soup:
            _, page_rows = parse_table(page_soup)
            rows.extend(page_rows)
            log.info(f"    → Page {page}: +{len(page_rows)} rows (total {len(rows)})")

    records = []
    for row in rows:
        record = {headers[i]: row[i] if i < len(row) else "" for i in range(len(headers))}
        records.append(record)

    return {
        "category": name,
        "status": "ok",
        "headers": headers,
        "total_rows": len(records),
        "pages": max_page,
        "rows": records,
    }


# ── Output helpers ────────────────────────────────────────────────────────────
def save_json(data: dict, filepath: str):
    os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
    # Indent-free + sorted keys keeps git diffs minimal on stable categories
    # while still being human-readable when piped through jq.
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
    log.info(f"JSON saved → {filepath}")


def save_csv(data: dict, filepath: str):
    """Write all categories to a single CSV (optional)."""
    os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = None
        for stat_type in ("individual", "team"):
            for cat_data in data.get(stat_type, {}).values():
                if cat_data["status"] != "ok" or not cat_data["rows"]:
                    continue
                fieldnames = ["stat_type", "category"] + cat_data["headers"]
                if writer is None:
                    writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
                    writer.writeheader()
                for row in cat_data["rows"]:
                    writer.writerow({"stat_type": stat_type, "category": cat_data["category"], **row})
    log.info(f"CSV saved  → {filepath}")


# ── Main ──────────────────────────────────────────────────────────────────────
def run():
    log.info("=" * 60)
    log.info("NCAA DI Softball Stats Scraper — starting run")
    log.info("=" * 60)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    now_iso = datetime.now(timezone.utc).isoformat()

    result = {
        "metadata": {
            "sport": "NCAA Division I Softball",
            "season": "Current (2025-26)",
            "scraped": now_iso,
            "source": "https://www.ncaa.com/stats/softball/d1/current",
        },
        "individual": {},
        "team": {},
    }

    log.info(f"Scraping {len(INDIVIDUAL_STATS)} individual stat categories...")
    for name, path in INDIVIDUAL_STATS:
        result["individual"][name] = scrape_stat_category(name, path)
        time.sleep(DELAY_BETWEEN_REQUESTS)

    log.info(f"Scraping {len(TEAM_STATS)} team stat categories...")
    for name, path in TEAM_STATS:
        result["team"][name] = scrape_stat_category(name, path)
        time.sleep(DELAY_BETWEEN_REQUESTS)

    json_path = os.path.join(OUTPUT_DIR, OUTPUT_JSON)
    save_json(result, json_path)

    if WRITE_CSV:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        save_csv(result, os.path.join(OUTPUT_DIR, f"ncaa_softball_stats_{timestamp}.csv"))

    ok_ind  = sum(1 for v in result["individual"].values() if v["status"] == "ok")
    ok_team = sum(1 for v in result["team"].values()       if v["status"] == "ok")
    total_rows = sum(v.get("total_rows", 0) or 0
                     for d in (result["individual"], result["team"])
                     for v in d.values())
    log.info(f"Done — {ok_ind}/{len(INDIVIDUAL_STATS)} individual, {ok_team}/{len(TEAM_STATS)} team categories")
    log.info(f"Total data rows: {total_rows}")
    log.info("=" * 60)


if __name__ == "__main__":
    run()
