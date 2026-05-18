#!/usr/bin/env python3
"""
NCAA Division I Softball 2026 Bracket Scraper
=============================================
Pulls live bracket data directly from the NCAA's GraphQL API
(the same endpoint the official bracket page uses).

Usage:
    python ncaa_bracket_scraper.py              # run once
    python ncaa_bracket_scraper.py --watch      # run continuously on a schedule

Scheduling (automated overnight / during tournament):
    Cron (Mac/Linux):   */5 * * * * python3 /path/to/ncaa_bracket_scraper.py
    Windows Task Scheduler: run every 5 minutes during tournament hours

Requirements:
    pip install requests

Output files (timestamped, saved to ./bracket_output/):
    ncaa_softball_bracket_YYYYMMDD_HHMMSS.json   - full structured bracket
    ncaa_softball_bracket_latest.json            - always overwritten (latest snapshot)
    ncaa_softball_bracket_YYYYMMDD_HHMMSS.csv    - flat CSV of all games
    ncaa_softball_bracket_latest.csv             - always overwritten (latest snapshot)
"""

import requests
import json
import csv
import time
import logging
import os
import sys
import argparse
from datetime import datetime
from urllib.parse import quote

# Configuration
OUTPUT_DIR         = "./bracket_output"
LOG_FILE           = "ncaa_bracket_scraper.log"
WATCH_INTERVAL_SEC = 300    # 5 minutes between polls in --watch mode
MAX_RETRIES        = 3
RETRY_BACKOFF_SEC  = 5

# NCAA GraphQL API Config - embedded in the official bracket page's drupalSettings.
# The SHA is a persisted-query hash, stable for the 2026 season.
GQL_ENDPOINT      = "https://sdataprod.ncaa.com/"
GQL_META          = "GetBracketChampionship_ncaa"
GQL_SHA           = "0f017b52a0eb4f83e33ca93e1278190edcf2e4bfba8202d300350c7cf29db1f7"
CHAMPIONSHIP_ID   = 6410
SPORT_URL         = "softball"
DIVISION          = 1
YEAR              = 2026

REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.ncaa.com/brackets/softball/d1/2026",
    "Origin":          "https://www.ncaa.com",
}

# sectionIds 101-116 = Regionals, 201-208 = Super Regionals,
# 301-302 = World Series brackets, 401 = Finals
def section_to_round(section_id: int) -> str:
    if section_id >= 400:
        return "World Series Finals"
    elif section_id >= 300:
        return "World Series"
    elif section_id >= 200:
        return "Super Regionals"
    else:
        return "Regionals"

GAME_STATES = {
    "F": "Final",
    "I": "In Progress",
    "P": "Scheduled",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


def fetch_bracket() -> dict | None:
    """
    Call the NCAA GraphQL persisted-query endpoint and return the raw JSON response.
    Uses automatic retries with exponential back-off.
    """
    variables = json.dumps({
        "championshipId": CHAMPIONSHIP_ID,
        "sportUrl":       SPORT_URL,
        "division":       DIVISION,
        "year":           YEAR,
        "staticTestEnv":  None,
    }, separators=(",", ":"))

    extensions = json.dumps({
        "persistedQuery": {
            "version":    1,
            "sha256Hash": GQL_SHA,
        }
    }, separators=(",", ":"))

    url = (
        f"{GQL_ENDPOINT}"
        f"?meta={GQL_META}"
        f"&extensions={quote(extensions)}"
        f"&variables={quote(variables)}"
    )

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            log.info(f"Fetching bracket data (attempt {attempt}/{MAX_RETRIES})...")
            resp = requests.get(url, headers=REQUEST_HEADERS, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            log.warning(f"Request failed: {e}")
            if attempt < MAX_RETRIES:
                wait = RETRY_BACKOFF_SEC * (2 ** (attempt - 1))
                log.info(f"Retrying in {wait}s...")
                time.sleep(wait)

    log.error("All retries exhausted. Could not fetch bracket data.")
    return None


def process_bracket(raw: dict) -> dict:
    """
    Transform the raw GraphQL response into a clean, structured bracket dict.
    """
    championships = raw.get("data", {}).get("championships", [])
    if not championships:
        raise ValueError("No championship data found in API response.")

    champ = championships[0]

    section_lookup = {
        s["sectionId"]: s["title"].strip()
        for s in champ.get("sections", [])
    }

    rounds_lookup = {
        r["roundNumber"]: r["title"]
        for r in champ.get("rounds", [])
    }

    games = []
    for g in champ.get("games", []):
        section_id   = g.get("sectionId", 0)
        location_data = g.get("location") or {}
        teams        = g.get("teams", [])

        top_team    = next((t for t in teams if t.get("isTop")),    None)
        bottom_team = next((t for t in teams if not t.get("isTop")), None)

        def team_dict(t: dict | None) -> dict:
            if not t:
                return {"name": "TBD", "seed": None, "score": None,
                        "record": None, "sectionRecord": None,
                        "isWinner": False, "eliminated": False}
            return {
                "name":          t.get("nameShort") or t.get("nameFull", "TBD"),
                "nameFull":      t.get("nameFull", ""),
                "seed":          t.get("seed"),
                "score":         t.get("score"),
                "record":        t.get("record", ""),
                "sectionRecord": t.get("sectionRecord", ""),
                "isWinner":      t.get("isWinner", False),
                "eliminated":    t.get("eliminated", False),
                "color":         t.get("color", ""),
                "logoUrl":       "https://www.ncaa.com" + t.get("logoUrl", "") if t.get("logoUrl") else "",
            }

        game = {
            "contestId":        g.get("contestId"),
            "gameState":        g.get("gameState", "P"),
            "gameStateLabel":   GAME_STATES.get(g.get("gameState", "P"), "Unknown"),
            "statusDisplay":    g.get("statusCodeDisplay", ""),
            "currentPeriod":    g.get("currentPeriod") or "",
            "finalMessage":     g.get("finalMessage") or "",
            "round":            section_to_round(section_id),
            "roundLabel":       rounds_lookup.get(
                                    1 if section_id < 200
                                    else 2 if section_id < 300
                                    else 3 if section_id < 400
                                    else 4, ""),
            "sectionId":        section_id,
            "location":         section_lookup.get(section_id, ""),
            "venue":            location_data.get("venue", ""),
            "city":             location_data.get("city", ""),
            "state":            location_data.get("stateUsps", ""),
            "startDate":        g.get("startDate", ""),
            "startTime":        g.get("startTime", ""),
            "startTimeEpoch":   g.get("startTimeEpoch"),
            "isIfNecessary":    g.get("isIfNecessary", False),
            "gameUrl":          "https://www.ncaa.com" + g.get("url", "") if g.get("url") else "",
            "topTeam":          team_dict(top_team),
            "bottomTeam":       team_dict(bottom_team),
        }
        games.append(game)

    games.sort(key=lambda g: (
        {"Regionals": 1, "Super Regionals": 2, "World Series": 3, "World Series Finals": 4}
            .get(g["round"], 9),
        g["sectionId"],
        g["startTimeEpoch"] or 0,
    ))

    total         = len(games)
    final_count   = sum(1 for g in games if g["gameState"] == "F")
    live_count    = sum(1 for g in games if g["gameState"] == "I")
    sched_count   = sum(1 for g in games if g["gameState"] == "P")

    return {
        "metadata": {
            "title":          champ.get("title", ""),
            "year":           champ.get("year"),
            "championshipId": champ.get("championshipId"),
            "sport":          "NCAA Division I Softball",
            "bracketUrl":     "https://www.ncaa.com/brackets/softball/d1/2026",
            "scrapedAt":      datetime.now().isoformat(),
            "gameSummary": {
                "total":      total,
                "final":      final_count,
                "inProgress": live_count,
                "scheduled":  sched_count,
            },
        },
        "rounds": [
            {"roundNumber": r["roundNumber"], "title": r["title"], "staged": r.get("staged", False)}
            for r in champ.get("rounds", [])
        ],
        "locations": [
            {"sectionId": s["sectionId"], "title": s["title"].strip()}
            for s in champ.get("sections", [])
        ],
        "games": games,
    }


def flatten_game_for_csv(g: dict) -> dict:
    """Flatten a processed game dict to a single-level row for CSV output."""
    top    = g["topTeam"]
    bottom = g["bottomTeam"]
    return {
        "contestId":              g["contestId"],
        "round":                  g["round"],
        "location":               g["location"],
        "venue":                  g["venue"],
        "city":                   g["city"],
        "state":                  g["state"],
        "startDate":              g["startDate"],
        "startTime":              g["startTime"],
        "gameState":              g["gameState"],
        "gameStateLabel":         g["gameStateLabel"],
        "currentPeriod":          g["currentPeriod"],
        "isIfNecessary":          g["isIfNecessary"],
        "gameUrl":                g["gameUrl"],
        "topTeam_name":           top["name"],
        "topTeam_seed":           top["seed"],
        "topTeam_score":          top["score"],
        "topTeam_record":         top["record"],
        "topTeam_sectionRecord":  top["sectionRecord"],
        "topTeam_isWinner":       top["isWinner"],
        "topTeam_eliminated":     top["eliminated"],
        "bottomTeam_name":        bottom["name"],
        "bottomTeam_seed":        bottom["seed"],
        "bottomTeam_score":       bottom["score"],
        "bottomTeam_record":      bottom["record"],
        "bottomTeam_sectionRecord": bottom["sectionRecord"],
        "bottomTeam_isWinner":    bottom["isWinner"],
        "bottomTeam_eliminated":  bottom["eliminated"],
    }


def save_outputs(bracket: dict, timestamp: str):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    json_stamped = os.path.join(OUTPUT_DIR, f"ncaa_softball_bracket_{timestamp}.json")
    json_latest  = os.path.join(OUTPUT_DIR, "ncaa_softball_bracket_latest.json")
    for path in (json_stamped, json_latest):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(bracket, f, indent=2)
    log.info(f"JSON -> {json_stamped}")
    log.info(f"JSON -> {json_latest} (latest)")

    flat_rows    = [flatten_game_for_csv(g) for g in bracket["games"]]
    csv_stamped  = os.path.join(OUTPUT_DIR, f"ncaa_softball_bracket_{timestamp}.csv")
    csv_latest   = os.path.join(OUTPUT_DIR, "ncaa_softball_bracket_latest.csv")
    if flat_rows:
        fieldnames = list(flat_rows[0].keys())
        for path in (csv_stamped, csv_latest):
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(flat_rows)
        log.info(f"CSV  -> {csv_stamped}")
        log.info(f"CSV  -> {csv_latest} (latest)")


def run_once() -> bool:
    """Fetch, process, and save bracket data. Returns True on success."""
    raw = fetch_bracket()
    if raw is None:
        return False

    try:
        bracket = process_bracket(raw)
    except (ValueError, KeyError) as e:
        log.error(f"Failed to process bracket data: {e}")
        return False

    meta = bracket["metadata"]
    gs   = meta["gameSummary"]
    log.info(
        f"Bracket: {meta['title']} | "
        f"Total games: {gs['total']} | "
        f"Final: {gs['final']} | "
        f"Live: {gs['inProgress']} | "
        f"Scheduled: {gs['scheduled']}"
    )

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    save_outputs(bracket, timestamp)
    return True


def run_watch(interval: int = WATCH_INTERVAL_SEC):
    """
    Poll the API on a fixed interval.
    Smart scheduling: if games are live (gameState='I'), poll every minute.
    Otherwise use the configured interval (default 5 min).
    """
    log.info(f"Watch mode started - polling every {interval}s (faster when games are live).")
    while True:
        success = run_once()
        if success:
            latest = os.path.join(OUTPUT_DIR, "ncaa_softball_bracket_latest.json")
            try:
                with open(latest) as f:
                    data = json.load(f)
                live_games = data["metadata"]["gameSummary"]["inProgress"]
                wait = 60 if live_games > 0 else interval
                if live_games > 0:
                    log.info(f"{live_games} game(s) currently live - polling every 60s.")
            except Exception:
                wait = interval
        else:
            wait = interval

        log.info(f"Next poll in {wait}s...")
        time.sleep(wait)


def main():
    parser = argparse.ArgumentParser(
        description="NCAA DI Softball 2026 Bracket Scraper"
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Run continuously, polling on a schedule (smart: 60s when live, 5min otherwise)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=WATCH_INTERVAL_SEC,
        help=f"Polling interval in seconds for --watch mode (default: {WATCH_INTERVAL_SEC})",
    )
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("NCAA DI Softball Bracket Scraper")
    log.info("=" * 60)

    if args.watch:
        run_watch(args.interval)
    else:
        success = run_once()
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
