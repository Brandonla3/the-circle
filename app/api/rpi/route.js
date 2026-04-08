// Server-side RPI fetcher.
// ?source=ncaa  -> henrygd ncaa-api wrapper around ncaa.com (weekly official RPI)
// ?source=nolan -> warrennolan.com HTML parsed into JSON (live RPI when available)

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UA = 'Mozilla/5.0 (compatible; TheCircle/1.0)';

async function fetchNcaa() {
  const url = 'https://ncaa-api.henrygd.me/rankings/softball/d1/ncaa-womens-softball-rpi';
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!r.ok) throw new Error(`NCAA fetch failed: HTTP ${r.status}`);
  const data = await r.json();
  // henrygd returns { sport, title, updated, page, pages, data: [ {rank, school, ...} ] }
  return {
    source: 'NCAA Official RPI',
    cadence: 'Weekly',
    updated: data.updated || '',
    title: data.title || 'NCAA Women\'s Softball RPI',
    rows: (data.data || []).map((row) => ({
      rank: row.RANK || row.Rank || row.rank || '',
      team: row.School || row.school || row.Team || row.team || '',
      conference: row.Conference || row.conference || '',
      record: row.W || row.Record || row.record || '',
      rpi: row.RPI || row.rpi || '',
      previous: row.PREVIOUS || row.Previous || row.previous || '',
    })),
  };
}

function parseNolanHtml(html) {
  // Strip scripts/styles to reduce noise
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  // Find all <tr> blocks
  const trMatches = clean.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const rows = [];
  for (const tr of trMatches) {
    // Pull all <td> cells
    const tdMatches = tr.match(/<td[\s\S]*?<\/td>/gi);
    if (!tdMatches || tdMatches.length < 4) continue;
    // Strip tags from each cell
    const cells = tdMatches.map((td) =>
      td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    );
    // Heuristic: first cell is a rank number, find a team-looking cell, an RPI-looking decimal
    const rank = parseInt(cells[0], 10);
    if (isNaN(rank) || rank < 1 || rank > 400) continue;
    // Team is usually cell 1 or 2
    const team = cells[1] && cells[1].length > 1 ? cells[1] : cells[2] || '';
    // RPI: find a cell that looks like 0.xxxx
    const rpiCell = cells.find((c) => /^0?\.\d{3,5}$/.test(c)) || '';
    // Record: find a cell like W-L or W-L-T
    const recCell = cells.find((c) => /^\d+-\d+(-\d+)?$/.test(c)) || '';
    rows.push({ rank, team, rpi: rpiCell, record: recCell });
  }
  return rows;
}

async function fetchNolanYear(year) {
  const url = `https://www.warrennolan.com/softball/${year}/rpi-live`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!r.ok) throw new Error(`Nolan ${year} fetch failed: HTTP ${r.status}`);
  const html = await r.text();
  const rows = parseNolanHtml(html);
  return { url, rows };
}

async function fetchNolan() {
  // Try current year first; fall back to last year if empty
  const currentYear = new Date().getFullYear();
  let result;
  let yearUsed = currentYear;
  try {
    result = await fetchNolanYear(currentYear);
    if (!result.rows || result.rows.length < 5) {
      const prev = await fetchNolanYear(currentYear - 1);
      if (prev.rows && prev.rows.length >= 5) {
        result = prev;
        yearUsed = currentYear - 1;
      }
    }
  } catch (e) {
    const prev = await fetchNolanYear(currentYear - 1);
    result = prev;
    yearUsed = currentYear - 1;
  }
  return {
    source: 'Warren Nolan Live RPI',
    cadence: yearUsed === currentYear ? 'Live' : `Final ${yearUsed} Season`,
    updated: '',
    title: `${yearUsed} College Softball RPI`,
    sourceUrl: result.url,
    rows: result.rows,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const source = searchParams.get('source');
  try {
    let payload;
    if (source === 'ncaa') payload = await fetchNcaa();
    else if (source === 'nolan') payload = await fetchNolan();
    else return new Response(JSON.stringify({ error: 'source must be ncaa or nolan' }), { status: 400 });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, source }), { status: 500 });
  }
}
