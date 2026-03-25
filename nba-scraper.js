/**
 * nba-scraper.js
 * Downloads and parses the NBA official injury report PDFs every minute.
 * Reports are published every 15 minutes at a predictable URL.
 *
 * URL pattern:
 *   https://ak-static.cms.nba.com/referee/injury/Injury-Report_YYYY-MM-DD_HH_MMAM.pdf
 *   e.g. Injury-Report_2026-03-24_09_00AM.pdf
 *
 * Table columns in PDF:
 *   Game Date | Game Time | Matchup | Team | Player | Current Status | Previous Status | Reason
 */

const axios  = require('axios');
const pdf    = require('pdf-parse');
const { Pool } = require('pg');

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Track which PDF URL we last successfully processed to avoid re-parsing
let lastProcessedUrl = null;

// In-memory cache of latest official report entries (keyed by player name)
let officialCache = {};   // { "LeBron James": { ...entry } }
let officialFetchedAt = null;

// ── DB INIT ───────────────────────────────────────────────────────────────────
async function initOfficialDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nba_official_injuries (
        id              SERIAL PRIMARY KEY,
        report_url      TEXT,
        report_time     TIMESTAMPTZ,
        game_date       DATE,
        game_time       TEXT,
        matchup         TEXT,
        team            TEXT,
        player          TEXT,
        current_status  TEXT,
        previous_status TEXT,
        reason          TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (report_url, player, team)
      );
      CREATE INDEX IF NOT EXISTS idx_official_player ON nba_official_injuries(player);
      CREATE INDEX IF NOT EXISTS idx_official_team   ON nba_official_injuries(team);
      CREATE INDEX IF NOT EXISTS idx_official_time   ON nba_official_injuries(report_time DESC);
    `);
    console.log('[NBA Official] DB schema ready ✓');
  } catch (err) {
    console.error('[NBA Official] DB init error:', err.message);
  }
}

// ── URL BUILDER ───────────────────────────────────────────────────────────────
// Construct the PDF URL for the latest 15-minute interval in ET
function getCurrentPdfUrl() {
  // Work in Eastern Time
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);

  // Round down to nearest 15 minutes
  const mins = et.getMinutes();
  const roundedMins = Math.floor(mins / 15) * 15;
  et.setMinutes(roundedMins, 0, 0);

  const year  = et.getFullYear();
  const month = String(et.getMonth() + 1).padStart(2, '0');
  const day   = String(et.getDate()).padStart(2, '0');

  let hours = et.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;   // 0 → 12
  const hh = String(hours).padStart(2, '0');
  const mm = String(roundedMins).padStart(2, '0');

  return `https://ak-static.cms.nba.com/referee/injury/Injury-Report_${year}-${month}-${day}_${hh}_${mm}${ampm}.pdf`;
}

// ── PDF PARSER ────────────────────────────────────────────────────────────────
// Status normalisation — NBA uses varied labels
function normaliseStatus(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.includes('out'))                          return 'Out';
  if (s.includes('doubtful'))                     return 'Doubtful';
  if (s.includes('game time') || s === 'gtd')     return 'Game-Time Decision';
  if (s.includes('questionable'))                 return 'Questionable';
  if (s.includes('probable'))                     return 'Probable';
  if (s.includes('available') || s === 'active')  return null; // skip healthy players
  return null;
}

// Parse the flat text extracted from the PDF into structured rows.
// The NBA PDF uses a consistent repeating column layout per row:
//   Game Date  Game Time  Matchup  Team  Player  Current  Previous  Reason
function parseInjuryText(text) {
  const entries = [];

  // Split into lines and clean
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  // State machine: accumulate tokens into rows
  // Each row starts with a date pattern MM/DD/YYYY
  const dateRe = /^\d{2}\/\d{2}\/\d{4}$/;

  let i = 0;
  while (i < lines.length) {
    // Look for a date line to mark the start of a row
    if (!dateRe.test(lines[i])) { i++; continue; }

    const gameDate = lines[i];       // "03/24/2026"
    const gameTime = lines[i+1] || '';  // "7:30 PM ET"
    const matchup  = lines[i+2] || '';  // "Golden State Warriors vs. Los Angeles Lakers"
    const team     = lines[i+3] || '';  // "Los Angeles Lakers"
    const player   = lines[i+4] || '';  // "LeBron James"
    const currentStatus  = lines[i+5] || '';
    const previousStatus = lines[i+6] || '';
    // Reason can span multiple lines until next date or end
    let reasonParts = [];
    let j = i + 7;
    while (j < lines.length && !dateRe.test(lines[j])) {
      // Stop if we hit what looks like a time or matchup line for next row
      if (/^\d{1,2}:\d{2}\s*(AM|PM)/i.test(lines[j])) break;
      reasonParts.push(lines[j]);
      j++;
    }
    const reason = reasonParts.join(' ').trim() || '';

    const normStatus = normaliseStatus(currentStatus);

    if (player && player.length > 2 && normStatus) {
      entries.push({
        game_date:       gameDate,
        game_time:       gameTime,
        matchup:         matchup,
        team:            team,
        player:          player,
        current_status:  normStatus,
        previous_status: normaliseStatus(previousStatus),
        reason:          reason,
      });
    }

    i = j;
  }

  return entries;
}

// ── SAVE TO DB ────────────────────────────────────────────────────────────────
async function saveEntries(entries, reportUrl, reportTime) {
  if (!pool || !entries.length) return 0;
  let saved = 0;
  for (const e of entries) {
    try {
      const res = await pool.query(`
        INSERT INTO nba_official_injuries
          (report_url, report_time, game_date, game_time, matchup, team, player,
           current_status, previous_status, reason)
        VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (report_url, player, team) DO UPDATE
          SET current_status  = EXCLUDED.current_status,
              previous_status = EXCLUDED.previous_status,
              reason          = EXCLUDED.reason
      `, [
        reportUrl,
        reportTime,
        parseGameDate(e.game_date),
        e.game_time,
        e.matchup,
        e.team,
        e.player,
        e.current_status,
        e.previous_status || null,
        e.reason || null,
      ]);
      if (res.rowCount) saved++;
    } catch (err) {
      console.error('[NBA Official] Save error:', err.message);
    }
  }
  return saved;
}

// Convert "MM/DD/YYYY" → "YYYY-MM-DD" for Postgres DATE
function parseGameDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// ── MAIN POLL ─────────────────────────────────────────────────────────────────
async function pollOfficialReport() {
  const url = getCurrentPdfUrl();

  // Don't re-process the same PDF
  if (url === lastProcessedUrl) return;

  console.log(`[NBA Official] Fetching ${url}`);

  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; InjuryWire/1.0)',
      },
    });

    if (res.status !== 200) {
      console.warn(`[NBA Official] HTTP ${res.status} — report may not be published yet`);
      return;
    }

    const data = await pdf(res.data);
    const entries = parseInjuryText(data.text);

    console.log(`[NBA Official] Parsed ${entries.length} injured players from ${url}`);

    if (entries.length === 0) {
      console.warn('[NBA Official] No entries parsed — PDF may have changed format');
      return;
    }

    // Update in-memory cache (latest status per player)
    officialCache = {};
    for (const e of entries) {
      officialCache[e.player] = { ...e, report_url: url, report_time: new Date() };
    }
    officialFetchedAt = new Date();

    // Persist to DB
    const saved = await saveEntries(entries, url, new Date());
    console.log(`[NBA Official] Saved ${saved} entries to DB ✓`);

    lastProcessedUrl = url;

  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 404) {
      // Report for this 15-min slot not published yet — normal, don't log as error
      console.log(`[NBA Official] Report not available yet (${err.response.status})`);
    } else {
      console.error('[NBA Official] Fetch/parse error:', err.message);
    }
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

// Get latest in-memory official report (all injured players)
function getOfficialCache() {
  return { entries: Object.values(officialCache), count: Object.keys(officialCache).length, fetched_at: officialFetchedAt };
}

// Get official status for a specific player
function getOfficialStatusForPlayer(playerName) {
  if (!playerName) return null;
  const entry = officialCache[playerName];
  if (entry) return entry;
  // Case-insensitive fallback
  const lower = playerName.toLowerCase();
  return Object.values(officialCache).find(e => e.player.toLowerCase() === lower) || null;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function startScraper(app) {
  await initOfficialDB();

  // Load today's most recent report from DB into memory on startup
  if (pool) {
    try {
      const rows = await pool.query(`
        SELECT DISTINCT ON (player, team) *
        FROM nba_official_injuries
        WHERE report_time > NOW() - INTERVAL '12 hours'
        ORDER BY player, team, report_time DESC
      `);
      for (const r of rows.rows) {
        officialCache[r.player] = r;
      }
      officialFetchedAt = new Date();
      console.log(`[NBA Official] Loaded ${rows.rowCount} entries from DB ✓`);
    } catch (err) {
      console.error('[NBA Official] Startup load error:', err.message);
    }
  }

  // Wire up API routes
  if (app) {
    // GET /nba/injuries — full latest official report
    app.get('/nba/injuries', (req, res) => {
      res.json(getOfficialCache());
    });

    // GET /nba/player/:name — official status for one player
    app.get('/nba/player/:name', (req, res) => {
      const entry = getOfficialStatusForPlayer(req.params.name);
      if (!entry) return res.status(404).json({ error: 'Player not found in official report' });
      res.json(entry);
    });

    // GET /nba/history — last 7 days from DB
    app.get('/nba/history', async (req, res) => {
      if (!pool) return res.json({ entries: [], count: 0 });
      try {
        const rows = await pool.query(`
          SELECT * FROM nba_official_injuries
          WHERE report_time > NOW() - INTERVAL '7 days'
          ORDER BY report_time DESC
          LIMIT 2000
        `);
        res.json({ entries: rows.rows, count: rows.rowCount });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /nba/latest-url — which PDF was last processed
    app.get('/nba/latest-url', (req, res) => {
      res.json({ url: lastProcessedUrl, current_url: getCurrentPdfUrl() });
    });
  }

  // Poll immediately, then every minute
  await pollOfficialReport();
  setInterval(pollOfficialReport, 60000);

  console.log('[NBA Official] Scraper started — polling every 60s ✓');
}

module.exports = { startScraper, getOfficialCache, getOfficialStatusForPlayer, pollOfficialReport };
