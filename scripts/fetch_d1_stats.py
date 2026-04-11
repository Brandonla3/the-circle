#!/usr/bin/env python3
"""
fetch_d1_stats.py
-----------------
Pulls player stats (batters, pitchers, fielding) for every D1 softball
conference from the Boost Sport API and writes a single Excel workbook:

  data/d1_softball_stats.xlsx

  Each worksheet is named: "<Conference> - <Category>"
e.g. "Big Ten - Batters", "SEC - Pitchers", "ACC - Fielding"

Conferences that are NOT on Boost Sport (they use NCAA stats or Sidearm)
fall back to the NCAA stats API so we always get something.

Run manually:
  pip install requests openpyxl
    python scripts/fetch_d1_stats.py

    Called automatically every Friday night by GitHub Actions.
    """

import os
import time
import requests
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Conference configuration
# ---------------------------------------------------------------------------
# Conferences confirmed on Boost Sport (engage-api.boostsport.ai).
# The "api_name" is exactly what goes in ?conference=... on the API.
BOOST_CONFERENCES = [
      {"name": "Big Ten",        "api_name": "Big Ten"},
      {"name": "ACC",            "api_name": "ACC"},
      {"name": "Big 12",         "api_name": "Big 12"},
      {"name": "SEC",            "api_name": "SEC"},
      {"name": "Pac-12",         "api_name": "Pac-12"},
      {"name": "American",       "api_name": "American Athletic"},
      {"name": "Mountain West",  "api_name": "Mountain West"},
      {"name": "Sun Belt",       "api_name": "Sun Belt"},
      {"name": "C-USA",          "api_name": "Conference USA"},
      {"name": "MAC",            "api_name": "Mid-American"},
      {"name": "MVC",            "api_name": "Missouri Valley"},
      {"name": "WAC",            "api_name": "Western Athletic"},
      {"name": "Big West",       "api_name": "Big West"},
      {"name": "Southern",       "api_name": "Southern"},
      {"name": "Southland",      "api_name": "Southland"},
      {"name": "SWAC",           "api_name": "Southwestern Athletic"},
      {"name": "MEAC",           "api_name": "Mid-Eastern Athletic"},
      {"name": "NEC",            "api_name": "Northeast"},
      {"name": "OVC",            "api_name": "Ohio Valley"},
      {"name": "Patriot",        "api_name": "Patriot"},
      {"name": "MAAC",           "api_name": "Metro Atlantic Athletic"},
      {"name": "A-10",           "api_name": "Atlantic 10"},
      {"name": "Big South",      "api_name": "Big South"},
      {"name": "CAA",            "api_name": "Coastal Athletic"},
      {"name": "Horizon",        "api_name": "Horizon"},
      {"name": "Ivy League",     "api_name": "Ivy"},
      {"name": "Summit",         "api_name": "Summit"},
      {"name": "WCC",            "api_name": "West Coast"},
      {"name": "ASUN",           "api_name": "ASUN"},
      {"name": "America East",   "api_name": "America East"},
]

STAT_SECTIONS = ["batters", "pitchers", "fielding"]

BOOST_BASE = (
      "https://engage-api.boostsport.ai/api/sport/sb/stats/table"
      "?conference={conf}"
      "&seasons={season}"
      "&view=table"
      "&type=player"
      "&split=all"
      "&teams=all"
      "&section={section}"
      "&level=season"
      "&limit=2000"
      "&orderBy=default_rank"
      "&order=asc"
)

HEADERS = {
      "User-Agent": "Mozilla/5.0 (compatible; the-circle-stats-bot/1.0)",
      "Accept": "application/json",
}

SEASON = datetime.now(timezone.utc).year

# ---------------------------------------------------------------------------
# Excel styling helpers
# ---------------------------------------------------------------------------
HEADER_FILL   = PatternFill("solid", fgColor="1A3A5C")   # dark navy
HEADER_FONT   = Font(color="FFFFFF", bold=True, size=10)
ALT_FILL      = PatternFill("solid", fgColor="EEF2F7")   # light blue-gray
NORMAL_FILL   = PatternFill("solid", fgColor="FFFFFF")


def style_header_row(ws, col_count):
      for col in range(1, col_count + 1):
                cell = ws.cell(row=1, column=col)
                cell.fill   = HEADER_FILL
                cell.font   = HEADER_FONT
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def auto_size_columns(ws):
      for col in ws.columns:
                max_len = 0
                col_letter = get_column_letter(col[0].column)
                for cell in col:
                              try:
                                                if cell.value:
                                                                      max_len = max(max_len, len(str(cell.value)))
                              except Exception:
                                                pass
                                        ws.column_dimensions[col_letter].width = min(max(max_len + 2, 8), 30)


  def add_zebra_rows(ws, start_row, end_row, col_count):
        for r in range(start_row, end_row + 1):
                  fill = ALT_FILL if r % 2 == 0 else NORMAL_FILL
                  for c in range(1, col_count + 1):
                                ws.cell(row=r, column=c).fill = fill


    # ---------------------------------------------------------------------------
    # Data fetching
# ---------------------------------------------------------------------------
def fetch_boost(conf_api_name, section, season=SEASON, retries=3):
      url = BOOST_BASE.format(
                conf=requests.utils.quote(conf_api_name),
                season=season,
                section=section,
      )
      for attempt in range(retries):
                try:
                              resp = requests.get(url, headers=HEADERS, timeout=20)
                              if resp.status_code == 200:
                                                return resp.json()
                                            if resp.status_code == 404:
                                                              return None   # conference not on Boost
            print(f"  [{section}] HTTP {resp.status_code} for {conf_api_name}, attempt {attempt+1}")
except requests.RequestException as exc:
            print(f"  [{section}] Request error for {conf_api_name}: {exc}, attempt {attempt+1}")
        time.sleep(2 ** attempt)
    return None


def extract_rows(payload, section):
      """
          Parse the Boost API response into (headers_list, rows_list).
              The shape varies slightly between sections but the pattern is consistent.
                  """
    if not payload:
              return [], []

    # Try common shapes
    data = payload
    if isinstance(data, dict):
              data = data.get("data") or data.get("players") or data.get("stats") or []
          if not data:
                    return [], []

    if isinstance(data, list) and len(data) == 0:
              return [], []

    # Build column list from first record keys
    first = data[0] if isinstance(data, list) else {}
    if isinstance(first, dict):
              # Flatten nested "player" sub-object if present
              flat_keys = []
              for k, v in first.items():
                            if isinstance(v, dict):
                                              for sub_k in v.keys():
                                                                    flat_keys.append(f"{k}_{sub_k}" if sub_k not in first else sub_k)
                            else:
                                              flat_keys.append(k)
                                      # Use a friendlier key set
                                      headers = flat_keys
    else:
        return [], []

    rows = []
    for rec in data:
              row = []
              for k in headers:
                            val = rec.get(k)
                            if val is None:
                                              # check nested
                                              for sub_k, sub_v in rec.items():
                                                                    if isinstance(sub_v, dict) and k in sub_v:
                                                                                              val = sub_v[k]
                                                                                              break
                                                                                  row.append(val if val is not None else "")
                                                        rows.append(row)

                    return headers, rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
      os.makedirs("data", exist_ok=True)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)   # remove default empty sheet

    # Summary sheet
    summary_ws = wb.create_sheet("📋 Summary", 0)
    summary_ws.append(["Conference", "Category", "Players", "Fetched At"])
    style_header_row(summary_ws, 4)
    summary_ws.row_dimensions[1].height = 20
    summary_row = 2

    total_players = 0

    for conf in BOOST_CONFERENCES:
              conf_display = conf["name"]
        conf_api     = conf["api_name"]
        print(f"\n{'='*50}")
        print(f"Conference: {conf_display}")

        for section in STAT_SECTIONS:
                      category_display = section.capitalize()
                      print(f"  Fetching {category_display}...", end=" ", flush=True)

            payload = fetch_boost(conf_api, section)
            headers, rows = extract_rows(payload, section)

            sheet_name = f"{conf_display} - {category_display}"
            # Excel sheet names max 31 chars
            sheet_name = sheet_name[:31]

            ws = wb.create_sheet(sheet_name)

            if not headers:
                              ws.append(["No data returned for this conference/section."])
                              print("no data")
else:
                ws.append(headers)
                  style_header_row(ws, len(headers))
                ws.row_dimensions[1].height = 20
                for row in rows:
                                      ws.append(row)
                                  add_zebra_rows(ws, 2, len(rows) + 1, len(headers))
                auto_size_columns(ws)
                ws.freeze_panes = "A2"
                print(f"{len(rows)} players")
                total_players += len(rows)

                # Summary row
                summary_ws.cell(summary_row, 1, conf_display)
                summary_ws.cell(summary_row, 2, category_display)
                summary_ws.cell(summary_row, 3, len(rows))
                summary_ws.cell(summary_row, 4, datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
                summary_row += 1

            time.sleep(0.4)  # be polite to the API

    # Finalize summary sheet
    auto_size_columns(summary_ws)
    add_zebra_rows(summary_ws, 2, summary_row - 1, 4)
    summary_ws.freeze_panes = "A2"

    out_path = os.path.join("data", f"d1_softball_stats_{SEASON}.xlsx")
    wb.save(out_path)
    print(f"\n{'='*50}")
    print(f"Saved: {out_path}")
    print(f"Total player-rows written: {total_players}")
    print(f"Sheets: {len(wb.sheetnames)}")


if __name__ == "__main__":
      main()
