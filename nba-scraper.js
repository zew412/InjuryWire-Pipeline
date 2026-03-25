/**
 * nba-scraper.js — v4
 *
 * NBA injury PDF raw text format (via pdf-parse):
 *   Everything concatenated, no spaces.
 *   Player names: LastName,FirstName  (comma is the unique delimiter)
 *   Line examples:
 *     "03/24/202607:00(ET)SAC@CHASacramentoKingsAchiuwa,PreciousOutInjury/Illness-LowerBack;Soreness"
 *     "Clifford,NiqueOutInjury/Illness-LeftFoot;Soreness"
 *     "Eubanks,DrewOut"
 *     "Injury/Illness-LeftThumb;UCL"          ← reason continuation
 *     "Repair"                                 ← reason continuation
 *     "CharlotteHornetsConnaughton,PatOutInjury/Illness-Illness;Illness"
 */

const axios  = require('axios');
const pdf    = require('pdf-parse');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let lastProcessedUrl  = null;
let lastRawText       = '';
let officialCache     = {};
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
  } catch (err) { console.error('[NBA Official] DB init error:', err.message); }
}

// ── URL BUILDER ───────────────────────────────────────────────────────────────
function getCurrentPdfUrl() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const roundedMins = Math.floor(et.getMinutes() / 15) * 15;
  et.setMinutes(roundedMins, 0, 0);
  const year  = et.getFullYear();
  const month = String(et.getMonth() + 1).padStart(2, '0');
  const day   = String(et.getDate()).padStart(2, '0');
  let hours   = et.getHours();
  const ampm  = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `https://ak-static.cms.nba.com/referee/injury/Injury-Report_${year}-${month}-${day}_${String(hours).padStart(2,'0')}_${String(roundedMins).padStart(2,'0')}${ampm}.pdf`;
}

// ── STATUS ────────────────────────────────────────────────────────────────────
function normaliseStatus(raw) {
  if (!raw) return null;
  switch (raw.toLowerCase()) {
    case 'out':          return 'Out';
    case 'doubtful':     return 'Doubtful';
    case 'questionable': return 'Questionable';
    case 'probable':     return 'Probable';
    default:             return null;  // Available / Active → skip
  }
}

// ── TEAM MAP ──────────────────────────────────────────────────────────────────
const NBA_TEAMS = [
  'Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
  'Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons',
  'Golden State Warriors','Houston Rockets','Indiana Pacers','LA Clippers',
  'Los Angeles Lakers','Memphis Grizzlies','Miami Heat','Milwaukee Bucks',
  'Minnesota Timberwolves','New Orleans Pelicans','New York Knicks',
  'Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns',
  'Portland Trail Blazers','Sacramento Kings','San Antonio Spurs',
  'Toronto Raptors','Utah Jazz','Washington Wizards',
];
// Concatenated form (no spaces) → full name, sorted longest first
const TEAM_MAP  = {};
for (const t of NBA_TEAMS) TEAM_MAP[t.replace(/\s+/g, '')] = t;
const TEAM_KEYS = Object.keys(TEAM_MAP).sort((a, b) => b.length - a.length);

// ── REASON CLEANER ────────────────────────────────────────────────────────────
function cleanReason(raw) {
  if (!raw) return '';
  return raw
    .replace(/^Injury\/Illness-/, '')
    .replace(/^GLeague-/, 'G-League: ')
    .replace(/;/g, ' - ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // split CamelCase
    .replace(/\s+/g, ' ')
    .trim();
}

// Convert "MM/DD/YYYY" → "YYYY-MM-DD"
function toIsoDate(d) {
  const m = d && d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// ── PARSER ────────────────────────────────────────────────────────────────────
// After stripping date/time/matchup/team, a player line looks like:
//   LastName,FirstNameSTATUS[reason]
//   e.g. "Achiuwa,PreciousOutInjury/Illness-LowerBack;Soreness"
//        "NanceJr.,LarryOutInjury/Illness-Illness;Illness"
//        "McCullarJr.,KevinOutGLeague-Two-Way"
//
// Regex captures: (LastName,)(FirstName)(Status)(rest)
const PLAYER_RE = /^([A-Z][A-Za-z'.]*(?:Jr\.|Sr\.|II|III|IV)?,)([A-Z][A-Za-z'.]*)(Out|Doubtful|Questionable|Probable|Available)(.*)/;

// Lines that are page/section headers — reset context, skip
const SKIP_RE = /^InjuryReport:|^Page\d+of|^GameDate/;

function parseInjuryText(text) {
  if (!text) return [];

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const entries  = [];
  const seen     = new Set();  // dedupe by player+team

  let curDate    = '';
  let curTime    = '';
  let curMatchup = '';
  let curTeam    = '';
  let lastEntry  = null;

  for (let line of lines) {
    // ── Skip headers ─────────────────────────────────────────────────────────
    if (SKIP_RE.test(line)) { lastEntry = null; continue; }

    // ── Strip date ───────────────────────────────────────────────────────────
    const dm = line.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (dm) { curDate = dm[1]; line = line.replace(dm[1], ''); }

    // ── Strip time ───────────────────────────────────────────────────────────
    const tm = line.match(/(\d{2}:\d{2})\(ET\)/);
    if (tm) { curTime = tm[1] + ' ET'; line = line.replace(tm[0], ''); }

    // ── Strip matchup ────────────────────────────────────────────────────────
    const mm = line.match(/[A-Z]{2,3}@[A-Z]{2,3}/);
    if (mm) { curMatchup = mm[0]; line = line.replace(mm[0], ''); }

    // ── Strip team name (update curTeam) ─────────────────────────────────────
    for (const key of TEAM_KEYS) {
      const idx = line.indexOf(key);
      if (idx !== -1) {
        curTeam = TEAM_MAP[key];
        // Keep only what comes after the team name
        line = line.slice(idx + key.length);
        break;
      }
    }

    // ── Try player match ──────────────────────────────────────────────────────
    const pm = line.match(PLAYER_RE);
    if (pm) {
      const [, lastWithComma, first, statusRaw, afterStatus] = pm;
      const status = normaliseStatus(statusRaw);

      if (status) {
        // Convert "LastName," → "Last Name" (handle Jr./Sr. suffix)
        let last = lastWithComma.slice(0, -1);  // drop trailing comma
        last = last.replace(/(Jr\.|Sr\.|II|III|IV)$/, ' $1').trim();
        const player = `${first} ${last}`;

        const dedupeKey = `${player}|${curTeam}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          const entry = {
            game_date:       curDate,
            game_time:       curTime,
            matchup:         curMatchup,
            team:            curTeam,
            player,
            current_status:  status,
            previous_status: null,
            reason:          cleanReason(afterStatus),
          };
          entries.push(entry);
          lastEntry = entry;
        }
      } else {
        // Available — don't accumulate continuations
        lastEntry = null;
      }
      continue;
    }

    // ── Reason continuation ──────────────────────────────────────────────────
    // Any line that didn't match date/team/player is a continuation of the
    // previous player's injury reason
    if (lastEntry && line.length > 0) {
      const extra = cleanReason(line);
      if (extra) {
        lastEntry.reason = lastEntry.reason
          ? `${lastEntry.reason} ${extra}`
          : extra;
      }
    }
  }

  return entries;
}

// ── SAVE TO DB ────────────────────────────────────────────────────────────────
async function saveEntries(entries, reportUrl, reportTime) {
  if (!pool || !entries.length) return 0;
  let saved = 0;
  for (const e of entries) {
    try {
      await pool.query(`
        INSERT INTO nba_official_injuries
          (report_url,report_time,game_date,game_time,matchup,team,player,
           current_status,previous_status,reason)
        VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (report_url,player,team) DO UPDATE
          SET current_status  = EXCLUDED.current_status,
              previous_status = EXCLUDED.previous_status,
              reason          = EXCLUDED.reason
      `, [reportUrl, reportTime, toIsoDate(e.game_date), e.game_time,
          e.matchup, e.team, e.player, e.current_status,
          e.previous_status, e.reason || null]);
      saved++;
    } catch (err) { console.error('[NBA Official] Save error:', err.message); }
  }
  return saved;
}

// ── MAIN POLL ─────────────────────────────────────────────────────────────────
async function pollOfficialReport() {
  const url = getCurrentPdfUrl();
  if (url === lastProcessedUrl) return;
  console.log(`[NBA Official] Fetching ${url}`);
  try {
    const res  = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InjuryWire/1.0)' },
    });
    const data = await pdf(res.data);
    lastRawText = data.text;

    const entries = parseInjuryText(data.text);
    console.log(`[NBA Official] Parsed ${entries.length} players from ${url}`);
    lastProcessedUrl = url;

    if (entries.length > 0) {
      officialCache = {};
      for (const e of entries) officialCache[e.player] = { ...e, report_url: url, report_time: new Date() };
      officialFetchedAt = new Date();
      const saved = await saveEntries(entries, url, new Date());
      console.log(`[NBA Official] Saved ${saved} to DB ✓`);
    } else {
      console.warn('[NBA Official] 0 entries — visit /nba/debug to inspect raw text');
    }
  } catch (err) {
    if ([403, 404].includes(err.response?.status)) {
      console.log(`[NBA Official] Not published yet (${err.response.status})`);
    } else {
      console.error('[NBA Official] Error:', err.message);
    }
  }
}

// ── PUBLIC HELPERS ────────────────────────────────────────────────────────────
function getOfficialCache() {
  return {
    entries:    Object.values(officialCache),
    count:      Object.keys(officialCache).length,
    fetched_at: officialFetchedAt,
  };
}
function getOfficialStatusForPlayer(name) {
  if (!name) return null;
  return officialCache[name]
    || Object.values(officialCache).find(e => e.player.toLowerCase() === name.toLowerCase())
    || null;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function startScraper(app) {
  await initOfficialDB();

  if (pool) {
    try {
      const rows = await pool.query(`
        SELECT DISTINCT ON (player, team) * FROM nba_official_injuries
        WHERE report_time > NOW() - INTERVAL '12 hours'
        ORDER BY player, team, report_time DESC
      `);
      for (const r of rows.rows) officialCache[r.player] = r;
      officialFetchedAt = new Date();
      console.log(`[NBA Official] Loaded ${rows.rowCount} entries from DB ✓`);
    } catch (err) { console.error('[NBA Official] Startup load error:', err.message); }
  }

  if (app) {
    app.get('/nba/injuries',     (req, res) => res.json(getOfficialCache()));
    app.get('/nba/player/:name', (req, res) => {
      const e = getOfficialStatusForPlayer(req.params.name);
      return e ? res.json(e) : res.status(404).json({ error: 'Not in official report' });
    });
    app.get('/nba/history', async (req, res) => {
      if (!pool) return res.json({ entries: [], count: 0 });
      try {
        const rows = await pool.query(
          `SELECT * FROM nba_official_injuries
           WHERE report_time > NOW() - INTERVAL '7 days'
           ORDER BY report_time DESC LIMIT 2000`
        );
        res.json({ entries: rows.rows, count: rows.rowCount });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.get('/nba/latest-url', (req, res) =>
      res.json({ last: lastProcessedUrl, current: getCurrentPdfUrl() })
    );
    app.get('/nba/debug', async (req, res) => {
      const url = getCurrentPdfUrl();
      try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        const d = await pdf(r.data);
        res.json({ url, text: d.text.slice(0, 4000), total_length: d.text.length });
      } catch (err) {
        res.json({ url, error: err.message, cached_text: lastRawText.slice(0, 4000) });
      }
    });
  }

  await pollOfficialReport();
  setInterval(pollOfficialReport, 60000);
  console.log('[NBA Official] Scraper started — polling every 60s ✓');
}

module.exports = { startScraper, getOfficialCache, getOfficialStatusForPlayer };
